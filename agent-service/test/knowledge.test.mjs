import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chunkSource, createRetriever, sourceDisposition } from '../knowledge.mjs';
import { directory, readHandoff, isApproved, questionInstructions } from '../handoff.mjs';
import { modelContext } from '../model.mjs';
import { fitContext } from '../routing.mjs';

const pack = readHandoff();
const retrieve = createRetriever(pack.sources, pack.topics);
const root = path.dirname(directory);

test('coverage accounts for every tracked public file, with broad code/docs/test coverage and explicit exclusions', () => {
  const tree = execFileSync('git', ['ls-tree', '-r', '-z', '-l', pack.commit], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(entry => {
      const [metadata, file] = entry.split('\t');
      const [mode, type, blob, size] = metadata.trim().split(/\s+/);
      return { file, mode, type, blob, bytes: Number(size) || 0 };
    });
  const files = tree.map(entry => entry.file).sort();
  assert.deepEqual(pack.coverage.map(entry => entry.file).sort(), files);
  assert.equal(new Set(pack.coverage.map(entry => entry.file)).size, files.length);
  const indexed = pack.coverage.filter(entry => entry.status === 'indexed');
  assert.ok(indexed.length >= 300, `Only ${indexed.length} public text files indexed`);
  for (const prefix of ['js/', 'discord-bot/', 'test/', 'docs/', 'scripts/', '.github/']) {
    assert.ok(indexed.some(entry => entry.file.startsWith(prefix)), `Missing ${prefix}`);
  }
  for (const entry of pack.coverage) {
    const expected = tree.find(item => item.file === entry.file);
    for (const field of ['mode', 'type', 'blob', 'bytes']) assert.equal(entry[field], expected[field], entry.file);
    const excluded = sourceDisposition(entry.file, entry.mode);
    if (excluded) {
      assert.equal(entry.status, 'excluded', entry.file);
      assert.equal(entry.reason, excluded);
      assert.equal(pack.sources.some(source => source.file === entry.file), false);
    } else {
      assert.equal(entry.status, 'indexed', entry.file);
      assert.equal(pack.sources.filter(source => source.file === entry.file).length, entry.chunks, entry.file);
      assert.ok(entry.chunks >= 1);
    }
  }
  assert.equal(pack.coverage.find(entry => entry.file === 'contributor-accounts.json').status, 'excluded');
  assert.equal(pack.coverage.find(entry => entry.file === 'payroll-queue.json').status, 'excluded');
});

test('each indexed source exactly matches deterministic chunks of the public Git blob, not a local worktree', () => {
  for (const entry of pack.coverage.filter(item => item.status === 'indexed')) {
    const bytes = execFileSync('git', ['cat-file', 'blob', entry.blob], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const expectedBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    assert.equal(expectedBlob, entry.blob);
    assert.equal(bytes.length, entry.bytes);
    assert.deepEqual(pack.sources.filter(source => source.file === entry.file),
      chunkSource(entry.file, new TextDecoder('utf-8', { fatal: true }).decode(bytes), pack.commit), entry.file);
  }
  assert.equal(new Set(pack.sources.map(source => source.id)).size, pack.sources.length);
  for (const source of pack.sources) {
    assert.ok(Buffer.byteLength(source.text) <= 1800, source.id);
    assert.ok(source.line >= 1 && source.endLine >= source.line);
    assert.match(source.url, new RegExp(`/blob/${pack.commit}/`));
  }
});

test('chunking bounds long UTF-8 lines without losing characters or corrupting line citations', () => {
  const line = 'music \u{1f3b5} '.repeat(1000);
  const text = `${line}\nend`;
  const chunks = chunkSource('test.txt', text, 'a'.repeat(40));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(chunk => chunk.text).join(''), `${line}\nend`);
  assert.ok(chunks.every(chunk => !chunk.text.includes('\uFFFD') && Buffer.byteLength(chunk.text) <= 1800));
  assert.equal(chunks[0].line, 1);
  assert.equal(chunks.at(-1).endLine, 2);
});

test('credentials, individual records, binary assets, lockfiles and recursive snapshots are not model knowledge', () => {
  for (const file of ['.env', '.env.local', 'discord-bot/.env.example', 'server.key', 'agent-service/access.json',
    'agent-service/approval.json', 'contributor-accounts.json', 'payroll-queue.json', 'docs/reports/report.json',
    'img/D_Busker.jpeg', 'package-lock.json', 'agent-service/handoff/sources.json', 'data.sqlite']) {
    assert.notEqual(sourceDisposition(file), null, file);
  }
  assert.notEqual(sourceDisposition('js/link.js', '120000'), null);
  for (const file of ['README.md', 'js/tutorial.js', '.github/workflows/bounty-bot.yml',
    '.github/ISSUE_TEMPLATE/whitelist-request.yml', 'payroll-assets.json', 'test/pinner-rewards.test.js']) {
    assert.equal(sourceDisposition(file), null, file);
  }
});

for (const item of pack.evaluation.filter(item => item.retrieval)) {
  test(`retrieval: ${item.question}`, () => {
    const context = fitContext({
      instructions: questionInstructions(pack, item.question, item.history || []),
      sources: retrieve(item.question, item.history || []),
      messages: [{ role: 'user', content: item.question }],
    });
    const sources = context.sources;
    assert.ok(sources.length <= 8 && sources.length > 0);
    for (const file of new Set(sources.map(source => source.file))) {
      assert.ok(sources.filter(source => source.file === file).length <= 3, file);
    }
    for (const alternatives of item.retrieval) {
      assert.ok(sources.some(source => alternatives.includes(source.file)),
        `Missing ${alternatives.join(' or ')}; got ${sources.map(source => `${source.file}:${source.line}`).join(', ')}`);
    }
    for (const evidence of item.evidence || []) {
      assert.ok(sources.some(source => source.text.toLowerCase().includes(evidence.toLowerCase())),
        `Missing actual evidence text: ${evidence}`);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(modelContext(context))) <= 28000,
      'Evaluation evidence does not fit the real request ceiling');
  });
}

