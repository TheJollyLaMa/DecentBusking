const test = require('node:test');
const assert = require('node:assert/strict');

const name = 'decentbusking-test-state.json';
const tags = { app: 'decentbusking', kind: 'test-state', schema: '1' };

function clock(start = '2026-10-17T16:00:00Z') {
  let epoch = Date.parse(start);
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => epoch,
    setTimer: (run, delay) => {
      const id = ++nextId;
      timers.set(id, { run, at: epoch + delay });
      return id;
    },
    clearTimer: id => timers.delete(id),
    jump: value => { epoch = Date.parse(value); },
    async advance(ms) {
      const end = epoch + ms;
      for (let count = 0; count < 1000; count++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { epoch = end; return; }
        timers.delete(next[0]);
        epoch = next[1].at;
        await next[1].run();
      }
      throw new Error('Checkpoint timer did not settle');
    },
  };
}

function pinata(time) {
  const files = [];
  const uploads = [];
  const deletes = [];
  const data = new Map();
  const failures = { upload: false, remove: false, listingLag: false, archiveUpload: false, archiveRead: false };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      if (failures.upload) return new Response('{}', { status: 503 });
      const form = options.body;
      if (failures.archiveUpload && form.get('group_id') === 'archive') return new Response('{}', { status: 503 });
      const snapshot = JSON.parse(await form.get('file').text());
      const cid = `cid${require('node:crypto').createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`;
      const file = { id: `file-${uploads.length}`, cid, name: form.get('name'), group_id: form.get('group_id'),
        keyvalues: JSON.parse(form.get('keyvalues')), created_at: new Date(time.now()).toISOString() };
      uploads.push({ ...file, snapshot });
      files.unshift(file);
      data.set(cid, snapshot);
      return new Response(JSON.stringify({ data: { cid } }));
    }
    if (options.method === 'DELETE') {
      if (failures.remove) return new Response('{}', { status: 503 });
      const id = url.split('/').pop();
      deletes.push(id);
      const index = files.findIndex(file => file.id === id);
      if (index !== -1) files.splice(index, 1);
      return new Response('{}');
    }
    if (url.includes('/gateways')) return new Response(JSON.stringify({ data: { rows: [] } }));
    if (url.includes('/ipfs/')) {
      const snapshot = data.get(url.split('/').pop());
      if (failures.archiveRead && snapshot?.policy === 'weekly-history-v1') return new Response('{}', { status: 503 });
      return new Response(JSON.stringify(snapshot));
    }
    const parsed = new URL(url);
    const offset = Number(parsed.searchParams.get('pageToken') || 0);
    const listed = files.filter(file => !failures.listingLag || file !== files[0]);
    return new Response(JSON.stringify({ data: { files: listed.slice(offset, offset + 3),
      next_page_token: offset + 3 < listed.length ? String(offset + 3) : null } }));
  };
  return { files, uploads, deletes, failures, fetchImpl, data };
}

async function setup(t, start, overrides = {}) {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const time = clock(start);
  const api = pinata(time);
  const warnings = [];
  const options = { pinataJwt: 'test', groupId: 'live', retentionDays: 7, name, tags,
    serialize: value => value, deserialize: value => value, ...time, fetchImpl: api.fetchImpl,
    log: { warn: message => warnings.push(message) }, ...overrides };
  const store = createPinataStateStore(options);
  t.after(() => store.close());
  return { store, time, api, options, warnings };
}

