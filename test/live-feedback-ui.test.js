const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const ethers = require('../discord-bot/node_modules/ethers');

const START = Date.parse('2026-11-20T20:00:00Z');
const END = START + 20 * 60_000;
const ORIGIN = 'https://radio.example';
const WALLET = `0x${'12'.repeat(20)}`;

function show(time, changes = {}) {
  return {
    configured: true, phase: 'live', armed: true, bookingId: 'show-a',
    serverTime: time, startUtc: new Date(START).toISOString(), endUtc: new Date(END).toISOString(),
    performer: { wallet: WALLET }, bookingVerification: { fresh: true, verifiedAt: time },
    policy: { mode: 'live', bookingId: 'show-a' }, status: 'RECONNECTING', broadcast: null,
    ...changes,
  };
}

class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this._text = '';
    this.classList = { add: name => { this.className += ` ${name}`; } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  dispatch(type) { for (const callback of this.listeners[type] || []) callback({ type, target: this }); }
  append(...children) {
    for (const child of children) { child.parentNode = this; this.children.push(child); }
  }
  prepend(...children) {
    for (const child of children.reverse()) { child.parentNode = this; this.children.unshift(child); }
  }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

function documentFixture() {
  const document = {
    createElement: tag => new Element(tag, document),
    createTextNode: text => { const node = new Element('#text', document); node.textContent = text; return node; },
  };
  return { document, root: document.createElement('section') };
}

function findClass(root, name) {
  if (root.className.split(/\s+/).includes(name)) return root;
  for (const child of root.children) {
    const found = findClass(child, name);
    if (found) return found;
  }
  return null;
}

function timersFixture() {
  let next = 0;
  const intervals = new Map(), timeouts = new Map();
  return {
    setInterval(callback) { const id = ++next; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { const id = ++next; timeouts.set(id, callback); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    get active() { return intervals.size + timeouts.size; },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for feedback fixture');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('listener controls submit anonymous allowlisted signals and fail closed on stale or changed shows', async () => {
  const { createLiveFeedbackControl } = await import('../js/live-feedback.mjs');
  const { root } = documentFixture(), clock = { at: START + 10_000 }, calls = [];
  let reply = { status: 200, body: { ok: true, signal: 'applause', bookingId: 'show-a', nextAllowedInMs: 2000 } };
  const control = createLiveFeedbackControl({
    root, serviceUrl: 'https://service.example/', clientId: 'anonymous_listener_1', now: () => clock.at,
    timeoutSignal: () => undefined,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: reply.status === 200, status: reply.status, json: async () => reply.body, headers: new Map() };
    },
  });
  assert.equal(root.hidden, true);
  control.update(show(clock.at));
  const buttons = root.children[0].children;
  assert.equal(buttons.length, 4);
  assert.ok(buttons.every(button => button.attributes['aria-label'] && !button.disabled));
  assert.equal(await control.send('applause'), 'sent');
  assert.equal(calls[0].url, 'https://service.example/api/live-audio/feedback');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    signal: 'applause', bookingId: 'show-a', clientId: 'anonymous_listener_1',
  });
  assert.equal(calls[0].options.credentials, 'omit');
  assert.match(root.textContent, /accepted.*connection/i);
  assert.equal(await control.send('love'), 'ignored');
  clock.at += 2000;
  control.update(show(clock.at));
  reply = { status: 429, body: { retryAfterMs: 15_000 } };
  assert.equal(await control.send('love'), 'limited');
  assert.match(root.textContent, /too many/i);
  assert.equal(await control.send('audio-problem'), 'ignored');
  clock.at += 15_000;
  control.update(show(clock.at));
  reply = { status: 503, body: {} };
  assert.equal(await control.send('audio-problem'), 'unavailable');
  assert.match(root.textContent, /unavailable/i);
  control.update(null, { unavailable: true });
  assert.equal(root.hidden, false);
  assert.ok(buttons.every(button => button.disabled));
  assert.match(root.textContent, /disconnected/i);
  assert.equal(await control.send('encore'), 'ignored');
  control.update(show(clock.at, { bookingVerification: { fresh: false, verifiedAt: clock.at } }));
  assert.equal(root.hidden, false);
  assert.ok(buttons.every(button => button.disabled));
  control.update(show(clock.at));
  control.setMode('archive');
  assert.equal(root.hidden, true);
  assert.equal(await control.send('applause'), 'ignored');
  control.setMode('radio');
  clock.at = END;
  control.tick();
  assert.equal(root.hidden, true);
  control.dispose();
});

