// On-demand personal listens: 30-second preview, then 0.25 USDC per song via DJuke.
// Fails open to free playback whenever payments are not live, matching today's behavior.
import { playArchiveTrack, archiveSessionId, archiveMedia, returnToRadio } from './radio-sync.js?v=20261010-listens';
import { setNowPlaying } from './stage.js?v=20261010-listens';

export const LISTEN_PRICE_UNITS = 250000n;
export const PREVIEW_SECONDS = 30;
export const MAX_PLAYLIST = 50;
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const LISTEN_ABI = ['function purchaseListens(bytes32[] songIds, uint256 maxTotal) returns (uint256)',
  'function quoteListens(bytes32[] songIds) view returns(uint256)'];
const USDC_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];

export function formatUsdc(units) {
  const fraction = String(units % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${units / 1000000n}.${fraction}`;
}

export function audioCid(value) {
  return String(value || '').match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/)?.[1] || String(value || '').match(/\/ipfs\/([^/?#]+)/)?.[1] || '';
}

export async function purchaseListens({ signer, djuke, usdc, songIds, contractVersion = '0.1', onStep = () => {} }) {
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453) throw new Error('Switch your wallet to Base');
  if (usdc.target.toLowerCase() !== BASE_USDC.toLowerCase() || Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (!Array.isArray(songIds) || !songIds.length || songIds.length > MAX_PLAYLIST || songIds.some(id => !/^0x[0-9a-fA-F]{64}$/.test(id))) {
    throw new Error(`Choose 1 to ${MAX_PLAYLIST} songs`);
  }
  const total = contractVersion === '0.2' ? await djuke.quoteListens(songIds) : LISTEN_PRICE_UNITS * BigInt(songIds.length);
  if (total <= 0n) throw new Error('Invalid personal listen quote');
  onStep(`Personal listen price: ${formatUsdc(total)} USDC`);
  const address = await signer.getAddress();
  if (await usdc.balanceOf(address) < total) throw new Error(`You need ${formatUsdc(total)} USDC on Base`);
  if (await usdc.allowance(address, djuke.target) < total) {
    onStep(`Approve exactly ${formatUsdc(total)} USDC`);
    if ((await (await usdc.approve(djuke.target, total)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
  }
  await djuke.purchaseListens.staticCall(songIds, total);
  onStep('Confirm your listen purchase');
  const transaction = await djuke.purchaseListens(songIds, total);
  onStep('Waiting for Base confirmation\u2026');
  if ((await transaction.wait())?.status !== 1) throw new Error('Listen purchase did not confirm');
  return { txHash: transaction.hash, totalUnits: total };
}

export function createListenPlaylist(storage = globalThis.localStorage, key = 'decentbusking:listen-playlist:v1') {
  const read = () => {
    try {
      const items = JSON.parse(storage?.getItem(key) || '[]');
      return Array.isArray(items) ? items.filter(item => /^0x[0-9a-fA-F]{64}$/.test(item?.songId || '') && item.audioUrl) : [];
    } catch { return []; }
  };
  const write = items => { try { storage?.setItem(key, JSON.stringify(items)); } catch {} };
  return {
    list: read,
    add(item) {
      const items = read();
      if (items.some(entry => entry.songId === item.songId)) return false;
      if (items.length >= MAX_PLAYLIST) throw new Error(`Playlists hold up to ${MAX_PLAYLIST} songs`);
      write([...items, { songId: item.songId, title: item.title, artist: item.artist, audioUrl: item.audioUrl, mediaType: item.mediaType || '' }]);
      return true;
    },
    remove(songId) { write(read().filter(item => item.songId !== songId)); },
    clear() { write([]); },
  };
}

export function createListenController({ getLive, play, freePlay, getSession, getMedia, onPreviewEnded,
  previewSeconds = PREVIEW_SECONDS, pollMs = 500, newSessionId = () => crypto.randomUUID() }) {
  let watch = null;
  const stopWatch = () => { clearInterval(watch); watch = null; };
  async function playSong(song) {
    const live = await getLive().catch(() => null);
    const songId = live?.songIdForCid(audioCid(song.audioUrl));
    if (!songId) { stopWatch(); freePlay(song); return 'free'; }
    const sessionId = newSessionId();
    stopWatch();
    play({ ...song, sessionId });
    watch = setInterval(() => {
      if (getSession() !== sessionId) { stopWatch(); return; }
      const media = getMedia();
      if (media && media.currentTime >= previewSeconds) {
        stopWatch();
        media.pause();
        onPreviewEnded({ song: { ...song, songId }, resume: () => { if (getSession() === sessionId) media.play().catch(() => {}); } });
      }
    }, pollMs);
    return 'preview';
  }
  function playPurchased(items) {
    stopWatch();
    const start = index => {
      const sessionId = newSessionId();
      play({ ...items[index], sessionId, onEnded: () => (index + 1 < items.length ? (start(index + 1), true) : false) });
    };
    if (items.length) start(0);
  }
  return { playSong, playPurchased, stop: stopWatch };
}

function nftSong(nft) {
  return { title: nft.name || nft.title || `Track #${nft.tokenId}`, artist: nft.artist || nft.creator || '',
    audioUrl: nft.videoUrl || nft.audioUrl || nft.animation_url || '', mediaType: nft.mediaType || (nft.videoUrl ? 'video/mp4' : '') };
}

