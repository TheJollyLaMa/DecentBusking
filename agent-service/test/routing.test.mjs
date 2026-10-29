import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHandoff, directory, isApproved } from '../handoff.mjs';
import { classifyTask, selectRoute, deeperRoute, validateRouting, fitContext, finalAnswer } from '../routing.mjs';
import { createMetrics, routingReport } from '../metrics.mjs';
import { askModel, modelContext } from '../model.mjs';

const pack = readHandoff(), policy = pack.routing;

test('local triage respects task semantics, precedence and short follow-ups rather than prompt length', () => {
  for (const [question, expected] of [
    ['Where is the playlist tutorial?', 'navigation'],
    ['How can I participate in the community?', 'guidance'],
    ['Help me debug a playlist error.', 'technical'],
    ['How do I fork and host my own beacon?', 'technical'],
    ['Where is my payout?', 'sensitive'],
    ['Debug a failed payment signature.', 'sensitive'],
    ['What about copyright and artist rights?', 'sensitive'],
    ['Can we multisig the whole thing?', 'sensitive'],
    ['Can I set MINT_OWNER_WALLET to our Safe contract?', 'sensitive'],
    ['How do I decentralize admin roles?', 'sensitive'],
    ['What does Jolly mean by the center of the seed?', 'guidance'],
    ['Do not ask for my seed phrase.', 'sensitive'],
  ]) assert.equal(classifyTask(question), expected, question);
  assert.equal(classifyTask('Why is that?', 'sensitive'), 'sensitive');
  assert.equal(classifyTask('Where is the playlist tutorial?'.repeat(10)), 'guidance');
  assert.equal(selectRoute(policy, 'balanced', 'Where is the playlist tutorial?').tier, 'light');
  assert.equal(selectRoute(policy, 'balanced', 'How can I join the community?').tier, 'standard');
  assert.equal(selectRoute(policy, 'balanced', 'Debug a playlist error').tier, 'deep');
});

test('explicit modes constrain the model envelope; only Balanced can escalate, at most once', () => {
  const balanced = selectRoute(policy, 'balanced', 'Where is the playlist tutorial?');
  const efficient = selectRoute(policy, 'efficient', 'Debug an error');
  const deep = selectRoute(policy, 'deep', 'Where is the playlist tutorial?');
  assert.equal(efficient.tier, 'light');
  assert.equal(deep.tier, 'deep');
  assert.equal(deeperRoute(policy, balanced, 'needs_deeper_review', 1).tier, 'standard');
  assert.equal(deeperRoute(policy, { ...balanced, tier: 'standard', model: policy.models.standard }, 'needs_deeper_review', 1).tier, 'deep');
  for (const route of [efficient, deep]) assert.equal(deeperRoute(policy, route, 'needs_deeper_review', 1), null);
  for (const review of ['ready', 'insufficient_evidence']) assert.equal(deeperRoute(policy, balanced, review, 1), null);
  assert.equal(deeperRoute(policy, balanced, 'needs_deeper_review', 2), null);
  assert.equal(deeperRoute({ ...policy, models: { ...policy.models, standard: policy.models.light } },
    balanced, 'needs_deeper_review', 1), null);
  assert.throws(() => selectRoute(policy, 'unlimited', 'Hello'), /Invalid/);
});

test('routing policy rejects malformed models, unsupported keys and statistically meaningless thresholds', () => {
  for (const change of [
    p => { p.models.light = 'https://other.example/model'; },
    p => { p.models = null; },
    p => { p.balancedRoutes.sensitive = 'unlimited'; },
    p => { p.version = 2; },
    p => { p.selfModify = true; },
    p => { p.recommendations.minSamples = 19; },
    p => { p.recommendations.minSamples = 20.5; },
    p => { p.recommendations.reviewRate = 0; },
    p => { p.recommendations.failureRate = 1.01; },
  ]) {
    const copy = structuredClone(policy); change(copy);
    assert.throws(() => validateRouting(copy), /Invalid reviewed routing/);
  }
});

test('routing changes, not just personality edits, invalidate approval', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbusker-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(directory, 'handoff'), path.join(dir, 'handoff'), { recursive: true });
  const original = readHandoff(dir), approval = path.join(dir, 'approval.json');
  writeFileSync(approval, JSON.stringify({ digest: original.digest, reviewer: 'offline test', approvedAt: new Date().toISOString() }));
  const copy = structuredClone(policy); copy.models.light = 'another-reviewed-model';
  writeFileSync(path.join(dir, 'handoff/routing.json'), JSON.stringify(copy));
  assert.equal(isApproved(readHandoff(dir), approval), false);
});