test('seven calendar days retain one full cumulative state per day, not seven recent writes', async t => {
  const { store, time, api } = await setup(t);
  api.files.push(
    { id: 'legacy', cid: 'baseline', name, keyvalues: tags },
    { id: 'pre-policy', cid: 'proof', name, keyvalues: tags, group_id: 'live' },
    { id: 'weekly', cid: 'archive', name, keyvalues: tags, group_id: 'archive' },
    { id: 'media', cid: 'video', name: 'video.mp4', keyvalues: tags, group_id: 'live' });
  const entries = [];
  for (let day = 9; day <= 17; day++) {
    time.jump(`2026-10-${String(day).padStart(2, '0')}T16:00:00Z`);
    for (let update = 0; update < 3; update++) {
      entries.push({ id: `${day}-${update}` });
      await store.save({ schemaVersion: 1, entries });
    }
  }
  const daily = api.files.filter(file => file.keyvalues.checkpointPolicy === 'daily-v1');
  assert.equal(daily.length, 7);
  assert.deepEqual(daily.map(file => file.keyvalues.checkpointDay).sort(),
    ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  assert.equal(api.uploads.at(-1).snapshot.entries.length, 27);
  assert.equal(api.uploads.findLast(file => file.keyvalues.checkpointDay === '2026-10-11').snapshot.entries.length, 9);
  assert.deepEqual(api.files.filter(file => !file.keyvalues.checkpointPolicy).map(file => file.id),
    ['legacy', 'pre-policy', 'weekly', 'media']);
  assert.ok(api.uploads.every(file => file.group_id === 'live'));
});

test('routine bursts coalesce for five minutes, clone their input and skip unchanged uploads', async t => {
  const { store, time, api } = await setup(t);
  const state = { schemaVersion: 1, count: 0 };
  for (let count = 1; count <= 1000; count++) {
    state.count = count;
    store.schedule(state);
  }
  state.count = -1;
  await time.advance(299999);
  assert.equal(api.uploads.length, 0);
  await time.advance(1);
  assert.equal(api.uploads.length, 1);
  assert.equal(api.uploads[0].snapshot.count, 1000);
  store.schedule({ schemaVersion: 1, count: 1000 });
  await time.advance(300000);
  assert.equal(api.uploads.length, 1);
  assert.equal(store.getPersistenceState().pending, false);
});

test('weekly history embeds all seven full daily states and events, readable three weeks after daily expiry', async t => {
  const { store, time, api } = await setup(t, '2026-10-12T16:00:00Z', { archiveGroupId: 'archive' });
  for (let index = 0; index < 7; index++) {
    time.jump(`2026-10-${12 + index}T16:00:00Z`);
    await store.save({ count: index + 1 }, { events: [
      { id: `play-${index}`, type: 'play', trackId: 'song', observedAt: new Date(time.now()).toISOString(),
        occurredAt: new Date(time.now() - 60000).toISOString(), audibleMs: 60000 },
      { id: `vote-${index}`, type: 'vote', vote: 1, observedAt: new Date(time.now()).toISOString() },
    ] });
  }
  time.jump('2026-10-19T16:00:00Z');
  await store.save({ count: 8 });
  const weekly = api.uploads.filter(file => file.group_id === 'archive');
  assert.equal(weekly.length, 1);
  const archive = weekly[0].snapshot;
  assert.equal(archive.week, '2026-10-12');
  assert.deepEqual(archive.missingDays, []);
  assert.deepEqual(archive.days.map(entry => entry.snapshot.count), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(archive.days.flatMap(entry => entry.snapshot._checkpoint.events).length, 14);
  for (let day = 20; day <= 25; day++) {
    time.jump(`2026-10-${day}T16:00:00Z`);
    await store.save({ count: day });
  }
  assert.equal(api.uploads.filter(file => file.group_id === 'archive').length, 1);
  time.jump('2026-11-09T16:00:00Z');
  await store.save({ count: 99 });
  assert.ok(!api.files.some(file => file.group_id === 'live' && file.keyvalues.checkpointDay === '2026-10-12'));
  assert.ok(api.files.some(file => file.cid === weekly[0].cid));
  const savedArchive = await (await api.fetchImpl(`https://example.test/ipfs/${weekly[0].cid}`)).json();
  assert.equal(savedArchive.days[0].snapshot._checkpoint.events[0].id, 'play-0');
  assert.equal(savedArchive.days[6].snapshot.count, 7);
});

test('new weeks are partial when observations were unavailable, never invented from a cumulative total', async t => {
  const { store, time, api } = await setup(t, '2026-10-17T16:00:00Z', { archiveGroupId: 'archive' });
  await store.save({ count: 1 });
  time.jump('2026-10-19T16:00:00Z');
  await store.save({ count: 2 });
  const archive = api.uploads.find(file => file.group_id === 'archive').snapshot;
  assert.deepEqual(archive.days.map(entry => entry.day), ['2026-10-17']);
  assert.deepEqual(archive.missingDays, ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-18']);
});

test('archive upload or readback failure prevents expiry until an embedded historical copy is verified', async t => {
  for (const failure of ['archiveUpload', 'archiveRead']) {
    const { store, time, api } = await setup(t, '2026-10-12T16:00:00Z', { archiveGroupId: 'archive' });
    await store.save({ count: 1 });
    const dailyCid = api.uploads[0].cid;
    time.jump('2026-10-20T16:00:00Z');
    api.failures[failure] = true;
    await assert.rejects(store.save({ count: 2 }), /503|unavailable/);
    assert.equal(api.deletes.length, 0);
    assert.ok(api.files.some(file => file.cid === dailyCid));
    api.failures[failure] = false;
    await store.save({ count: 2 });
    assert.ok(!api.files.some(file => file.cid === dailyCid));
    const archive = api.uploads.findLast(file => file.group_id === 'archive');
    assert.equal(archive.snapshot.days[0].snapshot.count, 1);
    store.close();
  }
});

test('corrupt weekly readback never authorizes deletion of the source daily data', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { store, time, api, options } = await setup(t, '2026-10-12T16:00:00Z', { archiveGroupId: 'archive' });
  await store.save({ count: 1 });
  store.close();
  time.jump('2026-10-20T16:00:00Z');
  const guarded = createPinataStateStore({ ...options, fetchImpl: async (url, init) => {
    const response = await api.fetchImpl(url, init);
    if (url.includes('/ipfs/') && response.ok) {
      const content = await response.json();
      if (content?.policy === 'weekly-history-v1') content.days[0].snapshot.count = -1;
      return new Response(JSON.stringify(content));
    }
    return response;
  } });
  t.after(() => guarded.close());
  await assert.rejects(guarded.save({ count: 2 }), /verification failed/);
  assert.equal(api.deletes.length, 0);
  assert.ok(api.files.some(file => file.group_id === 'live' && file.keyvalues.checkpointDay === '2026-10-12'));
});

test('same-day event activity survives batching, restart, unchanged totals, and idempotent retries', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { store, time, api, options } = await setup(t);
  const observedAt = new Date(time.now()).toISOString();
  store.schedule({ count: 0 }, { events: [{ id: 'up', type: 'vote', vote: 1, observedAt }] });
  store.schedule({ count: 0 }, { events: [{ id: 'down', type: 'vote', vote: -1, observedAt }] });
  await time.advance(300000);
  assert.deepEqual(api.uploads[0].snapshot._checkpoint.events.map(event => event.id), ['up', 'down']);
  store.close();
  const restarted = createPinataStateStore(options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.restore(), { count: 0 });
  await restarted.save({ count: 0 }, { events: [{ id: 'up', type: 'vote', vote: 1, observedAt }] });
  assert.equal(api.uploads.length, 1);
  await restarted.save({ count: 0 }, { events: [{ id: 'third', type: 'vote', vote: 1, observedAt }] });
  assert.equal(api.uploads.at(-1).snapshot._checkpoint.events.length, 3);
});

test('financial changes retain chain event time and observation time without duplicating repeated scans', async t => {
  const { store, time, api } = await setup(t, undefined, {
    name: 'decentbusking-payment-ledger.json', tags: { ...tags, kind: 'payment-ledger' },
  });
  const entry = { txHash: `0x${'1'.repeat(64)}`, logIndex: 0, amountUnits: '1000',
    paidAt: '2026-10-10T12:00:00Z', verification: 'verified' };
  await store.save({ entries: [entry] });
  const event = api.uploads[0].snapshot._checkpoint.events[0];
  assert.equal(event.type, 'financial');
  assert.equal(event.occurredAt, entry.paidAt);
  assert.equal(event.observedAt, new Date(time.now()).toISOString());
  await store.save({ entries: [entry] });
  assert.equal(api.uploads.length, 1);
});

test('late daily history merges with previously archived days on restart and replaces only verified weekly predecessors', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { store, time, api, options } = await setup(t, '2026-10-17T16:00:00Z', { archiveGroupId: 'archive' });
  await store.save({ count: 1 });
  const daily = api.uploads[0];
  time.jump('2026-10-19T16:00:00Z');
  await store.save({ count: 2 });
  const firstArchive = api.uploads.find(file => file.group_id === 'archive');
  store.close();
  const late = { ...daily.snapshot, count: 3, _checkpoint: { ...daily.snapshot._checkpoint,
    day: '2026-10-18', savedAt: '2026-10-19T03:59:59Z' } };
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(late)]), name);
  form.append('name', name);
  form.append('group_id', 'live');
  form.append('keyvalues', JSON.stringify({ ...daily.keyvalues, checkpointDay: '2026-10-18' }));
  await api.fetchImpl('https://uploads.pinata.cloud/v3/files', { method: 'POST', body: form });
  time.jump('2026-10-20T16:00:00Z');
  const restarted = createPinataStateStore(options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.restore(), { count: 2 });
  await restarted.save({ count: 4 });
  const archives = api.files.filter(file => file.group_id === 'archive');
  assert.equal(archives.length, 1);
  assert.notEqual(archives[0].cid, firstArchive.cid);
  const archive = api.data.get(archives[0].cid);
  assert.deepEqual(archive.days.map(entry => [entry.day, entry.snapshot.count]), [['2026-10-17', 1], ['2026-10-18', 3]]);
  assert.ok(api.deletes.includes(firstArchive.id));
});

