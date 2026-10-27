import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chunkSource, sourceDisposition, createRetriever, matchTopics } from './knowledge.mjs';
import { modelContext } from './model.mjs';
import { validateRouting, fitContext } from './routing.mjs';

export const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory);

export function readHandoff(base = directory) {
  const files = ['voice.md', 'boundaries.md', 'participation.md', 'topics.json', 'evaluation.json', 'sources.json', 'routing.json', 'stewardship.md', 'welcome.md'];
  const contents = files.map(file => readFileSync(path.join(base, 'handoff', file), 'utf8'));
  const digest = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
  const snapshot = JSON.parse(contents[5]);
  if (!snapshot.commit || !Array.isArray(snapshot.sources) || !snapshot.sources.length) {
    throw new Error('Public-source snapshot is missing or invalid; run npm run snapshot -- <public commit>');
  }
  const topics = JSON.parse(contents[3]);
  if (!Array.isArray(topics) || topics.some(topic => typeof topic.id !== 'string' ||
      !Array.isArray(topic.aliases) || !Array.isArray(topic.terms) || !Array.isArray(topic.files) ||
      !Array.isArray(topic.entryFiles) || [...topic.aliases, ...topic.terms, ...topic.files, ...topic.entryFiles]
        .some(value => typeof value !== 'string' || !value.trim()))) {
    throw new Error('Invalid reviewed topic routes');
  }
  for (const topic of topics) {
    for (const [file, evidence] of Object.entries(topic.entryEvidence || {})) {
      const anchors = Array.isArray(evidence) ? evidence : [evidence];
      if (!topic.entryFiles.includes(file) || !anchors.length || anchors.some(text =>
        typeof text !== 'string' || !text.trim() ||
          !snapshot.sources.some(source => source.file === file && source.text.includes(text)))) {
        throw new Error(`Missing reviewed entry-point evidence for ${topic.id}: ${file}`);
      }
    }
  }
  return {
    digest, instructions: `${contents[0]}\n\n${contents[1]}\n\n${contents[2]}`,
    topics, evaluation: JSON.parse(contents[4]), routing: validateRouting(JSON.parse(contents[6])),
    stewardship: contents[7], welcome: contents[8], ...snapshot,
  };
}

export function questionInstructions(pack, message, history = []) {
  const matches = matchTopics(message, history, pack.topics);
  const guides = [];
  if (matches.some(({ topic }) => ['steward', 'independent-host', 'multisig', 'seed'].includes(topic.id))) {
    guides.push(pack.stewardship);
  }
  if (matches.some(({ topic }) => topic.id === 'newcomer')) guides.push(pack.welcome);
  return [pack.instructions, ...guides].join('\n\n');
}

export function isApproved(handoff, approvalFile) {
  try {
    const approval = JSON.parse(readFileSync(approvalFile, 'utf8'));
    return approval.digest === handoff.digest && typeof approval.reviewer === 'string' &&
      approval.reviewer.trim().length > 0 && Number.isFinite(Date.parse(approval.approvedAt));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function snapshot(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Supply an explicit 40-character public commit');
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
  if (!['https://github.com/TheJollyLaMa/DecentBusking.git', 'https://github.com/TheJollyLaMa/DecentBusking',
    'git@github.com:TheJollyLaMa/DecentBusking.git'].includes(origin)) {
    throw new Error('Snapshot requires the public DecentBusking origin');
  }
  const reachable = execFileSync('git', ['branch', '-r', '--contains', commit], { cwd: root, encoding: 'utf8' });
  if (!reachable.split('\n').some(line => line.trim() === 'origin/main')) {
    throw new Error('Snapshot must come from fetched public origin/main history, never a private worktree');
  }
  const entries = execFileSync('git', ['ls-tree', '-r', '-z', '-l', commit], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(entry => {
      const [metadata, file] = entry.split('\t');
      const [mode, type, blob, size] = metadata.trim().split(/\s+/);
      return { file, mode, type, blob, bytes: Number(size) || 0 };
    });
  const sources = [], coverage = [];
  for (const entry of entries) {
    let reason = sourceDisposition(entry.file, entry.mode);
    if (!reason) {
      const bytes = execFileSync('git', ['cat-file', 'blob', entry.blob], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { reason = 'non-UTF-8 content'; }
      if (!reason && text.includes('\0')) reason = 'binary content';
      if (!reason) {
        const chunks = chunkSource(entry.file, text, commit);
        sources.push(...chunks);
        coverage.push({ ...entry, status: 'indexed', chunks: chunks.length });
      }
    }
    if (reason) coverage.push({ ...entry, status: 'excluded', reason });
  }
  writeFileSync(path.join(directory, 'handoff/sources.json'),
    `${JSON.stringify({ commit, indexedAt: new Date().toISOString(), coverage, sources }, null, 2)}\n`);
  console.log(`Captured ${coverage.filter(file => file.status === 'indexed').length} public text files / ${sources.length} excerpts; ` +
    `${coverage.filter(file => file.status === 'excluded').length} explicit exclusions. Commit ${commit}. Approval is now invalidated.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'snapshot') snapshot(process.argv[3]);
  else if (command === 'review') {
    const pack = readHandoff();
    console.log(JSON.stringify({ digest: pack.digest, publicCommit: pack.commit, indexedAt: pack.indexedAt,
      coverage: { indexed: pack.coverage?.filter(file => file.status === 'indexed').length,
        excluded: pack.coverage?.filter(file => file.status === 'excluded') },
      topics: pack.topics.map(topic => topic.id), routing: pack.routing, stewardship: pack.stewardship,
      evaluation: pack.evaluation, approved: isApproved(pack,
        path.resolve(process.env.DBUSKER_APPROVAL_FILE || 'approval.json')) }, null, 2));
  } else if (command === 'evaluate-retrieval') {
    const pack = readHandoff(), retrieve = createRetriever(pack.sources, pack.topics);
    const results = pack.evaluation.filter(item => item.retrieval).map(item => {
      const context = fitContext({
        instructions: questionInstructions(pack, item.question, item.history || []),
        sources: retrieve(item.question, item.history || []),
        messages: [{ role: 'user', content: item.question }],
      });
      const sources = context.sources;
      const files = [...new Set(sources.map(source => source.file))];
      const missing = item.retrieval.filter(alternatives => !alternatives.some(file => files.includes(file)));
      const missingEvidence = (item.evidence || []).filter(term =>
        !sources.some(source => source.text.toLowerCase().includes(term.toLowerCase())));
      const contextBytes = Buffer.byteLength(JSON.stringify(modelContext(context)));
      return { question: item.question, passed: missing.length === 0 && missingEvidence.length === 0 && contextBytes <= 28000,
        files, missing, missingEvidence, contextBytes };
    });
    if (!results.length) throw new Error('No retrieval acceptance cases are defined');
    console.log(JSON.stringify({ digest: pack.digest, cases: results.length, results }, null, 2));
    if (results.some(result => !result.passed)) process.exitCode = 1;
  } else if (command === 'approve') {
    const reviewer = process.argv[3]?.trim();
    if (!reviewer) throw new Error('After human review: npm run approve -- "reviewer name"');
    const pack = readHandoff();
    writeFileSync(path.resolve(process.env.DBUSKER_APPROVAL_FILE || 'approval.json'),
      `${JSON.stringify({ digest: pack.digest, reviewer, approvedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 });
    console.log(`Approved ${pack.digest}. Restart the service to load the reviewed pack.`);
  } else throw new Error('Use snapshot <public commit>, review, evaluate-retrieval, or approve <reviewer>');
}