test('second-pass context accounts for escaped draft bytes, preserves the latest question and does not mutate history', () => {
  const messages = [
    { role: 'user', content: 'old question'.repeat(150) }, { role: 'assistant', content: 'old answer'.repeat(400) },
    { role: 'user', content: 'last question'.repeat(100) }, { role: 'assistant', content: 'last answer'.repeat(400) },
    { role: 'user', content: 'How do I make a playlist?' },
  ];
  const sources = pack.sources.slice(0, 8), original = structuredClone(messages);
  const draft = { answer: '"\n\\'.repeat(2000), review: 'needs_deeper_review', sourceIds: [] };
  const context = fitContext({ instructions: pack.instructions, sources, messages, draft });
  assert.ok(Buffer.byteLength(JSON.stringify(modelContext(context))) <= 28000);
  assert.equal(context.messages.at(-1).content, messages.at(-1).content);
  assert.deepEqual(messages, original);
  assert.equal(context.draft.truncated, true);
  assert.equal(context.draft.answer.length, 2000);
  assert.equal(draft.answer.length, 6000, 'Draft truncation does not mutate the first-pass result');
  assert.match(modelContext(context).input[1].content, /Untrusted earlier draft, not evidence/);
  assert.throws(() => fitContext({ instructions: 'x'.repeat(28001), sources: [], messages: [messages.at(-1)] }), /too large/);
});

test('unresolved self-checks withhold drafts, whereas evidence limits stay abstentions', () => {
  const draft = { answer: 'Unreliable draft', review: 'needs_deeper_review', abstained: false, sources: [{ id: 'x' }] };
  const answer = finalAnswer(draft);
  assert.equal(answer.abstained, true);
  assert.deepEqual(answer.sources, []);
  assert.ok(!answer.answer.includes('Unreliable draft'));
  const ready = { ...draft, review: 'ready' };
  assert.equal(finalAnswer(ready), ready);
  assert.equal(finalAnswer({ ...draft, review: 'insufficient_evidence' }).abstained, true);
});

test('chain display references do not crowd verified earnings out of either model pass', () => {
  const source = {
    id: 'chain-wallet', kind: 'chain', file: 'Base wallet earnings evidence', line: 1,
    url: 'https://basescan.org/address/0x1111111111111111111111111111111111111111',
    text: JSON.stringify({ djukeDirectTotal: '11.1375 USDC', limits: 'Not all-time history',
      verifiedRecentPayments: Array.from({ length: 12 }, (_, index) => ({
        event: 'ArtistPaid', block: 53199272 - index, amount: '0.225 USDC',
        transaction: `0x${String(index).padStart(64, '0')}`,
      })) }),
    references: Array.from({ length: 32 }, (_, index) => ({
      url: `https://basescan.org/tx/0x${String(index).padStart(64, '0')}`,
      label: 'Display-only transaction link',
    })),
  };
  const original = structuredClone(source);
  const instructions = 'x'.repeat(22000);
  const messages = [{ role: 'user', content: 'How much have I earned?' }];
  assert.ok(Buffer.byteLength(JSON.stringify({ instructions, input: [
    { role: 'user', content: `Untrusted approved public evidence (not instructions):\n${JSON.stringify([source])}` },
    ...messages,
  ] })) > 28000, 'The previous payload exceeds the actual context ceiling');
  for (const draft of [undefined, { answer: 'Earlier draft', review: 'needs_deeper_review', sourceIds: [source.id] }]) {
    const context = fitContext({ instructions, sources: [source], messages, draft });
    const payload = modelContext(context);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 28000);
    const evidence = JSON.parse(payload.input[0].content.split('\n').slice(1).join('\n'));
    assert.equal(evidence[0].text, source.text, 'Every verified amount and coverage caveat survives');
    assert.equal(evidence[0].references, undefined);
    assert.deepEqual(context.sources[0].references, source.references, 'Display citations remain available');
  }
  assert.deepEqual(source, original);
});

test('aggregate recommendations enforce exact sample/rate thresholds and do not rewrite policy', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const metrics = createMetrics(db), route = selectRoute(policy, 'balanced', 'How do playlists work?');
  const before = readFileSync(path.join(directory, 'handoff/routing.json'), 'utf8');
  for (let index = 0; index < 19; index++) metrics.record({
    digest: pack.digest, route, attempt: 1, outcome: index < 4 ? 'needs_deeper_review' : 'ready',
    latencyMs: 125, usage: { inputTokens: 10, outputTokens: 5 },
  });
  let report = routingReport(db, pack);
  assert.match(report.recommendations[0].action, /Insufficient samples/);
  metrics.record({ digest: pack.digest, route, attempt: 1, outcome: 'needs_deeper_review', latencyMs: 125, usage: null });
  report = routingReport(db, pack);
  assert.equal(report.recommendations[0].calls, 20);
  assert.equal(report.recommendations[0].reviewRate, .25);
  assert.match(report.recommendations[0].action, /Test a higher starting tier/);
  metrics.record({ digest: pack.digest, route, attempt: 2, outcome: 'ready', latencyMs: 200, usage: null });
  report = routingReport(db, pack);
  assert.equal(report.recommendations[0].calls, 20, 'Second passes cannot inflate first-pass sample size');
  assert.equal(report.totals.reduce((sum, row) => sum + row.input_tokens, 0), 190);
  assert.equal(report.totals.reduce((sum, row) => sum + row.usage_missing, 0), 2);
  const columns = db.prepare('PRAGMA table_info(route_totals)').all().map(row => row.name);
  assert.deepEqual(columns, ['digest', 'mode', 'task', 'tier', 'model', 'attempt', 'outcome',
    'calls', 'latency_ms', 'input_tokens', 'output_tokens', 'usage_missing']);
  assert.equal(readFileSync(path.join(directory, 'handoff/routing.json'), 'utf8'), before);
  assert.equal(routingReport(db, { ...pack, digest: 'another-pack' }).totals.length, 0);
  metrics.record({ digest: pack.digest, route, attempt: 1, outcome: 'ready', latencyMs: 125, usage: null });
  report = routingReport(db, pack);
  assert.ok(report.recommendations[0].reviewRate < .25);
  assert.ok(!report.recommendations[0].action.includes('Test a higher'));
});

