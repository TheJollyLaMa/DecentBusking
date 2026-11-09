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
  });
  global.document = { createElement };
  global.window = { _wallet: { address: wallet } };
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

test('Profile/Admin and index preserve live-audio-pilot cache references', async () => {
  for (const file of ['live-performance-profile.mjs', 'live-performance-admin.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    assert.match(source, /live-bookings\.mjs\?v=20261108-live-audio-pilot/);
    assert.match(source, /live-audio\.mjs\?v=20261108-live-audio-pilot/);
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /live-performance-admin\.mjs\?v=20261108-live-audio-pilot/);
  assert.match(html, /live-booking-notifications\.mjs\?v=20261108-live-audio-pilot/);
  assert.match(html, /src="js\/creator-profile\.mjs\?v=20261108-live-audio-pilot"/);
  assert.match(html, /src="js\/radio-schedule-ui\.mjs\?v=20261108-live-audio-pilot"/);
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  assert.equal(map.imports['./js/radio-schedule-ui.mjs?v=20261025-community-reminder'],
    './js/radio-schedule-ui.mjs?v=20261108-live-audio-pilot');
  assert.equal(map.imports['./js/fund-display.mjs?v=20261024-djuke-labels'],
    './js/fund-display.mjs?v=20261108-live-audio-pilot');
});

test('production live audio reuses encrypted mirrored storage, never an ephemeral file path', () => {
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  assert.match(source, /createLiveAudioPinataStore/);
  assert.match(source, /storageKey: process\.env\.LIVE_AUDIO_STORAGE_KEY/);
  assert.match(source, /store: liveAudioStore/);
  assert.doesNotMatch(source, /createLiveAudioFileStore|LIVE_AUDIO_STATE_PATH/);
  assert.match(source, /enabled: process\.env\.LIVE_AUDIO_ENABLED === 'true'/);
});
