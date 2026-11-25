const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modules = Promise.all([
  import('../js/live-audio.mjs'),
  import('../js/live-performance-profile.mjs'),
  import('../js/live-performance-admin.mjs'),
]);
const wallet = '0x' + '11'.repeat(20);
const otherWallet = '0x' + '22'.repeat(20);
const NOW = Date.parse('2026-11-14T01:00:00Z');
const booking = () => ({
  id: 'pilot:encoded /?&"\'<booking>', eventId: 'friday-live-performance:2026-11-13',
  title: 'Pilot fixture', displayName: 'Fixture performer', wallet, mode: 'phase1',
  payoutPolicy: 'pilot-guaranteed-v1', airtimeMinutes: 20, status: 'funded', acknowledged: true,
  startUtc: '2026-11-14T02:00:00Z', endUtc: '2026-11-14T02:20:00Z',
  claimDeadline: '2026-11-18T02:20:00Z', reviewWindow: 86400, amountUnits: '20000000',
  additionalOffer: 'Separate offer <not markup>', transactions: {},
});

function dom(t) {
  const saved = new Map(['document', 'window', 'localStorage'].map(key => [key, global[key]]));
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  });
  const createElement = tag => ({
    tag, children: [], attributes: {}, textContent: '', innerHTML: '',
    append(...children) { this.children.push(...children); },
    prepend(...children) { this.children.unshift(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, callback) { this.listeners ||= {}; this.listeners[name] = callback; },
    style: { setProperty() {} },
    remove() { this.removed = true; },
  });
  global.document = { createElement, body: createElement('body'), createTextNode: text => ({ textContent: text }), dispatchEvent() {} };
  global.window = { _wallet: { address: wallet }, setTimeout() { return 1; }, clearTimeout() {}, addEventListener() {}, removeEventListener() {} };
  global.localStorage = { getItem: () => null };
  return createElement;
}
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];

