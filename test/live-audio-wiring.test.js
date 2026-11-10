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
    setAttribute(name, value) { this.attributes[name] = value; },
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

test('room links are encoded and offered only for eligible funded pilot bookings', async () => {
  const [{ liveAudioRoomUrl }] = await modules;
  const b = booking();
  const url = new URL(liveAudioRoomUrl(b, NOW), 'https://radio.example/');
  assert.equal(url.pathname, '/live-room.html');
  assert.equal(url.searchParams.get('booking'), b.id);
  assert.equal(url.searchParams.size, 1);
  assert.equal(liveAudioRoomUrl(b, Date.parse(b.startUtc)), liveAudioRoomUrl(b, NOW));
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
  assert.deepEqual(requests, [{ url: 'https://worker.example/api/live-bookings', options: { cache: 'no-store' } }]);
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
  assert.match(html, /Guaranteed pilot fee/);
  assert.match(html, /Separate offer &lt;not markup&gt;/);
  const actions = [...html.matchAll(/data-live-action="([^"]+)"/g)].map(([, action]) => action);
  assert.deepEqual(actions, ['agreement', 'acknowledge', 'schedule', 'fund', 'reconcile', 'review', 'settle', 'cancel']);
  assert.deepEqual(b, before);
  for (const change of [{ status: 'draft' }, { acknowledged: false }, { cancelled: true },
    { endUtc: new Date(NOW).toISOString() }, { payoutPolicy: undefined }]) {
    assert.doesNotMatch(renderLivePerformanceAdminBooking({ ...b, ...change }, NOW), /data-live-room=/);
  }
  const source = fs.readFileSync(path.join(__dirname, '../js/live-performance-admin.mjs'), 'utf8');
  assert.match(source, /bookings\.map\(b => renderLivePerformanceAdminBooking\(b\)\)/);
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

test('Profile/Admin and index preserve live-audio-pilot cache references', async () => {
  for (const file of ['live-performance-profile.mjs', 'live-performance-admin.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    assert.match(source, /live-bookings\.mjs\?v=20261108-live-audio-pilot/);
    assert.match(source, /live-audio\.mjs\?v=20261108-live-audio-pilot/);
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /live-performance-admin\.mjs\?v=20261110-profile-invitation/);
  assert.match(html, /live-booking-notifications\.mjs\?v=20261110-profile-invitation/);
  assert.match(html, /src="js\/creator-profile\.mjs\?v=20261110-wallet-practice"/);
  assert.match(html, /src="js\/radio-schedule-ui\.mjs\?v=20261110-wallet-practice"/);
  assert.match(html, /live-performance\.css\?v=20261110-invitation-card/);
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.equal(map.imports['./js/radio-schedule-ui.mjs?v=20261025-community-reminder'],
    './js/radio-schedule-ui.mjs?v=20261110-wallet-practice');
  assert.equal(map.imports['./js/fund-display.mjs?v=20261024-djuke-labels'],
    './js/fund-display.mjs?v=20261108-live-audio-pilot');
  for (const file of ['creator-profile.mjs', 'radio-schedule-ui.mjs']) {
    assert.match(fs.readFileSync(path.join(__dirname, '../js', file), 'utf8'),
      /live-performance-profile\.mjs\?v=20261110-wallet-practice/);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '../js/live-performance-admin.mjs'), 'utf8'),
    /live-booking-notifications\.mjs\?v=20261110-profile-invitation/);
});

test('production live audio reuses encrypted mirrored storage, never an ephemeral file path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  assert.match(source, /createLiveAudioPinataStore/);
  assert.match(source, /storageKey: process\.env\.LIVE_AUDIO_STORAGE_KEY/);
  assert.match(source, /store: liveAudioStore/);
  assert.doesNotMatch(source, /createLiveAudioFileStore|LIVE_AUDIO_STATE_PATH/);
  assert.match(source, /enabled: process\.env\.LIVE_AUDIO_ENABLED === 'true'/);
});
