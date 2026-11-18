const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('edge publishes only authenticated, bounded, short-lived objects; expiry is not a public archive', async () => {
  const { handleBroadcastRequest } = await import('../cloudflare/broadcast-worker.mjs');
  const token = 't'.repeat(40), key = `hls/${'a'.repeat(32)}/segment-000000001.ts`;
  const objects = new Map(), time = 1700000000000;
  const env = {
    BROADCAST_UPLOAD_TOKEN: token,
    BROADCAST_RATE_LIMITER: { limit: async () => ({ success: true }) },
    BROADCAST_BUCKET: {
      put: async (name, body, options) => objects.set(name, { body, ...options }),
      get: async name => objects.get(name),
    },
  };
  const request = (method, headers = {}, body) => new Request(`https://edge.example/${key}`, { method, headers, body });
  assert.equal((await handleBroadcastRequest(request('PUT', {}, 'no'), env, {}, () => time)).status, 403);
  const auth = { authorization: `Bearer ${token}`, 'x-broadcast-expires-at': String(time + 120000) };
  assert.equal((await handleBroadcastRequest(request('PUT', auth, 'audio'), env, {}, () => time)).status, 204);
  const read = await handleBroadcastRequest(request('GET'), env, {}, () => time);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), 'audio');
  assert.equal(read.headers.get('access-control-allow-origin'), '*');
  assert.match(read.headers.get('cache-control'), /max-age=30, must-revalidate/);
  assert.equal((await handleBroadcastRequest(request('HEAD'), env, {}, () => time)).body, null);
  assert.equal((await handleBroadcastRequest(request('GET'), env, {}, () => time + 120001)).status, 404);
  assert.equal((await handleBroadcastRequest(request('PUT', { ...auth,
    'x-broadcast-expires-at': String(time + 121000) }, 'audio'), env, {}, () => time)).status, 400);
  assert.equal((await handleBroadcastRequest(request('PUT', auth, Buffer.alloc(256001)), env, {}, () => time)).status, 413);
  assert.equal((await handleBroadcastRequest(new Request('https://edge.example/hls/private-recording'), env, {})).status, 404);
  const stateUrl = `https://edge.example/hls/${'a'.repeat(32)}/state.json`;
  assert.equal((await handleBroadcastRequest(new Request(stateUrl, {
    method: 'PUT', headers: auth, body: JSON.stringify({ publicBroadcast: { status: 'ready' } }),
  }), env, {}, () => time)).status, 204);
  const state = await handleBroadcastRequest(new Request(stateUrl), env, {}, () => time);
  assert.match(state.headers.get('content-type'), /application\/json/);
  assert.match(state.headers.get('cache-control'), /max-age=1, must-revalidate/);
  assert.equal((await state.json()).publicBroadcast.status, 'ready');
  assert.equal((await handleBroadcastRequest(new Request(stateUrl), env, {}, () => time + 120001)).status, 404);
  env.BROADCAST_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await handleBroadcastRequest(request('GET'), env, {}, () => time)).status, 429);
});

test('public state reads coalesce but expired failures never become stale successes', async () => {
  const { createBroadcastStateReader } = await import('../discord-bot/public-broadcast.js');
  let at = 1000, reads = 0, reject = false;
  const read = createBroadcastStateReader(async () => {
    reads++;
    if (reject) throw new Error('Public state unavailable');
    await wait(5);
    return { generation: reads };
  }, { now: () => at });
  const snapshots = await Promise.all(Array.from({ length: 200 }, () => read()));
  assert.equal(reads, 1);
  assert.ok(snapshots.every(snapshot => snapshot === snapshots[0]));
  at += 1001; reject = true;
  await assert.rejects(read, /unavailable/);
  await assert.rejects(read, /unavailable/);
  reject = false;
  assert.equal((await read()).generation, 4);
});