test('backstage waits for a slow booking lookup and reports an exhausted deadline explicitly', async t => {
  const { runInNewContext } = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../js/live-audio-room.mjs'), 'utf8');
  const refreshSource = source.slice(source.indexOf('async function refreshBooking()'),
    source.indexOf("byId('room-authorize').onclick"));
  for (const delay of [15000, 61000]) {
    await t.test(`booking response after ${delay}ms`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const nodes = new Map(), messages = [];
      const b = { ...booking(), stewardApproved: true };
      const context = {
        refreshing: false, disposed: false, bookingId: b.id, serviceUrl: 'https://worker.example',
        booking: null, session: null, broadcastState: null, observedAt: 0, practiceMode: false, actionPending: false,
        Date: { now: () => NOW, parse: Date.parse },
        AbortSignal: { timeout(ms) {
          const controller = new AbortController();
          setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
          return controller.signal;
        } },
        byId(id) { if (!nodes.has(id)) nodes.set(id, { disabled: true }); return nodes.get(id); },
        status: message => messages.push(message), renderSign() {}, performerAllocationAccess: () => false,
        broadcastControls: { update() {} },
        fetch: async (url, { signal }) => {
          if (url.endsWith('/api/live-bookings')) await new Promise((resolve, reject) => {
            setTimeout(resolve, delay);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          return { ok: true, json: async () => url.endsWith('/api/live-bookings')
            ? { bookings: [b] } : { configured: true } };
        },
      };
      const loading = runInNewContext(`${refreshSource}\nrefreshBooking();`, context);
      t.mock.timers.tick(Math.min(delay, 60000));
      await loading;
      if (delay < 60000) {
        assert.equal(nodes.get('room-authorize').disabled, false);
        assert.equal(context.booking.id, b.id);
        assert.match(messages.at(-1), /Backstage is ready/);
      } else {
        assert.equal(nodes.get('room-authorize').disabled, true);
        assert.equal(context.booking, null);
        assert.match(messages.at(-1), /Booking verification timed out.*Retrying automatically/);
      }
    });
  }
});

test('cancelling a late first-check confirmation neither submits nor reports a saved check', async () => {
  const { runInNewContext } = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../js/live-audio-room.mjs'), 'utf8');
  const handlers = source.slice(source.indexOf("for (const [id, check] of [['room-check60'"),
    source.indexOf("byId('room-arm').onclick"));
  const nodes = new Map(), commands = [], saved = [];
  let confirmed = false;
  runInNewContext(handlers, {
    actionPending: false, broadcastState: { lateFirstCheckAllowed: true },
    remoteTrack: {}, audio: { paused: false }, window: { confirm: () => confirmed },
    byId(id) { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    command: async input => { commands.push(input); return {}; }, render() {},
    perform: (fn, _pending, success) => async () => { await fn(); saved.push(success); },
  });
  await nodes.get('room-check60').onclick({});
  assert.equal(commands.length, 0);
  assert.equal(saved.length, 0);
  confirmed = true;
  await nodes.get('room-check60').onclick({});
  assert.equal(commands.length, 1);
  assert.equal(commands[0].lateConfirmed, true);
  assert.equal(saved.length, 1);
});

test('ended ETH booking offers the Studio and a same-browser draft reminder without requiring payment', async t => {
  const [, { renderLivePerformances }] = await modules;
  const { recordingDraftKey } = await import('../js/live-recording-edit.mjs');
  const make = dom(t);
  const b = { ...booking(), id: 'asset:artist', escrowVersion: 'assets-v1', payoutPolicy: 'asset-guaranteed-v1',
    assetSymbol: 'ETH', assetDecimals: 18, amountUnits: '20000000000000000' };
  const key = recordingDraftKey(wallet, b.id, 'bafyexample');
  const otherKey = recordingDraftKey(otherWallet, b.id, 'bafyexample');
  const saved = new Map([[otherKey, JSON.stringify({ schema: 1, draft: { songs: [{}] } })]]);
  window.localStorage = { get length() { return saved.size; }, key: i => [...saved.keys()][i], getItem: k => saved.get(k) };
  const container = make('div');
  const render = () => renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example', bookingState: { bookings: [b] } });
  await render();
  const studio = () => descendants(container).filter(node => node.attributes?.['data-recording-edit'] === b.id).at(-1);
  assert.equal(studio().textContent, 'Review recording');
  assert.equal(studio().children[0].tag, 'img');
  saved.set(key, saved.get(otherKey));
  await render();
  assert.equal(studio().textContent, 'Resume recording edit');
  assert.ok(descendants(container).some(node => /does not affect your performance pay.*Long-form Hour/.test(node.textContent)));
});

test('asset fee shows the exact unlock time, a single claim action only when eligible, and no resend for pending or paid', async t => {
  const [, { renderLivePerformances }] = await modules;
  const make = dom(t);
  let now = Date.parse('2026-11-21T16:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const b = { ...booking(), id:'show-eth', startUtc:'2026-11-21T02:25:00Z', endUtc:'2026-11-21T02:45:00Z',
    escrowVersion:'assets-v1', payoutPolicy:'asset-guaranteed-v1', escrowAddress:otherWallet,
    assetDecimals:18, assetSymbol:'ETH', amountUnits:'20000000000000000' };
  const render = async (status, configured = true) => {
    const container = make('div');
    await renderLivePerformances({ container, wallet, serviceUrl:'worker',
      bookingState:{ bookings:[{ ...b, status }], assetEscrowAddress:otherWallet, assetEscrowConfigured:configured } });
    const nodes = descendants(container.children[0]);
    return { status:nodes.find(n => n.tag === 'output').textContent, buttons:nodes.filter(n => n.tag === 'button') };
  };
  const waiting = await render('funded');
  assert.match(waiting.status, /Funded, not paid\.\nClaim opens Nov 21, 2026, 9:45 PM ET.*producer approval/);
  assert.equal(waiting.buttons.length, 0);
  const ready = await render('approved');
  assert.deepEqual(ready.buttons.map(b => b.textContent), ['Claim 0.02 ETH']);
  assert.equal(ready.buttons[0].disabled, false);
  assert.equal(ready.buttons[0].children[0].tag, 'img');
  const unavailable = await render('funded', false);
  assert.match(unavailable.status, /unavailable/);
  assert.equal(unavailable.buttons.length, 0);
  now = Date.parse('2026-11-22T02:45:00Z');
  assert.equal((await render('funded')).buttons[0].textContent, 'Claim 0.02 ETH');
  localStorage.getItem = k => k === 'live-claim:show-eth' ? 'saved-hash' : null;
  assert.deepEqual((await render('approved')).buttons.map(b => b.textContent), ['Check pending claim']);
  const paid = await render('paid');
  assert.match(paid.status, /Paid to your booked wallet/);
  assert.equal(paid.buttons.length, 0);
});

test('audience feedback follows essential performer and operator audio controls', () => {
  const performer = fs.readFileSync(path.join(__dirname, '../live-room.html'), 'utf8');
  const producer = fs.readFileSync(path.join(__dirname, '../producer-room.html'), 'utf8');
  for (const id of ['room-publish', 'room-stop', 'room-monitor-toggle', 'room-monitor', 'room-arm', 'room-cancel']) {
    assert.ok(performer.indexOf(`id="${id}"`) < performer.indexOf('id="room-listener-signals"'), id);
  }
  assert.ok(performer.indexOf('id="room-publish"') < performer.indexOf('id="room-feedback-visuals"'));
  assert.ok(performer.indexOf('id="room-feedback-visuals"') < performer.indexOf('id="room-monitor-toggle"'));
  for (const id of ['desk-listen', 'desk-stop']) {
    assert.ok(producer.indexOf(`id="${id}"`) < producer.indexOf('id="desk-listener-signals"'), id);
  }
});

test('room links are encoded and offered only for eligible funded pilot bookings', async () => {
  const [{ liveAudioRoomUrl }] = await modules;
  const b = booking();
  const url = new URL(liveAudioRoomUrl(b, NOW), 'https://radio.example/');
  assert.equal(url.pathname, '/live-room.html');
  assert.equal(url.searchParams.get('booking'), b.id);
  assert.equal(url.searchParams.size, 1);
  assert.equal(liveAudioRoomUrl(b, Date.parse(b.startUtc)), liveAudioRoomUrl(b, NOW));
  assert.equal(liveAudioRoomUrl({ ...b, payoutPolicy:'asset-guaranteed-v1' }, NOW), liveAudioRoomUrl(b, NOW));
  for (const change of [
    { id: '' }, { mode: 'phase0' }, { payoutPolicy: undefined }, { status: 'draft' },
    { status: 'funding pending' }, { status: 'approved' }, { status: 'paid' },
    { acknowledged: false }, { cancelled: true }, { startUtc: 'invalid' }, { endUtc: 'invalid' },
  ]) assert.equal(liveAudioRoomUrl({ ...b, ...change }, NOW), null, JSON.stringify(change));
  assert.equal(liveAudioRoomUrl(b, Date.parse(b.endUtc)), null);
});

test('Profile renders a booking-specific performer entry without changing summaries, offers or claims', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section'), b = booking();
  t.mock.method(Date, 'now', () => NOW);
  const before = structuredClone(b), requests = [];
  await renderLivePerformances({
    container, wallet, serviceUrl: 'https://worker.example/',
    ethers: { BrowserProvider() { throw new Error('Rendering must not authorize or send a transaction'); } },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ escrowAddress: otherWallet, bookings: [
        b, { ...b, id: 'other-booking', wallet: otherWallet },
      ] }) };
    },
  });
  const nodes = descendants(container), links = nodes.filter(node => node.attributes?.['data-live-room']);
  assert.equal(links.length, 1);
  assert.equal(links[0].attributes['data-live-room'], 'performer');
  assert.equal(links[0].textContent, 'Open performer audio room');
  assert.equal(new URL(links[0].href, 'https://radio.example/').searchParams.get('booking'), b.id);
  assert.equal(links[0].onclick, undefined);
  assert.equal(links[0].target, undefined, 'same-tab navigation avoids a second simultaneous radio player');
  const notice = nodes.find(node => node.tag === 'small').textContent;
  assert.match(notice, /does not grant access.*booked performer wallet.*hosting may be unavailable/);
  assert.match(notice, /T−70.*Keep the room open/);
  assert.match(container.children[0].innerHTML, /Guaranteed pilot fee/);
  assert.match(container.children[0].innerHTML, /Separate offer &lt;not markup&gt;/);
  const claim = nodes.find(node => node.tag === 'button');
  assert.equal(claim.disabled, true);
  assert.match(claim.textContent, /Awaiting review/);
  assert.deepEqual(b, before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://worker.example/api/live-bookings');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('Profile omits room entries for unfunded, cancelled, ended and incompatible bookings', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => NOW);
  const b = booking();
  const bookings = [
    { ...b, status: 'funding pending' }, { ...b, cancelled: true },
    { ...b, endUtc: new Date(NOW).toISOString() }, { ...b, payoutPolicy: undefined },
  ];
  await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
    fetchImpl: async () => ({ ok: true, json: async () => ({ bookings, escrowAddress: otherWallet }) }) });
  assert.equal(descendants(container).filter(node => node.attributes?.['data-live-room']).length, 0);
  assert.equal(descendants(container).filter(node => node.tag === 'button').length, bookings.length);
});

const reentryTime = Date.parse('2026-11-14T02:25:00Z');
const allocatedBooking = (status = 'funded') => ({ ...booking(), status,
  ...(status === 'paid' ? { paidUnits: '20000000', transactions: {
    PerformancePaid: { hash: '0x' + 'ab'.repeat(32), blockNumber: 12345 },
  } } : {}),
  broadcastCompletion: { known: true, pending: true, actualEndedAt: null } });
const allocatedState = (b, phase = 'live') => ({
  bookingId: b.id, configured: true, serverTime: reentryTime,
  bookingVerification: { fresh: true, verifiedAt: reentryTime },
  phase: phase === 'waiting' ? 'preflight' : 'live',
  broadcast: { allocationId: 'fixture-allocation', revision: 2, phase,
    accessUntil: reentryTime + 40 * 60000 },
});