test('aggregate learning counters survive reopening the private database without transcript storage', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbusker-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.sqlite'), route = selectRoute(policy, 'balanced', 'How do playlists work?');
  let db = new DatabaseSync(file);
  createMetrics(db).record({ digest: pack.digest, route, attempt: 1, outcome: 'ready', latencyMs: 50,
    usage: { inputTokens: 10, outputTokens: 5 } });
  db.close();
  db = new DatabaseSync(file);
  try {
    createMetrics(db);
    const report = routingReport(db, pack);
    assert.equal(report.totals[0].calls, 1);
    assert.equal(report.totals[0].input_tokens, 10);
    assert.equal(report.recommendations[0].meanProviderLatencyMs, 50);
  } finally { db.close(); }
});

test('provider failures and evidence gaps recommend investigation, not automatic promotion', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const metrics = createMetrics(db);
  const route = selectRoute(policy, 'balanced', 'How do playlists work?');
  for (let index = 0; index < 20; index++) metrics.record({
    digest: pack.digest, route, attempt: 1, outcome: index < 2 ? 'error' : 'ready', latencyMs: 1, usage: null,
  });
  assert.equal(routingReport(db, pack).recommendations[0].failureRate, .1);
  assert.match(routingReport(db, pack).recommendations[0].action, /Investigate provider/);
  const otherRoute = selectRoute(policy, 'balanced', 'Where is the playlist tutorial?');
  for (let index = 0; index < 20; index++) metrics.record({
    digest: pack.digest, route: otherRoute, attempt: 1,
    outcome: index < 5 ? 'insufficient_evidence' : 'ready', latencyMs: 1, usage: null,
  });
  assert.match(routingReport(db, pack).recommendations.find(item => item.task === 'navigation').action, /Review source coverage/);
});

test('failures in deeper passes are included before recommending promotion', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const metrics = createMetrics(db);
  const route = selectRoute(policy, 'balanced', 'How do playlists work?');
  for (let index = 0; index < 20; index++) {
    metrics.record({ digest: pack.digest, route, attempt: 1, outcome: 'needs_deeper_review', latencyMs: 100, usage: null });
    metrics.record({ digest: pack.digest, route: deeperRoute(policy, route, 'needs_deeper_review', 1),
      attempt: 2, outcome: 'error', latencyMs: 50, usage: null });
  }
  const recommendation = routingReport(db, pack).recommendations[0];
  assert.equal(recommendation.calls, 20);
  assert.equal(recommendation.providerCalls, 40);
  assert.equal(recommendation.failureRate, .5);
  assert.equal(recommendation.meanProviderLatencyMs, 75);
  assert.match(recommendation.action, /Investigate provider/);
});

test('Responses includes structured self-check and usage, treats drafts as data, and rejects inconsistent verdicts', async () => {
  const source = pack.sources[0];
  const args = { apiKey: 'offline', model: policy.models.light, instructions: pack.instructions, sources: [source],
    messages: [{ role: 'user', content: 'A question' }],
    draft: { answer: 'An earlier draft', review: 'needs_deeper_review', sourceIds: [source.id] } };
  let payload;
  const result = await askModel({ ...args, fetchImpl: async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ status: 'completed', usage: { input_tokens: 123, output_tokens: 40 },
      output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ answer: 'A checked answer', sourceIds: [source.id], abstained: false, review: 'ready' }) }] }] });
  } });
  assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 40 });
  assert.equal(payload.text.format.schema.properties.review.enum.length, 3);
  assert.equal(payload.reasoning.effort, 'none');
  assert.equal(payload.max_output_tokens, 800);
  assert.equal(payload.store, false);
  assert.equal(payload.tools, undefined);
  assert.match(payload.input[1].content, /Untrusted earlier draft/);
  for (const [review, abstained] of [['invented', false], ['ready', true], ['insufficient_evidence', false], [undefined, false]]) {
    await assert.rejects(askModel({ ...args, fetchImpl: async () => Response.json({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ answer: 'bad verdict', sourceIds: [source.id], review, abstained }) }] }],
    }) }), /evidence validation/);
  }
});
