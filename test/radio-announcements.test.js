const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

async function fixture({ defaultMention = 'everyone' } = {}) {
  const { Wallet } = await import('../discord-bot/node_modules/ethers/lib.esm/index.js');
  const { PermissionFlagsBits } = await import('../discord-bot/node_modules/discord.js/src/index.js');
  const module = await import('../js/radio-announcement.mjs');
  const shared = { ...module, announcementHash: value => module.announcementHash(value, require('node:crypto').webcrypto) };
  const { createRadioAnnouncements } = await import('../discord-bot/radio-announcements.js');
  const { defaultRadioSchedule } = await import('../js/radio-schedule.mjs');
  const owner = Wallet.createRandom();
  let time = Date.parse('2026-10-22T12:00:00Z');
  let snapshot;
  let failSave = false;
  let failure;
  const posted = [];
  const permissions = new Set(Object.values(PermissionFlagsBits));
  const role = { id: '123456789012345678', name: 'JukeboxHero', mentionable: true };
  const guild = { id: '943117480883265536', roles: { cache: new Map([[role.id, role]]) },
    channels: { cache: new Map([['222222222222222222', { isVoiceBased: () => true }]]) } };
  const channel = { id: '943117480883265539', name: 'themessagebox', guild, isTextBased: () => true,
    permissionsFor: () => ({ has: flag => permissions.has(flag) }),
    send: async content => {
      if (failure) throw failure;
      const message = { ...content, id: String(posted.length + 1), url: `https://discord.com/channels/${guild.id}/${channel.id}/${posted.length + 1}`,
        author: { id: 'bot' }, createdTimestamp: time };
      posted.push(message);
      return message;
    },
    messages: { fetch: async () => new Map(posted.map(message => [message.id, message])) },
  };
  const client = { isReady: () => true, user: { id: 'bot' }, channels: { fetch: async () => channel } };
  const schedule = { ready: true, schedule: defaultRadioSchedule(), events: [] };
  const store = { restore: async () => structuredClone(snapshot), save: async value => {
    if (failSave) throw new Error('storage down');
    snapshot = structuredClone(value);
    return 'ipfs://announcement-checkpoint';
  } };
  const config = { store, getSchedule: () => schedule, getClient: () => client, ownerWallet: owner.address,
    voiceChannelId: '222222222222222222', listenUrl: 'https://example.org/radio', now: () => time, defaultMention };
  let service = createRadioAnnouncements(config);
  let counter = 0;
  async function authorize(action, payload, wallet = owner, overrides = {}) {
    const body = { address: wallet.address, payload, contentHash: await shared.announcementHash(payload),
      nonce: `${String(++counter).padStart(16, '0')}`, expiresAt: new Date(time + 240000).toISOString(), ...overrides };
    body.signature = await wallet.signMessage(shared.announcementAuthorization({ ...body, action, origin: 'https://example.org',
      occurrenceId: payload.occurrenceId, startUtc: payload.startUtc }));
    return body;
  }
  const call = async (action, payload, wallet, overrides) => service.handle(action, await authorize(action, payload, wallet, overrides), 'https://example.org');
  const input = { occurrenceId: 'friday-top10-hype:2026-10-23', startUtc: '2026-10-24T00:00:00.000Z',
    mentions: { everyone: true, roles: [] } };
  return { shared, config, owner, Wallet, PermissionFlagsBits, permissions, role, guild, channel, posted, schedule, input, authorize, call,
    restart: () => { service = createRadioAnnouncements(config); },
    advance: delta => { time += delta; }, fail: error => { failure = error; }, failSave: value => { failSave = value; },
    get snapshot() { return snapshot; }, handle: (...args) => service.handle(...args),
    preview: (value = {}) => call('preview', { ...input, ...value }),
  };
}