for (const status of ['funded', 'approved', 'paid']) {
  for (const phase of ['waiting', 'live']) {
    test(`Profile re-enters the verified ${phase} allocation after original end with ${status} fee status`, async t => {
      const [, { renderLivePerformances }] = await modules;
      const createElement = dom(t), container = createElement('section'), requests = [], receipts = [];
      t.mock.method(Date, 'now', () => reentryTime);
      const b = allocatedBooking(status), before = structuredClone(b);
      await renderLivePerformances({
        container, wallet, serviceUrl: 'https://worker.example/',
        bookingState: { bookings: [b, { ...b, id: 'other-booking', wallet: otherWallet }], escrowAddress: otherWallet },
        onReceipt: receipt => receipts.push(receipt),
        ethers: { BrowserProvider() { throw new Error('Rendering must not authorize'); } },
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          return { ok: true, json: async () => allocatedState(b, phase) };
        },
      });
      const nodes = descendants(container), text = nodes.map(node => node.textContent).join(' ');
      assert.equal(requests.length, 1, 'Only this wallet’s pending allocation is checked');
      const requested = new URL(requests[0].url);
      assert.equal(requested.pathname, '/api/live-audio/state');
      assert.equal(requested.searchParams.get('bookingId'), b.id);
      assert.equal(requests[0].options.cache, 'no-store');
      assert.ok(requests[0].options.signal instanceof AbortSignal);
      assert.match(nodes.find(node => node.tag === 'h3').textContent, /Return to your allocated backstage/);
      const link = nodes.find(node => node.attributes?.['data-live-room'] === 'performer');
      assert.equal(link.textContent, 'Return to allocated backstage');
      assert.equal(new URL(link.href, 'https://radio.example').searchParams.get('booking'), b.id);
      assert.equal(link.target, undefined);
      assert.match(text, /Original contract times and guaranteed fee are unchanged/);
      assert.doesNotMatch(text, /Your set is finished|Private checks open at T−70/);
      assert.match(text, /does not itself grant private access or prove public playback/);
      assert.match(text, /Never open a second publishing microphone/);
      assert.match(text, /Refresh stage & payment status/);
      if (status === 'paid') {
        assert.match(text, /Confirmed on-chain\. No payment action needed/);
        assert.equal(receipts.length, 1);
        assert.equal(receipts[0].transactions[0].hash, b.transactions.PerformancePaid.hash);
        assert.equal(receipts[0].units, 20000000n);
      }
      if (status === 'approved') assert.equal(nodes.find(node => node.tag === 'button' && /^Claim/.test(node.textContent)).disabled, false);
      assert.deepEqual(b, before, 'Neither contract times nor financial status are widened');
    });
  }
}

test('Profile resolves unknown allocated completion from exact fresh state, not invented extended dates', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => reentryTime);
  const b = { ...allocatedBooking(), broadcastCompletion: { known: false, pending: null } };
  await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
    bookingState: { bookings: [b], escrowAddress: otherWallet },
    fetchImpl: async () => ({ ok: true, json: async () => allocatedState(b, 'waiting') }) });
  assert.equal(descendants(container).filter(node => node.attributes?.['data-live-room']).length, 1);
  assert.equal(b.endUtc, booking().endUtc);
});

test('Profile never treats unavailable, stale, wrong-booking or expired allocation data as re-entry authority', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t);
  t.mock.method(Date, 'now', () => reentryTime);
  const b = allocatedBooking(), valid = allocatedState(b);
  const invalid = [
    { ...valid, bookingId: 'another-booking' },
    { ...valid, configured: false },
    { ...valid, bookingVerification: { fresh: false, verifiedAt: reentryTime } },
    { ...valid, bookingVerification: { fresh: true, verifiedAt: null } },
    { ...valid, bookingVerification: { fresh: true, verifiedAt: reentryTime - 30001 } },
    { ...valid, phase: 'unavailable' },
    { ...valid, broadcast: null },
    { ...valid, broadcast: { ...valid.broadcast, allocationId: null } },
    { ...valid, broadcast: { ...valid.broadcast, accessUntil: reentryTime } },
    { ...valid, broadcast: { ...valid.broadcast, accessUntil: Number.MAX_VALUE } },
    { ...valid, broadcast: { ...valid.broadcast, phase: 'unknown' } },
  ];
  for (const result of [...invalid, 'http-error', 'network-error']) {
    const container = createElement('section');
    await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [b], escrowAddress: otherWallet },
      fetchImpl: async () => {
        if (result === 'network-error') throw new Error('offline');
        return { ok: result !== 'http-error', json: async () => result };
      } });
    const nodes = descendants(container), text = nodes.map(node => node.textContent).join(' ');
    assert.equal(nodes.filter(node => node.attributes?.['data-live-room']).length, 0, JSON.stringify(result));
    assert.match(nodes.find(node => node.tag === 'h3').textContent, /Check your allocated stage status/);
    assert.doesNotMatch(text, /Your set is finished/);
    assert.match(text, /original guaranteed fee and claim rights are unchanged/);
  }
});

test('Profile terminal allocated states have no re-entry link and forced endings are not graceful success', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t);
  t.mock.method(Date, 'now', () => reentryTime);
  for (const endReason of ['producer-finished', 'operator-cut', 'authorization-expired', 'audio-loss', 'declined', 'not-ready', null]) {
    const container = createElement('section'), b = allocatedBooking();
    const state = { ...allocatedState(b), phase: 'ended',
      broadcast: { ...allocatedState(b).broadcast, phase: 'ended', endReason,
        actualStartedAt: reentryTime - 600000, actualEndedAt: reentryTime } };
    await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [b], escrowAddress: otherWallet },
      fetchImpl: async () => ({ ok: true, json: async () => state }) });
    const nodes = descendants(container), title = nodes.find(node => node.tag === 'h3').textContent;
    assert.equal(nodes.filter(node => node.attributes?.['data-live-room']).length, 0);
    assert.match(title, endReason === 'producer-finished' ? /Your set is finished/ : /original guaranteed fee unchanged/);
  }
});

test('Profile does not celebrate inconsistent, stale or wrong-booking successful-ending claims', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t);
  t.mock.method(Date, 'now', () => reentryTime);
  const b = allocatedBooking();
  const valid = { ...allocatedState(b), phase: 'ended', broadcast: {
    ...allocatedState(b).broadcast, phase: 'ended', endReason: 'producer-finished',
    actualStartedAt: reentryTime - 600000, actualEndedAt: reentryTime - 1000,
  } };
  for (const state of [
    { ...valid, bookingId: 'other' },
    { ...valid, bookingVerification: { fresh: false, verifiedAt: reentryTime } },
    { ...valid, bookingVerification: { fresh: true, verifiedAt: reentryTime - 30001 } },
    { ...valid, phase: 'cancelled' },
    { ...valid, broadcast: { ...valid.broadcast, phase: 'live' } },
    { ...valid, broadcast: { ...valid.broadcast, allocationId: null } },
    { ...valid, broadcast: { ...valid.broadcast, actualStartedAt: null } },
    { ...valid, broadcast: { ...valid.broadcast, actualEndedAt: null } },
    { ...valid, broadcast: { ...valid.broadcast, actualStartedAt: reentryTime } },
    { ...valid, broadcast: { ...valid.broadcast, actualEndedAt: reentryTime + 1 } },
  ]) {
    const container = createElement('section');
    const activate = await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [b], escrowAddress: otherWallet },
      fetchImpl: async () => ({ ok: true, json: async () => state }) });
    activate();
    const nodes = descendants(container);
    assert.equal(nodes.some(node => node.className === 'live-curtain-call'), false, JSON.stringify(state));
    assert.doesNotMatch(nodes.map(node => node.textContent).join(' '), /Your set is finished/);
  }
});