test('publisher sends segments before their playlist and redacts private headers and URL redirects', async () => {
  const { createBroadcastUploader, parseBroadcastPlaylist, stereoPcm } = await import('../discord-bot/public-broadcast.js');
  assert.throws(() => createBroadcastUploader({ baseUrl: 'http://edge.example', token: 't'.repeat(40) }));
  const calls = [];
  const uploader = createBroadcastUploader({ baseUrl: 'https://edge.example', token: 't'.repeat(40),
    now: () => 1000, fetchImpl: async (url, input) => {
      calls.push({ url, input }); return new Response(null, { status: 204 });
    } });
  await uploader.put(`${'a'.repeat(32)}/segment-000000001.ts`, Buffer.from('audio'), 'video/mp2t');
  assert.equal(calls[0].input.redirect, 'error');
  assert.equal(calls[0].input.headers['x-broadcast-expires-at'], '121000');
  await assert.rejects(() => uploader.put('../recordings/private', Buffer.alloc(1), 'audio/wav'));
  assert.throws(() => parseBroadcastPlaylist('#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01\nhttps://private/token\n'));
  assert.deepEqual([...stereoPcm({ sampleRate: 48000, channels: 1, samplesPerChannel: 2,
    data: new Int16Array([100, -100]) })], [100, 0, 100, 0, 156, 255, 156, 255]);
});

test('transient object uploads retry identical bytes inside one deadline without disclosing credentials', async () => {
  const { createBroadcastUploader } = await import('../discord-bot/public-broadcast.js');
  const calls = [], warnings = [], bytes = Buffer.from('audio'), token = 't'.repeat(40);
  const uploader = createBroadcastUploader({ baseUrl: 'https://edge.example', token,
    log: { warn: (...args) => warnings.push(args) },
    fetchImpl: async (url, input) => {
      calls.push({ url, input });
      if (calls.length === 1) throw new TypeError('private request details');
      return new Response(null, { status: calls.length === 2 ? 503 : 204 });
    } });
  await uploader.put(`${'a'.repeat(32)}/segment-000000001.ts`, bytes, 'video/mp2t');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url === calls[0].url && call.input.body === bytes &&
    call.input.signal === calls[0].input.signal && call.input.redirect === 'error'));
  assert.equal(warnings.length, 2);
  assert.ok(!JSON.stringify(warnings).includes('private'));
  assert.ok(!JSON.stringify(warnings).includes(token));
  let failedAttempts = 0;
  const offline = createBroadcastUploader({ baseUrl: 'https://edge.example', token,
    log: { warn() {} }, fetchImpl: async () => { failedAttempts++; throw new TypeError('Network unavailable'); } });
  await assert.rejects(offline.put(`${'a'.repeat(32)}/state.json`, bytes, 'application/json'), TypeError);
  assert.equal(failedAttempts, 3);
  for (const status of [400, 403, 429]) {
    let attempts = 0;
    const denied = createBroadcastUploader({ baseUrl: 'https://edge.example', token,
      log: { warn: () => assert.fail('Permanent failures must not retry') },
      fetchImpl: async () => {
        attempts++;
        const response = new Response('Denied', { status });
        if (status === 403) response.body.cancel = async () => { throw new TypeError('Cleanup failed'); };
        return response;
      } });
    await assert.rejects(denied.put(`${'a'.repeat(32)}/state.json`, bytes, 'application/json'),
      error => error.status === status);
    assert.equal(attempts, 1);
  }
});

test('upload retry never restarts the original eight-second deadline', { timeout: 12000 }, async () => {
  const { createBroadcastUploader } = await import('../discord-bot/public-broadcast.js');
  const signals = [];
  const uploader = createBroadcastUploader({ baseUrl: 'https://edge.example', token: 't'.repeat(40),
    log: { warn() {} }, fetchImpl: async (_url, input) => {
      signals.push(input.signal);
      if (signals.length === 1) return new Response(null, { status: 503 });
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Shared upload deadline was not honored')), 9000);
        input.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(input.signal.reason);
        }, { once: true });
      });
    } });
  await assert.rejects(uploader.put(`${'a'.repeat(32)}/state.json`, Buffer.from('{}'), 'application/json'),
    error => error.name === 'TimeoutError');
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[1].aborted, true);
});