export function initListens() {
  const cfg = window.DecentConfig || {};
  const service = (cfg.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  const gate = document.getElementById('listen-gate');
  const gateText = document.getElementById('listen-gate-text');
  const gateStatus = document.getElementById('listen-gate-status');
  const playlistEl = document.getElementById('djuke-playlist');
  const playlistTotal = document.getElementById('djuke-playlist-total');
  const playlistBuy = document.getElementById('djuke-playlist-buy');
  const playlist = createListenPlaylist();
  let cached = null;
  let pendingGate = null;
  let busy = false;
  const gateway = (cfg.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/');
  const httpUrl = url => url.replace(/^ipfs:\/\//i, gateway);

  async function getLive() {
    if (cached && Date.now() - cached.at < 60000) return cached.live;
    const address = (window.DecentConfig?.djukeContractAddress || '').toLowerCase();
    let live = null;
    if (service && address) {
      const response = await fetch(`${service}/api/djuke`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const snapshot = response.ok ? await response.json() : null;
      if (snapshot?.paymentsEnabled && String(snapshot.contractAddress || '').toLowerCase() === address && Array.isArray(snapshot.tracks)) {
        const byCid = new Map(snapshot.tracks.filter(track => track.ipfsCid).map(track => [track.ipfsCid, track.songId]));
        live = { songIdForCid: cid => byCid.get(cid) || '' };
      }
    }
    cached = { at: Date.now(), live };
    return live;
  }
  const contracts = () => {
    const signer = window._wallet?.signer;
    if (!signer) throw new Error('Connect your wallet first');
    return { signer, contractVersion: window.DecentConfig.djukeContractVersion || '0.1',
      djuke: new ethers.Contract(window.DecentConfig.djukeContractAddress, LISTEN_ABI, signer),
      usdc: new ethers.Contract(BASE_USDC, USDC_ABI, signer) };
  };
  const ensureWallet = async () => { if (!window._wallet?.signer) await window._wallet?.connect?.(); return contracts(); };

  const controller = createListenController({
    getLive,
    play: song => playArchiveTrack({ title: song.title, artist: song.artist, audioUrl: httpUrl(song.audioUrl),
      mediaType: song.mediaType, sessionId: song.sessionId, onEnded: song.onEnded }),
    freePlay: song => setNowPlaying(song),
    getSession: archiveSessionId,
    getMedia: archiveMedia,
    onPreviewEnded: ({ song, resume }) => {
      pendingGate = { song, resume };
      gateText.textContent = cfg.djukeContractVersion === '0.2'
        ? `Personal listen for ${song.title}. The current creator price will be quoted before payment.`
        : `That was your 30-second preview of \u201c${song.title}\u201d. Keep listening for ${formatUsdc(LISTEN_PRICE_UNITS)} USDC \u2014 90% goes to the artist.`;
      gateStatus.textContent = '';
      if (!gate.open) gate.showModal();
    },
  });

  function renderPlaylist() {
    const items = playlist.list();
    playlistEl.replaceChildren();
    for (const item of items) {
      const row = document.createElement('li');
      const title = document.createElement('span');
      title.textContent = item.title;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '\u00d7';
      remove.setAttribute('aria-label', `Remove ${item.title} from playlist`);
      remove.addEventListener('click', () => { playlist.remove(item.songId); renderPlaylist(); });
      row.append(title, remove);
      playlistEl.append(row);
    }
    playlistTotal.textContent = items.length ? cfg.djukeContractVersion === '0.2'
      ? `${items.length} songs - creator prices quoted before payment`
      : `${items.length} song${items.length === 1 ? '' : 's'} \u00b7 ${formatUsdc(LISTEN_PRICE_UNITS * BigInt(items.length))} USDC` : 'Empty \u2014 add songs from any DNFT card';
    playlistBuy.disabled = !items.length || busy;
  }
  async function addToPlaylist(song, status) {
    const live = await getLive().catch(() => null);
    const songId = song.songId || live?.songIdForCid(audioCid(song.audioUrl));
    if (!songId) { status('Personal playlists open when DJuke payments are live.'); return; }
    status(playlist.add({ ...song, songId }) ? 'Added to your DJuke playlist.' : 'Already in your playlist.');
    renderPlaylist();
  }

  document.getElementById('listen-gate-pay').addEventListener('click', async () => {
    if (!pendingGate || busy) return;
    busy = true;
    try {
      await purchaseListens({ ...(await ensureWallet()), songIds: [pendingGate.song.songId], onStep: text => { gateStatus.textContent = text; } });
      gate.close();
      pendingGate.resume();
      pendingGate = null;
    } catch (error) {
      gateStatus.textContent = error.shortMessage || error.reason || error.message;
    } finally { busy = false; }
  });
  document.getElementById('listen-gate-add').addEventListener('click', () => {
    if (pendingGate) addToPlaylist(pendingGate.song, text => { gateStatus.textContent = text; });
  });
  document.getElementById('listen-gate-radio').addEventListener('click', () => { gate.close(); pendingGate = null; returnToRadio(); });
  playlistBuy.addEventListener('click', async () => {
    const items = playlist.list();
    if (!items.length || busy) return;
    busy = true;
    renderPlaylist();
    const status = document.getElementById('djuke-payment-state');
    try {
      await purchaseListens({ ...(await ensureWallet()), songIds: items.map(item => item.songId), onStep: text => { status.textContent = text; } });
      status.textContent = 'Enjoy your playlist!';
      controller.playPurchased(items);
    } catch (error) {
      status.textContent = error.shortMessage || error.reason || error.message;
    } finally { busy = false; renderPlaylist(); }
  });
  document.addEventListener('dbusk-listen', event => {
    event.preventDefault();
    controller.playSong(nftSong(event.detail.nft));
  });
  document.addEventListener('dbusk-playlist-add', event => {
    event.preventDefault();
    addToPlaylist(nftSong(event.detail.nft), event.detail.status || (() => {}));
  });
  renderPlaylist();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initListens, { once: true });
