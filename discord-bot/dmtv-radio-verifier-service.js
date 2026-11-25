import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readVerifierChrome } from './dmtv-verifier-chrome.js';

const clientPath = fileURLToPath(new URL('./dmtv-radio-verifier-client.js', import.meta.url));

// Only these variables reach the verifier process; the browser it launches gets fewer still.
export function verifierChildEnv({ env = process.env, chrome, publicUrl, secret }) {
  return {
    ...Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(name => env[name] != null).map(name => [name, env[name]])),
    PUBLIC_WORKER_URL: publicUrl,
    DMTV_VERIFIER_SECRET: secret,
    DMTV_CHROME_EXECUTABLE: chrome.executablePath,
    DMTV_CHROME_LIBRARY_PATH: chrome.libraryPath,
  };
}

// Runs the DMTv radio verifier beside the bot on Render. Any failure leaves the verifier
// unready, so new paid radio-video starts stay gated (fail closed); the bot keeps running.
export async function startInServiceRadioVerifier({ env = process.env, log = console, spawnChild = spawn,
  readChrome = readVerifierChrome, minDelayMs = 5_000, maxDelayMs = 300_000 } = {}) {
  if (env.DMTV_RADIO_VERIFIER_IN_SERVICE !== 'true') return null;
  const publicUrl = env.PUBLIC_WORKER_URL || env.RENDER_EXTERNAL_URL;
  const secret = env.DMTV_VERIFIER_SECRET || env.CHECKPOINT_MIRROR_SECRET;
  if (!publicUrl || !secret) {
    log.error('[dmtv-verifier] In-service verifier needs PUBLIC_WORKER_URL (or RENDER_EXTERNAL_URL) and DMTV_VERIFIER_SECRET');
    return null;
  }
  let chrome;
  try {
    chrome = await readChrome();
  } catch (error) {
    log.error(`[dmtv-verifier] Verifier Chrome is not installed (${error.message}); paid radio-video stays gated`);
    return null;
  }
  const childEnv = verifierChildEnv({ env, chrome, publicUrl, secret });
  let child, timer, stopped = false, delay = minDelayMs;
  const launch = () => {
    const startedAt = Date.now();
    child = spawnChild(process.execPath, [clientPath], { env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('exit', (code, signal) => {
      child = undefined;
      if (stopped) return;
      delay = Date.now() - startedAt > maxDelayMs ? minDelayMs : Math.min(delay * 2, maxDelayMs);
      log.error(`[dmtv-verifier] Verifier exited (${signal || code}); restarting in ${Math.round(delay / 1000)}s`);
      timer = setTimeout(launch, delay);
      timer.unref?.();
    });
  };
  launch();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    child?.kill('SIGTERM');
  };
  process.once('exit', stop);
  log.info('[dmtv-verifier] In-service verifier started');
  return { stop };
}