test('publication failure identifies the exact stage and safe status without exposing the underlying error', async () => {
  const { createPublicBroadcast } = await import('../discord-bot/public-broadcast.js');
  const { writeFile } = require('node:fs/promises');
  const { dirname, join } = require('node:path');
  const encoder = new EventEmitter(), messages = [];
  encoder.stdin = new PassThrough();
  encoder.kill = () => { encoder.emit('close'); return true; };
  let playlist;
  const broadcaster = createPublicBroadcast({ enabled: true,
    spawnImpl: (_command, args) => { playlist = args.at(-1); return encoder; },
    uploader: { baseUrl: 'https://edge.example', put: async () => {
      throw Object.assign(new Error('private token and filesystem path'), { status: 503 });
    } },
    log: { error: (...args) => messages.push(args) },
  });
  try {
    await broadcaster.start();
    await writeFile(join(dirname(playlist), 'segment-000000000.ts'), 'audio');
    await writeFile(playlist, '#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-11-18T00:00:00Z\nsegment-000000000.ts\n');
    for (let count = 0; count < 100 && broadcaster.snapshot().status !== 'unavailable'; count++) await wait(10);
    assert.equal(broadcaster.snapshot().reason, 'EDGE_PUBLISH_FAILED');
    assert.deepEqual(broadcaster.snapshot().reasonDetails, { stage: 'segment-upload', httpStatus: 503 });
    assert.ok(!JSON.stringify(messages).includes('private'));
  } finally { await broadcaster.stop(); }
});

test('native HLS listener never joins LiveKit and follows programme timestamps across an ended live set', async () => {
  const { createPublicBroadcastListener, getAudibleBroadcast } = await import('../js/public-broadcast-client.mjs');
  let time = 50000, paused = true;
  const audio = { currentTime: 16, readyState: 4, muted: false, volume: 1,
    get paused() { return paused; }, canPlayType: () => 'probably',
    getStartDate: () => new Date(10000), play: async () => { paused = false; },
    pause: () => { paused = true; }, removeAttribute() {}, load() {} };
  const programs = [], grants = [];
  const client = createPublicBroadcastListener({ audio, serviceUrl: 'https://api.example', now: () => time,
    sdkLoader: () => { throw new Error('No LiveKit or HLS SDK needed on native Safari'); },
    request: async (_url, route, input) => { grants.push({ route, input }); return {}; },
    telemetry: {}, onProgram: program => programs.push(program) });
  const state = { selected: true, status: 'ready', url: `https://edge.example/hls/${'a'.repeat(32)}/index.m3u8`,
    programHistory: [{ at: 10000, playId: 'live:a', bookingId: 'a', live: true, title: 'A' },
      { at: 30000, playId: 'outro', title: 'Ad' }] };
  client.update(state);
  await wait(5);
  client.update(state);
  assert.equal(programs.at(-1).playId, 'live:a');
  assert.equal(getAudibleBroadcast(time).at, 26000);
  assert.equal(grants[0].input.transport, 'hls');
  assert.equal(audio.src, state.url);
  audio.currentTime = 22;
  client.update(state);
  assert.equal(programs.at(-1).playId, 'outro');
  assert.equal(audio.src, state.url, 'outro must not replace the stream or cut the buffered tail');
  client.stop();
  assert.equal(getAudibleBroadcast(time), null);
});

test('failed or late HLS attachment cannot take over an archive, and never silently falls back', async () => {
  const { createPublicBroadcastListener } = await import('../js/public-broadcast-client.mjs');
  let resolveSdk, attached = 0;
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    static ErrorTypes = {};
    on() {}
    loadSource() { attached++; }
    attachMedia() {}
    destroy() {}
  }
  const audio = { canPlayType: () => '', pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const client = createPublicBroadcastListener({ audio, serviceUrl: 'https://api.example', telemetry: {},
    sdkLoader: () => new Promise(resolve => { resolveSdk = resolve; }) });
  client.update({ selected: true, status: 'ready', url: `https://edge.example/hls/${'a'.repeat(32)}/index.m3u8` });
  client.stop(); resolveSdk(Hls);
  await wait(5);
  assert.equal(attached, 0);
});

test('native-capable Chrome without a programme clock uses Hls.js for exact audible attribution', async () => {
  const { createPublicBroadcastListener, getAudibleBroadcast } = await import('../js/public-broadcast-client.mjs');
  let attached = 0;
  const programs = [];
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    playingDate = new Date(26000);
    on() {}
    loadSource() {}
    attachMedia() { attached++; }
    destroy() {}
  }
  const audio = { currentTime: 16, readyState: 4, paused: false, muted: false, volume: 1,
    canPlayType: () => 'maybe', play: async () => {}, pause() {}, removeAttribute() {}, load() {} };
  const client = createPublicBroadcastListener({ audio, serviceUrl: 'https://api.example', telemetry: {},
    sdkLoader: async () => Hls, now: () => 40000, onProgram: program => programs.push(program) });
  const state = { selected: true, status: 'ready', url: `https://edge.example/hls/${'a'.repeat(32)}/index.m3u8`,
    programHistory: [{ at: 10000, playId: 'live:a', title: 'Artist A' }] };
  client.update(state);
  await wait(5);
  client.update(state);
  assert.equal(attached, 1);
  assert.equal(programs.at(-1).playId, 'live:a');
  assert.equal(getAudibleBroadcast(40000).at, 26000);
  client.stop();
});