test('paid-playback and advert-vote history survive journal eviction', async t => {
  const { store, api } = await setup(t, undefined, { tags: { ...tags, kind: 'devert-main-radio' } });
  const impression = { impressionId: 'played-ad', campaignId: '1', state: 'recorded', recordedAt: '2026-10-17T15:00:00Z' };
  const vote = { radioPlayId: 'play', voterId: 'existing-pseudonym', campaignId: '1', vote: 1, recordedAt: '2026-10-17T15:01:00Z' };
  await store.save({ impressions: [impression], adVotes: [vote] });
  await store.save({ impressions: [], adVotes: [] });
  const events = api.uploads.at(-1).snapshot._checkpoint.events;
  assert.equal(events.length, 2);
  assert.equal(events.find(event => event.type === 'vote').occurredAt, vote.recordedAt);
  assert.equal(events.find(event => event.type === 'playback-transition').record.impressionId, 'played-ad');
});

test('versioned DeVert journals archive advert votes and paid advert plays', async () => {
  const { stateHistoryEvents } = await import('../discord-bot/checkpoint-history.js');
  const vote = { radioPlayId: 'play', voterId: 'existing-pseudonym', campaignId: '1', vote: 1, recordedAt: '2026-10-17T15:01:00Z' };
  const paidPlay = { radioPlayId: 'devert-paid:9:1', campaignId: '1', recordedAt: '2026-10-17T15:02:00Z' };
  const events = stateHistoryEvents('devert-main-radio-0x4894698f2b5caf13fad4aa8fbafe3618b960909f',
    { impressions: [], adVotes: [vote], paidPlays: [paidPlay] }, { impressions: [], adVotes: [], paidPlays: [] }, '2026-10-17T15:03:00Z');
  assert.deepEqual(events.map(event => [event.type, event.recordType]), [['vote', 'adVotes'], ['playback-transition', 'paidPlays']]);
});