test('Profile release parties require the connected performer and a real minted recording playback', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => reentryTime);
  const release = { known: true, state: 'airing', trackId: 'exact-song', title: 'The exact released song',
    tokenId: '19', firstPlayId: 'verified-radio-start', firstStartedAt: reentryTime - 1000 };
  const b = { ...booking(), broadcastCompletion: { known: true, pending: false,
    actualEndedAt: reentryTime - 60000, endReason: 'audio-loss' },
    recordingRelease: { ...release, releases: [release] } };
  const render = async () => {
    container.children = [];
    const activate = await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [b], escrowAddress: otherWallet } });
    activate();
    return descendants(container);
  };
  let nodes = await render();
  assert.ok(nodes.some(node => node.className === 'live-release-party'));
  assert.ok(nodes.some(node => node.textContent === release.title));
  assert.equal(nodes.some(node => node.className === 'live-curtain-call'), false, 'a real partial release is not a successful show');
  global.window._wallet.address = otherWallet;
  nodes = await render();
  assert.equal(nodes.some(node => node.className === 'live-release-party'), false);
  global.window._wallet.address = wallet;
  b.recordingRelease = { ...release, state: 'minted', releases: [{ ...release, state: 'minted', firstPlayId: undefined }] };
  nodes = await render();
  assert.equal(nodes.some(node => node.className === 'live-release-party'), false, 'minting is not airing');
});

test('Profile shows a replayable curtain call only for the connected performer’s verified finish', async t => {
  const [, { renderLivePerformances }] = await modules;
  const model = await import('../js/live-afterparty.mjs?v=20261117-release-party');
  const createElement = dom(t), container = createElement('section'), storage = new Map(), events = [];
  t.mock.method(Date, 'now', () => Date.parse('2026-11-14T02:10:00Z'));
  global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  global.document.dispatchEvent = event => events.push(event);
  model.resetAfterpartyMilestones();
  t.after(() => model.resetAfterpartyMilestones());
  const finished = { known: true, pending: false, actualEndedAt: Date.now() - 60000, endReason: 'producer-finished' };
  const b = { ...booking(), broadcastCompletion: finished };
  const render = async value => {
    container.children = [];
    const activate = await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [value], escrowAddress: otherWallet } });
    activate();
  };
  await render(b);
  let curtain = descendants(container).find(node => node.className === 'live-curtain-call');
  assert.ok(curtain, 'an early verified finish is visible before the original end');
  assert.equal(curtain.open, true);
  assert.match(descendants(curtain).find(node => node.tag === 'h3').textContent, /Fixture performer/);
  assert.ok(descendants(container).some(node => /Approval opens after the original booked end/.test(node.textContent)));
  assert.equal(descendants(container).some(node => node.attributes?.['data-live-room'] === 'performer'), false);
  assert.equal(descendants(container).some(node => node.attributes?.['data-live-performer-directions'] === ''), false);
  assert.equal(events.filter(event => event.type === 'afterparty-celebration').length, 1);
  await render(b);
  curtain = descendants(container).find(node => node.className === 'live-curtain-call');
  assert.notEqual(curtain.open, true, 'refresh keeps the option to replay without repeating automatically');
  assert.equal(events.filter(event => event.type === 'afterparty-celebration').length, 1);
  for (const change of [
    { broadcastCompletion: { ...finished, endReason: 'operator-cut' } },
    { broadcastCompletion: { ...finished, endReason: 'audio-loss' } },
    { broadcastCompletion: { ...finished, endReason: 'declined' } },
    { broadcastCompletion: { known: true, pending: false, actualEndedAt: null, endReason: 'producer-finished' } },
    { cancelled: true },
  ]) {
    await render({ ...b, ...change });
    assert.equal(descendants(container).some(node => node.className === 'live-curtain-call'), false, JSON.stringify(change));
  }
  global.window._wallet.address = otherWallet;
  await render(b);
  assert.equal(descendants(container).some(node => node.className === 'live-curtain-call'), false, 'a stale Profile render cannot celebrate for another connected wallet');
});

test('re-entry lookup skips cancelled, incompatible, historical-complete and other non-candidate bookings', async () => {
  const { resolvePerformerReentry } = await import('../js/performer-room.mjs');
  const b = allocatedBooking();
  const changes = [
    { cancelled: true }, { acknowledged: false }, { status: 'draft' }, { status: 'refunded' },
    { mode: 'phase0' }, { payoutPolicy: 'unknown' }, { startUtc: 'invalid' }, { endUtc: 'invalid' },
    { broadcastCompletion: undefined }, { broadcastCompletion: { known: true, pending: false } },
    { endUtc: new Date(reentryTime + 60000).toISOString() },
  ];
  for (const change of changes) assert.deepEqual(await resolvePerformerReentry({ ...b, ...change }, {
    serviceUrl: 'https://worker.example', now: () => reentryTime,
    fetchImpl() { throw new Error('An irrelevant booking must not be fetched'); },
  }), { status: 'none' });
});

test('unavailable allocated stage never blocks reconciling an already-submitted performer claim', async t => {
  const [, { renderLivePerformances }] = await modules;
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const { Interface, id } = require('../discord-bot/node_modules/ethers');
  const createElement = dom(t), container = createElement('section'), b = { ...allocatedBooking(), termsHash: id('terms') }, removed = [];
  const iface = new Interface(LIVE_ESCROW_ABI);
  const log = { ...iface.encodeEventLog('PerformancePaid', [id(b.id), wallet, 20000000n, b.termsHash]), address: otherWallet };
  t.mock.method(Date, 'now', () => reentryTime);
  const savedHash = '0x' + 'ab'.repeat(32);
  global.localStorage = {
    getItem: key => key === `live-claim:${b.id}` ? savedHash : null,
    removeItem: key => removed.push(key),
  };
  class BrowserProvider {
    async getSigner() { return { getAddress: async () => wallet }; }
    async getNetwork() { return { chainId: 8453n }; }
    async getTransactionReceipt(hash) { assert.equal(hash, savedHash); return { status: 1, blockNumber: 100, logs: [log] }; }
    async getBlockNumber() { return 101; }
  }
  await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
    bookingState: { bookings: [b], escrowAddress: otherWallet },
    ethers: { BrowserProvider, Interface, id, Contract() { throw new Error('Never send a second claim'); } },
    fetchImpl: async () => { throw new Error('offline'); } });
  const nodes = descendants(container), claim = nodes.find(node => node.textContent === 'Check pending claim');
  assert.equal(claim.disabled, false);
  await claim.onclick();
  assert.match(claim.textContent, /Previous claim confirmed/);
  assert.deepEqual(removed, [`live-claim:${b.id}`]);
});