test('unsupported AAC reports a browser capability failure without pointless recovery or a LiveKit fallback', async () => {
  const { createPublicBroadcastListener } = await import('../js/public-broadcast-client.mjs');
  let onError, recoveries = 0;
  const reports = [];
  class Hls {
    static isSupported() { return true; }
    static Events = { ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    on(_event, callback) { onError = callback; }
    loadSource() {}
    attachMedia() {}
    destroy() {}
    recoverMediaError() { recoveries++; }
  }
  const audio = { canPlayType: () => '', pause() {}, removeAttribute() {}, load() {}, play: async () => {} };
  const client = createPublicBroadcastListener({ audio, serviceUrl: 'https://api.example', telemetry: {},
    sdkLoader: async () => Hls, onStatus: status => reports.push(status) });
  client.update({ selected: true, status: 'ready', url: `https://edge.example/hls/${'a'.repeat(32)}/index.m3u8` });
  await wait(5);
  onError('error', { fatal: true, type: 'mediaError', details: 'bufferAddCodecError' });
  assert.match(reports.at(-1).reason, /cannot decode the AAC/);
  assert.equal(reports.at(-1).failed, true);
  assert.equal(recoveries, 0);
  client.stop();
});

test('resource samples report real core-time, bytes and event-loop delay rather than invented hosting headroom', async () => {
  const { createRadioResourceMetrics } = await import('../discord-bot/radio-resource-metrics.js');
  let at = 1000, cpu = 1000;
  const metrics = createRadioResourceMetrics({ now: () => at, cpuUsage: () => ({ user: cpu, system: 0 }),
    memoryUsage: () => ({ rss: 120000000, heapUsed: 20000000 }),
    readContainer: async () => ({ available: false, reason: 'Local fixture' }),
    histogram: { enable() {}, disable() {}, reset() {}, percentile: () => 123000000, max: 1944000000 } });
  at += 1000; cpu += 500000;
  assert.deepEqual(await metrics.sample(), { at: 2000, elapsedMs: 1000, cpuCorePercent: 50,
    rssBytes: 120000000, heapUsedBytes: 20000000, eventLoopP99Ms: 123, eventLoopMaxMs: 1944,
    container: { available: false, reason: 'Local fixture' } });
  metrics.stop();
});

test('CPU stall summaries attribute external leaf work to its radio caller without publishing raw profiles', async () => {
  const { summarizeRadioCpuProfile } = await import('../discord-bot/radio-resource-metrics.js');
  const url = new URL('../discord-bot/example.js', `file://${__filename}`).href;
  const frame = (functionName, url = '', lineNumber = -1) => ({ functionName, url, lineNumber });
  const result = summarizeRadioCpuProfile({
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 4] },
      { id: 2, callFrame: frame('checkpoint', url, 41), children: [3] },
      { id: 3, callFrame: frame('hash', 'node:crypto') },
      { id: 4, callFrame: frame('(idle)') },
    ],
    samples: [3, 3, 4], timeDeltas: [10000, 20000, 5000],
  });
  assert.deepEqual(result, [
    { file: 'example.js', line: 42, function: 'checkpoint', sampledMs: 30 },
    { file: '(runtime)', line: 0, function: '(idle)', sampledMs: 5 },
  ]);
  assert.ok(!JSON.stringify(result).includes('file://'));
});

