import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const probeOrigin = 'http://127.0.0.1:46931';

export async function createRadioProofBrowser(executablePath) {
  const browser = await chromium.launch({ executablePath, timeout: 15_000,
    args: ['--autoplay-policy=no-user-gesture-required'],
    env: Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'DISPLAY']
      .filter(name => process.env[name] != null).map(name => [name, process.env[name]])) });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    page.on('console', message => {
      if (message.text().startsWith('[dmtv-proof]')) console.log(`${new Date().toISOString()} ${message.text()}`);
    });
    await page.route(`${probeOrigin}/**`, async route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>DMTv verifier</title>' });
      } else if (/^\/[a-z][a-z0-9-]*\.mjs$/.test(pathname)) {
        await route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL(`../js${pathname}`, import.meta.url)) });
      } else {
        await route.abort();
      }
    });
    await page.goto(probeOrigin);
    if (!await page.evaluate(() => typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function' &&
        globalThis.MediaSource?.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') &&
        document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'))) {
      throw new Error('DMTv verifier needs Chrome with AAC, H.264 and video frame callbacks');
    }
    return {
      page,
      ready: () => browser.isConnected(),
      verify: (job, serviceUrl) => page.evaluate(async ({ job, serviceUrl }) =>
        (await import('/dmtv-radio-proof.mjs')).verifyRadioPlayback(job, serviceUrl), { job, serviceUrl }),
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function main() {
  const base = new URL(process.env.PUBLIC_WORKER_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.origin !== base.href.replace(/\/$/, '')) {
    throw new Error('DMTv verifier requires the public HTTPS worker origin');
  }
  const secret = process.env.CHECKPOINT_MIRROR_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('DMTv verifier requires the checkpoint mirror secret');
  const executablePath = process.env.DMTV_CHROME_EXECUTABLE;
  if (!executablePath) throw new Error('Set DMTV_CHROME_EXECUTABLE to the installed Chrome executable');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
  const player = await createRadioProofBrowser(executablePath);
  let active, result;
  try {
    while (!stopping) {
      if (!player.ready()) throw new Error('DMTv verifier browser disconnected');
      try {
        const response = await fetch(new URL('/api/dmtv/radio-verification', base), { method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, ready: true, result }), redirect: 'error', signal: AbortSignal.timeout(6000) });
        if (!response.ok) throw new Error(`DMTv verifier exchange returned ${response.status}`);
        const { job } = await response.json();
        if (result && job?.id !== result.id) result = undefined;
        if (!active && !result && job?.id && job.deadline > Date.now()) {
          active = player.verify(job, base.origin)
            .then(syncedMs => { result = { id: job.id, syncedMs }; })
            .catch(error => {
              console.error(`${new Date().toISOString()} [dmtv-verifier] Playback check failed: ${error.name}`);
              result = { id: job.id, syncedMs: 0 };
            }).finally(() => { active = undefined; });
        }
      } catch (error) { console.error(`[dmtv-verifier] ${error.message}`); }
      await sleep(2000);
    }
  } finally { await player.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`[dmtv-verifier] ${error.message}`); process.exitCode = 1; });
}
