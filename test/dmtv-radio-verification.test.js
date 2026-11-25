const test = require('node:test');
const assert = require('node:assert/strict');

const program = { playId: 'radio:123', ipfsCid: 'bafy' + 'a'.repeat(50), expectedMs: 2000 };

test('radio verifier binds results to the play and requires at least half the duration', async () => {
  const { createDmtvRadioVerification } = await import('../discord-bot/dmtv-radio-verification.js');
  for (const [syncedMs, expected] of [[999, false], [1000, true]]) {
    let time = 0;
    const verifier = createDmtvRadioVerification({ now: () => time, log: { warn() {} } });
    assert.equal(verifier.ready(), false);
    verifier.exchange({ version: 1, ready: true });
    const outcome = verifier.start(program);
    const { job } = verifier.exchange({ version: 1, ready: true, result: { id: 'old', syncedMs: 2000 } });
    assert.equal(job.playId, program.playId);
    time = 1000;
    verifier.exchange({ version: 1, ready: true, result: { id: job.id, syncedMs } });
    assert.equal(await outcome, expected);
    time = 14000;
    assert.equal(verifier.ready(), false);
  }
});

test('radio verifier rejects impossible duration claims and cannot settle an unverified audio completion', async () => {
  const { createDmtvRadioVerification, attachDmtvRadioVerification } = await import('../discord-bot/dmtv-radio-verification.js');
  const verifier = createDmtvRadioVerification({ now: () => 0, log: { warn() {} } });
  verifier.exchange({ version: 1, ready: true });
  const outcome = verifier.start(program);
  const { job } = verifier.exchange({ version: 1, ready: true });
  verifier.exchange({ version: 1, ready: true, result: { id: job.id, syncedMs: 1000 } });
  assert.equal(await outcome, false);
  let refunds = 0;
  const queue = attachDmtvRadioVerification({
    completeVerifiedRadio() { assert.fail('audio alone cannot settle'); },
    fail() { refunds++; },
  }, verifier);
  await queue.complete({}, { finished: true, audibleMs: 2000 });
  assert.equal(refunds, 1);
});

test('sample-derived fractional durations use the same exact half-playback threshold', async () => {
  const { createDmtvRadioVerification } = await import('../discord-bot/dmtv-radio-verification.js');
  let time = 0;
  const verifier = createDmtvRadioVerification({ now: () => time, log: { warn() {} } });
  verifier.exchange({ version: 1, ready: true });
  const outcome = verifier.start({ ...program, expectedMs: 2000.5 });
  const { job } = verifier.exchange({ version: 1, ready: true });
  assert.ok(job);
  time = 1001;
  verifier.exchange({ version: 1, ready: true, result: { id: job.id, syncedMs: 1000.25 } });
  assert.equal(await outcome, true);
});

test('50% radio evidence settles once before ingest ends and failure below 50% refunds', async () => {
  const { attachDmtvRadioVerification } = await import('../discord-bot/dmtv-radio-verification.js');
  for (const ok of [true, false]) {
    let resolve, settled = 0, refunded = 0;
    const queue = attachDmtvRadioVerification({
      completeVerifiedRadio(record, playId) { assert.equal(playId, program.playId); settled++; },
      fail() { refunded++; },
    }, { start: () => new Promise(r => { resolve = r; }) });
    const record = {};
    queue.startPlayback(record, program);
    queue.startPlayback(record, program);
    resolve(ok);
    await queue.complete(record);
    await queue.release(record);
    assert.equal(settled, ok ? 1 : 0);
    assert.equal(refunded, ok ? 0 : 1);
  }
});

test('synced playback counts unique rendered intervals, not seeks, freezes or audio-only time', async () => {
  const { createSyncedPlaybackMeter } = await import('../js/dmtv-radio-proof.mjs');
  const meter = createSyncedPlaybackMeter(2000);
  const sample = (position, time = position, audioTime = position, frameTime = position) =>
    meter({ position, time, audioTime, frameTime });
  assert.equal(sample(0), 0);
  for (let i = 200; i <= 1000; i += 200) sample(i);
  assert.equal(sample(1000, 1200, 1000, 1000), 1000);
  assert.equal(sample(2000, 1400, 2000, 2000), 1000);
  assert.equal(sample(500, 1600), 1000);
  assert.equal(sample(700, 1800), 1000);
  assert.equal(sample(900, 2000, 700, 700), 1000);
  meter(null);
  assert.equal(sample(1100, 2200), 1000);
  assert.equal(sample(1300, 2400), 1200);
});

