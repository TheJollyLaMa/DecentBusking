import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createDmtvStation({ queue, nextFree, resolveMediaUrl, log = console }) {
  const sessions = new Map();
  let current = null;
  let active = false;
  let healthy = false;
  let child;
  let timer;
  let count = 0;
  async function step() {
    let paid;
    let dir;
    let playId;
    let published = false;
    let deliveryCompleted = false;
    try {
      const adDue = count >= 10;
      if (!adDue) {
        try { paid = await queue.nextPaid(); }
        catch (error) { log.warn(`[dmtv] Paid selection deferred: ${error.message}`); }
      }
      const track = paid?.track || await nextFree({ adDue });
      if (!track || !active) return;
      if (adDue) count = 0;
      let input;
      if (track.houseAd && adDue && !paid) {
        input = ['-re', '-f', 'lavfi', '-i', 'color=c=0x141735:s=854x480:r=24:d=6'];
      } else {
        const cid = track.videoUrl?.match(/^ipfs:\/\/(?:ipfs\/)?([a-z0-9]+)$/i)?.[1];
        if (!cid) throw new Error('DMTv requires canonical IPFS media.');
        const mediaUrl = await resolveMediaUrl(cid);
        if (!mediaUrl) throw new Error('DMTv media is unavailable from the configured gateways.');
        const url = new URL(mediaUrl);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
          throw new Error('DMTv requires an HTTPS media gateway or a loopback test gateway.');
        }
        input = ['-re', '-i', url.href];
      }
      dir = await mkdtemp(join(tmpdir(), 'dmtv-hls-'));
      playId = randomUUID();
      sessions.set(playId, dir);
      const end = await new Promise((resolve, reject) => {
        let progress = false;
        let errors = '';
        let output = '';
        child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-rw_timeout', '15000000',
          ...input, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast',
          '-threads', '1', '-vf', 'scale=-2:480,fps=24', '-g', '96', '-sc_threshold', '0',
          '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
          '-hls_flags', 'delete_segments+temp_file+independent_segments',
          '-progress', 'pipe:1', 'live.m3u8'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-600); });
        child.stdout.on('data', chunk => {
          output += chunk;
          const lines = output.split('\n');
          output = lines.pop();
          for (const line of lines) if (line.trim() === 'progress=end') progress = true;
        });
        const publish = setInterval(async () => {
          try {
            if ((await readFile(join(dir, 'live.m3u8'), 'utf8')).includes('#EXTINF:') && active) {
              published = true;
              healthy = true;
              current = { playId, title: track.title, manifest: `/api/dmtv/stream/${playId}/live.m3u8` };
            }
          } catch (error) {
            if (error.code !== 'ENOENT') log.warn(`[dmtv] Manifest unavailable: ${error.message}`);
          }
        }, 500);
        const deadline = setTimeout(() => child?.kill('SIGKILL'), 2 * 60 * 60_000);
        child.once('error', error => {
          clearInterval(publish);
          clearTimeout(deadline);
          reject(error);
        });
        child.once('close', (code) => {
          clearInterval(publish);
          clearTimeout(deadline);
          child = null;
          if (code !== 0 || !progress) {
            const httpStatus = errors.match(/Server returned (\d{3})\b/)?.[1];
            reject(new Error(`DMTv encoder failed (${code ?? 'terminated'})${httpStatus ? `: upstream HTTP ${httpStatus}` : ''}`));
          }
          else resolve(true);
        });
      });
      const manifest = end && await readFile(join(dir, 'live.m3u8'), 'utf8');
      if (!manifest.includes('#EXT-X-ENDLIST') || !manifest.includes('#EXTINF:')) {
        throw new Error('DMTv playback did not publish a completed video.');
      }
      if (active && paid) {
        if (!published) throw new Error('DMTv video never became available during the shared broadcast.');
        deliveryCompleted = true;
        await queue.completePublished(paid.record, playId);
      }
      if (!adDue) count++;
    } catch (error) {
      healthy = false;
      log.warn(`[dmtv] Playback deferred: ${error.message}`);
      if (active && paid && !deliveryCompleted) {
        try { await queue.fail(paid.record); }
        catch (refundError) { log.warn(`[dmtv] Refund deferred: ${refundError.code || 'checkpoint or transaction unavailable'}`); }
      }
    } finally {
      if (paid) {
        try { await queue.release(paid.record); }
        catch (error) { log.warn(`[dmtv] Release deferred: ${error.message}`); }
      }
      if (dir) {
        const cleanup = setTimeout(() => {
          sessions.delete(playId);
          void rm(dir, { recursive: true, force: true }).catch(error => log.warn(`[dmtv] Cleanup: ${error.message}`));
        }, 60_000);
        cleanup.unref();
      }
      if (current?.playId === playId) current = null;
      if (active) {
        timer = setTimeout(() => void step(), 1500);
        timer.unref();
      }
    }
  }
  return {
    start() { if (!active) { active = true; void step(); } },
    stop() { active = healthy = false; clearTimeout(timer); child?.kill('SIGKILL'); },
    state() { return { current, healthy: active && healthy }; },
    async media(playId, name) {
      if (!/^(?:live\.m3u8|live\d+\.ts)$/.test(name) || !sessions.has(playId)) return null;
      try { return await readFile(join(sessions.get(playId), name)); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
  };
}