test('owner-signed options and preview bind origin, action, occurrence, content, nonce and expiry', async () => {
  const f = await fixture();
  const options = await f.call('options', {});
  assert.equal(options.channelId, '943117480883265539');
  assert.deepEqual(options.defaultMentions, { everyone: true, roles: [] });
  assert.equal(options.roles[0].name, 'JukeboxHero');
  const stranger = f.Wallet.createRandom();
  await assert.rejects(f.call('options', {}, stranger), /owner/);
  await assert.rejects(f.call('preview', f.input, stranger), /owner/);
  const preview = await f.preview();
  await assert.rejects(f.call('send', preview.draft, stranger), /owner/);
  const body = await f.authorize('preview', f.input);
  await assert.rejects(f.handle('send', body, 'https://example.org'), /owner/);
  await assert.rejects(f.handle('preview', body, 'https://evil.example'), /owner/);
  await assert.rejects(f.handle('preview', { ...body, payload: { ...body.payload, reason: 'tampered' } }, 'https://example.org'), /authorization/);
  await assert.rejects(f.call('preview', f.input, undefined, { expiresAt: '2026-10-22T11:00:00Z' }), /expired/);
  assert.equal(f.posted.length, 0);
});

test('content includes concrete timezone, Discord times, reason, site and voice links; DST is correct', async () => {
  const f = await fixture();
  const summer = await f.preview();
  assert.match(summer.content, /October 23, 2026.*8:00 PM EDT/);
  assert.match(summer.content, /America\/New_York/);
  assert.match(summer.content, /<t:1792800000:F>.*<t:1792800000:R>/);
  assert.match(summer.content, /votes.*weekly turnover/);
  assert.match(summer.content, /https:\/\/example.org\/radio/);
  assert.match(summer.content, /https:\/\/discord.com\/channels\/943117480883265536\/222222222222222222/);
  const winter = await f.preview({ occurrenceId: 'friday-top10-hype:2026-11-06', startUtc: '2026-11-07T01:00:00.000Z' });
  assert.match(winter.content, /8:00 PM EST/);
  assert.equal(Date.parse(winter.draft.startUtc) - Date.parse(summer.draft.startUtc), 14 * 86400000 + 3600000);
});

test('recurring selection is one dated occurrence, supports every show type and one-offs', async () => {
  const f = await fixture();
  await assert.rejects(f.preview({ occurrenceId: 'friday-top10-hype' }), /changed or removed/);
  for (const [id, startUtc] of [['friday-live-performance:2026-10-23', '2026-10-24T01:00:00.000Z'],
    ['weekly-top10-final-listen:2026-10-25', '2026-10-26T03:00:00.000Z']]) {
    assert.equal((await f.preview({ occurrenceId: id, startUtc })).draft.occurrenceId, id);
  }
  f.schedule.schedule.push({ id: 'playlist', type: 'playlist', label: 'Playlist show', weekday: 5, startHourLocal: 17, endHourLocal: 18 });
  const playlist = await f.preview({ occurrenceId: 'playlist:2026-10-23', startUtc: '2026-10-23T21:00:00.000Z' });
  assert.match(playlist.content, /Playlist show/);
  assert.match(playlist.content, /independent music/);
  f.schedule.events.push({ id: 'one-off', title: 'Special', type: 'live_performance', startUtc: '2026-10-23T20:00:00.000Z', endUtc: '2026-10-23T21:00:00.000Z' });
  assert.match((await f.preview({ occurrenceId: 'one-off', startUtc: f.schedule.events[0].startUtc })).content, /live performance/);
});

test('mentions are precise, role IDs validated, accidental mentions escaped and default configurable', async () => {
  const f = await fixture({ defaultMention: '123456789012345678' });
  assert.deepEqual((await f.call('options', {})).defaultMentions, { everyone: false, roles: [f.role.id] });
  const preview = await f.preview({ mentions: { everyone: false, roles: [f.role.id, f.role.id] }, reason: '@everyone <@123456789012345678> listen!' });
  assert.deepEqual(preview.allowedMentions, { parse: [], roles: [f.role.id], users: [], repliedUser: false });
  assert.ok(!preview.content.includes('@everyone'));
  assert.match(preview.content, new RegExp(`<@&${f.role.id}>`));
  assert.deepEqual((await f.preview({ mentions: { everyone: false, roles: [] } })).allowedMentions.roles, []);
  assert.deepEqual((await f.preview()).allowedMentions.parse, ['everyone']);
  await assert.rejects(f.preview({ mentions: { everyone: false, roles: ['999999999999999999'] } }), /role/);
  f.role.mentionable = false;
  await assert.rejects(f.call('send', preview.draft), /mentionable/);
  f.permissions.delete(f.PermissionFlagsBits.MentionEveryone);
  await assert.rejects(f.preview(), /Mention Everyone/);
  assert.ok(await f.preview({ mentions: { everyone: false, roles: [] } }));
});