test('critical writes publish immediately, supersede routine state and survive explicit flush', async t => {
  const { store, time, api } = await setup(t);
  store.schedule({ count: 1 });
  const uri = await store.save({ count: 2, payment: 'confirmed' });
  assert.equal(uri, `ipfs://${api.uploads[0].cid}`);
  assert.equal(api.uploads[0].snapshot.payment, 'confirmed');
  await time.advance(300000);
  assert.equal(api.uploads.length, 1);
  store.schedule({ count: 3, payment: 'confirmed' });
  await store.flush();
  assert.equal(api.uploads.at(-1).snapshot.count, 3);
  assert.equal(api.files.length, 1);
});

test('restart deduplicates same-day data and quiet days rotate within the current week', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { store, time, api, options } = await setup(t, '2026-10-17T03:59:00Z');
  const state = { entries: [{ id: 'preserved' }] };
  await store.save(state);
  store.close();
  const restarted = createPinataStateStore(options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.restore(), state);
  await restarted.save(state);
  assert.equal(api.uploads.length, 1);
  await time.advance(60_000);
  assert.equal(api.uploads.length, 2);
  assert.equal(api.uploads[0].keyvalues.checkpointDay, '2026-10-16');
  assert.equal(api.uploads[1].keyvalues.checkpointDay, '2026-10-17');
  assert.deepEqual(api.uploads[1].snapshot.entries, state.entries);
  assert.notEqual(api.uploads[0].cid, api.uploads[1].cid);
  assert.deepEqual(await restarted.restore(), state);
});