test('room reader baselines old events and recovers new verified tip notices without replay', async t => {
  const [{ createLiveFeedbackReader }, { createLiveFeedback }] = await Promise.all([
    import('../js/live-feedback.mjs'), import('../discord-bot/live-feedback.js'),
  ]);
  const clock = { at: START + 10_000 }, views = [], tips = { ready: false, entries: [] };
  let currentBooking = 'show-a', failure = null;
  const feedback = createLiveFeedback({
    now: () => clock.at, resolveState: () => show(clock.at, {
      bookingId: currentBooking, policy: { mode: 'live', bookingId: currentBooking },
    }),
    readLiveTips: () => tips.ready ? { ready: true, complete: false, count: tips.entries.length,
      totalWei: String(tips.entries.reduce((total, entry) => total + BigInt(entry.amountWei), 0n)),
      checkedAt: new Date(clock.at).toISOString(), entries: tips.entries } : { ready: false },
  });
  t.after(() => feedback.close());
  feedback.submit({ signal: 'applause', bookingId: 'show-a', clientId: 'anonymous_listener_1' }, { peer: '192.0.2.1' });
  const reader = createLiveFeedbackReader({
    serviceUrl: 'https://service.example', bookingId: 'show-a', now: () => clock.at,
    request: async () => { if (failure) throw failure; return feedback.snapshot('show-a'); },
    onChange: view => views.push(view),
  });
  t.after(() => reader.dispose());
  reader.setSession({ token: 'test-pass', expiresAt: END, state: { bookingId: 'show-a' } });
  await waitFor(() => views.at(-1)?.snapshot);
  assert.equal(views.at(-1).snapshot.windows.short.counts.applause, 1);
  assert.deepEqual(views.at(-1).notices, []);
  clock.at += 2000;
  feedback.submit({ signal: 'love', bookingId: 'show-a', clientId: 'anonymous_listener_1' }, { peer: '192.0.2.1' });
  tips.ready = true;
  tips.entries = [
    { eventKey: 'old-tip', amountWei: '1', paidAt: clock.at - 3000 },
    { eventKey: 'new-tip', amountWei: '100000000000000000', paidAt: clock.at - 1000 },
  ];
  await reader.refresh();
  assert.deepEqual(views.at(-1).notices, [
    { kind: 'love' }, { kind: 'tip', amountWei: '100000000000000000' },
  ]);
  assert.equal(views.at(-1).snapshot.tips.complete, false);
  await reader.refresh();
  assert.deepEqual(views.at(-1).notices, [], 'unchanged snapshots do not replay events or tips');
  clock.at += 9001;
  reader.tick();
  assert.equal(views.at(-1).fresh, false);
  await waitFor(() => views.at(-1).fresh);
  failure = Object.assign(new Error('offline'), { status: 503 });
  await reader.refresh();
  assert.equal(views.at(-1).snapshot, null);
  assert.match(views.at(-1).message, /unavailable.*audio controls/i);
  failure = Object.assign(new Error('expired'), { status: 401 });
  await reader.refresh();
  assert.equal(views.at(-1).session, false);
  assert.match(views.at(-1).message, /pass ended/i);
  reader.setSession({ token: 'other', expiresAt: END, state: { bookingId: 'show-b' } });
  assert.equal(views.at(-1).session, false);
  assert.match(views.at(-1).message, /another booking/i);
  failure = null;
  reader.setSession({ token: 'new-pass', expiresAt: END, state: { bookingId: 'show-a' } });
  await waitFor(() => views.at(-1)?.snapshot);
  currentBooking = 'show-b';
  await reader.refresh();
  assert.equal(views.at(-1).snapshot.active, false);
  assert.deepEqual(views.at(-1).notices, []);
});