test('success, concurrent duplicate requests and restart retries deliver once; reannounce needs a new explicit preview', async () => {
  const f = await fixture();
  const p = await f.preview();
  const results = await Promise.all([f.call('send', p.draft), f.call('send', p.draft)]);
  assert.equal(f.posted.length, 1);
  assert.equal(results.filter(result => result.duplicate).length, 1);
  assert.equal(results[0].delivery.announcedAt, '2026-10-22T12:00:00.000Z');
  assert.match(results[0].delivery.messageUrl, /discord.com/);
  assert.deepEqual(f.posted[0].allowedMentions.parse, ['everyone']);
  f.restart();
  assert.equal((await f.call('send', p.draft)).duplicate, true);
  const again = await f.preview({ reannounce: true });
  await f.call('send', again.draft);
  await f.call('send', again.draft); // A lost success response must not re-announce twice.
  assert.equal(f.posted.length, 2);
  f.restart();
  await f.call('send', again.draft);
  assert.equal(f.posted.length, 2);
});

test('stale, changed weekly programming, removed, canceled and ended events never send', async () => {
  const f = await fixture();
  const preview = await f.preview();
  f.schedule.schedule[1].label = 'Changed title';
  await assert.rejects(f.call('send', preview.draft), /Stale preview/);
  f.schedule.schedule[1].startHourLocal = 19;
  await assert.rejects(f.call('send', preview.draft), /changed or removed/);
  f.schedule.schedule = [];
  await assert.rejects(f.call('send', preview.draft), /changed or removed/);
  f.schedule.events = [{ id: f.input.occurrenceId, startUtc: f.input.startUtc, endUtc: '2026-10-24T01:00:00Z', title: 'Canceled', status: 'cancelled' }];
  await assert.rejects(f.preview(), /canceled/);
  f.schedule.events[0].status = 'scheduled';
  const current = await f.preview();
  f.advance(3 * 86400000);
  await assert.rejects(f.call('send', current.draft), /changed or removed|ended/);
  assert.equal(f.posted.length, 0);
});

test('definite Discord failure is retryable, unavailable checkpoint prevents send', async () => {
  const f = await fixture();
  const p = await f.preview();
  f.fail(Object.assign(new Error('Missing permissions'), { status: 403 }));
  await assert.rejects(f.call('send', p.draft), /Discord delivery failed/);
  f.fail(null);
  await f.call('send', p.draft);
  assert.equal(f.posted.length, 1);
  const another = await f.preview({ reannounce: true });
  f.failSave(true);
  await assert.rejects(f.call('send', another.draft), /Checkpoint failed; nothing sent/);
  assert.equal(f.posted.length, 1);
});

test('uncertain timeout is never blindly resent; pending delivery survives restart and reconciles by marker', async () => {
  const f = await fixture();
  const p = await f.preview();
  const send = f.channel.send;
  f.channel.send = async value => { await send(value); throw new Error('connection lost after acceptance'); };
  await assert.rejects(f.call('send', p.draft), /Discord delivery failed/);
  f.restart();
  const result = await f.call('send', p.draft);
  assert.equal(result.duplicate, true);
  assert.equal(f.posted.length, 1);
  assert.equal(Object.values(f.snapshot.requests)[0].status, 'sent');
});