test('a saved claim waits for confirmations and retains its hash when payment evidence does not match', async t => {
  const [, { renderLivePerformances }] = await modules;
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const { Interface, id } = require('../discord-bot/node_modules/ethers');
  const createElement = dom(t), b = { ...allocatedBooking(), termsHash: id('terms') }, hash = '0x' + 'ab'.repeat(32);
  const iface = new Interface(LIVE_ESCROW_ABI);
  const log = { ...iface.encodeEventLog('PerformancePaid', [id('another booking'), wallet, 20000000n, b.termsHash]), address: otherWallet };
  t.mock.method(Date, 'now', () => reentryTime);
  for (const [head, expected] of [[100, /two Base confirmations/], [101, /payment event could not be verified/]]) {
    const container = createElement('section'), removed = [];
    global.localStorage = { getItem: key => key === `live-claim:${b.id}` ? hash : null, removeItem: key => removed.push(key) };
    class BrowserProvider {
      async getSigner() { return { getAddress: async () => wallet }; }
      async getNetwork() { return { chainId: 8453n }; }
      async getTransactionReceipt() { return { status: 1, blockNumber: 100, logs: [log] }; }
      async getBlockNumber() { return head; }
    }
    await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [b], escrowAddress: otherWallet },
      ethers: { BrowserProvider, Interface, id, Contract() { throw new Error('Never send a second claim'); } },
      fetchImpl: async () => { throw new Error('offline'); } });
    const nodes = descendants(container), claim = nodes.find(node => node.textContent === 'Check pending claim');
    await claim.onclick();
    assert.match(nodes.find(node => node.tag === 'output').textContent, expected);
    assert.deepEqual(removed, []);
  }
});

test('Profile celebrates a new claim only when its confirmed receipt proves the exact performance payment', async t => {
  const [, { renderLivePerformances }] = await modules;
  const { LIVE_ESCROW_ABI } = await import('../js/live-bookings.mjs');
  const { Interface, id } = require('../discord-bot/node_modules/ethers');
  const { resetPaymentCelebrationState } = await import('../js/payment-celebration.mjs');
  const createElement = dom(t), hash = '0x' + 'ab'.repeat(32), termsHash = id('terms');
  t.mock.method(Date, 'now', () => reentryTime);
  const iface = new Interface(LIVE_ESCROW_ABI);
  const event = (changes = {}) => {
    const values = { bookingId: id(booking().id), performer: wallet, amount: 20000000n, termsHash, ...changes };
    return { ...iface.encodeEventLog('PerformancePaid', [values.bookingId, values.performer, values.amount, values.termsHash]),
      address: otherWallet };
  };
  const cases = [
    { name: 'matching event', logs: [event()], verified: true },
    { name: 'other booking', logs: [event({ bookingId: id('other') })] },
    { name: 'other performer', logs: [event({ performer: otherWallet })] },
    { name: 'wrong amount', logs: [event({ amount: 19999999n })] },
    { name: 'wrong terms', logs: [event({ termsHash: id('other terms') })] },
    { name: 'other escrow', logs: [{ ...event(), address: wallet }] },
    { name: 'duplicate events', logs: [event(), event()] },
    { name: 'missing event', logs: [] },
    { name: 'reverted transaction', logs: [event()], receiptStatus: 0 },
    { name: 'missing agreement fingerprint', logs: [event()], termsHash: '' },
    { name: 'invalid expected amount', logs: [event()], approvedUnits: 'invalid' },
  ];
  for (const scenario of cases) {
    resetPaymentCelebrationState();
    const storage = new Map(), container = createElement('section');
    global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key) };
    const b = { ...booking(), status: 'approved', approvedUnits: '20000000', termsHash,
      ...(scenario.termsHash !== undefined ? { termsHash: scenario.termsHash } : {}),
      ...(scenario.approvedUnits !== undefined ? { approvedUnits: scenario.approvedUnits } : {}) };
    class BrowserProvider {
      async getSigner() { return { getAddress: async () => wallet }; }
      async getNetwork() { return { chainId: 8453n }; }
    }
    class Contract {
      async claim(bookingHash) {
        assert.equal(bookingHash, id(b.id));
        return { hash, wait: async confirmations => {
          assert.equal(confirmations, 2);
          return { status: scenario.receiptStatus ?? 1, logs: scenario.logs };
        } };
      }
    }
    await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
      bookingState: { bookings: [b], escrowAddress: otherWallet }, ethers: { BrowserProvider, Contract, Interface, id } });
    const claim = descendants(container).find(node => node.className === 'live-performer-claim');
    assert.ok(claim, scenario.name);
    await claim.onclick();
    assert.equal(storage.has('decentbusking:payment-celebrations:v1'), !!scenario.verified, scenario.name);
    assert.equal(storage.has(`live-claim:${b.id}`), !scenario.verified, scenario.name);
    if (scenario.verified) assert.match(claim.textContent, /Claim confirmed/);
    else if (scenario.receiptStatus === 0) assert.match(claim.textContent, /Claim needs attention/, scenario.name);
    else {
      assert.match(claim.textContent, /evidence needs review/, scenario.name);
      assert.match(descendants(container).find(node => node.tag === 'output').textContent, /do not send another claim/i);
    }
  }
  resetPaymentCelebrationState();
});