test('room effects are bounded, optional and isolated from direction controls', async t => {
  const [{ bindLiveFeedbackRoom, bindTogether }, { createLiveFeedback }] = await Promise.all([
    import('../js/live-feedback.mjs'), import('../discord-bot/live-feedback.js'),
  ]);
  const clock = { at: START + 10_000 }, timers = timersFixture(), { document, root } = documentFixture();
  const stageRoot = document.createElement('div');
  const feedback = createLiveFeedback({ now: () => clock.at, resolveState: () => show(clock.at) });
  t.after(() => feedback.close());
  const panel = bindLiveFeedbackRoom({ container: root, stageContainer: stageRoot, bookingId: 'show-a', performer: true, environment: timers,
    now: () => clock.at, request: async () => feedback.snapshot('show-a') });
  assert.equal(stageRoot.hidden, true);
  panel.setSession({ token: 'test-pass', expiresAt: END, state: { bookingId: 'show-a' } });
  await waitFor(() => root.textContent.includes('Anonymous signals received'));
  assert.equal(stageRoot.hidden, false);
  for (let index = 0; index < 8; index++) {
    feedback.submit({ signal: 'encore', bookingId: 'show-a', clientId: `anonymous_listener_${index}` }, { peer: '192.0.2.1' });
  }
  clock.at += 3000;
  timers.tick();
  const stage = findClass(stageRoot, 'feedback-stage'), toggle = findClass(stageRoot, 'feedback-toggle').children[0];
  await waitFor(() => stage.children.length === 4);
  assert.equal(stage.attributes['aria-hidden'], 'true');
  assert.match(root.textContent, /advisory.*do not prove/i);
  toggle.checked = false;
  toggle.dispatch('change');
  assert.equal(stage.children.length, 0);
  panel.setSession(null);
  assert.equal(stageRoot.hidden, true);
  let sessions = 0, disposed = 0;
  const primary = { setSession() { sessions++; }, dispose() { disposed++; } };
  const warning = console.warn;
  console.warn = () => {};
  try {
    const combined = bindTogether(primary, { setSession() { throw Error('feedback failed'); },
      dispose() { throw Error('feedback failed'); } });
    combined.setSession({});
    combined.dispose();
    assert.equal(sessions, 1);
    assert.equal(disposed, 1);
  } finally { console.warn = warning; }
  panel.dispose();
  assert.equal(timers.active, 0);
  assert.equal(stageRoot.children.length, 0);
});

test('compact tip notices avoid clipping and retain exact confirmed amounts in the panel', async t => {
  const [{ bindLiveFeedbackRoom, formatFeedbackWei }, { createLiveFeedback }] = await Promise.all([
    import('../js/live-feedback.mjs'), import('../discord-bot/live-feedback.js'),
  ]);
  const clock = { at: START + 10_000 }, timers = timersFixture(), { document, root } = documentFixture();
  const createElement = document.createElement;
  let narrow = false;
  document.createElement = tag => {
    const node = createElement(tag);
    if (tag === 'span') {
      node.clientWidth = 100;
      node.clientHeight = 56;
      Object.defineProperty(node, 'scrollWidth', { get: () => narrow && node.textContent.startsWith('Tip ·') ? 101 : 100 });
      node.scrollHeight = 56;
    }
    return node;
  };
  const stageRoot = document.createElement('div'), entries = [];
  const feedback = createLiveFeedback({ now: () => clock.at, resolveState: () => show(clock.at),
    readLiveTips: () => ({ ready: true, complete: true, count: entries.length,
      totalWei: entries.reduce((sum, entry) => sum + BigInt(entry.amountWei), 0n).toString(),
      checkedAt: new Date(clock.at).toISOString(), entries }) });
  const panel = bindLiveFeedbackRoom({ container: root, stageContainer: stageRoot, bookingId: 'show-a', performer: true,
    environment: timers, now: () => clock.at, request: async () => feedback.snapshot('show-a') });
  t.after(() => { panel.dispose(); feedback.close(); });
  panel.setSession({ token: 'test-pass', expiresAt: END, state: { bookingId: 'show-a' } });
  await waitFor(() => root.textContent.includes('Anonymous signals received'));
  const stage = findClass(stageRoot, 'feedback-stage');

  clock.at += 3000;
  const precise = '123456789012345678';
  entries.push({ eventKey: 'precise-tip', amountWei: precise, paidAt: clock.at });
  timers.tick();
  await waitFor(() => stage.children.length === 1);
  assert.equal(stage.children[0].textContent, 'Tip · 0.123456789012345678 ETH');
  assert.match(root.textContent, /Latest confirmed tip: 0\.123456789012345678 ETH/);

  clock.at += 3000;
  const large = '1'.repeat(78);
  entries.push({ eventKey: 'large-tip', amountWei: large, paidAt: clock.at });
  timers.tick();
  await waitFor(() => stage.children.length === 2);
  assert.equal(stage.children[0].textContent, 'Tip received');
  assert.ok(root.textContent.includes(`Latest confirmed tip: ${formatFeedbackWei(large)} ETH.`));

  clock.at += 3000;
  narrow = true;
  entries.push({ eventKey: 'narrow-tip', amountWei: '100000000000000000', paidAt: clock.at });
  timers.tick();
  await waitFor(() => stage.children.length === 3);
  assert.equal(stage.children[0].textContent, 'Tip received');
  assert.match(root.textContent, /Latest confirmed tip: 0\.1 ETH/);
});