test('timeout without known receipt fails closed and does not duplicate; final checkpoint failure recovers', async () => {
  const f = await fixture();
  const p = await f.preview();
  f.fail(new Error('timeout'));
  await assert.rejects(f.call('send', p.draft), /Discord delivery failed/);
  f.restart();
  f.fail(null);
  await assert.rejects(f.call('send', p.draft), /Delivery uncertain/);
  assert.equal(f.posted.length, 0);
  const g = await fixture();
  const preview = await g.preview();
  const send = g.channel.send;
  g.channel.send = async value => { const message = await send(value); g.failSave(true); return message; };
  await assert.rejects(g.call('send', preview.draft), /receipt checkpoint failed/);
  g.failSave(false);
  g.restart();
  await g.call('send', preview.draft);
  assert.equal(g.posted.length, 1);
});

test('worker rejects unauthorized origins and uses owner authorization for role enumeration', async () => {
  const f = await fixture();
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const { Readable } = require('node:stream');
  const handler = createWorkerRequestHandler({ allowedOrigins: ['https://example.org'], ownerWallet: f.owner.address, radioAnnouncements: { handle: f.handle } });
  async function route(origin, wallet) {
    const body = await f.authorize('options', {}, wallet);
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST'; req.url = '/api/radio/announcements/options'; req.headers = { origin };
    const res = { writeHead(status) { this.status = status; }, end(data) { this.data = JSON.parse(data); } };
    await handler(req, res);
    return res;
  }
  assert.equal((await route('https://evil.example')).status, 400);
  assert.match((await route('https://example.org', f.Wallet.createRandom())).data.error, /owner/);
  assert.equal((await route('https://example.org')).status, 200);
});

test('admin-only checkbox UI selects without sending and invalidates edited previews', () => {
  const ui = readFileSync('js/admin-radio-announcements.mjs', 'utf8');
  const publicUi = readFileSync('js/radio-schedule-ui.mjs', 'utf8');
  const admin = readFileSync('js/admin.js', 'utf8');
  assert.match(ui, /checkbox\.addEventListener\('change'/);
  assert.match(ui, /Confirm — send to Discord/);
  assert.match(ui, /reason\.addEventListener\('input', invalidate\)/);
  assert.match(admin, /if \(signer && address && _radioSchedule\) renderAdminRadioAnnouncements/);
  assert.ok(!publicUi.includes('renderAdminRadioAnnouncements'));
});

test('schedule, expiry and channel permissions are rechecked after the durable pending write', async () => {
  for (const change of ['schedule', 'expiry', 'permissions']) {
    const f = await fixture();
    const p = await f.preview();
    const save = f.config.store.save;
    let first = true;
    f.config.store.save = async state => {
      const result = await save(state);
      if (first) {
        first = false;
        if (change === 'schedule') f.schedule.schedule[1].label = 'Changed during upload';
        if (change === 'expiry') f.advance(300000);
        if (change === 'permissions') f.permissions.delete(f.PermissionFlagsBits.MentionEveryone);
      }
      return result;
    };
    await assert.rejects(f.call('send', p.draft), /Stale|expired|Mention Everyone/);
    assert.equal(f.posted.length, 0);
  }
});

test('missing, corrupt, failed or unconfirmed durable storage cannot send', async () => {
  const { createRadioAnnouncements } = await import('../discord-bot/radio-announcements.js');
  for (const store of [null, { restore: async () => { throw new Error('restore offline'); } },
    { restore: async () => ({ schemaVersion: 1, deliveries: [], requests: {} }) }]) {
    const f = await fixture();
    const service = createRadioAnnouncements({ ...f.config, store });
    await assert.rejects(service.handle('options', await f.authorize('options', {}), 'https://example.org'), /disabled/);
    assert.equal(f.posted.length, 0);
  }
  const f = await fixture();
  const p = await f.preview();
  f.config.store.save = async () => null;
  await assert.rejects(f.call('send', p.draft), /did not confirm/);
  assert.equal(f.posted.length, 0);
});

test('receipt recovery remains possible if the event is removed after an uncertain successful send', async () => {
  const f = await fixture();
  const p = await f.preview();
  const send = f.channel.send;
  f.channel.send = async body => { await send(body); throw new Error('lost response'); };
  await assert.rejects(f.call('send', p.draft), /Discord delivery failed/);
  f.schedule.schedule = [];
  f.restart();
  assert.equal((await f.call('send', p.draft)).duplicate, true);
  assert.equal(f.posted.length, 1);
});

class TestElement {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  prepend(child) { child.remove(); child.parentElement = this; this.children.unshift(child); }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  after(child) { const parent = this.parentElement; child.remove(); child.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, child); }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [(selector === '[data-radio-announcements]' ? 'radioAnnouncements' in child.dataset : child.tag === selector) ? child : null,
      ...child.querySelectorAll(selector)]).filter(Boolean);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  setAttribute(name, value) { this[name] = value; }
  async emit(name) { await Promise.all((this.listeners[name] || []).map(listener => listener({ target: this }))); await new Promise(resolve => setImmediate(resolve)); }
}

