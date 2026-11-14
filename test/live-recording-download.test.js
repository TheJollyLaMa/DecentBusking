const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePromise = import('../discord-bot/live-recording.js');
const cid = 'bafy' + 'a'.repeat(42);
const limit = 2880044;

test('recording segment URL preserves discovered gateway token and puts CID in the path', async () => {
  const { downloadRecordingSegment } = await modulePromise;
  for (const gateway of [
    'https://recordings.mypinata.cloud/ipfs/?pinataGatewayToken=fixture%2Btoken',
    'https://recordings.mypinata.cloud?pinataGatewayToken=fixture%2Btoken',
    'https://recordings.mypinata.cloud/ipfs?pinataGatewayToken=fixture%2Btoken',
  ]) {
    const bytes = Buffer.from('fixture bytes');
    assert.deepEqual(await downloadRecordingSegment(cid, { gateway, fetchImpl: async (url, options) => {
      const target = new URL(url);
      assert.equal(target.pathname, `/ipfs/${cid}`);
      assert.equal(target.searchParams.get('pinataGatewayToken'), 'fixture+token');
      assert.equal(target.searchParams.size, 1);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers, undefined, 'Never forward the Pinata API JWT to media gateways');
      return new Response(bytes);
    } }), bytes);
  }
});

test('configured public gateways keep their path prefix and do not receive authentication', async () => {
  const { downloadRecordingSegment } = await modulePromise;
  for (const gateway of ['https://public.example', 'https://public.example/ipfs/', 'https://public.example/base/ipfs/']) {
    await downloadRecordingSegment(cid, { gateway, fetchImpl: async url => {
      const target = new URL(url);
      assert.equal(target.pathname, `${gateway.includes('/base/') ? '/base' : ''}/ipfs/${cid}`);
      assert.equal(target.search, '');
      return new Response('fixture');
    } });
  }
});

test('recording download rejects invalid inputs before fetch and reports gateway failures without credentials', async () => {
  const { downloadRecordingSegment } = await modulePromise;
  const gateway = 'https://recordings.mypinata.cloud/ipfs/?pinataGatewayToken=fixture-secret';
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error(`failed fetching ${gateway}`); };
  for (const bad of ['', '../secret', 'cid?query', 'https://attacker.example']) {
    await assert.rejects(downloadRecordingSegment(bad, { gateway, fetchImpl }), /Invalid recording segment CID/);
  }
  for (const bad of ['http://public.example', 'https://user:password@public.example', 'https://public.example/#secret']) {
    await assert.rejects(downloadRecordingSegment(cid, { gateway: bad, fetchImpl }), /Invalid recording gateway/);
  }
  assert.equal(calls, 0);
  await assert.rejects(downloadRecordingSegment(cid, { gateway, fetchImpl }), error =>
    /network, timeout or redirect/.test(error.message) && !error.message.includes('fixture-secret'));
  for (const status of [401, 403, 404, 429, 503]) {
    await assert.rejects(downloadRecordingSegment(cid, { gateway, fetchImpl: async () => new Response('', { status }) }),
      new RegExp(`failed \\(${status}\\)`));
  }
});

test('recording response is bounded while streaming, including dishonest or missing content lengths', async () => {
  const { downloadRecordingSegment } = await modulePromise;
  const gateway = 'https://public.example';
  assert.equal((await downloadRecordingSegment(cid, { gateway,
    fetchImpl: async () => new Response(Buffer.alloc(limit)) })).length, limit);
  let cancelled = false;
  await assert.rejects(downloadRecordingSegment(cid, { gateway, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(limit)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': '1' } }) }), /exceeds size limit/);
  assert.equal(cancelled, true);
  await assert.rejects(downloadRecordingSegment(cid, { gateway,
    fetchImpl: async () => new Response('small', { headers: { 'content-length': String(limit + 1) } }) }), /exceeds size limit/);
  await assert.rejects(downloadRecordingSegment(cid, { gateway,
    fetchImpl: async () => new Response(null) }), /no body/);
  await assert.rejects(downloadRecordingSegment(cid, { gateway, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.error(Error('fixture-secret stream error')); },
  })) }), error => error.message === 'Recording segment download failed while reading body');
});

test('production recorder uses the tested downloader instead of concatenating after a token query', () => {
  const source = fs.readFileSync(path.join(__dirname, '../discord-bot/index.js'), 'utf8');
  assert.match(source, /downloadRecordingSegment\(cid, \{ gateway \}\)/);
  assert.doesNotMatch(source, /fetch\(`\$\{base\}\/ipfs\/\$\{cid\}`/);
});
