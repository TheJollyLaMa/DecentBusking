const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile, access } = require('node:fs/promises');
const { createServer } = require('node:http');

test('paid media is completely downloaded before preparation returns and cleanup removes it', async () => {
  const { bufferRadioMedia } = await import('../discord-bot/radio-media-buffer.js');
  let finish;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      finish = () => { controller.enqueue(new Uint8Array([3, 4])); controller.close(); };
    },
  });
  let resolved = false;
  const preparing = bufferRadioMedia('https://media.example/song', {
    fetchImpl: async () => new Response(body, { headers: { 'content-length': '4' } }),
  }).then(media => { resolved = true; return media; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(resolved, false, 'an intro buffer is not a complete recording');
  finish();
  const media = await preparing;
  try {
    assert.deepEqual(await readFile(media.path), Buffer.from([1, 2, 3, 4]));
    assert.equal(media.bytes, 4);
  } finally { await media.dispose(); }
  await assert.rejects(access(media.path), { code: 'ENOENT' });
});

test('media buffering rejects HTTP errors, invalid lengths, empty and oversized bodies', async () => {
  const { bufferRadioMedia } = await import('../discord-bot/radio-media-buffer.js');
  for (const response of [
    new Response('bad gateway', { status: 502 }),
    new Response('partial', { status: 206 }),
    new Response('x', { headers: { 'content-length': '999' } }),
    new Response('x', { headers: { 'content-length': '2' } }),
    new Response(''),
    new Response('too much'),
  ]) {
    await assert.rejects(bufferRadioMedia('https://media.example/song', {
      maxBytes: 4, fetchImpl: async () => response,
    }), /Paid media download/);
  }
});

test('a severed HTTP transfer is rejected before any partial recording is decoded', async t => {
  const { bufferRadioMedia } = await import('../discord-bot/radio-media-buffer.js');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-length': '10000' });
    response.write(Buffer.alloc(100));
    setImmediate(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(bufferRadioMedia(`http://127.0.0.1:${server.address().port}/broken`));
});

test('shutdown and bounded transfer timeout abort a stalled HTTP download', async t => {
  const { bufferRadioMedia } = await import('../discord-bot/radio-media-buffer.js');
  const server = createServer((request, response) => {
    response.writeHead(200);
    response.write(Buffer.alloc(100));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/stalled`;
  await assert.rejects(bufferRadioMedia(url, { timeoutMs: 30 }));
  const controller = new AbortController();
  const pending = bufferRadioMedia(url, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
