const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { performance } = require('node:perf_hooks');

async function main() {
  const { createPublicBroadcast, createBroadcastUploader } = await import('../../discord-bot/public-broadcast.js');
  const { createRadioResourceMetrics } = await import('../../discord-bot/radio-resource-metrics.js');
  const { handleBroadcastRequest } = await import('../../cloudflare/broadcast-worker.mjs');
  const root = path.resolve(__dirname, '../..'), objects = new Map(), port = Number(process.env.PORT || 8331);
  const origin = `http://127.0.0.1:${port}`;
  const resources = createRadioResourceMetrics();
  const metricsTimer = setInterval(() => { void resources.sample(); }, 1000);
  const uploader = process.env.PUBLIC_BROADCAST_EDGE_URL ? createBroadcastUploader({
    baseUrl: process.env.PUBLIC_BROADCAST_EDGE_URL, token: process.env.PUBLIC_BROADCAST_UPLOAD_TOKEN,
  }) : {
    baseUrl: origin, put: async (key, body) => {
      for (const [name, object] of objects) if (Number(object.customMetadata.expiresAt) <= Date.now()) objects.delete(name);
      objects.set(`hls/${key}`, { body: Buffer.from(body), customMetadata: { expiresAt: String(Date.now() + 120000) } });
    },
  };
  const broadcaster = createPublicBroadcast({ enabled: true, uploader });
  const snapshot = () => ({ nowPlaying: null, serverTime: Date.now(),
    publicBroadcast: { ...broadcaster.snapshot(), selected: true } });
  broadcaster.setStateReader(snapshot);
  await broadcaster.start();
  const data = Int16Array.from({ length: 960 }, (_, i) => Math.round(Math.sin(i * 2 * Math.PI * 500 / 48000) * 2000));
  const booking = { id: 'synthetic-preview', title: 'Synthetic rehearsal tone', displayName: 'Local test only',
    wallet: `0x${'1'.repeat(40)}` };
  broadcaster.setPolicy({ mode: 'live', bookingId: booking.id });
  const beganAt = performance.now();
  let generated = 0;
  const feed = setInterval(() => {
    const due = Math.floor((performance.now() - beganAt) / 20);
    while (generated < due) {
      broadcaster.liveFrame(booking, { data, samplesPerChannel: 960, channels: 1, sampleRate: 48000 });
      generated++;
    }
  }, 20);
  const env = {
    BROADCAST_RATE_LIMITER: { limit: async () => ({ success: true }) },
    BROADCAST_BUCKET: { get: async key => objects.get(key) },
  };
  const html = `<!doctype html><meta name="viewport" content="width=device-width">
<title>Local HLS verification</title><style>body{max-width:38rem;margin:2rem auto;padding:1rem;font:18px system-ui}
audio{max-width:100%}button{padding:.75rem}#activity{min-height:4rem}</style>
<h1>Local HLS verification</h1><p>Synthetic audio only. Not connected to LiveKit, a wallet or production.</p>
<h2 id="programme">Buffering</h2><p id="activity"></p><audio id="audio" controls></audio><button id="play">Play broadcast</button>
<script type="module">
import {createPublicBroadcastListener} from '/js/public-broadcast-client.mjs';
const audio=document.querySelector('audio');
window.listener=createPublicBroadcastListener({audio,serviceUrl:location.origin,telemetry:{},
request:async()=>({}),onStatus:s=>document.querySelector('#activity').textContent=s.reason||'Playing',
onProgram:p=>document.querySelector('#programme').textContent=p.title});
document.querySelector('#play').onclick=()=>listener.play().catch(e=>document.querySelector('#activity').textContent=e.message);
setInterval(async()=>{const state=await(await fetch('/api/radio')).json();
for(const key of ['url','stateUrl'])if(state.publicBroadcast[key])state.publicBroadcast[key]=state.publicBroadcast[key].replace(location.origin,'https://broadcast.fixture');
listener.update(state.publicBroadcast);},1000);
</script>`;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
      if (url.pathname === '/api/radio' || url.pathname === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(url.pathname === '/health' ? { radioResources: resources.snapshot() } : snapshot())); return;
      }
      if (url.pathname.startsWith('/hls/')) {
        const response = await handleBroadcastRequest(new Request(url, { method: req.method }), env, {});
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) Readable.fromWeb(response.body).pipe(res);
        else res.end();
        return;
      }
      const filename = url.pathname === '/api/radio/hls-client.js'
        ? require.resolve('../../discord-bot/node_modules/hls.js')
        : url.pathname.startsWith('/js/') && !url.pathname.includes('..') ? path.join(root, url.pathname) : null;
      if (!filename) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', 'application/javascript'); res.end(await fs.readFile(filename));
    } catch (error) {
      console.error('[broadcast-preview]', error.message); res.writeHead(500); res.end('Preview failed');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`Synthetic HLS fixture listening on ${origin}`));
  const stop = async () => {
    clearInterval(feed); clearInterval(metricsTimer); resources.stop();
    server.closeAllConnections(); server.close();
    await broadcaster.stop();
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