test('New York boundaries handle 23- and 25-hour days without UTC rollover', async t => {
  const { checkpointDay } = await import('../discord-bot/ipfs-state.js');
  assert.equal(checkpointDay(Date.parse('2026-10-17T03:59:59Z')), '2026-10-16');
  assert.equal(checkpointDay(Date.parse('2026-10-17T04:00:00Z')), '2026-10-17');
  for (const [start, duration, nextDay] of [
    ['2026-03-08T05:00:00Z', 23, '2026-03-09'],
    ['2026-11-01T04:00:00Z', 25, '2026-11-02'],
  ]) {
    const { store, time, api } = await setup(t, start);
    await store.save({ retained: true });
    await time.advance(duration * 3600_000 - 1);
    assert.equal(api.uploads.length, 1);
    await time.advance(1);
    assert.equal(api.uploads.length, 2);
    assert.equal(api.uploads.at(-1).keyvalues.checkpointDay, nextDay);
    store.close();
  }
});

test('midnight flushes the final pending state into yesterday before opening today', async t => {
  const { store, time, api } = await setup(t, '2026-10-17T03:59:00Z');
  await store.save({ entries: [1] });
  store.schedule({ entries: [1, 2] });
  await time.advance(60_000);
  assert.equal(api.files.length, 2);
  assert.deepEqual(api.uploads.at(-2).snapshot.entries, [1, 2]);
  assert.equal(api.uploads.at(-2).keyvalues.checkpointDay, '2026-10-16');
  assert.deepEqual(api.uploads.at(-1).snapshot.entries, [1, 2]);
  assert.equal(api.uploads.at(-1).keyvalues.checkpointDay, '2026-10-17');
});

test('failed routine uploads stay pending, log and retry without pruning good data', async t => {
  const { store, time, api, warnings } = await setup(t);
  await store.save({ count: 1 });
  api.failures.upload = true;
  store.schedule({ count: 2 });
  await time.advance(300000);
  assert.equal(store.getPersistenceState().pending, true);
  assert.equal(api.deletes.length, 0);
  assert.match(warnings.at(-1), /maintenance pending.*503/);
  api.failures.upload = false;
  await time.advance(300000);
  assert.equal(api.uploads.at(-1).snapshot.count, 2);
  assert.equal(api.files.length, 1);
  assert.equal(store.getPersistenceState().pending, false);
});