test('withinthevacuum Profile invitation is wallet-scoped and cannot imply acceptance or funding', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => NOW);
  const guest = '0x405Bb3Cdf23833bb27BAD6629b7cd4f01688235f';
  global.window._wallet.address = guest;
  const b = { ...booking(), id: 'within:2026-11-13', wallet: guest.toLowerCase(),
    displayName: 'withinthevacuum', status: 'draft', acknowledged: false, stewardApproved: true,
    additionalOffer: '', termsVersion: 'LIVE PERFORMANCE PILOT v1', termsUri: 'ipfs://bafyfixture',
    termsHash: '0x' + 'ab'.repeat(32) };
  const options = { container, wallet: guest, serviceUrl: 'https://worker.example',
    ethers: { BrowserProvider() { throw new Error('Viewing must not request signatures'); } },
    fetchImpl: async () => ({ ok: true, json: async () => ({ escrowAddress: otherWallet, bookings: [
      b, { ...b, id: 'wrong-wallet', wallet: otherWallet },
    ] }) }) };
  await renderLivePerformances(options);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].className, 'live-booking-invite live-invitation-card');
  let nodes = descendants(container);
  const text = nodes.map(node => node.textContent).join(' ');
  assert.match(text, /Hey withinthevacuum, you're invited/);
  assert.match(text, /\$20 USDC on Base · guaranteed/);
  assert.match(text, /Your escrow will be funded after you accept/);
  assert.doesNotMatch(text, /Technical verification|fingerprint|Open LIVE PERFORMANCE|Draft invitation/);
  assert.equal(nodes.filter(node => node.attributes?.['data-live-room']).length, 0);
  const accept = nodes.find(node => node.tag === 'button');
  assert.equal(accept.disabled, false, 'the invitation button itself is explicit consent');
  assert.ok(descendants(accept).some(node => node.alt === 'Secret Pyramid'));
  assert.equal(nodes.filter(node => node.alt === 'Secret Pyramid').length, 2);
  assert.doesNotMatch(text, /licensed music|No recording|headphones|💛|💌/);
  assert.equal(nodes.filter(node => node.tag === 'input').length, 0);
  assert.equal(nodes.filter(node => node.tag === 'button').length, 1, 'no dead claim button on invitations');
  assert.match(text, /No payment\. No gas/);
  assert.match(text, /8:00 PM & 8:45 PM/);
  assert.doesNotMatch(text, /task|token|Calendar/);
  assert.equal(nodes.filter(node => node.tag === 'details').length, 1);
  assert.equal(nodes.filter(node => node.tag === 'a').length, 1, 'only a private practice-room link, not an external agreement');
  assert.match(nodes.find(node => node.tag === 'a').href, /live-room.html\?booking=/);
  b.acknowledged = true;
  const acceptedContainer = createElement('section');
  await renderLivePerformances({ ...options, container: acceptedContainer });
  nodes = descendants(acceptedContainer);
  assert.ok(nodes.some(node => /guest list.*fund your escrow/.test(node.textContent)));
  assert.ok(nodes.some(node => /No payment was sent by accepting/.test(node.textContent)));
  assert.equal(nodes.filter(node => node.tag === 'button').length, 0);
  assert.equal(nodes.filter(node => node.attributes?.['data-live-room']).length, 0);
});

test('Admin wires an escaped operator link separately from all existing guaranteed-pilot actions', async () => {
  const [, , { renderLivePerformanceAdminBooking }] = await modules;
  const b = booking(), before = structuredClone(b);
  const html = renderLivePerformanceAdminBooking(b, NOW);
  const match = html.match(/<a data-live-room="operator" href="([^"]+)">([^<]+)<\/a>/);
  assert.ok(match);
  assert.equal(match[2], 'Open operator audio room');
  const href = match[1].replace(/&#39;/g, "'");
  assert.equal(new URL(href, 'https://radio.example/').searchParams.get('booking'), b.id);
  assert.doesNotMatch(match[0], /data-live-action|onclick|target=/);
  assert.match(html, /configured owner wallet; publishing remains performer-only/);
  assert.match(html, /does not grant access/);
  assert.match(html, /Hosting may be unavailable/);
  const desk = html.match(/<a data-live-desk href="([^"]+)">Open production desk<\/a>/);
  assert.ok(desk);
  assert.equal(new URL(desk[1], 'https://radio.example/').pathname, '/producer-room.html');
  assert.equal(new URL(desk[1], 'https://radio.example/').searchParams.get('booking'), b.id);
  assert.match(html, /cues do not extend the booking/);
  assert.match(html, /Guaranteed pilot fee/);
  assert.match(html, /Separate offer &lt;not markup&gt;/);
  const actions = [...html.matchAll(/data-live-action="([^"]+)"/g)].map(([, action]) => action);
  assert.deepEqual(actions, ['release', 'agreement', 'acknowledge', 'schedule', 'fund', 'reconcile', 'review', 'settle', 'cancel']);
  assert.deepEqual(b, before);
  for (const change of [{ status: 'draft' }, { acknowledged: false }, { cancelled: true },
    { endUtc: new Date(NOW).toISOString() }, { payoutPolicy: undefined }]) {
    assert.doesNotMatch(renderLivePerformanceAdminBooking({ ...b, ...change }, NOW), /data-live-room=/);
  }
  const source = fs.readFileSync(path.join(__dirname, '../js/live-performance-admin.mjs'), 'utf8');
  assert.match(source, /bookings\.map\(b => renderLivePerformanceAdminBooking\(b\)\)/);
});

test('Admin separates allocated completion from original fee and preserves reconciliation', async () => {
  const [, , { renderLivePerformanceAdminBooking, renderLiveBroadcastCompletion }] = await modules;
  const b = { ...booking(), stewardApproved: true, endUtc: new Date(NOW - 1).toISOString(),
    broadcastCompletion: { known: true, pending: true, actualEndedAt: null } };
  const html = renderLivePerformanceAdminBooking(b, NOW);
  assert.match(html, /allocated stage is not finished/);
  assert.match(html, /data-live-desk/);
  assert.match(html, /data-live-action="release" disabled/);
  assert.match(html, /data-live-action="review" disabled/);
  assert.match(html, /data-live-action="settle" disabled/);
  assert.doesNotMatch(html.match(/<button[^>]*data-live-action="reconcile"[^>]*>/)[0], /disabled/);
  const interrupted = renderLiveBroadcastCompletion({ ...b,
    broadcastCompletion: { known: true, pending: false, actualEndedAt: NOW, endReason: 'operator-cut', priorityFollowup: true } });
  assert.match(interrupted, /Interrupted by an owner cut/);
  assert.match(interrupted, /not a new booking/);
  assert.doesNotMatch(interrupted, /Performer finished at the song-boundary ending/);
  const completed = renderLiveBroadcastCompletion({ ...b,
    broadcastCompletion: { known: true, pending: false, actualEndedAt: NOW, endReason: 'producer-finished' } });
  assert.match(completed, /Performer finished at the song-boundary ending/);
});

