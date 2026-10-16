const test = require('node:test');
const assert = require('node:assert/strict');

test('grouped checkpoints retain five complete states, archive weekly and never prune legacy or media files', async () => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  const tags = { app: 'decentbusking', kind: 'test-state', schema: '1' };
  const name = 'decentbusking-test-state.json';
  const uploads = [];
  const deletes = [];
  const archives = [];
  let now = Date.parse('2026-10-16T12:00:00Z');
  const files = Array.from({ length: 7 }, (_, i) => ({ id: `file-${i}`, cid: `cid-${i}`,
    name, group_id: 'live', keyvalues: tags, created_at: new Date(now - i * 1000).toISOString() }));
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      const form = options.body;
      const uploaded = { name: form.get('name'), group: form.get('group_id'),
        data: JSON.parse(await form.get('file').text()), tags: JSON.parse(form.get('keyvalues')) };
      uploads.push(uploaded);
      if (uploaded.group === 'archive') archives.push({ name: uploaded.name, group_id: 'archive', keyvalues: uploaded.tags });
      return new Response(JSON.stringify({ data: { cid: `uploaded-${uploads.length}` } }));
    }
    if (options.method === 'DELETE') { deletes.push(url); return new Response('{}'); }
    const parsed = new URL(url);
    if (parsed.searchParams.get('group') === 'archive') {
      return new Response(JSON.stringify({ data: { files: archives } }));
    }
    const page = parsed.searchParams.get('pageToken');
    const mixed = page ? files.slice(4) : [
      { id: 'legacy', cid: 'old', name, keyvalues: tags },
      { id: 'media', cid: 'video', name: 'video.mp4', group_id: 'live', keyvalues: tags },
      ...files.slice(0, 4),
    ];
    return new Response(JSON.stringify({ data: { files: mixed, next_page_token: page ? null : 'page-2' } }));
  };
  const options = { pinataJwt: 'test', groupId: 'live', archiveGroupId: 'archive',
    name, tags, fetchImpl, serialize: value => value, now: () => now };
  const state = { schemaVersion: 1, entries: [{ txHash: 'first' }, { txHash: 'second' }] };
  const store = createPinataStateStore(options);
  await store.save(state);
  assert.deepEqual(uploads[0].data, state);
  assert.deepEqual(uploads[1].data.snapshot, state);
  assert.equal(uploads[1].data.sourceSnapshotUri, 'ipfs://uploaded-1');
  assert.equal(uploads[1].data.week, '2026-10-12');
  assert.deepEqual(deletes.map(url => url.split('/').pop()).sort(), ['file-5', 'file-6']);
  await store.save(state);
  assert.equal(uploads.filter(file => file.group === 'archive').length, 1);
  const restarted = createPinataStateStore(options);
  await restarted.save(state);
  assert.equal(uploads.filter(file => file.group === 'archive').length, 1);
  now += 7 * 86400_000;
  await restarted.save({ ...state, entries: [...state.entries, { txHash: 'third' }] });
  assert.equal(uploads.filter(file => file.group === 'archive').length, 2);
  assert.equal(uploads.at(-1).data.snapshot.entries.length, 3);
});

test('archive failure prevents pruning, remains explicit and retries on next save', async () => {
  const { createPinataStateStore } = await import('../discord-bot/ipfs-state.js');
  let fail = true;
  let deletes = 0;
  let archives = 0;
  const store = createPinataStateStore({ pinataJwt: 'test', groupId: 'live', archiveGroupId: 'archive',
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST') {
        if (options.body.get('group_id') === 'archive') {
          archives++;
          if (fail) return new Response('{}', { status: 503 });
        }
        return new Response(JSON.stringify({ data: { cid: 'saved' } }));
      }
      if (options.method === 'DELETE') deletes++;
      return new Response(JSON.stringify({ data: { files: [] } }));
    } });
  await assert.rejects(store.save([{ trackId: 'preserved' }]), /503/);
  assert.equal(deletes, 0);
  fail = false;
  assert.equal(await store.save([{ trackId: 'preserved' }]), 'ipfs://saved');
  assert.equal(archives, 2);
});

test('checkpoint group provisioning reuses existing groups and creates only missing groups', async () => {
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
  assert.deepEqual(result, { groupId: 'live', archiveGroupId: 'archive', retainSnapshots: 5 });
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
  assert.equal(result.groups[0].keep.length, 5);
  assert.equal(result.groups[0].reviewBeforeRemoval.length, 3);
});
