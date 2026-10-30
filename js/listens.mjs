// On-demand personal listens: 30-second preview, then 0.25 USDC per song via DJuke.
// Fails open to free playback whenever payments are not live, matching today's behavior.
import { playArchiveTrack, archiveSessionId, archiveMedia, returnToRadio } from './radio-sync.js?v=20261030-ad-cutoff';
import { setNowPlaying } from './stage.js?v=20261030-ad-cutoff';
import { supportsDjukeAlbumsAndGas } from './djuke-version.mjs';
import { approvalNotice, ensureBaseNetwork, retryMissingRevertData, waitForAllowance } from './base-chain.mjs?v=20261023-usdc-only';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { formatUsdcUnits } from './usdc-format.mjs?v=20261017-mercury-release';
import { createPersonalPlayRecovery, verifyPersonalPlaySession } from './personal-play-recovery.mjs?v=20261023-personal-recovery';

export const LISTEN_PRICE_UNITS = 250000n;
export const PREVIEW_SECONDS = 30;
export const MAX_PLAYLIST = 50;
export const MAX_NAMED_PLAYLIST = 24;
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
  return formatUsdcUnits(units);
}

export function audioCid(value) {
  return String(value || '').match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)/)?.[1] || String(value || '').match(/\/ipfs\/([^/?#]+)/)?.[1] || '';
}

export async function purchaseListens({ signer, djuke, usdc, songIds, contractVersion = '0.1', onStep = () => {}, onSubmitted = () => {} }) {
  await ensureBaseNetwork(signer.provider);
  if (usdc.target.toLowerCase() !== BASE_USDC.toLowerCase() || Number(await usdc.decimals()) !== 6) throw new Error('Configured token is not native Base USDC');
  if (!Array.isArray(songIds) || !songIds.length || songIds.length > MAX_PLAYLIST || songIds.some(id => !/^0x[0-9a-fA-F]{64}$/.test(id))) {
    throw new Error(`Choose 1 to ${MAX_PLAYLIST} songs`);
  }
  const total = supportsDjukeAlbumsAndGas(contractVersion) ? await djuke.quoteListens(songIds) : LISTEN_PRICE_UNITS * BigInt(songIds.length);
  if (total <= 0n) throw new Error('Invalid personal listen quote');
  onStep(`Personal listen price: ${formatUsdc(total)} USDC`);
  const address = await signer.getAddress();
  if (await usdc.balanceOf(address) < total) throw new Error(`You need ${formatUsdc(total)} USDC on Base`);
  if (await usdc.allowance(address, djuke.target) < total) {
    onStep(approvalNotice(formatUsdc(total), { workerContribution: false }));
    if ((await (await usdc.approve(djuke.target, total)).wait())?.status !== 1) throw new Error('USDC approval did not confirm');
    onStep('Confirming approval…');
    await waitForAllowance(usdc, address, djuke.target, total);
  }
  onStep('Creating request…');
  await retryMissingRevertData(
    () => djuke.purchaseListens.staticCall(songIds, total),
    async () => {
      onStep('Confirming approval…');
      await waitForAllowance(usdc, address, djuke.target, total);
    },
  );
  onStep('Confirm your listen purchase');
  const transaction = await djuke.purchaseListens(songIds, total);
  await onSubmitted({ payer: address, contract: djuke.target, txHash: transaction.hash });
  onStep('Waiting for Base confirmation\u2026');
  if ((await transaction.wait())?.status !== 1) throw new Error('Listen purchase did not confirm');
  announcePaymentCelebration({
    chainId: 8453,
    txHash: transaction.hash,
    amountText: formatUsdc(total),
    assetText: 'USDC',
    summary: 'Listen purchase confirmed',
    txLabel: 'Listen purchase confirmed',
  });
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
      if (items.length >= MAX_PLAYLIST) throw new Error(`Listen carts hold up to ${MAX_PLAYLIST} songs`);
      write([...items, { songId: item.songId, title: item.title, artist: item.artist, audioUrl: item.audioUrl, mediaType: item.mediaType || '', ...(item.listenPriceUnits !== undefined ? { listenPriceUnits: String(item.listenPriceUnits) } : {}) }]);
      return true;
    },
    remove(songId) { write(read().filter(item => item.songId !== songId)); },
    replace(next) {
      if (!Array.isArray(next) || next.length > MAX_PLAYLIST || next.some(item => !/^0x[0-9a-fA-F]{64}$/.test(item?.songId || '') || !item.audioUrl) ||
          new Set(next.map(item => item.songId.toLowerCase())).size !== next.length) throw new Error('Listen carts hold up to 50 unique songs');
      write(next.map(item => ({ songId: item.songId.toLowerCase(), title: item.title, artist: item.artist, audioUrl: item.audioUrl, mediaType: item.mediaType || '', ...(item.listenPriceUnits !== undefined ? { listenPriceUnits: String(item.listenPriceUnits) } : {}) })));
    },
    clear() { write([]); },
  };
}

