import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { SiweMessage } from 'siwe';
import { createAgentServer, loadSettings } from '../server.mjs';
import { directory, readHandoff, isApproved } from '../handoff.mjs';
import { askModel, retrieveSources, modelContext, ModelFailure } from '../model.mjs';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbusker-test-'));
  const wallet = Wallet.createRandom(), other = Wallet.createRandom();
  const settings = { ...loadSettings({
    DBUSKER_SITE_URL: 'http://localhost:8080', DBUSKER_ENABLED: 'true', OPENAI_API_KEY: 'test-not-a-key',
    DBUSKER_STATE_FILE: path.join(dir, 'state.sqlite'), DBUSKER_ACCESS_FILE: path.join(dir, 'access.json'),
    DBUSKER_APPROVAL_FILE: path.join(dir, 'approval.json'),
  }), ...options.settings };
  writeFileSync(settings.accessFile, JSON.stringify({ enabled: true, wallets: [wallet.address, other.address] }));
  writeFileSync(settings.approvalFile, JSON.stringify({ digest: readHandoff().digest,
    reviewer: 'offline test only', approvedAt: new Date().toISOString() }));
  const calls = [];
  const logs = [];
  const modelCall = options.modelCall || (async input => {
    calls.push(input);
    return { answer: `Answer to ${input.messages.at(-1).content}`, abstained: false, review: 'ready',
      sources: [{ id: input.sources[0].id, file: input.sources[0].file, line: input.sources[0].line, url: input.sources[0].url }] };
  });
  let time = Date.now();
  const server = createAgentServer(settings, { modelCall, now: () => time, logger: { error: message => logs.push(message) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  async function request(route, data, credential, method = 'POST', origin = settings.origin) {
    const response = await fetch(`${base}${route}`, {
      method, headers: { Origin: origin, 'Content-Type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  async function login(who = wallet) {
    const challenge = await request('/challenge', { address: who.address, chainId: 8453 });
    assert.equal(challenge.status, 200);
    const message = challenge.body.message;
    const signature = await who.signMessage(message);
    const response = await request('/session', { message, signature });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { ...response.body, message, signature };
  }
  return { dir, settings, server, base, wallet, other, calls, logs, request, login,
    advance: ms => { time += ms; },
    access: value => writeFileSync(settings.accessFile, JSON.stringify(value)) };
}

test('pilot fails closed when disabled or handoff is not approved', async t => {
  const f = await fixture(t, { settings: { enabled: false } });
  assert.equal((await f.request('/challenge', { address: f.wallet.address, chainId: 8453 })).status, 503);
  f.settings.enabled = true;
  writeFileSync(f.settings.approvalFile, '{"digest":"outdated"}');
  assert.equal((await f.request('/challenge', { address: f.wallet.address, chainId: 8453 })).status, 503);
  assert.equal(f.calls.length, 0);
});

test('only invited Base wallets with valid one-time signatures get sessions', async t => {
  const f = await fixture(t);
  const stranger = Wallet.createRandom();
  assert.equal((await f.request('/challenge', { address: stranger.address, chainId: 8453 })).status, 403);
  assert.equal((await f.request('/challenge', { address: f.wallet.address, chainId: 1 })).status, 400);
  assert.equal((await f.request('/challenge', { address: 'invalid', chainId: 8453 })).status, 400);
  const signed = await f.login();
  assert.equal((await f.request('/session', { message: signed.message, signature: signed.signature })).status, 401);
  const challenge = await f.request('/challenge', { address: f.wallet.address, chainId: 8453 });
  const badSignature = await f.other.signMessage(challenge.body.message);
  assert.equal((await f.request('/session', { message: challenge.body.message, signature: badSignature })).status, 401);
});

test('invitation visibility check returns no roster or credentials and does not authorize chat', async t => {
  const f = await fixture(t);
  const address = f.wallet.address;
  const invited = await f.request('/invitation', { address, chainId: 8453 });
  assert.equal(invited.status, 200);
  assert.deepEqual(invited.body, { invited: true });
  assert.deepEqual((await f.request('/invitation', { address: Wallet.createRandom().address, chainId: 8453 })).body,
    { invited: false });
  assert.deepEqual((await f.request('/invitation', { address, chainId: 1 })).body, { invited: false });
  assert.equal((await f.request('/invitation', { address: 'invalid', chainId: 8453 })).status, 400);
  assert.equal((await f.request('/invitation', { address, chainId: 8453 }, null, 'POST', 'https://evil.example')).status, 403);
  assert.equal((await f.request('/chat', { message: 'Hello', consent: true })).status, 401);
  f.access({ enabled: true, wallets: [] });
  assert.deepEqual((await f.request('/invitation', { address, chainId: 8453 })).body, { invited: false });
  f.access({ enabled: false, wallets: [address] });
  assert.equal((await f.request('/invitation', { address, chainId: 8453 })).status, 503);
  assert.equal(f.calls.length, 0);
});

test('wrong domain, expired challenges, and expired sessions are rejected', async t => {
  const f = await fixture(t);
  const session = await f.login();
  const challenge = await f.request('/challenge', { address: f.wallet.address, chainId: 8453 });
  const wrong = new SiweMessage(challenge.body.message);
  wrong.domain = 'evil.example';
  const message = wrong.prepareMessage();
  assert.equal((await f.request('/session', { message, signature: await f.wallet.signMessage(message) })).status, 401);
  const expired = await f.request('/challenge', { address: f.wallet.address, chainId: 8453 });
  f.advance(5 * 60_000 + 1);
  assert.equal((await f.request('/session', { message: expired.body.message,
    signature: await f.wallet.signMessage(expired.body.message) })).status, 401);
  f.advance(10 * 60_000);
  assert.equal((await f.request('/chat', { message: 'Hello', consent: true }, session.token)).status, 401);
});

test('direct API access requires origin, session and explicit consent', async t => {
  const f = await fixture(t);
  const session = await f.login();
  assert.equal((await f.request('/chat', { message: 'hello', consent: true })).status, 401);
  assert.equal((await f.request('/chat', { message: 'hello', consent: true }, session.token, 'POST', 'https://evil.example')).status, 403);
  assert.equal((await f.request('/chat', { message: 'hello' }, session.token)).status, 400);
  assert.equal((await f.request('/chat', { message: 'x'.repeat(2001), consent: true }, session.token)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('conversations stay isolated and clearing a session destroys its history', async t => {
  const f = await fixture(t);
  const a = await f.login(), b = await f.login(f.other);
  assert.equal((await f.request('/chat', { message: 'my private question about playlists', consent: true }, a.token)).status, 200);
  assert.equal((await f.request('/chat', { message: 'another visitor asks about playlists', consent: true }, b.token)).status, 200);
  assert.equal(f.calls[1].messages.length, 1);
  assert.ok(!JSON.stringify(f.calls[1].messages).includes('my private question'));
  await f.request('/chat', { message: 'follow up', consent: true }, a.token);
  assert.equal(f.calls[2].messages.length, 3);
  assert.equal((await f.request('/session', null, a.token, 'DELETE')).status, 200);
  assert.equal((await f.request('/chat', { message: 'again', consent: true }, a.token)).status, 401);
  assert.ok(!f.logs.join('\n').includes('my private question'));
});

test('revocation and kill switch deny existing sessions immediately', async t => {
  const f = await fixture(t);
  const a = await f.login();
  f.access({ enabled: true, wallets: [] });
  assert.equal((await f.request('/chat', { message: 'hello', consent: true }, a.token)).status, 403);
  f.access({ enabled: false, wallets: [f.wallet.address] });
  assert.equal((await f.request('/challenge', { address: f.wallet.address, chainId: 8453 })).status, 503);
  assert.equal(f.calls.length, 0);
});

test('long conversations trim old context while preserving the byte ceiling and latest question', async t => {
  const inputs = [];
  const f = await fixture(t, { modelCall: async input => {
    inputs.push(input);
    return { answer: 'a'.repeat(8000), abstained: false, sources: [], review: 'ready' };
  } });
  const session = await f.login();
  for (const message of ['Explain listening', 'What is running on the live server right this second?', 'Follow up']) {
    assert.equal((await f.request('/chat', { message, consent: true }, session.token)).status, 200);
  }
  for (const input of inputs) {
    assert.ok(Buffer.byteLength(JSON.stringify(modelContext(input))) <= 28000);
  }
  assert.equal(inputs.at(-1).messages.at(-1).content, 'Follow up');
});

test('malformed JSON shapes and provider failures are explicit and consume no extra retries', async t => {
  const f = await fixture(t, { modelCall: async () => { throw new Error('test provider outage'); } });
  const session = await f.login();
  const malformed = await fetch(`${f.base}/chat`, { method: 'POST',
    headers: { Origin: f.settings.origin, 'Content-Type': 'application/json' }, body: 'null' });
  assert.equal(malformed.status, 401);
  const nullBody = await fetch(`${f.base}/chat`, { method: 'POST',
    headers: { Origin: f.settings.origin, 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: 'null' });
  assert.equal(nullBody.status, 400);
  const response = await f.request('/chat', { message: 'A playlist question', consent: true }, session.token);
  assert.equal(response.status, 503);
  assert.match(response.body.error, /unavailable/);
  assert.equal(JSON.stringify(response.body).includes('test provider outage'), false);
});

test('active model request is aborted on revocation', async t => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { modelCall: ({ signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const a = await f.login();
  const response = f.request('/chat', { message: 'hello playlists', consent: true }, a.token);
  await waiting;
  assert.equal((await f.request('/chat', { message: 'duplicate', consent: true }, a.token)).status, 409);
  f.access({ enabled: true, wallets: [] });
  assert.equal((await response).status, 403);
});

test('durable global call ceiling survives a fresh server instance', async t => {
  const f = await fixture(t, { settings: { maxCalls: 1 } });
  const a = await f.login();
  assert.equal((await f.request('/chat', { message: 'first playlist question', consent: true }, a.token)).status, 200);
  assert.equal((await f.request('/chat', { message: 'second playlist question', consent: true }, a.token)).status, 429);
  const fresh = createAgentServer(f.settings, { logger: { error() {} } });
  await new Promise(resolve => fresh.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { fresh.closeAllConnections(); fresh.close(resolve); }));
  const origin = f.settings.origin;
  const post = async (route, data, credential) => {
    const response = await fetch(`http://127.0.0.1:${fresh.address().port}${route}`, { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const challenge = await post('/challenge', { address: f.wallet.address, chainId: 8453 });
  const session = await post('/session', { message: challenge.body.message,
    signature: await f.wallet.signMessage(challenge.body.message) });
  assert.equal((await post('/chat', { message: 'third playlist question', consent: true }, session.body.token)).status, 429);
});

test('handoff changes invalidate human approval', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbusker-handoff-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(path.join(directory, 'handoff'), path.join(dir, 'handoff'), { recursive: true });
  const pack = readHandoff(dir), approval = path.join(dir, 'approval.json');
  writeFileSync(approval, JSON.stringify({ digest: pack.digest, reviewer: 'test', approvedAt: new Date().toISOString() }));
  assert.equal(isApproved(pack, approval), true);
  writeFileSync(path.join(dir, 'handoff/voice.md'), 'A changed voice needs another review.');
  assert.equal(isApproved(readHandoff(dir), approval), false);
});

test('Responses request has no tools/storage and validates returned source IDs', async () => {
  const pack = readHandoff(), sources = retrieveSources(pack.sources, 'listen wallet');
  let sent;
  const args = { apiKey: 'not-a-key', model: 'test', instructions: pack.instructions, sources,
    messages: [{ role: 'user', content: 'Can I listen?' }],
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      sent = JSON.parse(init.body);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{
        type: 'output_text', text: JSON.stringify({ answer: 'Yes', sourceIds: [sources[0].id], abstained: false, review: 'ready' }),
      }] }] });
    } };
  const answer = await askModel(args);
  assert.equal(sent.store, false);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.max_output_tokens, 800);
  assert.equal(answer.sources[0].id, sources[0].id);
  assert.equal(answer.sources[0].text, undefined);
  args.fetchImpl = async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{
    type: 'output_text', text: '{"answer":"invented","sourceIds":["not-real"],"abstained":false,"review":"ready"}',
  }] }] });
  await assert.rejects(askModel(args), /evidence validation/);
  args.fetchImpl = async () => Response.json({ status: 'incomplete', output: [] });
  await assert.rejects(askModel(args), /did not complete/);
  args.fetchImpl = async () => new Response('unavailable', { status: 429 });
  await assert.rejects(askModel(args), /HTTP 429/);
});

test('configuration rejects remote HTTP and invalid usage ceilings', () => {
  assert.throws(() => loadSettings({ DBUSKER_SITE_URL: 'http://example.com' }), /HTTPS/);
  assert.throws(() => loadSettings({ DBUSKER_MAX_CALLS: 'NaN' }), /MAX_CALLS/);
  assert.throws(() => loadSettings({ DBUSKER_MODEL: 'unreviewed-model' }), /routing.json/);
});

test('model failures classify safe diagnostics without leaking provider bodies or retrying', async () => {
  const args = { apiKey: 'not-a-key', model: 'offline', instructions: '', sources: [],
    messages: [{ role: 'user', content: 'public question' }] };
  for (const [code, response] of [
    ['provider_http', () => new Response('PRIVATE provider billing detail', { status: 429 })],
    ['provider_json', () => new Response('PRIVATE non-JSON body')],
    ['provider_json', () => Response.json(null)],
    ['output_limit', () => Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })],
    ['incomplete', () => Response.json({ status: 'failed' })],
    ['refusal', () => Response.json({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'refusal', refusal: 'PRIVATE refusal text' }] }] })],
    ['answer_json', () => Response.json({ status: 'completed', output: [] })],
    ['answer_json', () => Response.json({ status: 'completed', output: 'PRIVATE malformed output' })],
    ['evidence_validation', () => Response.json({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: 'null' }] }] })],
    ['transport', () => { throw new Error('PRIVATE network detail'); }],
  ]) {
    let calls = 0;
    await assert.rejects(askModel({ ...args, fetchImpl: async () => { calls++; return response(); } }),
      error => error instanceof ModelFailure && error.status === 503 && error.code === code &&
        error.message.includes(`[model:${code}]`) && !error.message.includes('PRIVATE'), code);
    assert.equal(calls, 1, code);
  }
  const controller = new AbortController();
  const reason = new Error('visitor cancelled');
  controller.abort(reason);
  await assert.rejects(askModel({ ...args, signal: controller.signal,
    fetchImpl: async () => { throw reason; } }), error => error === reason);
});

