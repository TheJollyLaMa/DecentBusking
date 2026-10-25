const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const botRequire = createRequire(path.join(__dirname, '../discord-bot/package.json'));
const { Collection, PermissionFlagsBits, MessagePayload } = botRequire('discord.js');
const siteUrl = 'https://thejollylama.github.io/DecentBusking/';
const monday = Date.parse('2026-10-26T13:00:00Z');
const messageId = '123456789012345678';

async function fixture({ saved = null } = {}) {
  const { createCommunityReminder } = await import('../discord-bot/community-reminder.js');
  let time = monday;
  let allowed = true;
  let permission = true;
  const sends = [];
  const writes = [];
  const messages = new Collection();
  const channel = {
    id: '943117480883265539', name: 'themessagebox', guild: { id: '943117480883265536' },
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => permission }),
    messages: { fetch: async () => messages },
    send: async payload => { sends.push(payload); return { id: messageId }; },
  };
  let reads = 0;
  const client = { user: { id: 'bot' }, isReady: () => true,
    channels: { fetch: async id => { reads++; assert.equal(id, channel.id); return channel; } } };
  const store = {
    restore: async () => structuredClone(saved),
    save: async state => { writes.push(structuredClone(state)); return 'ipfs://receipt'; },
  };
  const errors = [];
  const options = { store, getClient: () => client, canAnnounce: () => allowed, siteUrl,
    now: () => time, log: { log() {}, error: (...args) => errors.push(args) } };
  const service = createCommunityReminder(options);
  await service.ready;
  return { service, options, store, sends, writes, channel, client, messages, errors,
    time: value => { time = value; }, allow: value => { allowed = value; },
    permission: value => { permission = value; }, reads: () => reads };
}

test('Monday 9 AM follows New York civil time, including both DST changes and year rollover', async () => {
  const { communityReminderTime } = await import('../discord-bot/community-reminder.js');
  for (const [value, due, next] of [
    ['2026-10-25T10:01:00Z', false, '2026-10-26T13:00:00.000Z'],
    ['2026-10-26T12:59:59Z', false, '2026-10-26T13:00:00.000Z'],
    ['2026-10-26T13:00:00Z', true, '2026-11-02T14:00:00.000Z'],
    ['2026-10-26T13:59:59Z', true, '2026-11-02T14:00:00.000Z'],
    ['2026-10-26T14:00:00Z', false, '2026-11-02T14:00:00.000Z'],
    ['2026-11-02T14:00:00Z', true, '2026-11-09T14:00:00.000Z'],
    ['2027-03-15T13:00:00Z', true, '2027-03-22T13:00:00.000Z'],
    ['2026-12-31T15:00:00Z', false, '2027-01-04T14:00:00.000Z'],
  ]) {
    const result = communityReminderTime(Date.parse(value));
    assert.equal(result.due, due, value);
    assert.equal(result.nextRunAt, next, value);
  }
});

test('public schedule link opens the existing calendar and subscription controls without a wallet', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../js/radio-schedule-ui.mjs'), 'utf8');
  for (const search of ['?schedule=1', '', '?schedule=0']) {
    const nodes = new Map();
    let renders = 0;
    const document = {
      getElementById: id => {
        if (!nodes.has(id)) nodes.set(id, { open: false, addEventListener() {},
          showModal() { this.open = true; } });
        return nodes.get(id);
      },
      addEventListener() {},
    };
    const context = vm.createContext({
      document, window: { DecentConfig: { ipfsUploadServiceUrl: 'https://worker.example' }, location: { search } },
      URLSearchParams, AbortSignal, setInterval() {},
      renderSchedule: () => { renders++; },
      fetch: async () => ({ ok: true, json: async () => ({ ready: true, schedule: [], events: [] }) }),
    });
    const start = source.indexOf('export function initRadioScheduleBoard()');
    const end = source.lastIndexOf("if (typeof document");
    vm.runInContext(source.slice(start, end).replace('export ', ''), context);
    vm.runInContext('initRadioScheduleBoard()', context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.get('radio-schedule-dialog').open, search === '?schedule=1');
    assert.equal(renders, search === '?schedule=1' ? 1 : 0);
    assert.equal(nodes.get('radio-calendar-subscribe').href, 'webcal://worker.example/api/radio/calendar.ics');
    assert.equal(nodes.get('radio-calendar-feed').value, 'https://worker.example/api/radio/calendar.ics');
  }
});