export function createListenController({ getLive, play, freePlay, getSession, getMedia, onPreviewEnded,
  previewSeconds = PREVIEW_SECONDS, pollMs = 500, newSessionId = () => crypto.randomUUID() }) {
  let watch = null;
  let previewSession = null;
  let checkpoint = () => {};
  let detachPurchased = () => {};
  let purchasedGeneration = 0;
  const stopWatch = () => { clearInterval(watch); watch = null; };
  function stopPurchased() {
    checkpoint();
    checkpoint = () => {};
    detachPurchased();
    detachPurchased = () => {};
    purchasedGeneration++;
    stopWatch();
  }
  function playFree(song) {
    stopPurchased();
    previewSession = null;
    freePlay(song);
  }
  async function playSong(song) {
    const live = await getLive().catch(() => null);
    const songId = live?.songIdForCid(audioCid(song.audioUrl));
    if (!songId) { playFree(song); return 'free'; }
    const sessionId = newSessionId();
    stopPurchased();
    previewSession = sessionId;
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
  function playPurchased(items, { index = 0, position = 0, onProgress = () => {}, onComplete = () => {} } = {}) {
    stopPurchased();
    previewSession = null;
    const generation = purchasedGeneration;
    const start = (index, position = 0) => {
      detachPurchased();
      stopWatch();
      const sessionId = newSessionId();
      onProgress({ index, position });
      play({ ...items[index], sessionId, onEnded: () => {
        if (generation !== purchasedGeneration) return false;
        checkpoint = () => {};
        detachPurchased();
        stopWatch();
        if (index + 1 < items.length) { start(index + 1); return true; }
        onComplete();
        return false;
      } });
      const media = getMedia();
      let seekPending = position > 0;
      const seek = () => {
        if (!seekPending || getSession() !== sessionId || !media || media.readyState < 1) return;
        media.currentTime = Number.isFinite(media.duration) ? Math.min(position, Math.max(0, media.duration - 0.1)) : position;
        seekPending = false;
      };
      checkpoint = () => {
        if (getSession() !== sessionId || seekPending || !media || media.readyState < 1 ||
            !Number.isFinite(media.currentTime)) return;
        onProgress({ index, position: media.currentTime });
      };
      media?.addEventListener?.('loadedmetadata', seek);
      media?.addEventListener?.('pause', checkpoint);
      media?.addEventListener?.('seeked', checkpoint);
      const saveProgress = checkpoint;
      detachPurchased = () => {
        media?.removeEventListener?.('loadedmetadata', seek);
        media?.removeEventListener?.('pause', saveProgress);
        media?.removeEventListener?.('seeked', saveProgress);
      };
      seek();
      watch = setInterval(() => {
        if (getSession() !== sessionId) { stopPurchased(); return; }
        checkpoint();
      }, 1000);
    };
    if (items.length) start(index, position);
  }
  /** Cancels the current preview; returns true when a preview was still the active archive session. */
  function endPreview() {
    const active = previewSession !== null && getSession() === previewSession;
    if (previewSession !== null) stopWatch();
    previewSession = null;
    return active;
  }
  return { playSong, playPurchased, playFree, endPreview, checkpoint: () => checkpoint(), stop: stopPurchased };
}

function nftSong(nft) {
  return { title: nft.name || nft.title || `Track #${nft.tokenId}`, artist: nft.artist || nft.creator || '',
    audioUrl: nft.videoUrl || nft.audioUrl || nft.animation_url || '', mediaType: nft.mediaType || (nft.videoUrl ? 'video/mp4' : ''),
    nft };
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
  const recovery = createPersonalPlayRecovery();
  const recoverySection = document.getElementById('personal-play-recovery');
  const recoveryItems = document.getElementById('personal-play-recovery-items');
  const recoveryStatus = document.getElementById('personal-play-recovery-status');
  let recoveryAddress = '';
  let activePurchase = null;
  let resuming = false;
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
      mediaType: song.mediaType, nft: song.nft || null, sessionId: song.sessionId, onEnded: song.onEnded }),
    freePlay: song => setNowPlaying(song),
    getSession: archiveSessionId,
    getMedia: archiveMedia,
    onPreviewEnded: ({ song, resume }) => {
      // An open NFT card handles the end of its own preview with its Play button.
      if (!document.dispatchEvent(new CustomEvent('dbusk-preview-ended', { cancelable: true, detail: { song } }))) return;
      pendingGate = { song, resume };
      gateText.textContent = supportsDjukeAlbumsAndGas(cfg.djukeContractVersion)
        ? `Personal listen for ${song.title}. The current creator price will be quoted before payment.`
        : `That was your 30-second preview of \u201c${song.title}\u201d. Keep listening for ${formatUsdc(LISTEN_PRICE_UNITS)} USDC \u2014 90% goes to the artist.`;
      gateStatus.textContent = '';
      if (!gate.open) gate.showModal();
    },
  });

  function recoveryError(error) {
    if (recoveryStatus) recoveryStatus.textContent = error.message;
    const paymentStatus = document.getElementById('djuke-payment-state');
    if (paymentStatus) paymentStatus.textContent = error.message;
    console.warn('[listens] Personal Play recovery:', error.message);
  }
  function ownRecoveryProfile() {
    return Boolean(recoveryAddress && recoveryAddress.toLowerCase() === window._wallet?.address?.toLowerCase());
  }
  function renderRecovery() {
    if (!recoverySection || !recoveryItems) return;
    recoverySection.hidden = !ownRecoveryProfile();
    recoveryItems.replaceChildren();
    if (recoverySection.hidden) return;
    try {
      const sessions = recovery.list(recoveryAddress).filter(session => ['pending', 'confirmed'].includes(session.status));
      recoverySection.hidden = !sessions.length && !recoveryStatus?.textContent;
      for (const session of sessions) {
        const row = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = `${session.name} · song ${session.index + 1}/${session.items.length} · ${Math.floor(session.position)}s`;
        const button = document.createElement('button');
        button.type = 'button';
        const active = activePurchase?.txHash === session.txHash && archiveSessionId();
        button.textContent = active ? 'Resume / retry · no payment' : 'Resume · no payment';
        button.disabled = resuming;
        button.addEventListener('click', async () => {
          if (resuming) return;
          resuming = true;
          renderRecovery();
          try {
            const wallet = await ensureWallet();
            if ((await wallet.signer.getAddress()).toLowerCase() !== session.payer.toLowerCase()) throw new Error('Connect the wallet that purchased this session.');
            recoveryStatus.textContent = 'Verifying your existing purchase on Base; no payment required…';
            controller.checkpoint();
            const latest = recovery.list(session.payer).find(entry => entry.txHash === session.txHash);
            if (!latest || !['pending', 'confirmed'].includes(latest.status)) throw new Error('This session is no longer available to resume.');
            await verifyPersonalPlaySession(latest, wallet.signer.provider);
            if (window._wallet?.address?.toLowerCase() !== latest.payer.toLowerCase()) throw new Error('Wallet changed during verification. Reopen your profile to resume.');
            startRecovered(latest);
          } catch (error) {
            if (error.code === 'PERSONAL_PLAY_REVERTED') recovery.update(session.payer, session.txHash, { status: 'failed' });
            recoveryError(error);
          }
          finally { resuming = false; renderRecovery(); }
        });
        const proof = document.createElement('a');
        proof.href = `https://basescan.org/tx/${session.txHash}`;
        proof.textContent = 'Purchase';
        proof.target = '_blank';
        proof.rel = 'noopener noreferrer';
        row.append(label, button, proof);
        recoveryItems.append(row);
      }
    } catch (error) { recoveryError(error); }
  }
  function startRecovered(session) {
    recovery.update(session.payer, session.txHash, { status: 'confirmed' });
    if (window._wallet?.address?.toLowerCase() !== session.payer.toLowerCase()) {
      throw new Error('Purchase saved. Reconnect the purchasing wallet and resume in Profile → Playlists; do not pay again.');
    }
    controller.stop();
    activePurchase = session;
    let displayedIndex = session.index;
    const persist = changes => {
      try { recovery.update(session.payer, session.txHash, changes); return true; }
      catch (error) { recoveryError(error); return false; }
    };
    controller.playPurchased(session.items, {
      index: session.index, position: session.position,
      onProgress: progress => {
        persist(progress);
        if (progress.index !== displayedIndex) { displayedIndex = progress.index; renderRecovery(); }
      },
      onComplete: () => {
        const saved = persist({ status: 'completed' });
        activePurchase = null;
        if (saved && recoveryStatus) recoveryStatus.textContent = `Personal Play complete. All ${session.items.length} songs finished.`;
        renderRecovery();
      },
    });
    if (recoveryStatus) recoveryStatus.textContent = 'Personal Play restored. Progress is saved in this browser; no additional payment.';
    renderRecovery();
  }
  document.addEventListener('creator-profile-view-changed', event => {
    if (recoveryAddress.toLowerCase() !== event.detail?.address?.toLowerCase() && recoveryStatus) recoveryStatus.textContent = '';
    recoveryAddress = event.detail?.address || '';
    renderRecovery();
  });
  document.addEventListener('personal-play-recovery-changed', renderRecovery);
  for (const eventName of ['wallet-connected', 'wallet-disconnected']) {
    document.addEventListener(eventName, () => {
      if (activePurchase && activePurchase.payer.toLowerCase() !== window._wallet?.address?.toLowerCase()) {
        controller.stop();
        activePurchase = null;
        returnToRadio();
      }
      if (recoveryStatus) recoveryStatus.textContent = '';
      renderRecovery();
    });
  }
  window.addEventListener('pagehide', () => controller.checkpoint());
  document.addEventListener('visibilitychange', () => controller.checkpoint());
  async function purchaseRecoverableListens(items, onStep) {
    const wallet = await ensureWallet();
    const payer = await wallet.signer.getAddress();
    recovery.check(payer, items.map(item => item.songId));
    const purchase = await purchaseListens({ ...wallet, songIds: items.map(item => item.songId), onStep,
      onSubmitted: submitted => recovery.save({ ...submitted, items, name: items.length === 1 ? items[0].title : 'Personal playlist' }) });
    startRecovered(recovery.list(payer).find(session => session.txHash === purchase.txHash));
  }

  function renderPlaylist() {
    if (!playlistEl || !playlistTotal) return;
    const items = playlist.list();
    if (document.getElementById('djuke-playlist-save')) {
      document.dispatchEvent(new CustomEvent('djuke-playlist-draft-changed', { detail: { items } }));
      return;
    }
    if (!playlistBuy) return;
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
    const count = document.getElementById('djuke-playlist-draft-count');
    if (count) count.textContent = `${items.length}/${MAX_PLAYLIST}`;
    const namedSave = document.getElementById('djuke-playlist-save');
    if (namedSave) namedSave.disabled = !items.length || items.length > MAX_NAMED_PLAYLIST || busy;
    playlistTotal.textContent = items.length ? supportsDjukeAlbumsAndGas(cfg.djukeContractVersion)
      ? `${items.length} songs - creator prices quoted before payment`
      : `${items.length} song${items.length === 1 ? '' : 's'} \u00b7 ${formatUsdc(LISTEN_PRICE_UNITS * BigInt(items.length))} USDC` : 'Empty \u2014 add songs from any DNFT card';
    playlistBuy.hidden = !items.length;
    playlistBuy.disabled = !items.length || busy;
    document.dispatchEvent(new CustomEvent('djuke-playlist-draft-changed', { detail: { items } }));
  }
  async function addToPlaylist(song, status) {
    if (!playlistEl || !playlistTotal) {
      status('Playlists are no longer shown in the DJuke panel.');
      return;
    }
    const live = await getLive().catch(() => null);
    const songId = song.songId || live?.songIdForCid(audioCid(song.audioUrl));
    if (!songId) { status('Personal playlists open when DJuke payments are live.'); return; }
    try {
      status(playlist.add({ ...song, songId }) ? 'Added to your listen cart. Named saves support up to 24 songs; listen carts support 50.' : 'Already in your listen cart.');
      renderPlaylist();
    } catch (error) { status(error.message); }
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
  playlistBuy?.addEventListener('click', async () => {
    const items = playlist.list();
    if (!items.length || busy) return;
    busy = true;
    renderPlaylist();
    const status = document.getElementById('djuke-payment-state');
    try {
      await purchaseRecoverableListens(items, text => { status.textContent = text; });
      status.textContent = 'Enjoy your playlist!';
    } catch (error) {
      status.textContent = error.shortMessage || error.reason || error.message;
    } finally { busy = false; renderPlaylist(); }
  });
  document.addEventListener('dbusk-listen', event => {
    event.preventDefault();
    const song = nftSong(event.detail.nft);
    controller.playSong(song).then(mode => {
      document.dispatchEvent(new CustomEvent('dbusk-listen-started', { detail: { mode, song } }));
    });
  });
  // Single-view Play: pay for one full listen up front, then play from the start without a preview gate.
  async function buyFullListen(song, status) {
    if (busy) throw new Error('A payment is already in progress');
    const live = await getLive().catch(() => null);
    const songId = live?.songIdForCid(audioCid(song.audioUrl));
    if (!songId) { controller.playFree(song); status('Playing the full track.'); return 'free'; }
    // Cancel the active archive preview before opening the wallet so the user is not
    // left with a half-complete 30-second preview while waiting for a transaction.
    controller.endPreview();
    busy = true;
    renderPlaylist();
    try {
      status('Opening your wallet\u2026');
      await purchaseRecoverableListens([{ ...song, songId }], status);
      if (gate.open) gate.close();
      pendingGate = null;
      status('Enjoy the full track!');
      return 'purchased';
    } finally { busy = false; renderPlaylist(); }
  }
  document.addEventListener('dbusk-buy-listen', event => {
    event.preventDefault();
    const status = event.detail.status || (() => {});
    event.detail.result = buyFullListen(nftSong(event.detail.nft), status).catch(error => {
      status(error.shortMessage || error.reason || error.message);
      return 'failed';
    });
  });
  document.addEventListener('dbusk-preview-close', () => {
    if (controller.endPreview()) returnToRadio();
  });
  getLive().catch(() => {});
  document.addEventListener('dbusk-playlist-add', event => {
    event.preventDefault();
    addToPlaylist(nftSong(event.detail.nft), event.detail.status || (() => {}));
  });
  document.addEventListener('djuke-set-playlist-draft', event => {
    try { playlist.replace(event.detail?.items || []); renderPlaylist(); }
    catch (error) { document.getElementById('djuke-playlist-state').textContent = error.message; }
  });
  document.addEventListener('djuke-private-playlist-purchased', event => {
    try {
      const session = recovery.list(event.detail.payer).find(entry => entry.txHash === event.detail.txHash);
      if (!session) throw new Error('Confirmed Personal Play purchase could not be restored. Do not purchase again; keep your receipt.');
      startRecovered(session);
    } catch (error) { recoveryError(error); }
  });
  renderPlaylist();
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', initListens, { once: true });
