const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

test('separate worker processes cannot both commit the same promotions revision', async t => {
  const file = path.join(__dirname, `.promotions-workers-${randomUUID()}.sqlite`);
  const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/promotions-store.js')).href;
  const { initializePromotionStore, createPromotionStore } = await import(moduleUrl);
  await initializePromotionStore({ file });
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map(async worker => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = new Promise(resolve => worker.once('exit', resolve));
      worker.kill();
      await exited;
    }));
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  });
  const code = `
    const workerData = JSON.parse(process.argv[1]);
    (async () => {
      const { createPromotionStore } = await import(workerData.moduleUrl);
      const store = await createPromotionStore({ file: workerData.file,
        checkpoint: { restore: async () => null, getLatestSnapshotUri: () => '',
          save: async () => 'ipfs://public-checkpoint' } });
      const state = await store.restore();
      state.revision++;
      state.marker = workerData.marker;
      process.send('ready');
      process.once('message', async () => {
        try { await store.save(state, 0); process.send('saved'); }
        catch (error) { process.send(error.code || error.message); }
        finally { store.close(); process.disconnect(); }
      });
    })().catch(error => { throw error; });
  `;
  const launch = marker => new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, ['-e', code, JSON.stringify({ moduleUrl, file, marker })],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    workers.push(worker);
    let stderr = '';
    worker.stderr.on('data', bytes => { stderr += bytes; });
    worker.once('exit', code => { if (code) reject(new Error(stderr)); });
    worker.once('error', reject);
    worker.once('message', message => message === 'ready' ? resolve(worker) : reject(new Error(String(message))));
  });
  const [first, second] = await Promise.all([launch('first'), launch('second')]);
  const result = worker => new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const results = [result(first), result(second)];
  first.send('go');
  second.send('go');
  assert.deepEqual((await Promise.all(results)).sort(), ['PROMOTIONS_STALE', 'saved']);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file);
  const saved = JSON.parse(database.prepare('SELECT state FROM promotions_state WHERE id = 1').get().state);
  database.close();
  const restored = await createPromotionStore({ file, checkpoint: {
    restore: async () => saved, getLatestSnapshotUri: () => 'ipfs://public-checkpoint',
    save: async () => { throw new Error('No write expected'); },
  } });
  try {
    const state = await restored.restore();
    assert.equal(state.revision, 1);
    assert.ok(['first', 'second'].includes(state.marker));
  } finally { restored.close(); }
});

test('public Pinata checkpoints recover an uncertain upload without allowing a stale journal', async t => {
  const { initializePromotionStore, createPromotionStore } = await import('../discord-bot/promotions-store.js');
  const file = path.join(__dirname, `.promotions-recovery-${randomUUID()}.sqlite`);
  t.after(() => { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });
  let remote = null, failUpload = true;
  const checkpoint = {
    restore: async () => structuredClone(remote),
    getLatestSnapshotUri: () => 'ipfs://public-recovery',
    save: async value => {
      remote = structuredClone(value);
      if (failUpload) throw new Error('Upload response lost');
      return 'ipfs://public-recovery';
    },
  };
  await initializePromotionStore({ file });
  let store = await createPromotionStore({ file, checkpoint });
  const otherProcess = await createPromotionStore({ file, checkpoint });
  const next = { ...await store.restore(), revision: 1 };
  await assert.rejects(store.save(next, 0), /response lost/);
  await assert.rejects(store.restore(), /publication is pending/);
  await assert.rejects(otherProcess.restore(), /publication is pending/);
  await assert.rejects(otherProcess.save(next, 0), { code: 'PROMOTIONS_STALE' });
  otherProcess.close();
  store.close();
  store = await createPromotionStore({ file, checkpoint });
  assert.equal((await store.restore()).revision, 1, 'restart restores uploaded state instead of repeating it');
  assert.equal(store.getCheckpointUri(), 'ipfs://public-recovery');
  await assert.rejects(store.save(next, 0), { code: 'PROMOTIONS_STALE' });
  failUpload = false;
  await store.save({ ...next, revision: 2 }, 1);
  store.close();
  remote = next;
  await assert.rejects(createPromotionStore({ file, checkpoint }), /stale or inconsistent/);
  remote = null;
  await assert.rejects(createPromotionStore({ file, checkpoint }), /missing/);
});

test('a crash before upload republishes the exact pending state before reopening writes', async t => {
  const { initializePromotionStore, createPromotionStore } = await import('../discord-bot/promotions-store.js');
  const file = path.join(__dirname, `.promotions-before-upload-${randomUUID()}.sqlite`);
  t.after(() => { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });
  const checkpoint = { restore: async () => null, getLatestSnapshotUri: () => '',
    save: async () => { throw new Error('Offline before upload'); } };
  await initializePromotionStore({ file });
  let store = await createPromotionStore({ file, checkpoint });
  const pending = { ...await store.restore(), revision: 1 };
  await assert.rejects(store.save(pending, 0), /Offline/);
  store.close();
  let publications = 0;
  checkpoint.save = async value => {
    assert.deepEqual(value, pending);
    publications++;
    return 'ipfs://recovered-publication';
  };
  store = await createPromotionStore({ file, checkpoint });
  try {
    assert.equal(publications, 1);
    assert.deepEqual(await store.restore(), pending);
  } finally { store.close(); }
});

test('Pinata outage or missing acknowledgement prevents journal commits', async t => {
  const { initializePromotionStore, createPromotionStore } = await import('../discord-bot/promotions-store.js');
  const file = path.join(__dirname, `.promotions-unavailable-${randomUUID()}.sqlite`);
  t.after(() => { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true }); });
  await initializePromotionStore({ file });
  const checkpoint = { restore: async () => null, getLatestSnapshotUri: () => '',
    save: async () => '' };
  const store = await createPromotionStore({ file, checkpoint });
  try {
    const next = { ...await store.restore(), revision: 1 };
    await assert.rejects(store.save(next, 0), /did not confirm/);
    await assert.rejects(store.restore(), /publication is pending/);
    checkpoint.save = async () => { throw new Error('Pinata unavailable'); };
    await assert.rejects(store.save(next, 0), { code: 'PROMOTIONS_STALE' });
    await assert.rejects(store.restore(), /publication is pending/);
  } finally { store.close(); }
  await assert.rejects(createPromotionStore({ file, checkpoint }), /Pinata unavailable/);
  checkpoint.restore = async () => { throw new Error('Pinata listing unavailable'); };
  await assert.rejects(createPromotionStore({ file, checkpoint }), /listing unavailable/);
});