test('real Chrome verifies half a public HLS play with decoded video and rejects missing video', { timeout: 50_000 }, async () => {
  const { spawn, spawnSync } = require('node:child_process');
  const { createServer } = require('node:http');
  const { mkdtemp, readFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const { createRequire } = require('node:module');
  const { createRadioProofBrowser } = await import('../discord-bot/dmtv-radio-verifier-client.js');
  const requireBot = createRequire(require.resolve('../discord-bot/package.json'));
  const dir = await mkdtemp(join(tmpdir(), 'dmtv-proof-test-'));
  const mp4 = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24:d=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  assert.equal(mp4.status, 0, mp4.stderr.toString());
  const encoder = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45',
    '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '30',
    '-hls_flags', 'program_date_time+temp_file', join(dir, 'index.m3u8')], { stdio: 'ignore' });
  let base, start, missing = false, player;
  const run = 'a'.repeat(32);
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/radio') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ publicBroadcast: { selected: true, status: 'ready',
          url: `${base}/hls/${run}/index.m3u8`,
          programHistory: [{ at: start, playId: 'lead-in', mediaType: 'audio/mp4' },
            { ...program, at: start + 4000, mediaType: 'video/mp4' }] } }));
      } else if (url.pathname === '/api/radio/hls-client.js') {
        res.setHeader('content-type', 'application/javascript');
        res.end(await readFile(requireBot.resolve('hls.js')));
      } else if (url.pathname === '/api/radio/media') {
        if (missing) { res.writeHead(404).end(); return; }
        const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const from = range ? Number(range[1]) : 0;
        const to = range?.[2] ? Math.min(Number(range[2]), mp4.stdout.length - 1) : mp4.stdout.length - 1;
        res.setHeader('content-type', 'video/mp4');
        res.setHeader('accept-ranges', 'bytes');
        res.setHeader('content-length', to - from + 1);
        if (range) res.writeHead(206, { 'content-range': `bytes ${from}-${to}/${mp4.stdout.length}` });
        res.end(mp4.stdout.subarray(from, to + 1));
      } else if (new RegExp(`^/hls/${run}/(?:index\\.m3u8|index\\d+\\.ts)$`).test(url.pathname)) {
        res.setHeader('content-type', url.pathname.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl');
        res.end(await readFile(join(dir, url.pathname.split('/').at(-1))));
      } else res.writeHead(404).end();
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(error);
      res.writeHead(404).end();
    }
  });
  try {
    // HTTPS matches the public listener's production URL validation.
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const actualBase = `http://127.0.0.1:${server.address().port}`;
    base = 'https://radio-fixture.example';
    for (let i = 0; i < 80 && !start; i++) {
      try { start = Date.parse((await readFile(join(dir, 'index.m3u8'), 'utf8')).match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/)[1]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!start) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(start);
    player = await createRadioProofBrowser(process.env.DMTV_CHROME_EXECUTABLE ||
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'));
    await player.page.route(`${base}/**`, async route => {
      await route.fulfill({ response: await route.fetch({
        url: route.request().url().replace(base, actualBase),
      }) });
    });
    const job = { ...program, expectedMs: 12000, deadline: Date.now() + 25000 };
    const verified = await player.verify(job, base);
    assert.ok(verified >= 6000 && verified < 12000, `expected half a rendered play, got ${verified}ms`);
    missing = true;
    assert.equal(await player.verify({ ...job, deadline: Date.now() + 7000 }, base), 0);
  } finally {
    await player?.close();
    encoder.kill();
    if (encoder.exitCode === null) await new Promise(resolve => encoder.once('exit', resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('in-service verifier passes only its own secret and restarts with backoff', async () => {
  const { EventEmitter } = require('node:events');
  const { startInServiceRadioVerifier } = await import('../discord-bot/dmtv-radio-verifier-service.js');
  const log = { info() {}, error() {} };
  const env = { DMTV_RADIO_VERIFIER_IN_SERVICE: 'true', RENDER_EXTERNAL_URL: 'https://busk.example',
    DMTV_VERIFIER_SECRET: 'v'.repeat(32), CHECKPOINT_MIRROR_SECRET: 'm'.repeat(32), PINATA_JWT: 'jwt', PATH: '/bin' };
  const chrome = async () => ({ executablePath: '/chrome', libraryPath: '/libs' });
  assert.equal(await startInServiceRadioVerifier({ env: { ...env, DMTV_RADIO_VERIFIER_IN_SERVICE: 'false' }, log }), null);
  assert.equal(await startInServiceRadioVerifier({ env, log, readChrome: async () => { throw new Error('missing'); } }), null);

  const children = [];
  const spawnChild = (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { options, kill() {} });
    children.push(child);
    return child;
  };
  const service = await startInServiceRadioVerifier({ env, log, spawnChild, readChrome: chrome, minDelayMs: 1, maxDelayMs: 4 });
  assert.deepEqual(children[0].options.env, { PATH: '/bin', PUBLIC_WORKER_URL: 'https://busk.example',
    DMTV_VERIFIER_SECRET: 'v'.repeat(32), DMTV_CHROME_EXECUTABLE: '/chrome', DMTV_CHROME_LIBRARY_PATH: '/libs' });
  children[0].emit('exit', 1, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(children.length, 2);
  service.stop();
  children[1].emit('exit', null, 'SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(children.length, 2);
});

test('verifier Chrome installer maps missing shared libraries to Debian packages', async () => {
  const { missingLibraries, packagesForLibraries } = await import('../discord-bot/dmtv-verifier-chrome.js');
  const missing = missingLibraries('\tlibnss3.so => not found\n\tlibc.so.6 => /lib/libc.so.6\n\tlibnssutil3.so => not found\n');
  assert.deepEqual(missing, ['libnss3.so', 'libnssutil3.so']);
  assert.deepEqual(packagesForLibraries(missing), ['libnss3']);
  assert.throws(() => packagesForLibraries(['libunknown.so.9']), /No Debian package/);
});