test('preview CPU diagnostics stop after ten windows and retain no raw profile in health', async () => {
  const { createRadioResourceMetrics } = await import('../discord-bot/radio-resource-metrics.js');
  let at = 0;
  const logs = [];
  const metrics = createRadioResourceMetrics({ profileCpu: true, now: () => at,
    cpuUsage: () => ({ user: 0, system: 0 }), memoryUsage: () => ({ rss: 100, heapUsed: 50 }),
    histogram: { enable() {}, disable() {}, reset() {}, percentile: () => 0, max: 600000000 },
    readContainer: async () => ({ available: false }),
    log: { info: (...args) => logs.push(args), error: (...args) => assert.fail(args.join(' ')) },
  });
  try {
    for (let i = 0; i < 11; i++) {
      at += 1000;
      const sample = await metrics.sample();
      assert.equal(sample.eventLoopMaxMs, 600);
      assert.equal(sample.profile, undefined);
    }
    assert.equal(logs.length, 10);
    for (const [label, json] of logs) {
      assert.equal(label, '[radio-cpu-stall]');
      const summary = JSON.parse(json);
      assert.ok(summary.top.length <= 10);
      assert.deepEqual(Object.keys(summary).sort(), ['eventLoopMaxMs', 'top']);
    }
  } finally { metrics.stop(); }
});

test('container headroom normalizes all container CPU and memory against their actual quotas', async () => {
  const { createRadioResourceMetrics } = await import('../discord-bot/radio-resource-metrics.js');
  let at = 0, usage = 1000000;
  const metrics = createRadioResourceMetrics({
    now: () => at, cpuUsage: () => ({ user: 0, system: 0 }),
    memoryUsage: () => ({ rss: 100, heapUsed: 50 }),
    histogram: { enable() {}, disable() {}, reset() {}, percentile: () => 0, max: 0 },
    readContainer: async () => ({ available: true, cpuUsageUs: usage, cpuLimitCores: 0.5,
      memoryBytes: 384 * 1024 * 1024, memoryLimitBytes: 512 * 1024 * 1024 }),
  });
  at = 1000;
  assert.equal((await metrics.sample()).container.cpuQuotaPercent, null);
  at += 1000; usage += 350000;
  const sample = await metrics.sample();
  assert.equal(sample.cpuCorePercent, 0, 'Node-only CPU cannot stand in for FFmpeg/container CPU');
  assert.equal(sample.container.cpuQuotaPercent, 70);
  assert.equal(sample.container.memoryQuotaPercent, 75);
  metrics.stop();
});

test('container memory attribution never subtracts file cache from the frozen quota measurement', async () => {
  const { readContainerResources } = await import('../discord-bot/radio-resource-metrics.js');
  const counters = { 'cpu.stat': 'usage_usec 1000\n', 'cpu.max': '50000 100000\n',
    'memory.current': '500000000\n', 'memory.max': '536870912\n',
    'memory.stat': 'anon 280000000\nfile 200000000\ninactive_file 170000000\n' };
  const read = async path => counters[path.split('/').at(-1)];
  const resources = await readContainerResources({ platform: 'linux', read });
  assert.equal(resources.memoryBytes, 500000000);
  assert.equal(resources.memoryLimitBytes, 536870912);
  assert.deepEqual(resources.memoryBreakdown, { available: true, anonymousBytes: 280000000,
    fileBytes: 200000000, inactiveFileBytes: 170000000 });
  const missing = await readContainerResources({ platform: 'linux', read: async path => {
    if (path.endsWith('memory.stat')) throw Object.assign(new Error('Missing optional counter'), { code: 'ENOENT' });
    return read(path);
  } });
  assert.equal(missing.available, true);
  assert.equal(missing.memoryBytes, resources.memoryBytes);
  assert.deepEqual(missing.memoryBreakdown, { available: false });
});

test('an encoder spawn failure stops explicitly and teardown does not hang', async () => {
  const { createPublicBroadcast } = await import('../discord-bot/public-broadcast.js');
  const process = new EventEmitter();
  process.stdin = new PassThrough();
  process.kill = () => { process.emit('close'); return true; };
  const messages = [];
  const broadcaster = createPublicBroadcast({ enabled: true, uploader: { baseUrl: 'https://edge.example' },
    spawnImpl: () => process, log: { error: (...args) => messages.push(args) } });
  await broadcaster.start();
  process.emit('error', new Error('private/path/credentials'));
  assert.equal(broadcaster.snapshot().status, 'unavailable');
  assert.equal(broadcaster.snapshot().reason, 'ENCODER_START_FAILED');
  assert.ok(!JSON.stringify(messages).includes('credentials'));
  await broadcaster.stop();
});