test('safe model errors reach the visitor and logs while the failed Efficient call stays budgeted', async t => {
  const f = await fixture(t, { modelCall: async () => { throw new ModelFailure('output_limit'); } });
  const session = await f.login();
  const result = await f.request('/chat', { message: 'DVert campaigns', consent: true, mode: 'efficient' }, session.token);
  assert.equal(result.status, 503);
  assert.match(result.body.error, /\[model:output_limit\]/);
  assert.match(f.logs.at(-1), /\[model:output_limit\]/);
  const state = readState(f.settings.stateFile);
  assert.equal(state.calls, 1);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].mode, 'efficient');
  assert.equal(state.rows[0].outcome, 'error');
});

function candidate(input, review = 'ready') {
  const { text: _text, ...source } = input.sources[0];
  return { answer: review === 'needs_deeper_review' ? 'PRIVATE UNCHECKED DRAFT' : 'Checked playlist guidance',
    abstained: review === 'insufficient_evidence', review, sources: [source],
    usage: { inputTokens: 25, outputTokens: 15 } };
}

function readState(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { calls: db.prepare('SELECT calls FROM budget WHERE id=1').get().calls,
      rows: db.prepare('SELECT * FROM route_totals').all() };
  } finally { db.close(); }
}

test('Balanced revisits its own draft exactly once and publishes only the checked final answer', async t => {
  const inputs = [];
  const f = await fixture(t, { modelCall: async input => {
    inputs.push(input);
    return candidate(input, inputs.length === 1 ? 'needs_deeper_review' : 'ready');
  } });
  const session = await f.login();
  const response = await f.request('/chat', { message: 'Where is the playlist tutorial?', consent: true, mode: 'balanced' }, session.token);
  assert.equal(response.status, 200);
  assert.deepEqual(inputs.map(input => input.model), [readHandoff().routing.models.light, readHandoff().routing.models.standard]);
  assert.equal(inputs[0].draft, undefined);
  assert.equal(inputs[1].draft.answer, 'PRIVATE UNCHECKED DRAFT');
  assert.equal(response.body.answer, 'Checked playlist guidance');
  assert.equal(response.body.routing.attempts, 2);
  assert.equal(response.body.routing.escalation, 'used');
  assert.equal(response.body.usage, undefined);
  const state = readState(f.settings.stateFile);
  assert.equal(state.calls, 2);
  assert.equal(state.rows.reduce((sum, row) => sum + row.input_tokens, 0), 50);
  assert.ok(!JSON.stringify(state).includes('PRIVATE UNCHECKED DRAFT'));
  assert.ok(!JSON.stringify(state).includes('playlist tutorial'));
  assert.ok(!JSON.stringify(state).toLowerCase().includes(f.wallet.address.toLowerCase()));
  await f.request('/chat', { message: 'How does that work?', consent: true }, session.token);
  assert.ok(!JSON.stringify(inputs[2].messages).includes('PRIVATE UNCHECKED DRAFT'));
});