test('failed prior-day close can retry after a newer critical save without rolling active state back', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { store, time, api, options } = await setup(t, '2026-10-17T03:59:00Z');
  await store.save({ count: 1 });
  store.schedule({ count: 2 });
  api.failures.upload = true;
  await time.advance(60_000);
  await assert.rejects(store.save({ count: 3 }), /503/);
  api.failures.upload = false;
  const current = await store.save({ count: 4 });
  await store.flush();
  assert.equal(store.getLatestSnapshotUri(), current);
  assert.equal(api.uploads.find(file => `ipfs://${file.cid}` === current).snapshot.count, 4);
  assert.deepEqual(api.files.map(file => file.keyvalues.checkpointDay).sort(), ['2026-10-16', '2026-10-17']);
  store.close();
  const restarted = createPinataStateStore(options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.restore(), { count: 4 });
});

test('listing lag and pruning failures surface, preserve the new snapshot and retry without reuploading', async t => {
  const { store, api } = await setup(t);
  await store.save({ count: 1 });
  api.failures.listingLag = true;
  await assert.rejects(store.save({ count: 2 }), /not listed yet/);
  assert.equal(api.deletes.length, 0);
  api.failures.listingLag = false;
  api.failures.remove = true;
  await assert.rejects(store.save({ count: 2 }), /pruning failed.*503/);
  assert.equal(api.uploads.length, 2);
  api.failures.remove = false;
  await store.save({ count: 2 });
  assert.equal(api.uploads.length, 2);
  assert.equal(api.files.length, 1);
});

test('required local mirror failures still block new critical writes under daily retention', async t => {
  let offline = false;
  let confirmedCid;
  const { store, api } = await setup(t, undefined, {
    requireLocalMirror: true,
    beforeUpload: async bytes => {
      if (offline) throw new Error('Mirror offline');
      confirmedCid = `cid${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}`;
      return confirmedCid;
    },
  });
  const uri = await store.save({ schemaVersion: 1, records: [] });
  assert.equal(uri, `ipfs://${confirmedCid}`);
  offline = true;
  await assert.rejects(store.save({ schemaVersion: 1, records: [{ state: 'played' }] }), /Mirror offline/);
  assert.equal(api.uploads.length, 1);
  assert.equal(store.getLatestSnapshotUri(), uri);
});

test('a failed in-flight routine write cannot overwrite a newer critical write with the same timestamp', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { time, api, options } = await setup(t);
  let rejectUpload;
  let blocked = true;
  const store = createPinataStateStore({ ...options, fetchImpl: (url, init = {}) => {
    if (blocked && init.method === 'POST') {
      blocked = false;
      return new Promise((_resolve, reject) => { rejectUpload = reject; });
    }
    return api.fetchImpl(url, init);
  } });
  t.after(() => store.close());
  store.schedule({ count: 1 });
  const flushing = store.flush();
  const failed = assert.rejects(flushing, /offline/);
  await new Promise(resolve => setImmediate(resolve));
  const critical = store.save({ count: 2 });
  rejectUpload(new Error('offline'));
  await failed;
  const uri = await critical;
  await store.flush();
  assert.equal(store.getLatestSnapshotUri(), uri);
  assert.deepEqual(api.uploads.map(file => file.snapshot.count), [2]);
  assert.equal(api.uploads[0].snapshot._checkpoint.savedAt, new Date(time.now()).toISOString());
});