test('encoder waits for authorized audio, survives wall-clock corrections and fails a real scheduling stall', async t => {
  const { createPublicBroadcast } = await import('../discord-bot/public-broadcast.js');
  const encoder = new EventEmitter();
  encoder.stdin = new PassThrough();
  encoder.kill = () => { encoder.emit('close'); return true; };
  let wall = 1700000000000, elapsed = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const broadcaster = createPublicBroadcast({ enabled: true, uploader: { baseUrl: 'https://edge.example' },
    now: () => wall, monotonicNow: () => elapsed, spawnImpl: () => encoder, log: { error() {} } });
  await broadcaster.start();
  t.after(() => broadcaster.stop());
  elapsed = 60000;
  t.mock.timers.tick(20);
  assert.equal(broadcaster.snapshot().inputBytes, 0);
  assert.notEqual(broadcaster.snapshot().status, 'unavailable', 'catalog restoration before audio is not a programme stall');
  broadcaster.setPolicy({ mode: 'live', bookingId: 'live' });
  broadcaster.liveFrame({ id: 'private', rehearsal: true }, {
    data: new Int16Array(960), channels: 1, sampleRate: 48000, samplesPerChannel: 960,
  });
  t.mock.timers.tick(20);
  assert.equal(broadcaster.snapshot().inputBytes, 0, 'private audio must not start the programme clock');
  broadcaster.liveFrame({ id: 'live' }, {
    data: new Int16Array(960), channels: 1, sampleRate: 48000, samplesPerChannel: 960,
  });
  wall += 1000; elapsed += 20;
  t.mock.timers.tick(20);
  assert.equal(broadcaster.snapshot().inputBytes, 3840);
  assert.notEqual(broadcaster.snapshot().status, 'unavailable');
  wall -= 2000; elapsed += 20;
  t.mock.timers.tick(20);
  assert.equal(broadcaster.snapshot().inputBytes, 7680);
  elapsed += 600;
  t.mock.timers.tick(20);
  assert.equal(broadcaster.snapshot().reason, 'ENCODER_CLOCK_STALLED');
});

test('delayed inter-thread PCM cannot extend the existing one-second audio queue allowance', async t => {
  const { createPublicBroadcast } = await import('../discord-bot/public-broadcast.js');
  const encoder = new EventEmitter();
  encoder.stdin = new PassThrough();
  encoder.kill = () => { encoder.emit('close'); return true; };
  let wall = 1700000000000, elapsed = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const broadcaster = createPublicBroadcast({ enabled: true, uploader: { baseUrl: 'https://edge.example' },
    now: () => wall, monotonicNow: () => elapsed, spawnImpl: () => encoder, log: { error() {} } });
  await broadcaster.start();
  t.after(() => broadcaster.stop());
  broadcaster.setPolicy({ mode: 'live', bookingId: 'live' });
  broadcaster.liveFrame({ id: 'live' }, {
    data: new Int16Array(960), channels: 1, sampleRate: 48000, samplesPerChannel: 960,
  }, -2000);
  wall += 100; elapsed = 20;
  t.mock.timers.tick(20);
  assert.equal(broadcaster.snapshot().reason, 'PCM_BUFFER_LIMIT');
  assert.equal(broadcaster.snapshot().reasonDetails.stage, 'source-age');
  assert.equal(broadcaster.snapshot().inputBytes, 0);
});

test('the real encoder thread survives a blocked application loop without admitting private input', { timeout: 10000 }, async t => {
  const { createPublicBroadcastWorker } = await import('../discord-bot/public-broadcast-worker.js');
  const broadcaster = createPublicBroadcastWorker({ enabled: true, edgeUrl: 'https://edge.example', token: 't'.repeat(40) });
  await broadcaster.start();
  t.after(() => broadcaster.stop());
  broadcaster.setPolicy({ mode: 'live', bookingId: 'live' });
  const frame = { data: new Int16Array(960), channels: 1, sampleRate: 48000, samplesPerChannel: 960 };
  broadcaster.liveFrame({ id: 'live', rehearsal: true }, frame);
  await wait(100);
  assert.equal(broadcaster.snapshot().inputBytes, 0);
  broadcaster.liveFrame({ id: 'live' }, frame);
  const deadline = Date.now() + 2000;
  while (!broadcaster.snapshot().inputBytes && Date.now() < deadline) await wait(20);
  const before = broadcaster.snapshot().inputBytes;
  assert.ok(before > 0);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
  await wait(50);
  assert.notEqual(broadcaster.snapshot().status, 'unavailable');
  assert.ok(broadcaster.snapshot().inputBytes - before >= 48000, 'encoding must continue while the parent is blocked');
  assert.equal(broadcaster.pendingDrain(), true);
});