test('poster message is concise, accessible, mentions everyone once, and links the actual public schedule', async () => {
  const { buildCommunityReminder } = await import('../discord-bot/community-reminder.js');
  const payload = buildCommunityReminder('2026-10-26', siteUrl);
  assert.ok(payload.content.length < 120);
  assert.equal(payload.content.match(/@everyone/g).length, 1);
  assert.deepEqual(payload.allowedMentions.parse, ['everyone']);
  assert.equal(payload.files.length, 1);
  assert.match(payload.files[0].description, /calendar.*ads.*jams.*vote/i);
  assert.equal(payload.embeds[0].image.url, 'attachment://community-monday.png');
  assert.equal(payload.embeds[0].color, 0xff8a32);
  assert.match(payload.embeds[0].description, /DecentBusking\/\?schedule=1/);
  assert.equal(payload.embeds[0].footer.text, 'decent-community-monday:2026-10-26');
  const bytes = fs.readFileSync(payload.files[0].attachment);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 1200);
  assert.equal(bytes.readUInt32BE(20), 1500);
  assert.ok(bytes.length < 1_000_000);
  const resolved = await MessagePayload.resolveFile(payload.files[0]);
  assert.equal(resolved.name, 'community-monday.png');
  assert.deepEqual(resolved.data, bytes);
  const artwork = fs.readFileSync(path.join(__dirname, '../img/community-monday.svg'), 'utf8');
  assert.match(artwork, /The world is your village, Busk from home!/);
  assert.match(artwork, /decentbusking\.decentagency\.eth/);
  assert.doesNotMatch(artwork, /Your Monday signal|links below/);
  for (const color of ['#f0c040', '#ff8a32', '#52afff', '#c4cdd7']) {
    assert.ok(artwork.includes(color), `Brand palette must include ${color}`);
  }
  assert.doesNotMatch(artwork, /#(?:c7ff00|ff36c9|e4ff30|a62dff)\b/i);
  assert.throws(() => buildCommunityReminder('2026-10-26', 'javascript:alert(1)'), /HTTPS/);
});

test('sends once per local Monday, persists before sending, serializes ticks, and restores without reposting', async () => {
  const f = await fixture();
  f.channel.send = async payload => {
    assert.equal(f.writes.at(-1).deliveries[0].status, 'pending');
    f.sends.push(payload);
    return { id: messageId };
  };
  const first = f.service.tick();
  assert.equal(f.service.tick(), first);
  await first;
  await f.service.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.writes.length, 2);
  assert.equal(f.sends[0].enforceNonce, true);
  assert.equal(f.service.getStatus().lastDelivery.messageId, messageId);
  const restart = await fixture({ saved: f.writes.at(-1) });
  await restart.service.tick();
  assert.equal(restart.sends.length, 0);
  assert.equal(restart.writes.length, 0);
  restart.time(Date.parse('2026-11-02T14:00:00Z'));
  await restart.service.tick();
  assert.equal(restart.sends.length, 1);
});

test('no Discord reads or writes outside Monday delivery window, during cooldown, or while disconnected', async () => {
  const f = await fixture();
  for (const value of [monday - 1, monday + 60 * 60_000, monday + 86400_000]) {
    f.time(value);
    await f.service.tick();
  }
  f.time(monday);
  f.allow(false);
  await f.service.tick();
  f.allow(true);
  f.client.isReady = () => false;
  await f.service.tick();
  assert.equal(f.reads(), 0);
  assert.equal(f.sends.length, 0);
  assert.equal(f.writes.length, 0);
});