test('live listener HTTP signals and confirmed tips reach the authorized performer and operator rooms', async t => {
  const [{ createLiveFeedbackControl, bindLiveFeedbackRoom }, { createLiveFeedback, handleLiveFeedbackRequest },
    { createLiveAudioService }, { handleLiveAudioRequest }, { createTipLedger }, { TIP_ABI }, { roomRequest }] =
    await Promise.all([
      import('../js/live-feedback.mjs'), import('../discord-bot/live-feedback.js'),
      import('../discord-bot/live-audio.js'), import('../discord-bot/live-audio-http.js'),
      import('../discord-bot/tip-ledger.js'), import('../js/tip-protocol.mjs'), import('../js/live-audio-client.mjs'),
    ]);
  const clock = { at: START + 10_000 }, artist = ethers.Wallet.createRandom(), owner = ethers.Wallet.createRandom();
  const sender = `0x${'34'.repeat(20)}`, router = `0x${'56'.repeat(20)}`, iface = new ethers.Interface(TIP_ABI);
  const chain = { head: 3, logs: [], receipts: new Map() };
  const block = number => ({ hash: ethers.id(`fixture-block:${number}`), timestamp: START / 1000 + number });
  const provider = {
    getNetwork: async () => ({ chainId: 8453n }), getCode: async (_address, at) => at === 0 ? '0x' : '0x01',
    getBlockNumber: async () => chain.head, getBlock: async number => block(number),
    getTransactionReceipt: async hash => chain.receipts.get(hash),
    getLogs: async ({ fromBlock, toBlock }) => chain.logs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock),
  };
  const addTip = (name, blockNumber, amount, to = artist.address, bookingId = 'show-a') => {
    const hash = ethers.id(name), context = `decentbusking:live:${bookingId}`;
    const encoded = iface.encodeEventLog('TipSent', [sender, to, ethers.id(context), 0, amount, context]);
    const log = { ...encoded, address: router, index: 0, transactionHash: hash, blockNumber };
    chain.logs.push(log);
    chain.receipts.set(hash, { status: 1, hash, blockNumber, blockHash: block(blockNumber).hash, logs: [log] });
    return log;
  };
  const ledger = createTipLedger({ provider, routerAddress: router, startBlock: 1, now: () => clock.at,
    resolveContext: async () => ({ status: 'verified', label: 'Show' }), save: async () => 'ipfs://fixture' });
  await ledger.initialize();
  const booking = { id: 'show-a', wallet: artist.address, eventId: 'event-a', title: 'Fixture show',
    startUtc: new Date(START).toISOString(), endUtc: new Date(END).toISOString(),
    status: 'funded', acknowledged: true, payoutPolicy: 'pilot-guaranteed-v1', amountUnits: '20000000' };
  let persisted = { version: 1, rooms: [{ bookingId: booking.id, armed: true,
    checks: { t60: new Date(START - 60 * 60_000).toISOString(), t15: new Date(START - 15 * 60_000).toISOString() },
    lastVerifiedAt: clock.at }] };
  const transport = { ready: true, ingressEnabled: true, monitor: async () => {}, stop: async () => {} };
  let service;
  const feedback = createLiveFeedback({ now: () => clock.at, resolveState: () => service.feedbackState(),
    readLiveTips: scope => ledger.getLiveTips(scope) });
  service = createLiveAudioService({ ownerWallet: owner.address, getBookings: async () => ({ bookings: [booking] }),
    transport, feedback, now: () => clock.at, store: {
      restore: async () => structuredClone(persisted),
      save: async value => { persisted = structuredClone(value); },
    } });
  const authorize = async wallet => {
    const challenge = await service.challenge({ bookingId: booking.id, wallet: wallet.address }, ORIGIN);
    return service.authorize({ challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message) }, ORIGIN);
  };
  const performerPass = await authorize(artist), ownerPass = await authorize(owner);
  const before = structuredClone(persisted);
  const server = http.createServer((request, response) => {
    const handler = request.url === '/api/live-audio/feedback'
      ? handleLiveFeedbackRequest(request, response, { feedback, allowedOrigins: [ORIGIN] })
      : handleLiveAudioRequest(request, response, { service, allowedOrigins: [ORIGIN] });
    void handler.catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    feedback.close();
    await service.stop();
  });
  const serviceUrl = `http://127.0.0.1:${server.address().port}`;
  const withOrigin = (url, options) => fetch(url, { ...options, headers: { ...options.headers, origin: ORIGIN } });
  const request = (url, path, input, token) => roomRequest(url, path, input, token, withOrigin);
  await assert.rejects(request(serviceUrl, 'control', { action: 'feedback-snapshot' }),
    error => error.status === 401);
  const timers = timersFixture(), performerDocument = documentFixture(), performerRoot = performerDocument.root;
  const performerStageRoot = performerDocument.document.createElement('div'), operatorRoot = documentFixture().root;
  const performer = bindLiveFeedbackRoom({ container: performerRoot, serviceUrl, bookingId: booking.id,
    stageContainer: performerStageRoot, performer: true, environment: timers, request, now: () => clock.at });
  const operator = bindLiveFeedbackRoom({ container: operatorRoot, serviceUrl, bookingId: booking.id,
    environment: timers, request, now: () => clock.at });
  performer.setSession(performerPass);
  operator.setSession(ownerPass);
  t.after(() => { performer.dispose(); operator.dispose(); });
  await waitFor(() => performerRoot.textContent.includes('Anonymous signals received') &&
    operatorRoot.textContent.includes('Anonymous signals received'));
  const listenerRoot = documentFixture().root;
  const listener = createLiveFeedbackControl({ root: listenerRoot, serviceUrl, fetchImpl: withOrigin,
    clientId: 'anonymous_listener_1', now: () => clock.at, timeoutSignal: () => undefined });
  t.after(() => listener.dispose());
  listener.update(service.feedbackState());
  assert.equal(await listener.send('applause'), 'sent');
  const good = addTip('confirmed-tip', 11, 100000000000000000n);
  chain.logs.push(good);
  addTip('pending-tip', 12, 7n);
  addTip('wrong-recipient', 11, 9n, owner.address);
  addTip('wrong-booking', 11, 9n, artist.address, 'other');
  chain.head = 12;
  clock.at = START + 13_000;
  await ledger.compare();
  timers.tick();
  const performerStage = findClass(performerStageRoot, 'feedback-stage');
  const operatorStage = findClass(operatorRoot, 'feedback-stage');
  await waitFor(() => performerStage.children.length === 2);
  assert.equal(performerStageRoot.hidden, false);
  assert.match(performerStage.children[0].textContent, /^Tip ·/, 'a tip stays visible ahead of reactions');
  assert.match(performerStage.textContent, /Tip · 0\.1 ETH/);
  assert.match(performerRoot.textContent, /verified tips: 0\.1 ETH · 1 confirmed/i);
  assert.match(operatorRoot.textContent, /verified tips: 0\.1 ETH · 1 confirmed/i);
  assert.equal(operatorStage.hidden, true);
  assert.equal(operatorStage.children.length, 0);
  assert.deepEqual(persisted, before, 'advisory feedback does not modify broadcast or payment state');
  clock.at += 3000;
  chain.head = 13;
  await ledger.compare();
  timers.tick();
  await waitFor(() => performerRoot.textContent.includes('2 confirmed'));
  assert.equal(performerStage.children.length, 3, 'a newly confirmed tip appears once');
  clock.at += 3000;
  timers.tick();
  await waitFor(() => operatorRoot.textContent.includes('2 confirmed'));
  assert.equal(performerStage.children.length, 3, 'polling cannot replay the same notices');
});