test('one-button invitation preserves exact wallet consent and explicit failure states', async t => {
  const [, { renderPerformerBookingInvite }] = await modules;
  const { liveAcknowledgement } = await import('../js/live-bookings.mjs');
  dom(t);
  t.mock.method(Date, 'now', () => NOW);
  const b = { ...booking(), status: 'draft', acknowledged: false, stewardApproved: true,
    additionalOffer: '', termsVersion: 'LIVE PERFORMANCE PILOT v1', termsUri: 'ipfs://bafyfixture',
    termsHash: '0x' + 'ab'.repeat(32), cancellationWindow: 28800, killFeeBps: 10000 };
  for (const scenario of ['no-wallet', 'wrong-chain', 'wrong-wallet', 'rejected', 'service-error', 'unconfirmed', 'success']) {
    let signed = '', posts = 0;
    global.window.ethereum = scenario === 'no-wallet' ? undefined : {};
    const ethers = { BrowserProvider: class {
      async getNetwork() { return { chainId: scenario === 'wrong-chain' ? 1n : 8453n }; }
      async getSigner() { return {
        getAddress: async () => scenario === 'wrong-wallet' ? otherWallet : wallet,
        signMessage: async message => {
          if (scenario === 'rejected') throw new Error('Signature declined');
          signed = message;
          return '0xfixture-signature';
        },
      }; }
    } };
    const card = renderPerformerBookingInvite({ booking: b, wallet, serviceUrl: 'https://worker.example/',
      ethers, now: NOW, fetchImpl: async (url, options) => {
        posts++;
        assert.equal(url, 'https://worker.example/api/live-bookings/acknowledge');
        assert.deepEqual(JSON.parse(options.body), { id: b.id, address: wallet, signature: '0xfixture-signature' });
        return { ok: scenario !== 'service-error', json: async () => scenario === 'service-error'
          ? { error: 'Storage unavailable' } : { bookings: [{ ...b, acknowledged: scenario === 'success' }] } };
      } });
    const nodes = descendants(card), button = nodes.find(node => node.tag === 'button');
    await button.listeners.click();
    const status = nodes.find(node => node.attributes?.role === 'status').textContent;
    if (scenario === 'success') {
      assert.equal(signed, liveAcknowledgement(b), 'existing immutable agreement text is not rewritten');
      assert.match(status, /You’re in.*funding your escrow/);
      assert.equal(button.disabled, true);
      assert.ok(nodes.some(node => /guest list.*fund your escrow/.test(node.textContent)));
    } else {
      assert.match(status, /No escrow transaction was sent/);
      assert.equal(button.disabled, false, 'failed acceptance can be retried');
    }
    assert.equal(global.document.body.children.length, scenario === 'success' ? 1 : 0, 'only a saved acceptance celebrates');
    assert.equal(posts, ['service-error', 'unconfirmed', 'success'].includes(scenario) ? 1 : 0);
    assert.equal(b.acknowledged, false, 'rendering/signing does not fabricate a saved acknowledgement');
  }
});

test('cosmic acceptance confirmation includes all zodiac signs and cleans up without blocking input', async t => {
  const [, { celebrateLiveInvitation }] = await modules;
  dom(t);
  let timeout, exit, cleared = 0;
  global.window.matchMedia = () => ({ matches: true });
  global.window.setTimeout = (callback, duration) => { timeout = callback; assert.equal(duration, 4400); return 42; };
  global.window.clearTimeout = id => { assert.equal(id, 42); cleared++; };
  global.window.addEventListener = (name, callback) => { assert.equal(name, 'pagehide'); exit = callback; };
  celebrateLiveInvitation();
  const effect = global.document.body.children[0];
  assert.match(effect.className, /is-still/);
  assert.equal(effect.attributes['aria-hidden'], 'true');
  assert.equal(effect.attributes.popover, 'manual');
  assert.equal(effect.children.length, 49);
  assert.equal(effect.children.filter(node => node.className === 'live-cosmos-sign').map(node => node.textContent).join(''), '♈♉♊♋♌♍♎♏♐♑♒♓');
  assert.deepEqual(effect.children.filter(node => node.className === 'live-cosmos-figure').map(node => node.textContent),
    ['🜡', '☿', '♀︎', '🜐', '🜑', '⚸', '♁', '♄', '⚳', '⚵', '⚶', '⚷']);
  timeout();
  assert.equal(effect.removed, true);
  exit();
  assert.equal(cleared, 2);
  const css = fs.readFileSync(path.join(__dirname, '../css/live-performance.css'), 'utf8');
  assert.match(css, /live-invitation-cosmos[^}]+pointer-events: none/s);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('funded invitation stays compact during the show and offers only the authorized room link', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => Date.parse('2026-11-14T02:05:00Z'));
  const b = { ...booking(), stewardApproved: true, additionalOffer: '' };
  await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
    fetchImpl: async () => ({ ok: true, json: async () => ({ bookings: [b], escrowAddress: otherWallet }) }) });
  const nodes = descendants(container), text = nodes.map(node => node.textContent).join(' ');
  assert.match(container.children[0].className, /live-invitation-card/);
  assert.match(text, /Your fee is in escrow/);
  const link = nodes.find(node => node.attributes?.['data-live-room'] === 'performer');
  assert.equal(link.textContent, '🎙 Open your rehearsal room');
  assert.equal(link.target, undefined);
  assert.match(text, /Connect your invited wallet, allow your mic/);
  assert.equal(nodes.filter(node => node.tag === 'button').length, 0);
});

test('post-show performer card makes claim the primary action and keeps agreement details collapsed', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => Date.parse('2026-11-14T02:40:00Z'));
  const b = { ...booking(), id: 'performer:claim', status: 'approved', approvedUnits: '20000000' };
  await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
    bookingState: { bookings: [b], escrowAddress: otherWallet } });
  const article = container.children[0], nodes = descendants(article);
  assert.equal(article.className, 'live-performer-next');
  assert.equal(article.attributes['data-action-needed'], 'true');
  assert.match(nodes.find(node => node.tag === 'h3').textContent, /Your next step.*claim/);
  const claim = nodes.find(node => node.className === 'live-performer-claim');
  assert.equal(claim.textContent, 'Claim $20.00 USDC');
  assert.equal(claim.disabled, false);
  const details = nodes.find(node => node.className === 'live-performer-details');
  assert.equal(details.tag, 'details');
  assert.equal(details.attributes.open, undefined);
});

test('admin afterparty separates confirmed completion, approval, payment and recording facts', async () => {
  const [, , { renderLivePerformanceAdminBooking }] = await modules;
  const now = Date.parse('2026-11-14T03:00:00Z');
  const b = { ...booking(), broadcastCompletion: {
    known: true, pending: false, actualEndedAt: now - 60_000, endReason: 'producer-finished',
  }, recordingRelease: { known: true, state: 'mint-requested' } };
  const html = renderLivePerformanceAdminBooking(b, now);
  assert.match(html, /Set finished/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /Not paid yet/);
  assert.match(html, /Submitted · waiting for the mint/);
  assert.match(html, /Release the full guaranteed fee/);
  assert.match(html, /data-live-release-checks/);
  assert.equal((html.match(/data-live-action="release"/g) || []).length, 1);
  assert.doesNotMatch(html, /Payment confirmed/);
});

test('an already-approved escrow without a report URI updates the admin card without inventing a report link', async () => {
  const [, , { applyConfirmedRelease }] = await modules;
  const button = {}, report = { hidden: true };
  const card = { querySelector: selector => selector.includes('data-live-action') ? button : report };
  assert.doesNotThrow(() => applyConfirmedRelease(card, { outcome: 'approved', source: 'chain-state' }));
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /performer can claim/);
  assert.equal(report.hidden, true);
  applyConfirmedRelease(card, { reportUri: 'ipfs://bafkreitestpublicreport' });
  assert.equal(report.hidden, false);
  assert.equal(report.href, 'https://gateway.pinata.cloud/ipfs/bafkreitestpublicreport');
});

test('performer afterparty uses a verified early stage ending when the booking snapshot is pending', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  const now = Date.parse('2026-11-14T03:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const b = { ...booking(), broadcastCompletion: { known: true, pending: true } };
  const activate = await renderLivePerformances({
    container, wallet, serviceUrl: 'https://worker.example/',
    bookingState: { bookings: [b], escrowAddress: otherWallet },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        bookingId: b.id, configured: true, phase: 'ended', serverTime: now,
        bookingVerification: { fresh: true, verifiedAt: now },
        broadcast: { allocationId: 'fixture-allocation', phase: 'ended', endReason: 'producer-finished',
          actualStartedAt: now - 600000, actualEndedAt: now - 60000 },
      }),
    }),
  });
  const checklist = descendants(container.children[0]).find(node => node.className === 'live-afterparty-checklist');
  assert.ok(checklist);
  assert.match(descendants(checklist).find(node => node.tag === 'strong').textContent, /Show: Set finished/);
  assert.ok(descendants(container).some(node => node.className === 'live-curtain-call'));
  activate();
});

