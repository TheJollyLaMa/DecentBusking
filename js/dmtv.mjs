import { ensureBaseNetwork, approvalNotice } from './base-chain.mjs';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { SETTLEMENT_ROUTER_ADDRESS, verifyContributionReceipt } from './fund-contribution.mjs';
import { BASE_USDC_ADDRESS } from './settlement-funds.mjs';
import { renderWalletAddress, resolveWalletLabel } from './fund-display.mjs';
import { workerEnsProvider } from './ens-client.mjs';
import { dmtvRadioAuthorization } from './dmtv-radio.mjs';
import { DMTV_ESCROW_ABI, reserveDmtvVideo } from './dmtv-escrow.mjs';
import { songSplitOwners, songSplitPayeeResolver } from './song-split-wallet.mjs';

export const DMTV_PRICE_UNITS = 2000000n;
export const DMTV_CREATOR_UNITS = 1000000n;
export const DMTV_FUND_UNITS = 1000000n;
export const DMTV_MAIN_RADIO_PRICE_UNITS = 3000000n;
export const DMTV_MAIN_RADIO_CREATOR_UNITS = 1000000n;
export const DMTV_MAIN_RADIO_FUND_UNITS = 2000000n;
export const DMTV_FUND_SLUG = 'dbusk-playback';
const QUEUE_KEY = 'decentbusking:dmtv-queue:v3';
const paymentKey = payer => `decentbusking:dmtv-payment:8453:${payer.toLowerCase()}`;
const AD_INTERVAL = 10;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const VIDEO_TYPE = /^video\/(?:mp4|webm|quicktime|ogg)$/i;
const VIDEO_EXTENSION = /\.(mp4|webm|mov|ogv)(?:[?#]|$)/i;
const ROUTER_ABI = [
  'function paused() view returns(bool)',
  'function funds(bytes32) view returns(string metadataUri,bool active,bool exists)',
  'function approvedAssets(address) view returns(bool)',
  'function fundToken(bytes32,address,uint256)',
];
const USDC_ABI = [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];

function mediaUrl(value, config = {}) {
  const uri = String(value || '').trim();
  const gateway = String(config.ipfsGateway || 'https://gateway.pinata.cloud/ipfs/').replace(/\/+$/, '');
  const url = /^ipfs:\/\//i.test(uri) ? `${gateway}/${uri.replace(/^ipfs:\/\/(?:ipfs\/)?/i, '')}` : uri;
  return /^https?:\/\//i.test(url) ? url : '';
}

function mediaKey(uri) {
  const url = mediaUrl(uri);
  return url.match(/\/ipfs\/([^/?#]+)([^?#]*)/i)?.slice(1).join('') || url.split(/[?#]/)[0];
}

export function dmtvExperienceVideo(nft) {
  const uri = [nft.videoUrl, nft.animation_url, nft.mediaUri, nft.audioUrl].find(value => mediaUrl(value));
  const type = String(nft.mediaType || '').split(';')[0].trim();
  if (!uri || (type ? !VIDEO_TYPE.test(type) : !VIDEO_EXTENSION.test(uri))) return '';
  return uri;
}

export function dmtvArchiveItems(nfts, campaigns = [], { splitPayee = null } = {}) {
  const adMedia = new Set(campaigns.map(ad => mediaKey(ad.videoUrl || ad.audioURI)).filter(Boolean));
  const seen = new Set();
  return nfts.flatMap(nft => {
    const videoUrl = dmtvExperienceVideo(nft);
    const nftId = nft.nftId || (nft.contractAddress && nft.tokenId != null ? `${nft.contractAddress}:${nft.tokenId}` : '');
    const title = nft.name || nft.title || '';
    if (!videoUrl || !nftId || seen.has(nftId) || nft.isDevertAd || adMedia.has(mediaKey(videoUrl)) ||
        ['music-only', 'all-radio'].includes(nft.contentReview?.scope) ||
        /(?:subvertisement|advertisement)|^DecentAdvert(?:\b|[0-9_-])/i.test(title)) return [];
    seen.add(nftId);
    const owners = songSplitOwners(nft);
    // Shared songs pay their split wallet; without one they stay unpaid rather than paying a single owner.
    const creator = owners ? (splitPayee?.(owners) || '') :
      [nft.creator, nft.artist, nft.recipient, nft.tipWallet].find(value => ADDRESS.test(value || '')) || '';
    const artist = [nft.ensName, nft.discordName, nft.artistName, nft.artist].find(value => typeof value === 'string' && value.trim() && !ADDRESS.test(value)) || '';
    return [{ nftId, creator, artist, videoUrl, title: title || `Video #${nft.tokenId}`, ...(owners ? { owners } : {}) }];
  });
}

export function dmtvVideoAds(campaigns, nfts, now = Date.now()) {
  const archiveMedia = new Set(nfts.map(dmtvExperienceVideo).map(mediaKey).filter(Boolean));
  const seen = new Set();
  return campaigns.flatMap(ad => {
    const videoUrl = dmtvExperienceVideo({ ...ad, mediaUri: ad.videoUrl || ad.audioURI });
    const uri = ad.videoUrl || ad.audioURI;
    const key = mediaKey(uri);
    if (!key || seen.has(key) || ad.removed || ad.moderationBlocked ||
        !(Date.parse(ad.startedAt) <= now && now < Date.parse(ad.expiresAt)) ||
        (!videoUrl && !archiveMedia.has(key))) return [];
    seen.add(key);
    return [{ title: ad.title || 'DVert', videoUrl: uri, expiresAt: Date.parse(ad.expiresAt) }];
  });
}

export function createDmtvRotation() {
  let archiveCursor = 0;
  let adCursor = 0;
  let completed = 0;
  return {
    complete(item) {
      if (item?.kind === 'video') completed += 1;
    },
    next(archive, paid, ads) {
      if (completed >= AD_INTERVAL) {
        completed = 0;
        const ad = ads.length ? ads[adCursor++ % ads.length] : null;
        return ad ? { ...ad, kind: 'ad' } : { kind: 'house-ad' };
      }
      const request = paid[0];
      if (request) return { ...request, kind: 'video' };
      if (!archive.length) return null;
      return { ...archive[archiveCursor++ % archive.length], kind: 'video' };
    },
  };
}

function assertCreatorTransfer(receipt, usdc, payer, creator) {
  const verified = receipt?.status === 1 && receipt.logs.some(log => {
    if (log.address.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) return false;
    const event = usdc.interface.parseLog(log);
    return event?.name === 'Transfer' && event.args.from.toLowerCase() === payer.toLowerCase() &&
      event.args.to.toLowerCase() === creator.toLowerCase() && event.args.value === DMTV_CREATOR_UNITS;
  });
  if (!verified) throw new Error('The creator receipt does not prove the $1 USDC transfer.');
}

export function verifyDmtvFundReceipt(receipt, payer, ethers, amount = DMTV_FUND_UNITS) {
  verifyContributionReceipt({ receipt, ethers, operation: {
    slug: DMTV_FUND_SLUG, stage: 'deposit', address: payer, amountUnits: String(amount),
  } });
  return amount;
}

async function purchaseSpot({ signer, ethers, experience, onStep, onFund, queueSpot, radioBase }) {
  await ensureBaseNetwork(signer.provider);
  const { creator, nftId } = experience;
  const payer = await signer.getAddress();
  if (!ADDRESS.test(creator) || payer.toLowerCase() === creator.toLowerCase()) {
    throw new Error('Choose a video with a verified creator wallet other than your own.');
  }
  const lock = paymentKey(payer);
  const key = radioBase ? `${lock}:radio` : lock;
  const fundUnits = radioBase ? DMTV_MAIN_RADIO_FUND_UNITS : DMTV_FUND_UNITS;
  const fundText = radioBase ? '2.00' : '1.00';
  if (!navigator.locks) throw new Error('Use a browser with cross-tab purchase protection.');
  return navigator.locks.request(lock, async () => {
    const usdc = new ethers.Contract(BASE_USDC_ADDRESS, USDC_ABI, signer);
    const router = new ethers.Contract(SETTLEMENT_ROUTER_ADDRESS, ROUTER_ABI, signer);
    const fundId = ethers.id(DMTV_FUND_SLUG);
    const existing = JSON.parse(localStorage.getItem(key) || 'null');
    const operation = existing || { nftId, creator, creatorTx: null, fundTx: null };
    if (operation.nftId !== nftId || operation.creator.toLowerCase() !== creator.toLowerCase()) {
      throw new Error('Select the video from your unfinished purchase to resume it.');
    }
    if (radioBase && !operation.ticket) {
      const quote = await postRadio(radioBase, 'quote', { payer, nftId });
      if (!quote.ticket || quote.creator?.toLowerCase() !== creator.toLowerCase()) {
        throw new Error('The main-radio creator does not match the archive. No payment was sent.');
      }
      operation.ticket = quote.ticket;
    }

    async function confirm(field, send, verify) {
      if (operation[field] === 'pending') {
        throw new Error('An earlier wallet submission is unresolved. Check your wallet history before retrying.');
      }
      if (!operation[field]) {
        operation[field] = 'pending';
        localStorage.setItem(key, JSON.stringify(operation));
        try {
          const transaction = await send();
          operation[field] = transaction.hash;
          localStorage.setItem(key, JSON.stringify(operation));
        } catch (error) {
          if (error.code === 'ACTION_REJECTED' || error.code === 4001) {
            operation[field] = null;
            if (!operation.creatorTx && !operation.fundTx) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify(operation));
          }
          throw error;
        }
      }
      const hash = operation[field];
      const receipt = await signer.provider.waitForTransaction(hash, 2, 120000);
      if (!receipt) throw new Error(`Payment ${hash} is still pending. Select this video again to resume.`);
      if (receipt.status === 0) {
        operation[field] = null;
        if (!operation.creatorTx && !operation.fundTx) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(operation));
        throw new Error(`Payment ${hash} reverted. Select this video again to retry that step.`);
      }
      verify(receipt);
      return hash;
    }

    if (!operation.fundTx) {
      const remaining = operation.creatorTx ? fundUnits : DMTV_CREATOR_UNITS + fundUnits;
      if (await usdc.balanceOf(payer) < remaining) throw new Error('There is not enough Base USDC for the remaining payment.');
      const fund = await router.funds(fundId);
      if (await router.paused() || !fund.exists || !fund.active || !await router.approvedAssets(BASE_USDC_ADDRESS)) {
        throw new Error('The weekly Playback fund cannot receive Base USDC right now.');
      }
      if (await usdc.allowance(payer, SETTLEMENT_ROUTER_ADDRESS) < fundUnits) {
        onStep(approvalNotice(fundText));
        const approval = await usdc.approve(SETTLEMENT_ROUTER_ADDRESS, fundUnits);
        if ((await approval.wait(2))?.status !== 1) throw new Error('Weekly fund approval did not confirm.');
      }
      await router.fundToken.staticCall(fundId, BASE_USDC_ADDRESS, fundUnits);
    }
    onStep('Confirming the $1 creator share…');
    const creatorTx = await confirm('creatorTx', () => usdc.transfer(creator, DMTV_CREATOR_UNITS),
      receipt => assertCreatorTransfer(receipt, usdc, payer, creator));
    onStep(`Confirming the $${fundText} weekly Playback contribution…`);
    const fundTx = await confirm('fundTx', () => router.fundToken(fundId, BASE_USDC_ADDRESS, fundUnits),
      receipt => verifyDmtvFundReceipt(receipt, payer, ethers, fundUnits));
    if (!operation.celebrated) {
      operation.celebrated = true;
      localStorage.setItem(key, JSON.stringify(operation));
      onFund(fundTx, fundText);
    }
    if (radioBase) {
      onStep('Both payments confirmed. Sign to submit your video to the main radio.');
      if (!operation.signature) {
        operation.signature = await signer.signMessage(dmtvRadioAuthorization(operation.ticket, creatorTx, fundTx));
        localStorage.setItem(key, JSON.stringify(operation));
      }
      const response = await postRadio(radioBase, 'submit', { ticket: operation.ticket, creatorTx, fundTx, signature: operation.signature });
      if (!response.requestId) throw new Error('Queue acknowledgment missing. Choose this video again to resume; no repeat payment is needed.');
    } else queueSpot({ nftId, fundTx });
    localStorage.removeItem(key);
  });
}

async function postRadio(base, operation, body) {
  const response = await fetch(`${base}/api/dmtv/radio/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `DMTv radio returned HTTP ${response.status}`);
  return result;
}

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
  if (!response.ok) throw new Error(`${path.split('?')[0]} returned HTTP ${response.status}`);
  return response.json();
}

function readPaidSpots() {
  const records = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  if (!Array.isArray(records)) throw new Error('The saved DMTv queue could not be read.');
  return records;
}

export function initDmtv() {
  const byId = id => document.getElementById(id);
  const tab = byId('dmtv-tab');
  const panel = byId('dmtv-panel');
  if (!tab || !panel) return () => {};
  const queue = byId('dmtv-queue');
  const player = byId('dmtv-video-player');
  const status = byId('dmtv-status');
  const now = byId('dmtv-now');
  const receipt = byId('dmtv-receipt');
  const fallback = byId('dmtv-screen-fallback');
  const play = byId('dmtv-play');
  const retry = byId('dmtv-retry');
  const search = byId('dmtv-search');
  const buy = byId('dmtv-queue-button');
  const radioBuy = byId('dmtv-takeover-button');
  const radioStatus = byId('dmtv-radio-unavailable');
  const info = byId('dmtv-instructions');
  const rotation = createDmtvRotation();
  const names = new Map();
  const aliasCache = new Map();
  const failed = new Set();
  const cfg = window.DecentConfig || {};
  const base = String(cfg.ipfsUploadServiceUrl || cfg.publicWorkerUrl || '').replace(/\/$/, '');
  let opened = false;
  let started = false;
  let buying = false;
  let radioReady = false;
  let escrowState;
  let sharedPlayId;
  let hls;
  let hlsLoader;
  let sharedTimer;
  const unsettledReservations = new Set();
  const escrowAddress = () => cfg.dmtvEscrowAddress || '';
  const isEscrow = () => ADDRESS.test(escrowAddress());
  const splitPayee = songSplitPayeeResolver({ factory: cfg.songSplitWalletFactory,
    implementation: cfg.songSplitWalletImplementation }, window.ethers);
  let selected = null;
  let current = null;
  let archive = [];
  let ads = [];
  let catalog = [];
  let advertRefresh;
  let adTimer;
  let loadTask;

  function animateFunds(txHash, amountText, slugs = ['dbusk-playback']) {
    announcePaymentCelebration({ chainId: 8453, txHash, amountText, assetText: 'USDC',
      summary: 'DMTv weekly fund contribution confirmed', txLabel: 'Weekly fund deposit' });
    if (!opened || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const antenna = panel.querySelector('.dmtv-antenna').getBoundingClientRect();
    const targets = slugs.map(slug => byId(`${slug}-button`)?.getBoundingClientRect()).filter(rect => rect?.width);
    if (!targets.length) return;
    for (let i = 0; i < (amountText === '2.00' ? 12 : 8); i++) {
      const target = targets[i % targets.length];
      const cash = document.createElement('span');
      cash.className = 'dmtv-cash-particle';
      cash.setAttribute('aria-hidden', 'true');
      cash.textContent = '💵';
      cash.style.left = `${antenna.left}px`;
      cash.style.top = `${antenna.top}px`;
      cash.style.setProperty('--dx', `${target.left + target.width / 2 - antenna.left}px`);
      cash.style.setProperty('--dy', `${target.top + target.height / 2 - antenna.top}px`);
      cash.style.setProperty('--delay', `${i * 55}ms`);
      document.body.append(cash);
      setTimeout(() => cash.remove(), 1700);
    }
  }

  function updateButtons() {
    const resume = !isEscrow() && canResumeRadio();
    buy.disabled = buying || !selected?.creator || !isEscrow() || !escrowState?.sideReady;
    radioBuy.disabled = buying || !selected?.creator || (!radioReady && !resume);
    radioStatus.textContent = resume ? 'Resume unfinished main-radio checkout'
      : radioReady ? 'Plays in the shared DJuke / DMTv queue'
      : escrowState?.radioUnavailableReason || 'Main-radio checkout unavailable';
  }

  function canResumeRadio() {
    const wallet = window._wallet?.address;
    if (!selected || !ADDRESS.test(wallet || '')) return false;
    try {
      return JSON.parse(localStorage.getItem(`${paymentKey(wallet)}:radio`) || 'null')?.nftId === selected.nftId;
    } catch (error) {
      console.warn('[DMTv] Unable to read saved checkout:', error.message);
      return false;
    }
  }

  async function refreshRadio() {
    try {
      if (isEscrow()) {
        const state = await getJson(base, '/api/dmtv/escrow');
        escrowState = state.address?.toLowerCase() === escrowAddress().toLowerCase() ? state : null;
        radioReady = escrowState?.radioReady === true;
        for (const settlement of escrowState?.settlements || []) {
          if (!/^0x[0-9a-f]{64}$/i.test(settlement.txHash) ||
              !unsettledReservations.delete(`${settlement.lane}:${settlement.requestId}`)) continue;
          animateFunds(settlement.txHash, settlement.lane === 1 ? '2.00' : '1.00',
            ['dbusk-top10', 'dbusk-playback', 'dbusk-pinners', 'dbusk-repo-dev', 'dbusk-live-performers']);
        }
      } else {
        radioReady = false;
      }
    } catch (error) {
      escrowState = null;
      radioReady = false;
      console.warn('[DMTv] Main-radio checkout unavailable:', error.message);
    }
    updateButtons();
  }

  async function followStation() {
    await refreshRadio();
    if (!opened || !started || !isEscrow()) return;
    const currentPlay = escrowState?.station?.current;
    if (!currentPlay) {
      now.textContent = 'Waiting for the shared DMTv stream…';
      return;
    }
    if (sharedPlayId === currentPlay.playId) return;
    if (!/^\/api\/dmtv\/stream\/[a-f0-9-]{36}\/live\.m3u8$/.test(currentPlay.manifest)) {
      throw new Error('DMTv returned an invalid stream.');
    }
    const url = `${base}${currentPlay.manifest}`;
    if (!player.canPlayType('application/vnd.apple.mpegurl') && !window.Hls) {
      hlsLoader ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${base}/api/radio/hls-client.js`;
        script.onload = resolve;
        script.onerror = () => { hlsLoader = null; script.remove(); reject(new Error('DMTv video player failed to load.')); };
        document.head.append(script);
      });
      await hlsLoader;
    }
    if (!opened || !started || sharedPlayId === currentPlay.playId) return;
    hls?.destroy();
    if (player.canPlayType('application/vnd.apple.mpegurl')) player.src = url;
    else {
      if (!window.Hls?.isSupported()) throw new Error('This browser does not support DMTv streaming.');
      hls = new window.Hls();
      hls.loadSource(url);
      hls.attachMedia(player);
    }
    sharedPlayId = currentPlay.playId;
    now.textContent = `Now on DMTv · ${currentPlay.title}`;
    player.hidden = false;
    fallback.hidden = true;
    void player.play().catch(() => { status.textContent = 'Press play on the TV to continue.'; });
  }

  function syncStation() {
    void followStation().catch(error => { status.textContent = error.message; });
  }

  function renderArchive() {
    const term = search.value.trim().toLowerCase();
    const rows = archive.filter(item => !term || [item.title, item.artist, item.creator, names.get(item.creator)]
      .some(value => String(value || '').toLowerCase().includes(term)));
    queue.replaceChildren();
    for (const item of rows) {
      const row = document.createElement('li');
      row.className = 'dmtv-video-item';
      row.classList.toggle('dmtv-current', current?.nftId === item.nftId);
      row.classList.toggle('dmtv-selected', selected?.nftId === item.nftId);
      const tag = document.createElement('span');
      tag.textContent = '🎬';
      const button = document.createElement('button');
      button.type = 'button';
      const title = document.createElement('strong');
      title.textContent = item.title;
      button.append(title);
      button.setAttribute('aria-pressed', String(selected?.nftId === item.nftId));
      button.addEventListener('click', () => {
        selected = item;
        updateButtons();
        for (const control of queue.querySelectorAll('button')) {
          control.setAttribute('aria-pressed', String(control === button));
          control.parentElement.classList.toggle('dmtv-selected', control === button);
        }
        receipt.textContent = item.creator ? `Selected: ${item.title}` : 'This video has no verified payout wallet.';
      });
      const artist = document.createElement('small');
      const label = item.artist || names.get(item.creator);
      if (item.owners) {
        artist.className = 'dmtv-split-owners';
        artist.setAttribute('aria-label', `Shared by ${item.owners.length} owners`);
        void import('./creator-split-pie.mjs?v=20261123-split-admin-pies')
          .then(({ renderCreatorSplitPie }) => renderCreatorSplitPie(artist, item.owners,
            { label: `${item.title} payout split`, size: 'compact' }))
          .catch(() => { artist.textContent = `Shared by ${item.owners.length} owners`; });
      } else if (label && !label.includes('…') && !ADDRESS.test(label)) artist.textContent = label;
      else if (item.creator) artist.innerHTML = renderWalletAddress(item.creator);
      else artist.textContent = 'Artist unavailable';
      row.append(tag, button, artist);
      queue.append(row);
    }
    if (!rows.length) {
      const row = document.createElement('li');
      row.className = 'dmtv-empty';
      row.textContent = term ? 'No matching archive videos.' : 'No playable archive videos found.';
      queue.append(row);
    }
  }

  async function loadArchive() {
    if (loadTask) return loadTask;
    retry.hidden = true;
    const initial = !catalog.length;
    if (initial) status.textContent = 'Loading archive videos…';
    loadTask = (async () => {
      if (!base) throw new Error('The archive service is not configured.');
      const adsRequest = getJson(base, '/api/devert').catch(error => {
        console.warn('[DMTv] Video adverts unavailable:', error.message);
        return null;
      });
      const records = [];
      let offset = 0;
      while (offset !== null) {
        const page = await getJson(base, `/api/nfts?media=video&offset=${offset}&limit=25`);
        if (!Array.isArray(page.nfts) || (page.nextOffset !== null &&
          (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) throw new Error('Invalid archive page.');
        records.push(...page.nfts);
        offset = page.nextOffset;
      }
      const advertState = await adsRequest;
      const campaigns = advertState?.campaigns || [];
      const blocked = new Set((advertState?.contentBlockedMedia || []).map(mediaKey));
      catalog = records;
      const next = dmtvArchiveItems(records, campaigns, { splitPayee })
        .filter(item => !blocked.has(mediaKey(item.videoUrl)));
      const changed = initial || JSON.stringify(archive) !== JSON.stringify(next);
      archive = next;
      ads = advertState?.paused ? [] : dmtvVideoAds(campaigns, records).filter(ad => !blocked.has(mediaKey(ad.videoUrl)));
      play.disabled = !archive.length;
      if (initial) status.textContent = archive.length ? 'Pick a video to queue it, or press ▶ to watch the rotation.' : 'No archive videos are available.';
      if (selected) {
        selected = archive.find(item => item.nftId === selected.nftId) || null;
        updateButtons();
      }
      if (changed) renderArchive();
      const addresses = [...new Set(archive.filter(item => !item.artist && !item.owners && item.creator && !names.has(item.creator)).map(item => item.creator))];
      for (let i = 0; i < addresses.length; i += 5) {
        await Promise.all(addresses.slice(i, i + 5).map(async address => {
          try {
            const wallet = await resolveWalletLabel(address, workerEnsProvider, cfg.sponsorAliases, aliasCache);
            names.set(address, wallet.label);
          } catch (error) {
            console.warn('[DMTv] Artist identity unavailable:', error.message);
          }
        }));
      }
      if (addresses.length && !selected) renderArchive();
    })().catch(error => {
      status.textContent = `Archive unavailable: ${error.message}. Retry in a moment.`;
      retry.hidden = false;
    })
      .finally(() => { loadTask = null; });
    return loadTask;
  }

  function stopMedia() {
    clearTimeout(adTimer);
    player.pause();
    player.hidden = true;
    player.removeAttribute('src');
    player.load();
  }

  function houseBreak() {
    stopMedia();
    current = { kind: 'house-ad' };
    fallback.hidden = false;
    play.hidden = true;
    now.textContent = '📺 DMTv break · Queue an archive video to support its creator.';
    adTimer = setTimeout(advance, 6000);
  }

  function advance() {
    if (!opened || !started) return;
    if (isEscrow()) return syncStation();
    clearTimeout(adTimer);
    const playable = archive.filter(item => !failed.has(item.nftId));
    const byNft = new Map(playable.map(item => [item.nftId, item]));
    let paid = [];
    try {
      paid = readPaidSpots().filter(spot => !spot.played && byNft.has(spot.nftId))
        .map(spot => ({ ...byNft.get(spot.nftId), fundTx: spot.fundTx }));
    } catch (error) {
      status.textContent = error.message;
    }
    current = rotation.next(playable, paid, ads.filter(ad => ad.expiresAt > Date.now()));
    renderArchive();
    if (!current) {
      started = false;
      stopMedia();
      fallback.hidden = false;
      play.hidden = false;
      play.textContent = '↻ Try DMTv again';
      now.textContent = 'No videos could be played.';
      return;
    }
    if (current.kind === 'house-ad') return houseBreak();
    player.src = mediaUrl(current.videoUrl, cfg);
    player.hidden = false;
    fallback.hidden = true;
    now.textContent = `${current.kind === 'ad' ? '📢 DVert' : 'Now on DMTv'} · ${current.title}`;
    void player.play().catch(error => {
      if (error.name === 'NotAllowedError' && opened) status.textContent = 'Press play on the TV to continue.';
      else if (error.name !== 'AbortError' && error.name !== 'NotSupportedError') status.textContent = `Playback: ${error.message}`;
    });
  }

  player.addEventListener('ended', () => {
    if (isEscrow()) return syncStation();
    if (!opened || !started || !current) return;
    rotation.complete(current);
    if (current.fundTx) {
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(readPaidSpots().map(spot =>
          spot.fundTx === current.fundTx ? { ...spot, played: true } : spot)));
      } catch (error) {
        status.textContent = `Could not save playback: ${error.message}`;
        started = false;
        stopMedia();
        fallback.hidden = false;
        play.hidden = false;
        return;
      }
    }
    advance();
  });
  player.addEventListener('error', () => {
    if (isEscrow()) {
      if (opened && started) status.textContent = 'DMTv playback interrupted. Waiting for the next video.';
      return;
    }
    if (!opened || !started || !current || !player.getAttribute('src')) return;
    if (current.kind === 'ad') return houseBreak();
    failed.add(current.nftId);
    status.textContent = `Skipped unavailable video: ${current.title}`;
    advance();
  });

  function setOpen(value, { restoreFocus = true } = {}) {
    if (opened === value) return;
    opened = value;
    panel.classList.toggle('dmtv-open', opened);
    document.body.classList.toggle('dmtv-open', opened);
    panel.setAttribute('aria-hidden', String(!opened));
    panel.inert = !opened;
    tab.setAttribute('aria-expanded', String(opened));
    if (opened) {
      document.dispatchEvent(new CustomEvent('left-drawer-open', { detail: 'dmtv' }));
      void refreshRadio();
      void loadArchive();
      advertRefresh = setInterval(() => { void loadArchive(); void refreshRadio(); }, 60_000);
      if (isEscrow()) sharedTimer = setInterval(syncStation, 4000);
      if (started && current?.kind === 'house-ad') houseBreak();
      else if (started && current) void player.play().catch(() => { status.textContent = 'Press play on the TV to continue.'; });
    } else {
      player.pause();
      clearTimeout(adTimer);
      clearInterval(advertRefresh);
      clearInterval(sharedTimer);
      hls?.destroy();
      hls = null;
      sharedPlayId = null;
      if (isEscrow()) stopMedia();
      if (info.open) info.close();
      if (restoreFocus) tab.focus();
    }
  }
  tab.addEventListener('click', () => setOpen(!opened));
  const closeForOtherDrawer = event => {
    if (event.detail !== 'dmtv') setOpen(false, { restoreFocus: false });
  };
  document.addEventListener('left-drawer-open', closeForOtherDrawer);
  byId('dmtv-close').addEventListener('click', () => setOpen(false));
  byId('dmtv-info').addEventListener('click', () => info.showModal());
  retry.addEventListener('click', () => void loadArchive());
  search.addEventListener('input', renderArchive);
  play.addEventListener('click', () => {
    failed.clear();
    started = true;
    advance();
  });
  async function checkout(radio) {
    if (!selected || buying || !(radio ? radioReady || (!isEscrow() && canResumeRadio()) : isEscrow() && escrowState?.sideReady)) return;
    const experience = selected;
    buying = true;
    updateButtons();
    try {
      if (!window._wallet?.signer) await window._wallet?.connect?.();
      if (!window._wallet?.signer || !window.ethers) throw new Error('Connect a Base wallet first.');
      if (isEscrow()) {
        const { signer } = window._wallet;
        const ethers = window.ethers;
        await ensureBaseNetwork(signer.provider);
        const payer = await signer.getAddress();
        await refreshRadio();
        if (!(radio ? radioReady : escrowState?.sideReady)) throw new Error('This paid queue is temporarily offline.');
        if (!navigator.locks) throw new Error('Use a browser with cross-tab purchase protection.');
        const escrow = new ethers.Contract(escrowAddress(), DMTV_ESCROW_ABI, signer);
        const usdc = new ethers.Contract(BASE_USDC_ADDRESS, USDC_ABI, signer);
        const reservation = await navigator.locks.request(paymentKey(payer), () =>
          reserveDmtvVideo({ escrow, usdc, lane: radio ? 1 : 0, videoId: ethers.id(experience.nftId),
            mediaHash: ethers.id(experience.videoUrl), creator: experience.creator, payer,
            onStep: message => { receipt.textContent = message; } }));
        unsettledReservations.add(`${radio ? 1 : 0}:${reservation.requestId}`);
        receipt.textContent = `Reserved #${reservation.requestId} for ${radio ? 'main radio' : 'shared DMTv'}. Refund available if unplayed after ${new Date(reservation.refundAt * 1000).toLocaleString()}.`;
        return;
      }
      await purchaseSpot({ signer: window._wallet.signer, ethers: window.ethers, experience, radioBase: radio ? base : '',
        onStep: message => { receipt.textContent = message; }, onFund: animateFunds,
        queueSpot: spot => {
          const records = readPaidSpots();
          if (records.some(record => record.fundTx === spot.fundTx)) return false;
          localStorage.setItem(QUEUE_KEY, JSON.stringify([...records, spot]));
          return true;
        },
      });
      const payee = experience.owners ? `$1 split to ${experience.owners.length} owners` : '$1 creator';
      receipt.textContent = radio
        ? `Queued on the main radio: ${experience.title} · ${payee} + $2 weekly Playback fund.`
        : `Queued on this device: ${experience.title} · ${payee} + $1 weekly Playback fund.`;
      if (!radio && !started && opened) {
        started = true;
        advance();
      }
    } catch (error) {
      receipt.textContent = error.shortMessage || error.message;
    } finally {
      buying = false;
      updateButtons();
    }
  }
  buy.addEventListener('click', () => void checkout(false));
  radioBuy.addEventListener('click', () => void checkout(true));
  return () => {
    document.removeEventListener('left-drawer-open', closeForOtherDrawer);
    setOpen(false, { restoreFocus: false });
  };
}