test('topics point to indexed public evidence and small follow-ups keep the prior user context', () => {
  const indexed = new Set(pack.coverage.filter(item => item.status === 'indexed').map(item => item.file));
  for (const topic of pack.topics) {
    for (const file of [...topic.files, ...topic.entryFiles]) assert.ok(indexed.has(file), `${topic.id}: ${file}`);
  }
  const source = retrieve('And how do I get approved?', [{ role: 'user', content: 'I want repo dev bounties' }]);
  assert.ok(source.some(item => item.file === '.github/ISSUE_TEMPLATE/whitelist-request.yml'));
  assert.deepEqual(retrieve('zzzzzzzzzzzzzzzzzzzz'), [], 'No matches must not silently become the first source');
});

test('all supplied founder aliases and independence/governance paths receive reviewed stewardship guidance', () => {
  for (const question of [
    'Who is Jolly?', 'Who is THEJOLLYLAMA?', 'Who is TheJollyLaMa?', 'What does jollyEast do?',
    'Who is the one who made all this?', 'Who built this?',
    'Can I clone it?', 'Can we multisig this?', 'What about ERC-1271?',
    'Explain the center of the seed.', 'What is at the center of every seed?', 'How do I build my own center?',
    'Does the project have a single point of failure?',
  ]) {
    const instructions = questionInstructions(pack, question);
    assert.ok(instructions.includes(pack.stewardship), question);
    assert.ok(instructions.startsWith(pack.instructions), 'Core boundaries are retained');
    assert.ok(retrieve(question).length > 0, 'Aliases must retrieve actual public attribution/authority evidence');
  }
});

test('guidance follows a short founder follow-up but is not added to unrelated questions or partial-name matches', () => {
  assert.ok(questionInstructions(pack, 'And what still depends on him?',
    [{ role: 'user', content: 'Who is jollyEast?' }]).includes(pack.stewardship));
  for (const question of ['Where is the playlist tutorial?', 'How do I add an album collaborator?', 'What is jollygoodness?']) {
    assert.equal(questionInstructions(pack, question), pack.instructions, question);
  }
  assert.equal(questionInstructions(pack, 'Where is the playlist tutorial?',
    [{ role: 'assistant', content: 'Jolly says hello' }]), pack.instructions, 'Assistant prose cannot activate founder context');
});

test('newcomer guidance follows visitor intent without consuming unrelated governance context', () => {
  for (const question of ["What's this?", 'How do I submit a song?', pack.evaluation[0].question]) {
    assert.ok(questionInstructions(pack, question).includes(pack.welcome), question);
  }
  assert.ok(questionInstructions(pack, 'What next?',
    [{ role: 'user', content: 'How do I submit a song?' }]).includes(pack.welcome));
  assert.equal(questionInstructions(pack, 'Explain verifyAlchemySignature'), pack.instructions);
  assert.ok(!questionInstructions(pack, 'Can we multisig this?').includes(pack.welcome));
  assert.ok(!questionInstructions(pack, 'What next?',
    [{ role: 'assistant', content: 'Submit a song' }]).includes(pack.welcome));
  assert.match(pack.instructions, /sourceIds/);
  assert.match(pack.welcome, /under 180 words/);
  assert.match(pack.welcome, /genuinely missing, stale or conflicting facts explicit/);
});

