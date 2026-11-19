import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { id, isAddress, ZeroAddress } from 'ethers';
import { CID } from 'multiformats/cid';
import { dmtvArchiveItems } from '../js/dmtv.mjs';
import { nftIdentity } from '../js/nft-loader.js';
import { radioContentAllowed } from '../js/content-review.mjs';
import { verifiedRecordingDuration } from '../js/radio-duration.mjs';
import { isEligibleRadioMusic } from '../js/radio-playlists.mjs';

const exec = promisify(execFile);

function videoCid(uri) {
  const root = String(uri || '').match(/^ipfs:\/\/(?:ipfs\/)?([a-z0-9]+)$/i)?.[1];
  if (!root) return '';
  try { return CID.parse(root).toV1().toString(); } catch { return ''; }
}

export function dmtvCatalogEntries({ nfts, playlist, campaigns = [], blockedMedia = [] }) {
  const allowedTracks = new Map(playlist.filter(isEligibleRadioMusic).map(track => [track.ipfsCid, track]));
  const blocked = new Set([
    ...blockedMedia.map(videoCid),
    ...playlist.filter(track => !radioContentAllowed(track)).map(track => track.ipfsCid),
  ]);
  const minted = nfts.map(nft => ({ ...nft, nftId: nftIdentity(nft) }));
  const records = new Map(minted.map(nft => [nft.nftId, nft]));
  return dmtvArchiveItems(minted, campaigns).flatMap(item => {
    const ipfsCid = videoCid(item.videoUrl);
    if (!ipfsCid || blocked.has(ipfsCid)) return [];
    const nft = records.get(item.nftId);
    const track = allowedTracks.get(ipfsCid);
    const seconds = verifiedRecordingDuration(track);
    return [{ ...item, ipfsCid, videoId: id(item.nftId), mediaHash: id(item.videoUrl), nft,
      radioTrack: seconds > 0 && seconds <= 7200 ? track : null }];
  });
}

export async function probeDmtvVideo(url) {
  const input = new URL(url);
  if (input.protocol !== 'https:' &&
      !(input.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(input.hostname))) {
    throw new Error('DMTv probe requires an HTTPS media gateway or a loopback test gateway');
  }
  const { stdout, stderr } = await exec(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'info', '-xerror', '-rw_timeout', '10000000',
    '-threads', '1', '-i', input.href, '-map', '0:v:0', '-an', '-frames:v', '1',
    '-progress', 'pipe:1', '-f', 'null', '-',
  ], { timeout: 25_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024 });
  if (!/^frame=[1-9]\d*$/m.test(stdout)) throw new Error('No video frame decoded');
  const source = stderr.split('Stream mapping:')[0];
  const firstVideo = source.split('\n').find(line => /Stream #0:\d+.*: Video:/.test(line)) || '';
  return { radio: /^Input #0, mov,mp4,/m.test(source) && /Video: h264\b/.test(firstVideo) &&
    !firstVideo.includes('(attached pic)') && /Stream #0:\d+.*: Audio:/.test(source),
    video: !firstVideo.includes('(attached pic)') };
}

export function createDmtvCatalogRegistrar({ contract, getEntries, getCreator, resolveMediaUrl, probe = probeDmtvVideo,
  batchSize = 4, now = Date.now, log = console }) {
  const deferred = new Map();
  const confirmed = new Map();
  let cursor = 0;
  let task;
  return function reconcile() {
    if (task) return task;
    task = (async () => {
      const entries = await getEntries();
      let attempted = 0;
      let registered = 0;
      for (let scanned = 0; scanned < entries.length && attempted < batchSize; scanned++) {
        cursor %= entries.length;
        const entry = entries[cursor++];
        const { videoId, mediaHash, creator } = entry;
        const maxLanes = entry.radioTrack ? 3 : 1;
        const key = `${videoId}:${mediaHash}:${creator.toLowerCase()}:${maxLanes}`;
        if (confirmed.get(key) > now() || deferred.get(key) > now()) continue;
        attempted++;
        try {
          if (!isAddress(creator) || creator === ZeroAddress) throw new Error('No verified creator wallet');
          const current = await contract.videos(videoId);
          const lanes = Number(current.lanes);
          const exists = current.creator !== ZeroAddress;
          if (exists && (current.creator.toLowerCase() !== creator.toLowerCase() || current.mediaHash !== mediaHash)) {
            throw new Error('Existing media or creator differs; admin review required');
          }
          // A configured but disabled entry may have been intentionally disabled by an admin.
          if ((exists && !lanes) || (lanes & maxLanes) === maxLanes) {
            confirmed.set(key, now() + 300_000);
            continue;
          }
          if ((await getCreator(entry.nft)).toLowerCase() !== creator.toLowerCase()) {
            throw new Error('Archive wallet does not match the NFT creator');
          }
          const url = await resolveMediaUrl(entry.ipfsCid);
          if (!url) throw new Error('IPFS media not available');
          const media = await probe(url);
          if (!media.video) throw new Error('No playable video stream');
          const next = lanes | (media.radio ? maxLanes : 1);
          if (next !== lanes) {
            const tx = await contract.configureVideo(videoId, mediaHash, creator, next);
            if ((await tx.wait(2))?.status !== 1) throw new Error('Catalog registration not confirmed');
            log.log(`[dmtv-catalog] Registered ${entry.nftId}, lanes ${next}: ${tx.hash}`);
            registered++;
          }
          confirmed.set(key, now() + 300_000);
        } catch (error) {
          deferred.set(key, now() + 900_000);
          log.warn(`[dmtv-catalog] ${entry.nftId} deferred: ${error.shortMessage || (error.code ? error.code : error.message)}`);
        }
      }
      return registered;
    })().finally(() => { task = null; });
    return task;
  };
}
