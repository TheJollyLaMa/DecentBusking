import { BASE_USDC_ADDRESS, DJUKE_BROWSER_ABI, purchaseDjukeSong, replaceDjukeSong } from './djuke-payment.mjs';
import { checkoutRadioPlaylist, checkoutPrivatePlaylist } from './djuke-checkout.mjs';
import { createNamedPlaylistClient, quoteNamedPlaylist } from './djuke-playlists.mjs';
import { createPersonalPlayRecovery, verifyPersonalPlaySession } from './personal-play-recovery.mjs';
import { USDC_BROWSER_ABI } from './usdc-abi.mjs';
import { formatUsdcUnits } from './usdc-format.mjs';
import { playlistBatchProgress } from './djuke-playlist-progress.mjs';

const mounts = new WeakMap();
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SONG = /^0x[0-9a-f]{64}$/i;
const css = `
:host{display:block;color:var(--djuke-text,#f3f0ff);font:var(--djuke-font,16px/1.5 system-ui,sans-serif)}
.djuke{background:var(--djuke-background,#171324);border:1px solid var(--djuke-accent,#b99aff);border-radius:var(--djuke-radius,18px);padding:1.25rem;max-width:var(--djuke-width,48rem);margin:auto}
.djuke h2,.djuke h3{line-height:1.2}.djuke h2{margin-top:0}.djuke label{display:block;margin-top:.8rem}
.djuke button,.djuke input,.djuke select{font:inherit;color:inherit;background:var(--djuke-control,#302640);border:1px solid var(--djuke-accent,#b99aff);border-radius:.4rem;padding:.5rem;max-width:100%;box-sizing:border-box}
.djuke input,.djuke select{width:100%}.djuke button{cursor:pointer;margin:.25rem}.djuke button:disabled{opacity:.55;cursor:not-allowed}.djuke :focus-visible{outline:3px solid var(--djuke-accent,#b99aff);outline-offset:3px}
.djuke a{color:var(--djuke-accent,#d3bfff)}.djuke li{margin:.6rem 0}.djuke small{display:block}.djuke audio{width:100%}.djuke details{border-top:1px solid #777;padding:.8rem 0}.djuke summary{cursor:pointer}.djuke .notice{border-left:3px solid var(--djuke-accent,#b99aff);padding-left:.7rem}
@media(prefers-reduced-motion:reduce){.djuke *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

export function validateConfig(input = {}) {
  const config = { ...input };
  const service = String(config.ipfsUploadServiceUrl || '').replace(/\/$/, '');
  if (service) {
    const url = new URL(service);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('DJuke service must use HTTPS (HTTP is allowed only on localhost)');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('DJuke service URL must not contain credentials, query or fragment');
  }
  for (const field of ['djukeContractAddress', 'djukePlaylistBatchAddress']) {
    if (config[field] && !ADDRESS.test(config[field])) throw new Error(`Invalid ${field}`);
  }
  for (const field of ['djukeContractVersion', 'djukePlaylistBatchVersion']) {
    if (config[field] && config[field] !== '0.5') throw new Error('This standalone product requires USDC-only DJuke v0.5');
  }
  return Object.freeze({ ...config, ipfsUploadServiceUrl: service });
}

export function mount(element, options = {}) {
  if (!element?.attachShadow) throw new TypeError('Mount DJuke on a DOM element');
  if (mounts.has(element)) throw new Error('DJuke is already mounted on this element');
  const config = validateConfig(options.config);
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const root = element.shadowRoot || element.attachShadow({ mode: 'open' });
  const section = doc.createElement('section');
  section.className = 'djuke';
  section.setAttribute('aria-label', 'DJuke jukebox');
  const style = doc.createElement('style');
  style.textContent = css;
  section.innerHTML = `
    <h2></h2><p data-session role="status"></p>
    <p class="notice">Base · native USDC only · 90% artists/collaborators, 8% pinning, 2% dev fund.
      Normal Base network gas is additional. Payment confirmation is not playback delivery.</p>
    <p data-state role="status" aria-live="polite"></p><button data-refresh type="button">Refresh queue</button>
    <label>Search songs<input data-search type="search" placeholder="Title or artist"></label>
    <label>Song<select data-song aria-label="Select a song"></select></label>
    <p data-price></p><button data-pay type="button">Queue Song</button>
    <button data-add type="button">Add to playlist</button>
    <h3>Live paid queue</h3><ol data-queue></ol>
    <h3>Your playlist draft</h3><label>Playlist name<input data-name maxlength="60" placeholder="My mix"></label>
    <ol data-draft></ol><p data-total></p>
    <button data-save type="button">Save to Profile</button>
    <button data-private type="button">Personal Play</button><button data-live type="button">Play Live</button>
    <p data-payment role="status" aria-live="polite"></p>
    <details data-profile><summary>Profile → Playlists &amp; receipts</summary>
      <p>Saved mixes and recovery belong to your connected profile, not the public queue.</p>
      <button data-library-refresh type="button">Refresh profile</button>
      <label>Discover public playlists<input data-discover-query type="search"></label>
      <button data-discover type="button">Search playlists</button>
      <ul data-library></ul><ul data-discovered></ul>
      <h3>Your Play Live receipts</h3><div data-receipts></div>
      <h3>Personal Play recovery · no payment</h3><ul data-recovery></ul>
    </details>
    <p data-playing role="status"></p><audio data-audio controls preload="none" aria-label="Personal playlist playback"></audio>
    <details><summary>How DJuke works</summary>
      <p>Singles start at 0.25 USDC and double for each eight pending songs.
      Play Live playlists have radio tiers plus 3 USDC per started group of 12 songs (1–24).
      Main paid requests may cut in between playlist songs. Personal Play uses creator listen prices.</p>
      <p>Save to Profile signs an authorization but does not buy playback. Purchases require explicit wallet approval.
      Worker retries, per-resource EOF/PCM evidence, partial refunds and fee settlement remain platform services.
      A queued or confirming purchase is not a delivered song. Keep your Base transaction receipts.</p>
    </details>`;
  section.querySelector('h2').textContent = options.title || 'DJuke.decentagency.eth';
  root.append(style, section);
  const $ = key => section.querySelector(`[data-${key}]`);
  const cleanups = [];
  const requests = new Set();
  const lifetime = new AbortController();
  let destroyed = false, busy = false, generation = 0, timer, head, walletService, wallet = {};
  let unsubscribe, snapshot = null, radioReady = false, draft = [], activeSession = null, progressAt = 0;
  const library = options.ethers || view.ethers;
  const fetchImpl = options.fetch || view.fetch?.bind(view) || globalThis.fetch;
  const recovery = () => createPersonalPlayRecovery(options.storage || view.localStorage);
  const report = text => { if (!destroyed) $('payment').textContent = text; };
  const requireBase = async provider => {
    if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Switch to Base in the host DecentHead header');
  };
  const on = (target, type, callback) => {
    target.addEventListener(type, callback);
    cleanups.push(() => target.removeEventListener(type, callback));
  };
  const node = (tag, text) => {
    const result = doc.createElement(tag);
    if (text !== undefined) result.textContent = text;
    return result;
  };
  const button = (text, handler) => {
    const result = node('button', text);
    result.type = 'button';
    result.addEventListener('click', () => run(handler));
    return result;
  };
  async function request(path, init = {}) {
    if (destroyed) throw new Error('DJuke was unmounted');
    if (!config.ipfsUploadServiceUrl) throw new Error('DJuke platform service is not configured; cloning does not start a worker');
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(`${config.ipfsUploadServiceUrl}${path}`, { ...init,
        cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `DJuke service unavailable (${response.status})`);
      return result;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  const client = createNamedPlaylistClient({ fetchImpl: (url, init) =>
    request(url.replace(config.ipfsUploadServiceUrl, ''), init).then(body => ({ ok: true, json: async () => body })),
    getWallet: () => wallet, getServiceUrl: () => config.ipfsUploadServiceUrl, origin: view.location.origin });
  const selected = () => snapshot?.tracks?.find(track => track.trackId === $('song').value);
  const paidReady = () => !!snapshot?.paymentsEnabled && config.djukeContractVersion === '0.5' &&
    config.djukeContractAddress?.toLowerCase() === snapshot.contractAddress?.toLowerCase();
  const batchReady = () => config.djukePlaylistBatchEnabled === true && config.djukePlaylistBatchVersion === '0.5' &&
    ADDRESS.test(config.djukePlaylistBatchAddress || '') && paidReady();
  function gate() {
    if (destroyed) return;
    $('pay').disabled = busy || !paidReady() || !selected();
    $('add').disabled = busy || !selected() || draft.length >= 24;
    $('save').disabled = busy || !draft.length;
    $('private').disabled = busy || !draft.length || !batchReady();
    $('live').disabled = busy || !draft.length || !batchReady() || !radioReady;
    $('session').textContent = !head ? 'Waiting for the host DecentHead wallet/IPFS session — no second login.'
      : wallet.address ? `${wallet.ensName || wallet.address} · ${Number(wallet.chainId) === 8453 ? 'Base' : 'Switch to Base in DecentHead'}`
        : 'Connect your wallet in DecentHead before checkout. DJuke never opens a second wallet login.';
  }
  async function signer() {
    if (!head || !wallet.address || wallet.connected === false) throw new Error('Connect your wallet in the host DecentHead header');
    if (!library?.Contract) throw new Error('Host must provide ethers v6 (options.ethers)');
    if (Number(wallet.chainId) !== 8453) throw new Error('Switch to Base in the host DecentHead header, then retry');
    const address = wallet.address;
    const provider = wallet.provider;
    if (!provider?.getSigner) throw new Error('DecentHead shared BrowserProvider is unavailable');
    if (typeof provider.hasSigner === 'function' && !await provider.hasSigner(address)) throw new Error('Reconnect the existing wallet in the host DecentHead header');
    const result = await provider.getSigner(address);
    if (destroyed || wallet.address?.toLowerCase() !== address.toLowerCase()) throw new Error('Wallet changed; retry from your profile');
    return result;
  }
  async function run(action) {
    if (destroyed || busy) return;
    busy = true; gate();
    try { await action(); } catch (error) { report(error.shortMessage || error.message); }
    finally { busy = false; gate(); }
  }
  function renderSongs() {
    const previous = $('song').value;
    const terms = $('search').value.toLowerCase().trim().split(/\s+/);
    const choices = (snapshot?.tracks || []).filter(track => terms.every(term =>
      `${track.title} ${track.artist || track.uploader || ''}`.toLowerCase().includes(term)));
    $('song').replaceChildren(node('option', choices.length ? 'Select one song' : 'No matching songs'));
    $('song').firstChild.value = '';
    for (const track of choices) {
      const option = node('option', `${track.title} — ${track.artist || track.uploader || 'Unknown artist'}`);
      option.value = track.trackId;
      $('song').append(option);
    }
    $('song').value = choices.some(track => track.trackId === previous) ? previous : '';
    gate();
  }
  function renderDraft() {
    $('draft').replaceChildren();
    draft.forEach((track, index) => {
      const row = node('li', `${index + 1}. ${track.title}`);
      if (index) row.append(button(`Move ${track.title} earlier`, () => {
        [draft[index - 1], draft[index]] = [draft[index], draft[index - 1]]; renderDraft();
      }));
      if (index + 1 < draft.length) row.append(button(`Move ${track.title} later`, () => {
        [draft[index + 1], draft[index]] = [draft[index], draft[index + 1]]; renderDraft();
      }));
      row.append(button(`Remove ${track.title}`, () => { draft.splice(index, 1); renderDraft(); }));
      $('draft').append(row);
    });
    $('total').textContent = draft.length ? `${draft.length}/24 songs · Personal Play estimate ${formatUsdcUnits(
      quoteNamedPlaylist(draft.length, 'private', draft.map(track => track.listenPriceUnits)).totalUnits)} USDC · Play Live ${formatUsdcUnits(
      quoteNamedPlaylist(draft.length, 'radio').totalUnits)} USDC. Exact chain quote verified before payment.` : 'Empty playlist · choose songs above';
    gate();
  }
  function renderReceipts() {
    $('receipts').replaceChildren();
    for (const receipt of (snapshot?.playlistReceipts || []).filter(item => item.payer?.toLowerCase() === wallet.address?.toLowerCase()).slice(-5).reverse()) {
      const item = node('article');
      item.append(node('h4', `${receipt.name} · ${receipt.status}`),
        node('p', `${playlistBatchProgress(receipt).progress} · purchase confirmation is not completion`));
      if (receipt.subtotalUnits != null && receipt.feeUnits != null) {
        item.append(node('p', `Paid ${formatUsdcUnits(BigInt(receipt.subtotalUnits) + BigInt(receipt.feeUnits))} USDC${
          receipt.refundedUnits != null ? ` · refunded ${formatUsdcUnits(BigInt(receipt.refundedUnits))} USDC` : ''}`));
      }
      if (receipt.playbackFailure) {
        const failure = receipt.playbackFailure;
        item.append(node('p', `${failure.reason} · ${failure.attempts}/${failure.maxAttempts} attempts${failure.exhausted ? ' · retries exhausted' : ' · retry pending'}`));
      }
      for (const [label, hash] of [['Purchase', receipt.transactionHash], ['Settlement / refund', receipt.resolutionTransactionHash]]) {
        if (!SONG.test(hash || '')) continue;
        const link = node('a', label); link.href = `https://basescan.org/tx/${hash}`;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link, node('span', ' '));
      }
      $('receipts').append(item);
    }
  }
  function checkpoint(changes = {}) {
    if (!activeSession) return;
    try {
      activeSession = recovery().update(activeSession.payer, activeSession.txHash,
        { position: Number.isFinite($('audio').currentTime) ? $('audio').currentTime : 0, ...changes });
    } catch (error) { $('audio').pause(); report(error.message); }
  }
  function mediaUrl(uri) {
    if (!uri.startsWith('ipfs://')) throw new Error('Paid recovery media must use its saved IPFS URI');
    const ipfs = head?.getIpfs?.();
    if (typeof ipfs?.gatewayUrl === 'function') return ipfs.gatewayUrl(uri);
    const gateway = options.ipfsGateway || 'https://ipfs.io/ipfs/';
    const url = new URL(gateway);
    if (url.protocol !== 'https:') throw new Error('IPFS gateway must use HTTPS');
    return `${url.href.replace(/\/?$/, '/')}${uri.slice(7)}`;
  }
  function playSession(session) {
    checkpoint();
    activeSession = recovery().update(session.payer, session.txHash, { status: 'confirmed' });
    const item = session.items[session.index];
    $('audio').src = mediaUrl(item.audioUrl);
    $('playing').textContent = `${session.name}: ${session.index + 1}/${session.items.length} · ${item.title}`;
    const position = session.position;
    $('audio').currentTime = position;
    $('audio').play().catch(() => report('Purchase saved. Press the audio Play control or Resume in Profile; do not purchase again.'));
  }
  function renderRecovery() {
    $('recovery').replaceChildren();
    if (!wallet.address) return;
    try {
      for (const session of recovery().list(wallet.address).filter(item => ['pending', 'confirmed'].includes(item.status))) {
        const row = node('li', `${session.name} · ${session.index + 1}/${session.items.length}`);
        row.append(button('Resume · no payment', async () => {
          const current = await signer();
          checkpoint();
          const latest = recovery().list(session.payer).find(item => item.txHash === session.txHash);
          if (!latest || !['pending', 'confirmed'].includes(latest.status)) throw new Error('Session is no longer resumable');
          await verifyPersonalPlaySession(latest, current.provider);
          if (wallet.address?.toLowerCase() !== session.payer.toLowerCase() || destroyed) throw new Error('Wallet changed during verification');
          playSession(latest);
        }));
        $('recovery').append(row);
      }
    } catch (error) { report(error.message); }
  }
  async function refresh() {
    clearTimeout(timer);
    const check = ++generation;
    try {
      const result = await request('/api/djuke');
      if (destroyed || check !== generation) return;
      if (result.chainId !== 8453 || !Array.isArray(result.requests) || !Array.isArray(result.tracks) ||
          result.tracks.some(track => !SONG.test(track.songId) || typeof track.trackId !== 'string' || typeof track.title !== 'string')) {
        throw new Error('Invalid DJuke catalog or queue response');
      }
      snapshot = result;
      $('queue').replaceChildren();
      for (const item of result.requests) {
        const row = node('li', item.title);
        if (item.playable === false && item.payer?.toLowerCase() === wallet.address?.toLowerCase()) {
          row.append(button('Replace with selected song', async () => {
            const current = await signer();
            if (!selected()) throw new Error('Choose a replacement song');
            await replaceDjukeSong({ signer: current, signal: lifetime.signal, djuke: new library.Contract(config.djukeContractAddress, DJUKE_BROWSER_ABI, current),
              chainRequestId: item.chainRequestId, songId: selected().songId });
            report('Replacement confirmed; your place and payment are unchanged.'); await refresh();
          }));
        }
        $('queue').append(row);
      }
      for (const batch of result.playlistBatches || []) {
        const row = node('li', playlistBatchProgress(batch).heading);
        const songs = node('ol');
        for (const song of batch.songs) songs.append(node('li', `${song.title} · ${song.status}`));
        row.append(songs); $('queue').append(row);
      }
      $('price').textContent = `Queue Song: ${formatUsdcUnits(BigInt(result.priceUnits))} USDC · normal Base gas extra`;
      $('state').textContent = paidReady() ? 'Platform queue connected. Main paid requests precede playlist songs.'
        : 'Checkout disabled: configure the matching v0.5 contract and verify platform payment availability.';
      renderSongs(); renderReceipts();
      radioReady = false;
      try {
        const readiness = await request('/api/djuke/playlist-readiness');
        if (destroyed || check !== generation) return;
        radioReady = config.djukePlaylistRadioReady === true && readiness.ready === true && readiness.version === '0.5' &&
          readiness.contractAddress?.toLowerCase() === config.djukePlaylistBatchAddress?.toLowerCase();
      } catch { /* Singles remain available when only playlist readiness is offline. */ }
      gate();
    } catch (error) {
      if (destroyed || check !== generation) return;
      snapshot = null; radioReady = false; gate();
      $('state').textContent = `Offline / unavailable: ${error.message}. No purchase has been initiated. Refresh to retry.`;
    }
    if (!destroyed && check === generation) timer = setTimeout(refresh, 15000);
  }
  async function profile() {
    if (!wallet.address) throw new Error('Connect your wallet in the host DecentHead header');
    const address = wallet.address;
    const result = await client.profile(address);
    if (destroyed || address !== wallet.address) return;
    $('library').replaceChildren();
    for (const playlist of [...(result.madePlaylists || []), ...(result.playlists || [])]) playlistRow(playlist, $('library'));
    renderReceipts(); renderRecovery();
  }
  function playlistRow(playlist, list) {
    const row = node('li', `${playlist.name} · ${playlist.maker} · revision ${playlist.revision}`);
    row.append(button('Load mix', () => {
      const tracks = playlist.songIds.map(id => snapshot?.tracks.find(track => track.songId.toLowerCase() === id.toLowerCase()));
      if (!tracks.length || tracks.some(track => !track)) throw new Error('A playlist song is unavailable; no partial playlist was loaded');
      draft = tracks; $('name').value = playlist.name; renderDraft();
      report(`Loaded immutable revision ${playlist.revision}; saving creates your own attributed mix.`);
    }));
    if (wallet.address && wallet.address.toLowerCase() !== playlist.maker.toLowerCase()) {
      row.append(button('Save copy to Profile', async () => {
        wallet.signer = await signer(); await client.saveCopy(playlist); await profile();
      }));
    }
    list.append(row);
  }
  on($('refresh'), 'click', refresh);
  on($('search'), 'input', renderSongs);
  on($('song'), 'change', gate);
  on($('add'), 'click', () => run(() => { if (selected() && draft.length < 24) { draft.push({ ...selected() }); renderDraft(); } }));
  on($('pay'), 'click', () => run(async () => {
    if (!paidReady() || !selected()) throw new Error('Refresh and select an available song');
    const current = await signer();
    const songId = selected().songId;
    const quote = await request(`/api/djuke/gas-quote?${new URLSearchParams({ listener: wallet.address, songId })}`);
    if (BigInt(quote.contributionWei) !== 0n || BigInt(quote.fulfillmentCostWei) !== 0n) throw new Error('DJuke v0.5 requires USDC-only checkout');
    const result = await purchaseDjukeSong({ signer: current, ethers: library, songId, signal: lifetime.signal, ensureChain: requireBase,
      djuke: new library.Contract(config.djukeContractAddress, DJUKE_BROWSER_ABI, current),
      usdc: new library.Contract(BASE_USDC_ADDRESS, USDC_BROWSER_ABI, current),
      maxPriceUnits: BigInt(snapshot.priceUnits), gasQuote: quote, onStep: report });
    report(`Purchase ${result.txHash} confirmed; queued, not yet delivered.`); await refresh();
  }));
  on($('save'), 'click', () => run(async () => {
    wallet.signer = await signer();
    const playlist = { id: view.crypto.randomUUID().replaceAll('-', ''), maker: wallet.address.toLowerCase(),
      revision: 1, name: $('name').value.trim(), songIds: draft.map(track => track.songId) };
    await client.saveOriginal(playlist);
    report('Saved immutable playlist to Profile. No playback purchased.'); await profile();
  }));
  on($('private'), 'click', () => run(async () => {
    if (!batchReady()) throw new Error('Personal Play deployment is unavailable');
    const current = await signer(), payer = await current.getAddress();
    const items = draft.map(track => ({ ...track, audioUrl: `ipfs://${track.ipfsCid}` }));
    if (items.some(item => !item.ipfsCid)) throw new Error('A song has no verified IPFS media');
    const songIds = items.map(track => track.songId);
    recovery().check(payer, songIds);
    const purchase = await checkoutPrivatePlaylist({ playlist: { songIds }, signer: current, config, ethers: library, onStep: report, signal: lifetime.signal, ensureChain: requireBase,
      onSubmitted: submitted => recovery().save({ ...submitted, items, name: $('name').value.trim() || 'Personal playlist' }) });
    if (destroyed) return;
    const session = recovery().list(payer).find(item => item.txHash === purchase.txHash);
    report('Personal Play purchased. Resume without another payment in Profile → Playlists.');
    if (wallet.address?.toLowerCase() === payer.toLowerCase()) playSession(session);
    renderRecovery();
  }));
  on($('live'), 'click', () => run(async () => {
    if (!batchReady() || !radioReady) throw new Error('Play Live worker is not ready');
    const current = await signer();
    const result = await checkoutRadioPlaylist({ playlist: { songIds: draft.map(track => track.songId) },
      signer: current, config, ethers: library, onStep: report, signal: lifetime.signal, ensureChain: requireBase,
      fetchImpl: (url, init) => request(url.pathname + url.search, init).then(body => ({ ok: true, json: async () => body })) });
    report(`Purchase ${result.txHash} confirmed; delivery/refund receipts are in Profile → Playlists.`); await refresh();
  }));
  on($('library-refresh'), 'click', () => run(profile));
  on($('profile'), 'toggle', () => { if ($('profile').open) run(profile); });
  on($('discover'), 'click', () => run(async () => {
    const results = await client.discover($('discover-query').value);
    if (destroyed) return;
    $('discovered').replaceChildren();
    results.forEach(playlist => playlistRow(playlist, $('discovered')));
    if (!results.length) report('No matching public playlists.');
  }));
  on($('audio'), 'timeupdate', () => { if (Date.now() - progressAt > 5000) { checkpoint(); progressAt = Date.now(); } });
  on($('audio'), 'pause', () => checkpoint());
  on($('audio'), 'ended', () => {
    if (!activeSession) return;
    if (activeSession.index + 1 < activeSession.items.length) {
      checkpoint({ index: activeSession.index + 1, position: 0 });
      const next = activeSession; activeSession = null; playSession(next);
    } else {
      checkpoint({ status: 'completed' }); activeSession = null;
      $('playing').textContent = 'Personal Play complete'; renderRecovery();
    }
  });
  on($('audio'), 'error', () => { checkpoint(); report('Media unavailable. Resume/retry in Profile; do not purchase again.'); });
  function walletChanged(next = {}) {
    if (destroyed) return;
    checkpoint();
    if (wallet.address?.toLowerCase() !== next.address?.toLowerCase()) {
      $('audio').pause(); activeSession = null; $('audio').removeAttribute('src');
      $('library').replaceChildren(); $('recovery').replaceChildren();
    }
    wallet = { ...next };
    gate(); renderReceipts(); renderRecovery();
  }
  function attachHead() {
    const next = options.head || view.DecentHead;
    if (destroyed || !next || next === head) return;
    unsubscribe?.();
    head = next; walletService = head.getWallet?.();
    walletChanged(walletService?.snapshot?.() || {});
    unsubscribe = head.on?.('wallet', walletChanged);
    head.getIpfs?.();
    gate();
  }
  on(view, 'decenthead:ready', attachHead);
  const controller = {
    refresh,
    destroy() {
      if (destroyed) return;
      checkpoint(); destroyed = true; generation++; clearTimeout(timer); lifetime.abort();
      for (const controller of requests) controller.abort();
      requests.clear(); unsubscribe?.();
      for (const cleanup of cleanups) cleanup();
      $('audio').pause(); $('audio').removeAttribute('src'); $('audio').load();
      section.remove(); style.remove(); mounts.delete(element);
    },
  };
  mounts.set(element, controller);
  attachHead(); gate(); renderDraft(); refresh();
  return controller;
}