test('worker-owned credits release without parent acknowledgments while real backlog stays bounded', { timeout: 10000 }, async t => {
  const { createPublicBroadcastWorker } = await import('../discord-bot/public-broadcast-worker.js');
  let credits;
  class Thread extends EventEmitter {
    constructor(_url, { workerData }) {
      super(); credits = workerData.pendingFrames;
      queueMicrotask(() => this.emit('message', { type: 'ready',
        snapshot: { enabled: true, transport: 'hls', status: 'buffering' } }));
    }
    postMessage(message) { if (message.type === 'stop') queueMicrotask(() => this.emit('exit', 0)); }
  }
  const broadcaster = createPublicBroadcastWorker({ enabled: true, edgeUrl: 'https://edge.example',
    token: 't'.repeat(40), log: { error() {} }, WorkerImpl: Thread });
  await broadcaster.start();
  t.after(() => broadcaster.stop());
  broadcaster.setPolicy({ mode: 'live', bookingId: 'live' });
  const feed = count => {
    for (let index = 0; index < count; index++) broadcaster.liveFrame({ id: 'live' }, {
      data: new Int16Array(960), channels: 1, sampleRate: 48000, samplesPerChannel: 960,
    });
  };
  feed(50);
  assert.notEqual(broadcaster.snapshot().status, 'unavailable');
  Atomics.sub(credits, 0, 50);
  feed(50);
  assert.notEqual(broadcaster.snapshot().status, 'unavailable', 'worker progress must not wait for a busy parent to process ACK events');
  feed(1);
  assert.equal(broadcaster.snapshot().reason, 'PCM_BUFFER_LIMIT');
  assert.deepEqual(broadcaster.snapshot().reasonDetails, { stage: 'ipc', pendingFrames: 50 });
});

test('encoder thread failures remain explicit on the parent snapshot and can be shut down', { timeout: 10000 }, async t => {
  const { createPublicBroadcastWorker } = await import('../discord-bot/public-broadcast-worker.js');
  const broadcaster = createPublicBroadcastWorker({ enabled: true, edgeUrl: 'https://edge.example',
    token: 't'.repeat(40), ffmpeg: '/nonexistent/broadcast-ffmpeg' });
  await broadcaster.start();
  t.after(() => broadcaster.stop());
  const deadline = Date.now() + 2000;
  while (broadcaster.snapshot().status !== 'unavailable' && Date.now() < deadline) await wait(20);
  assert.equal(broadcaster.snapshot().reason, 'ENCODER_START_FAILED');
  await broadcaster.stop();
});

