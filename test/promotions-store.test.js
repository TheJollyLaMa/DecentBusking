const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

test('separate worker processes cannot both commit the same promotions revision', async t => {
  const file = path.join(__dirname, `.promotions-workers-${randomUUID()}.sqlite`);
  const keyHex = '47'.repeat(32);
  const moduleUrl = pathToFileURL(path.join(__dirname, '../discord-bot/promotions-store.js')).href;
  const { initializePromotionStore, createPromotionStore } = await import(moduleUrl);
  await initializePromotionStore({ file, keyHex });
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
      const store = await createPromotionStore({ file: workerData.file, keyHex: workerData.keyHex });
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
    const worker = spawn(process.execPath, ['-e', code, JSON.stringify({ moduleUrl, file, keyHex, marker })],
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
  const restored = await createPromotionStore({ file, keyHex });
  try {
    const state = await restored.restore();
    assert.equal(state.revision, 1);
    assert.ok(['first', 'second'].includes(state.marker));
  } finally { restored.close(); }
});