test('requires durable storage and valid receipts; unavailable restore never sends', async () => {
  const { createCommunityReminder, deserializeCommunityReminders } = await import('../discord-bot/community-reminder.js');
  const f = await fixture();
  const service = createCommunityReminder({ ...f.options, store: null });
  await service.ready;
  await service.tick();
  assert.equal(service.getStatus().ready, false);
  assert.match(service.getStatus().error, /storage/);
  assert.equal(f.sends.length, 0);
  assert.throws(() => deserializeCommunityReminders({ schemaVersion: 1, channelId: 'wrong', deliveries: [] }), /checkpoint/);
  const bad = await fixture({ saved: { schemaVersion: 1, channelId: f.channel.id, deliveries: [{ date: '2026-10-26', status: 'sent' }] } });
  await bad.service.tick();
  assert.equal(bad.service.getStatus().ready, false);
});

test('permissions and guild identity are checked, including after checkpoint latency', async () => {
  for (const changed of ['permission', 'guild', 'cooldown', 'window']) {
    const f = await fixture();
    const save = f.store.save;
    let first = true;
    f.store.save = async state => {
      const uri = await save(state);
      if (first) {
        first = false;
        if (changed === 'permission') f.permission(false);
        if (changed === 'guild') f.channel.guild.id = 'wrong';
        if (changed === 'cooldown') f.allow(false);
        if (changed === 'window') f.time(monday + 3600_000);
      }
      return uri;
    };
    await f.service.tick();
    assert.equal(f.sends.length, 0, changed);
    assert.ok(f.service.getStatus().error, changed);
    assert.equal(f.writes.at(-1).deliveries.length, 0, changed);
  }
  const f = await fixture();
  f.channel.permissionsFor = () => ({ has: permission => permission !== PermissionFlagsBits.AttachFiles });
  await f.service.tick();
  assert.match(f.service.getStatus().error, /AttachFiles/);
});

test('failed pre-send checkpoint never posts; a failed receipt save never duplicates a successful send', async () => {
  const f = await fixture();
  f.store.save = async () => { throw new Error('Pinata unavailable'); };
  await f.service.tick();
  assert.equal(f.sends.length, 0);
  assert.match(f.service.getStatus().error, /Pinata/);
  const g = await fixture();
  const save = g.store.save;
  let count = 0;
  g.store.save = async state => { if (++count === 2) throw new Error('Receipt failed'); return save(state); };
  await g.service.tick();
  assert.equal(g.sends.length, 1);
  assert.match(g.service.getStatus().error, /Receipt/);
  g.time(monday + 60_000);
  await g.service.tick();
  assert.equal(g.sends.length, 1);
  assert.equal(g.writes.at(-1).deliveries[0].status, 'sent');
});

test('ambiguous sends reconcile after restart rather than sending another everyone ping', async () => {
  const f = await fixture();
  f.channel.send = async () => { throw new Error('Network timed out'); };
  await f.service.tick();
  const restart = await fixture({ saved: f.writes.at(-1) });
  restart.messages.set(messageId, { id: messageId, author: { id: 'bot' },
    embeds: [{ footer: { text: 'decent-community-monday:2026-10-26' } }], createdTimestamp: monday });
  // Reconciliation is safe even after the send window.
  restart.time(monday + 2 * 3600_000);
  await restart.service.tick();
  assert.equal(restart.sends.length, 0);
  assert.equal(restart.service.getStatus().lastDelivery.messageId, messageId);
  const missing = await fixture({ saved: f.writes.at(-1) });
  await missing.service.tick();
  assert.equal(missing.sends.length, 0);
  assert.match(missing.service.getStatus().error, /uncertain/);
});

test('definite Discord rejections are checkpointed and respect retry backoff', async () => {
  const f = await fixture();
  let attempts = 0;
  f.channel.send = async () => { attempts++; throw Object.assign(new Error('Rate limited'), { status: 429 }); };
  await f.service.tick();
  assert.equal(attempts, 1);
  assert.match(f.service.getStatus().error, /Rate limited/);
  assert.equal(f.writes.at(-1).deliveries.length, 0);
  await f.service.tick();
  assert.equal(attempts, 1);
  f.time(monday + 60_000);
  await f.service.tick();
  assert.equal(attempts, 2);
});