test('real AAC/HLS output preserves ordered adverts, adjacent acts and private-room exclusion', { timeout: 35000 }, async t => {
  const { createPublicBroadcast, parseBroadcastPlaylist } = await import('../discord-bot/public-broadcast.js');
  const { broadcastProgramAt } = await import('../js/public-broadcast-client.mjs');
  const OpusScript = require('../discord-bot/node_modules/opusscript');
  const codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const objects = new Map(), publications = [];
  const uploader = { baseUrl: 'https://edge.example', put: async (key, bytes) => {
    if (key.endsWith('.m3u8')) {
      for (const name of parseBroadcastPlaylist(bytes.toString())) {
        assert.ok(objects.has(`${key.split('/')[0]}/${name}`), 'playlist must not reference an unuploaded segment');
      }
      publications.push(bytes.toString());
    }
    objects.set(key, Buffer.from(bytes));
  } };
  const broadcaster = createPublicBroadcast({ enabled: true, uploader });
  let stateReads = 0;
  broadcaster.setStateReader(() => {
    stateReads++;
    return { publicBroadcast: broadcaster.snapshot() };
  });
  await broadcaster.start();
  const a = { id: 'a', title: 'Artist A', wallet: `0x${'1'.repeat(40)}` };
  const b = { id: 'b', title: 'Artist B', wallet: `0x${'2'.repeat(40)}` };
  let sampleOffset = 0;
  const tone = frequency => Int16Array.from({ length: 960 },
    (_, i) => Math.round(Math.sin((i + sampleOffset) * 2 * Math.PI * frequency / 48000) * 4000));
  const stereo = Buffer.alloc(3840);
  const frame = frequency => ({ data: tone(frequency), channels: 1, sampleRate: 48000, samplesPerChannel: 960 });
  const beganAt = Date.now();
  const sent = { intro: 0, a: 0, b: 0, outro: 0 };
  let generated = 0;
  const feed = setInterval(() => {
    const due = Math.floor((Date.now() - beganAt) / 20);
    while (generated < due) {
      const seconds = generated / 50;
      if (seconds < 4 || seconds >= 12) {
        sent[seconds < 4 ? 'intro' : 'outro']++;
        broadcaster.setPolicy({ mode: 'adverts' });
        const pcm = tone(880);
        for (let i = 0; i < pcm.length; i++) { stereo.writeInt16LE(pcm[i], i * 4); stereo.writeInt16LE(pcm[i], i * 4 + 2); }
        broadcaster.radioPacket(codec.encode(stereo, 960),
          { playId: seconds < 4 ? 'intro' : 'outro', title: 'Advert', protected: true });
      } else {
        sent[seconds < 8 ? 'a' : 'b']++;
        const booking = seconds < 8 ? a : b;
        broadcaster.setPolicy({ mode: 'live', bookingId: booking.id });
        broadcaster.liveFrame({ ...booking, id: 'private', rehearsal: true }, frame(1100));
        broadcaster.liveFrame(booking === a ? b : a, frame(1100));
        broadcaster.liveFrame(booking, frame(booking === a ? 440 : 660));
      }
      sampleOffset += 960;
      generated++;
    }
  }, 20);
  t.after(async () => { clearInterval(feed); await broadcaster.stop(); codec.delete(); });
  while (Date.now() - beganAt < 22000) await wait(100);
  assert.equal(broadcaster.snapshot().status, 'ready');
  assert.deepEqual(broadcaster.snapshot().programHistory.map(p => p.playId), ['intro', 'live:a', 'live:b', 'outro']);
  assert.equal(broadcaster.pendingDrain(), true);
  assert.ok(publications.length >= 4);
  assert.ok(stateReads >= 4, 'public state must continue publishing between segment boundaries');
  const stateObject = [...objects].find(([key]) => key.endsWith('/state.json'))[1];
  assert.equal(JSON.parse(stateObject).publicBroadcast.status, 'ready');
  const firstAt = Date.parse(publications[0].match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/)[1]);
  assert.ok(Number.isFinite(firstAt));
  const media = [...objects].filter(([key]) => key.endsWith('.ts')).map(([, bytes]) => bytes);
  assert.ok(media.length >= 4);
  const probe = spawnSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', '-i', 'pipe:0'],
  { input: Buffer.concat(media), maxBuffer: 1024 * 1024 });
  assert.equal(probe.status, 0, probe.stderr.toString());
  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.codec_name, 'aac');
  assert.equal(stream.sample_rate, '48000');
  assert.equal(stream.channels, 2);
  const decoded = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'mpegts',
    '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '48000', 'pipe:1'],
  { input: Buffer.concat(media), maxBuffer: 8 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  assert.equal(sent.intro, 200);
  assert.equal(sent.a, 200);
  assert.equal(sent.b, 200);
  for (const [second, playId, lower, upper] of [[2, 'intro', 800, 950], [6, 'live:a', 400, 480],
    [10, 'live:b', 600, 720], [14, 'outro', 800, 950]]) {
    assert.equal(broadcastProgramAt(broadcaster.snapshot().programHistory, firstAt + second * 1000).playId, playId);
    let crossings = 0, negative = false;
    for (let i = second * 48000; i < (second + 1) * 48000; i++) {
      const sample = decoded.stdout.readInt16LE(i * 2);
      if (sample < -500) negative = true;
      if (negative && sample > 500) { crossings++; negative = false; }
    }
    assert.ok(crossings >= lower && crossings <= upper, `actual decoded ${second}s audio has ${crossings} Hz, expected ${lower}–${upper}`);
  }
});