test('restoring after downtime seeds today but does not fabricate the missed days', async t => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const { store, time, api, options } = await setup(t);
  await store.save({ retained: [1, 2, 3] });
  store.close();
  time.jump('2026-10-20T16:00:00Z');
  const restarted = createPinataStateStore(options);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.restore(), { retained: [1, 2, 3] });
  await time.advance(300000);
  assert.deepEqual(api.files.map(file => file.keyvalues.checkpointDay).sort(), ['2026-10-17', '2026-10-20']);
});

test('daily pruning is bounded, drains paginated backlogs without reuploading, and protects malformed policy tags', async t => {
  const { store, api } = await setup(t);
  const keyvalues = { ...tags, checkpointPolicy: 'daily-v1', checkpointDay: '2026-10-01',
    checkpointTimeZone: 'America/New_York' };
  for (let index = 0; index < 23; index++) api.files.push({ id: `old-${index}`, cid: `old-${index}`,
    name, keyvalues, group_id: 'live', created_at: '2026-10-01T12:00:00Z' });
  api.files.push({ id: 'invalid-day', cid: 'unknown', name, keyvalues: { ...keyvalues, checkpointDay: '2026-02-30' },
    group_id: 'live' });
  await store.save({ entries: [1] });
  assert.equal(api.deletes.length, 10);
  await store.save({ entries: [1] });
  assert.equal(api.deletes.length, 20);
  await store.save({ entries: [1] });
  assert.equal(api.deletes.length, 23);
  assert.equal(api.uploads.length, 1);
  assert.equal(api.files.length, 2);
  assert.ok(api.files.some(file => file.id === 'invalid-day'));
});

test('checkpoint group provisioning reuses live storage and provisions permanent weekly history', async () => {
  const { ensureCheckpointGroups } = await import('../discord-bot/checkpoint-groups.js');
  const created = [];
  const result = await ensureCheckpointGroups({ pinataJwt: 'test', fetchImpl: async (url, options = {}) => {
    if (options.method === 'POST') {
      created.push(JSON.parse(options.body).name);
      return new Response(JSON.stringify({ data: { id: 'archive' } }));
    }
    return new Response(JSON.stringify({ data: { groups: new URL(url).searchParams.get('name').includes('Live')
      ? [{ id: 'live', name: 'DecentBusking - Live checkpoints' }] : [] } }));
  } });
  assert.deepEqual(result, { groupId: 'live', archiveGroupId: 'archive', retentionDays: 7 });
  assert.deepEqual(created, ['DecentBusking - Weekly archives']);
});

test('legacy cleanup inventory is read-only, paginated and excludes media and unknown filenames', async () => {
  const { inventoryCheckpoints } = await import('../discord-bot/checkpoint-inventory.js');
  const files = Array.from({ length: 8 }, (_, index) => ({
    id: `id-${index}`, cid: `cid-${index}`, name: 'decentbusking-fund-ledger.json',
    mime_type: 'application/json', keyvalues: { app: 'decentbusking' },
    created_at: new Date(Date.now() - index * 1000).toISOString(),
  }));
  let calls = 0;
  const result = await inventoryCheckpoints({ pinataJwt: 'test', fetchImpl: async (url, options) => {
    assert.equal(options.method, undefined);
    calls++;
    const first = !new URL(url).searchParams.has('pageToken');
    return new Response(JSON.stringify({ data: { files: first ? files.slice(0, 4) : [...files.slice(4),
      { name: 'decentbusking-ad.mp4', mime_type: 'video/mp4' },
      { name: 'decentbusking-unknown.json', mime_type: 'application/json', keyvalues: { app: 'decentbusking' } }],
    next_page_token: first ? 'next' : null } }));
  } });
  assert.equal(calls, 2);
  assert.equal(result.dryRun, true);
  assert.equal(result.checkpointFiles, 8);
  assert.equal(result.untouchedFiles, 2);
  assert.equal(result.retentionDays, 7);
  assert.equal(result.groups[0].keep.length, 1);
  assert.equal(result.groups[0].reviewBeforeRemoval.length, 7);
});