test('newcomer anchors retain upload, review, public-storage and wallet-free evidence in either pass', () => {
  const question = pack.evaluation[0].question;
  for (const draft of [undefined, {
    answer: 'An uncertain first welcome. '.repeat(200), review: 'needs_deeper_review', sourceIds: [],
  }]) {
    const context = fitContext({
      instructions: questionInstructions(pack, question), sources: retrieve(question),
      messages: [{ role: 'user', content: question }], draft,
    });
    for (const evidence of pack.evaluation[0].evidence) {
      assert.ok(context.sources.some(source => source.text.includes(evidence)), evidence);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(modelContext(context))) <= 28000);
  }
});

test('review rejects empty, invalid or unsupported multiple entry-point anchors', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbusker-anchor-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(directory, 'handoff'), path.join(dir, 'handoff'), { recursive: true });
  const target = path.join(dir, 'handoff/topics.json');
  for (const anchors of [[], [''], [42], ['not an actual approved excerpt']]) {
    const topics = structuredClone(pack.topics);
    topics[0].entryEvidence['docs/NEWCOMERS.md'] = anchors;
    writeFileSync(target, JSON.stringify(topics));
    assert.throws(() => readHandoff(dir), /Missing reviewed entry-point evidence/);
  }
});

test('seed orientation distinguishes steward testimony, contributors, infrastructure, licenses and staged multisig limits', () => {
  for (const phrase of [
    'his supplied orientation', 'not a', 'verified on-chain identity', 'A Decent Agency contributors',
    'roots reach for water', 'shoots reach for light', 'not make the founder indispensable',
    'not proof who controls each account', 'owner review and settlement', 'domain/DNS',
    'start local/read-only', 'artist', 'cloning code does not clone',
    'DEFAULT_ADMIN_ROLE alone', 'never renounce first', 'ERC-1271',
    'EOA-only', 'MINT_OWNER_WALLET', 'narrowly scoped worker role',
  ]) assert.ok(pack.stewardship.toLowerCase().includes(phrase.toLowerCase()), phrase);
});

test('both bounded multisig passes retain the role and EOA-auth blocker evidence after context fitting', () => {
  const question = 'Can we multisig the whole thing so it no longer depends on Jolly?';
  const args = {
    instructions: questionInstructions(pack, question), sources: retrieve(question),
    messages: [{ role: 'user', content: question }],
  };
  for (const draft of [undefined, {
    answer: 'An uncertain governance draft. '.repeat(200), review: 'needs_deeper_review', sourceIds: [],
  }]) {
    const context = fitContext({ ...args, draft });
    assert.ok(Buffer.byteLength(JSON.stringify(modelContext(context))) <= 28000);
    assert.ok(context.sources.some(source => source.file === 'js/admin.js' && source.text.includes('function grantRole')));
    assert.ok(context.sources.some(source => source.file === 'discord-bot/ipfs-worker.js' && source.text.includes('verifyMessage')));
    assert.ok(context.sources.some(source => source.file === 'NOTICE'));
    assert.equal(context.messages.at(-1).content, question);
  }
});

test('code navigation outside curated topics retrieves actual implementation and related tests', () => {
  for (const [question, file] of [
    ['Explain buildCommunityPinManifest', 'js/pinner-rewards.mjs'],
    ['How does verifyAlchemySignature work?', 'discord-bot/alchemy-webhook.js'],
    ['Where is createSplitTutorialSurfaces defined?', 'js/split-tutorial-surfaces.mjs'],
    ['Explain js/playlist-schedule-warning.mjs', 'js/playlist-schedule-warning.mjs'],
  ]) {
    assert.ok(retrieve(question).some(source => source.file === file), question);
  }
});

test('community routes, mission, evaluation and corpus all invalidate prior approval when edited', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbusker-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(directory, 'handoff'), path.join(dir, 'handoff'), { recursive: true });
  const initial = readHandoff(dir), approval = path.join(dir, 'approval.json');
  writeFileSync(approval, JSON.stringify({ digest: initial.digest, reviewer: 'offline test', approvedAt: new Date().toISOString() }));
  assert.equal(isApproved(initial, approval), true);
  for (const file of ['voice.md', 'boundaries.md', 'participation.md', 'topics.json', 'evaluation.json', 'sources.json', 'stewardship.md', 'welcome.md', 'chain.md']) {
    const target = path.join(dir, 'handoff', file), original = readFileSync(target, 'utf8');
    writeFileSync(target, `${original}\n`);
    assert.equal(isApproved(readHandoff(dir), approval), false, file);
    writeFileSync(target, original);
  }
});