test('recursion stops after two passes even when both ask for deeper review', async t => {
  let count = 0;
  const f = await fixture(t, { modelCall: async input => { count++; return candidate(input, 'needs_deeper_review'); } });
  const session = await f.login();
  const response = await f.request('/chat', { message: 'How do playlists work?', consent: true }, session.token);
  assert.equal(response.status, 200);
  assert.equal(count, 2);
  assert.equal(response.body.abstained, true);
  assert.ok(!response.body.answer.includes('PRIVATE UNCHECKED DRAFT'));
  assert.deepEqual(response.body.sources, []);
});

test('Efficient and Deep dive make only one pass and do not silently escalate', async t => {
  const inputs = [];
  const f = await fixture(t, { modelCall: async input => { inputs.push(input); return candidate(input, 'needs_deeper_review'); } });
  const session = await f.login();
  for (const mode of ['efficient', 'deep']) {
    const response = await f.request('/chat', { message: 'How do playlists work?', consent: true, mode }, session.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.routing.attempts, 1);
    assert.equal(response.body.routing.escalation, 'mode_limit');
    assert.equal(response.body.abstained, true);
  }
  assert.deepEqual(inputs.map(input => input.model), [readHandoff().routing.models.light, readHandoff().routing.models.deep]);
});

test('missing evidence costs no provider call; invalid modes cannot select arbitrary models', async t => {
  const f = await fixture(t);
  const session = await f.login();
  const response = await f.request('/chat', { message: 'zyxqv987654321', consent: true }, session.token);
  assert.equal(response.status, 200);
  assert.equal(response.body.abstained, true);
  assert.equal(response.body.routing.attempts, 0);
  for (const mode of [null, 'unlimited', { model: 'anything' }]) {
    assert.equal((await f.request('/chat', { message: 'How do playlists work?', consent: true, mode }, session.token)).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(readState(f.settings.stateFile).calls, 0);
});

test('insufficient evidence verdicts do not buy a second model pass', async t => {
  let count = 0;
  const f = await fixture(t, { modelCall: async input => { count++; return candidate(input, 'insufficient_evidence'); } });
  const session = await f.login();
  const response = await f.request('/chat', { message: 'How do playlists work?', consent: true }, session.token);
  assert.equal(response.status, 200);
  assert.equal(count, 1);
  assert.equal(response.body.abstained, true);
});

test('the real request path includes reviewed founder guidance for aliases and follow-ups, with valid public evidence', async t => {
  const inputs = [];
  const f = await fixture(t, { modelCall: async input => {
    inputs.push(input);
    return candidate(input);
  } });
  const session = await f.login();
  for (const message of ['Who is jollyEast?', 'And what still depends on him?']) {
    const response = await f.request('/chat', { message, consent: true }, session.token);
    assert.equal(response.status, 200);
  }
  for (const input of inputs) {
    assert.ok(input.instructions.includes(readHandoff().stewardship));
    assert.ok(input.sources.some(source => source.file === 'NOTICE'));
    assert.ok(input.sources.some(source => source.file === 'docs/PAYROLL.md'));
    assert.ok(Buffer.byteLength(JSON.stringify(modelContext(input))) <= 28000);
  }
});

test('multisig self-review starts deep, retains the server-signature blocker and exposes no execution tools', async t => {
  const inputs = [];
  const f = await fixture(t, { modelCall: async input => {
    inputs.push(input);
    return candidate(input, inputs.length === 1 ? 'needs_deeper_review' : 'ready');
  } });
  const session = await f.login();
  const response = await f.request('/chat', {
    message: 'Can we multisig the whole thing so it no longer depends on Jolly?', consent: true,
  }, session.token);
  assert.equal(response.status, 200);
  assert.equal(inputs.length, 1, 'Sensitive task starts at the deepest tier; no recursive call above the ceiling');
  assert.equal(response.body.abstained, true);
  assert.equal(response.body.routing.task, 'sensitive');
  assert.ok(inputs[0].instructions.includes('not a checkbox'));
  assert.ok(inputs[0].sources.some(source => source.text.includes('Only the owner wallet may manage live bookings')));
  assert.equal(inputs[0].tools, undefined);
});

test('every recursive pass reserves the durable budget and cannot return an unchecked draft on exhaustion', async t => {
  let count = 0;
  const f = await fixture(t, { settings: { maxCalls: 1 }, modelCall: async input => { count++; return candidate(input, 'needs_deeper_review'); } });
  const session = await f.login();
  const response = await f.request('/chat', { message: 'How do playlists work?', consent: true }, session.token);
  assert.equal(response.status, 429);
  assert.equal(count, 1);
  assert.match(response.body.error, /budget/);
  assert.equal(response.body.answer, undefined);
  assert.equal(readState(f.settings.stateFile).calls, 1);
});

test('provider failures are recorded in aggregate without retries, error text or prompt persistence', async t => {
  let count = 0;
  const f = await fixture(t, { modelCall: async () => { count++; throw new Error('PRIVATE PROVIDER FAILURE'); } });
  const session = await f.login();
  const response = await f.request('/chat', { message: 'my PRIVATE QUESTION about playlists', consent: true }, session.token);
  assert.equal(response.status, 503);
  assert.equal(count, 1);
  const state = readState(f.settings.stateFile);
  assert.equal(state.calls, 1);
  assert.equal(state.rows[0].outcome, 'error');
  assert.equal(state.rows[0].usage_missing, 1);
  assert.ok(!JSON.stringify(state).includes('PRIVATE'));
  assert.ok(!f.logs.join('\n').includes('PRIVATE'));
});

test('a pause between recursive passes denies the next provider request', async t => {
  let f, count = 0;
  f = await fixture(t, { modelCall: async input => {
    count++;
    f.access({ enabled: false, wallets: [f.wallet.address] });
    return candidate(input, 'needs_deeper_review');
  } });
  const session = await f.login();
  const response = await f.request('/chat', { message: 'How do playlists work?', consent: true }, session.token);
  assert.equal(response.status, 503);
  assert.equal(count, 1);
});

test('the 20-call session ceiling counts both passes, not just visitor messages', async t => {
  let count = 0;
  const f = await fixture(t, { modelCall: async input => { count++; return candidate(input, 'needs_deeper_review'); } });
  const session = await f.login();
  for (let index = 0; index < 9; index++) {
    f.advance(10000);
    const response = await f.request('/chat', { message: 'How do playlists work?', consent: true }, session.token);
    assert.equal(response.status, 200);
  }
  f.advance(60000);
  assert.equal((await f.request('/chat', { message: 'How do playlists work?', consent: true, mode: 'efficient' }, session.token)).status, 200);
  const response = await f.request('/chat', { message: 'How do playlists work?', consent: true }, session.token);
  assert.equal(response.status, 429);
  assert.match(response.body.error, /session.*provider-call/i);
  assert.equal(count, 20);
  assert.equal(readState(f.settings.stateFile).calls, 20);
});