test('post-show waiting card gives ownership of next step without a disabled claim button or false payment', async t => {
  const [, { renderLivePerformances }] = await modules;
  const createElement = dom(t), container = createElement('section');
  t.mock.method(Date, 'now', () => Date.parse('2026-11-14T02:21:00Z'));
  const b = { ...booking(), status: 'funded', endUtc: new Date(Date.now() - 60000).toISOString() };
  await renderLivePerformances({ container, wallet, serviceUrl: 'https://worker.example',
    bookingState: { bookings: [b], escrowAddress: otherWallet } });
  const nodes = descendants(container);
  assert.equal(nodes.filter(node => node.className === 'live-performer-claim').length, 0);
  assert.match(nodes.find(node => node.tag === 'output').textContent, /Jolly’s next step.*Nothing for you to sign/);
  assert.match(nodes.find(node => node.tag === 'h3').textContent, /Your performance status/);
  assert.ok(nodes.some(node => /Show: Finish not verified/.test(node.textContent)));
  const creatorSource = fs.readFileSync(path.join(__dirname, '../js/creator-profile.mjs'), 'utf8');
  assert.match(creatorSource, /insertBefore\(livePerformances, earningsDisclosure\)/);
  assert.match(creatorSource, /livePaymentLoad = loadLivePayments\(check\)/);
});

test('Profile/Admin and index preserve live-audio-pilot cache references', async () => {
  for (const file of ['live-performance-profile.mjs', 'live-performance-admin.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    assert.match(source, /live-bookings\.mjs\?v=20261108-live-audio-pilot/);
    assert.match(source, /live-audio\.mjs\?v=20261114-allocated-stage/);
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /live-performance-admin\.mjs\?v=20261121-typed-review/);
  assert.match(html, /live-booking-notifications\.mjs\?v=20261117-booking-assets/);
  assert.match(html, /src="js\/creator-profile\.mjs\?v=20261123-supporter-queue"/);
  assert.match(html, /src="js\/radio-schedule-ui\.mjs\?v=20261124-public-personal"/);
  assert.match(html, /live-performance\.css\?v=20261121-action-status/);
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.equal(map.imports['./js/live-performance-profile.mjs?v=20261115-afterparty'],
    './js/live-performance-profile.mjs?v=20261121-payment-first');
  assert.equal(map.imports['./js/live-bookings.mjs?v=20261108-live-audio-pilot'],
    './js/live-bookings.mjs?v=20261117-booking-assets');
  for (const suffix of ['20261110-wallet-practice', '20261114-allocated-stage', '20261116-curtain']) {
    assert.equal(map.imports[`./js/performer-room.mjs?v=${suffix}`],
      './js/performer-room.mjs?v=20261117-booking-assets');
  }
  assert.equal(map.imports['./js/live-booking-notifications.mjs?v=20261113-one-action-release'],
    './js/live-booking-notifications.mjs?v=20261117-booking-assets');
  assert.equal(map.imports['./js/radio-schedule-ui.mjs?v=20261025-community-reminder'],
    './js/radio-schedule-ui.mjs?v=20261124-public-personal');
  assert.equal(map.imports['./js/fund-display.mjs?v=20261024-djuke-labels'],
    './js/fund-display.mjs?v=20261124-visible-payments');
  assert.match(fs.readFileSync(path.join(__dirname, '../js/radio-schedule-ui.mjs'), 'utf8'),
    /dbusk-calendar\.mjs/);
  assert.match(fs.readFileSync(path.join(__dirname, '../js/dbusk-calendar.mjs'), 'utf8'),
    /open-creator-profile/);
  assert.match(fs.readFileSync(path.join(__dirname, '../js/creator-profile.mjs'), 'utf8'),
    /live-performance-profile\.mjs\?v=20261115-afterparty/);
  assert.match(fs.readFileSync(path.join(__dirname, '../js/live-performance-admin.mjs'), 'utf8'),
    /live-booking-notifications\.mjs\?v=20261113-one-action-release/);
});

test('standalone backstage and main-page imports load compatible recovery helpers without stale cached clients', () => {
  for (const file of ['live-audio-room.mjs', 'producer-room.mjs', 'live-direction.mjs',
    'private-room-listener.mjs', 'live-broadcast-controls.mjs', 'producer-listener-telemetry.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    assert.match(source, /live-audio-client\.mjs\?v=20261117-lease-recovery/);
    assert.doesNotMatch(source, /20261114-direction|20261114-allocated-consent/);
  }
  const client = fs.readFileSync(path.join(__dirname, '../js/live-audio-client.mjs'), 'utf8');
  assert.match(client, /live-audio\.mjs\?v=20261117-producer-recovery/);
  assert.match(client, /live-listener-telemetry\.mjs\?v=20261117-lease-recovery/);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const { imports } = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const suffix of ['', '?v=20261114-direction', '?v=20261114-allocated-stage']) {
    assert.equal(imports[`./js/live-audio-client.mjs${suffix}`],
      './js/live-audio-client.mjs?v=20261117-lease-recovery');
  }
  for (const suffix of ['', '?v=20261108-live-audio-pilot', '?v=20261114-allocated-stage']) {
    assert.equal(imports[`./js/live-audio.mjs${suffix}`],
      './js/live-audio.mjs?v=20261117-booking-assets');
  }
  for (const [html, entry] of [['live-room.html', 'live-audio-room.mjs'], ['producer-room.html', 'producer-room.mjs']]) {
    const source = fs.readFileSync(path.join(__dirname, '..', html), 'utf8');
    assert.ok(source.includes(`${entry}?v=${entry === 'live-audio-room.mjs' ? '20261120-private-preflight' : '20261117-booking-assets'}`));
    assert.match(source, /live-audio\.css\?v=20261116-booth/);
    assert.doesNotMatch(source, /20261114-direction/);
  }
  for (const file of ['live-audio-room.mjs', 'producer-room.mjs']) {
    assert.match(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'),
      /live-broadcast-controls\.mjs\?v=20261117-producer-recovery/);
  }
});

test('production live audio reuses encrypted mirrored storage, never an ephemeral file path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  assert.match(source, /createLiveAudioPinataStore/);
  assert.match(source, /storageKey: process\.env\.LIVE_AUDIO_STORAGE_KEY/);
  assert.match(source, /store: liveAudioStore/);
  assert.doesNotMatch(source, /createLiveAudioFileStore|LIVE_AUDIO_STATE_PATH/);
  assert.match(source, /enabled: process\.env\.LIVE_AUDIO_ENABLED === 'true'/);
});