test('checkbox-to-preview-to-confirm UI never sends on selection, invalidates edits and retries the same confirmation', async () => {
  const { renderAdminRadioAnnouncements } = await import('../js/admin-radio-announcements.mjs');
  const f = await fixture();
  const document = global.document;
  const now = Date.now;
  global.document = { createElement: tag => new TestElement(tag), createTextNode: text => Object.assign(new TestElement('#text'), { textContent: text }) };
  Date.now = () => Date.parse('2026-10-22T12:00:00Z');
  try {
    const parent = new TestElement('section');
    const anchor = new TestElement('ul');
    parent.append(anchor);
    const calls = [];
    let fail = true;
    renderAdminRadioAnnouncements({ anchor, schedule: f.schedule, isCurrent: () => true,
      request: async (action, payload) => {
        calls.push({ action, payload });
        if (action === 'send' && fail) { fail = false; throw new Error('network down'); }
        return f.call(action, payload);
      } });
    const root = parent.querySelector('[data-radio-announcements]');
    const checkbox = root.querySelectorAll('input').find(input => input.dataset.occurrenceId === f.input.occurrenceId);
    checkbox.checked = true;
    await checkbox.emit('change');
    // Wait for the signed options request's asynchronous signature/verification.
    while (!root.querySelector('textarea')) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(call => call.action), ['options']);
    const preview = root.querySelectorAll('button').find(button => button.textContent === 'Preview announcement');
    await preview.emit('click');
    assert.deepEqual(calls.map(call => call.action), ['options', 'preview']);
    assert.equal(f.posted.length, 0);
    const reason = root.querySelector('textarea');
    reason.value = 'Edited reason';
    await reason.emit('input');
    assert.ok(!root.querySelectorAll('button').some(button => button.textContent.includes('Confirm')));
    await preview.emit('click');
    const confirm = root.querySelectorAll('button').find(button => button.textContent.includes('Confirm'));
    await Promise.all([confirm.emit('click'), confirm.emit('click')]);
    assert.match(root.textContent, /network down/);
    assert.equal(calls.filter(call => call.action === 'send').length, 1);
    await confirm.emit('click');
    const sends = calls.filter(call => call.action === 'send');
    assert.equal(sends.length, 2);
    assert.equal(sends[0].payload.requestId, sends[1].payload.requestId);
    assert.equal(f.posted.length, 1);
    assert.match(root.textContent, /sent successfully/);
    assert.match(root.textContent, /Last announced/);
    assert.match(root.querySelector('a').href, /discord.com/);
  } finally { global.document = document; Date.now = now; }
});

test('playlist shows get a vote-inviting default reason without changing other show defaults', async () => {
  const { defaultAnnouncementReason } = await import('../js/radio-announcement.mjs');
  assert.match(defaultAnnouncementReason({ type: 'playlist_show', playlistId: 'songs-awaiting-your-vote' }), /never received a single vote/);
  assert.match(defaultAnnouncementReason({ type: 'playlist_show', playlistId: 'other' }), /Discover independent music/);
  assert.match(defaultAnnouncementReason({ type: 'live_performance' }), /live performance/);
});
