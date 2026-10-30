import { buildCreatorWatchlistAuthorizationMessage, normalizeCreatorWatchlistEntry } from './creator-profile-data.mjs?v=20261030-ad-cutoff';
import { nftIdentity } from './nft-loader.js';

const WATCHLIST_EVENT = 'creator-watchlist-changed';

let _state = {
  address: '',
  watchlist: [],
  loading: false,
  error: '',
};

let _revision = 0;

function _serviceUrl() {
  return String(window.DecentConfig?.ipfsUploadServiceUrl || '').replace(/\/$/, '');
}

function _profileUrl(address) {
  return `${_serviceUrl()}/api/creator/profile?${new URLSearchParams({ address })}`;
}

function _watchlistUrl() {
  return `${_serviceUrl()}/api/creator/watchlist`;
}

function _clone(entry) {
  return entry ? { ...entry } : entry;
}

function _cloneState() {
  return { ..._state, watchlist: _state.watchlist.map(_clone) };
}

function _dispatch(detail = {}) {
  if (typeof document === 'undefined' || !document?.dispatchEvent) return;
  const CustomEventCtor = globalThis.CustomEvent || document.defaultView?.CustomEvent;
  if (!CustomEventCtor) return;
  document.dispatchEvent(new CustomEventCtor(WATCHLIST_EVENT, { detail: { ..._cloneState(), ...detail } }));
}

function _setState(next) {
  _state = {
    address: next.address || '',
    watchlist: Array.isArray(next.watchlist) ? next.watchlist.map(_clone) : [],
    loading: Boolean(next.loading),
    error: next.error || '',
  };
  _dispatch();
}

function _currentAddress() {
  return window._wallet?.address || '';
}

function _normalizeEntry(entry = {}) {
  const normalized = normalizeCreatorWatchlistEntry(entry);
  return { ...normalized, nftId: nftIdentity(normalized) };
}

function _sameIdentity(a, b) {
  return a && b && a.nftId === b.nftId;
}

function _findEntry(nft) {
  if (!nft) return null;
  const normalized = _normalizeEntry(nft);
  return _state.watchlist.find(entry => _sameIdentity(entry, normalized)) || null;
}

export function getCreatorWatchlistState() {
  return _cloneState();
}

export function creatorWatchlistIdentity(nft) {
  return nftIdentity(_normalizeEntry(nft));
}

export function creatorWatchlistEntrySnapshot(nft = {}) {
  const normalized = _normalizeEntry(nft);
  return {
    ...normalized,
    title: String(nft.name || nft.title || normalized.title || `Track #${normalized.tokenId}`).trim(),
    artist: String(nft.artist || nft.creator || normalized.artist || '').trim(),
    artworkURI: String(nft.artworkURI || nft.image || normalized.artworkURI || '').trim(),
    metadataUri: String(nft.metadataUri || normalized.metadataUri || '').trim(),
    audioUrl: String(nft.audioUrl || nft.videoUrl || nft.animation_url || normalized.audioUrl || '').trim(),
  };
}

export function isCreatorWatchlisted(nft) {
  return Boolean(_findEntry(nft));
}

export function creatorWatchlistButtonState(nft, { loading = false, resolving = false, saving = false, unavailable = false } = {}) {
  if (unavailable) return { label: '👀 Unavailable', title: 'Could not verify the NFT for this playback', pressed: false, disabled: true, mode: 'unavailable' };
  const address = _currentAddress();
  if (!address) return { label: '👀 Connect', title: 'Connect your wallet to save this NFT', pressed: false, disabled: false, mode: 'connect' };
  if (loading) return { label: '👀 Loading', title: 'Loading your watchlist…', pressed: false, disabled: true, mode: 'loading' };
  if (resolving) return { label: '👀 Pending', title: 'Verifying the exact NFT…', pressed: false, disabled: true, mode: 'pending' };
  const entry = _findEntry(nft);
  if (entry) return { label: '👀 Saved', title: 'Remove from your watchlist', pressed: true, disabled: saving, mode: 'saved', entry };
  return { label: '👀 Save', title: 'Save this NFT to your watchlist', pressed: false, disabled: saving, mode: 'save' };
}

export function applyCreatorWatchlistButton(button, nft, options = {}) {
  if (!button) return null;
  const state = creatorWatchlistButtonState(nft, options);
  button.textContent = state.label;
  button.title = state.title;
  button.setAttribute('aria-label', state.title);
  button.setAttribute('aria-pressed', String(state.pressed));
  button.disabled = state.disabled;
  return state;
}

export async function syncCreatorWatchlist(address = _currentAddress(), { fetchImpl = globalThis.fetch } = {}) {
  const nextAddress = String(address || '').toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(nextAddress)) {
    _setState({ address: '', watchlist: [], loading: false, error: '' });
    return _cloneState();
  }
  const revision = ++_revision;
  const priorWatchlist = _state.address === nextAddress ? _state.watchlist : [];
  _setState({ address: nextAddress, watchlist: priorWatchlist, loading: true, error: '' });
  try {
    const response = await fetchImpl(_profileUrl(nextAddress), { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    const profile = await response.json();
    if (revision !== _revision) return _cloneState();
    if (!response.ok) throw new Error(profile.error || 'Profile unavailable');
    const watchlist = Array.isArray(profile.watchlist) ? profile.watchlist.map(_clone) : [];
    _setState({ address: nextAddress, watchlist, loading: false, error: '' });
  } catch (error) {
    if (revision !== _revision) return _cloneState();
    _setState({ address: nextAddress, watchlist: priorWatchlist, loading: false, error: error.message });
  }
  return _cloneState();
}

export function clearCreatorWatchlist() {
  ++_revision;
  _setState({ address: '', watchlist: [], loading: false, error: '' });
}

export async function toggleCreatorWatchlist(nft, { fetchImpl = globalThis.fetch } = {}) {
  const entry = _findEntry(nft);
  return entry ? removeCreatorWatchlist(nft, { fetchImpl }) : saveCreatorWatchlist(nft, { fetchImpl });
}

export async function saveCreatorWatchlist(nft, { fetchImpl = globalThis.fetch } = {}) {
  return _mutateCreatorWatchlist('save-watchlist', nft, { fetchImpl });
}

export async function removeCreatorWatchlist(nft, { fetchImpl = globalThis.fetch } = {}) {
  return _mutateCreatorWatchlist('remove-watchlist', nft, { fetchImpl });
}

async function _mutateCreatorWatchlist(action, nft, { fetchImpl = globalThis.fetch } = {}) {
  const address = _currentAddress();
  const signer = window._wallet?.signer;
  if (!address || !signer) throw new Error('Connect your wallet in the page header');
  const snapshot = creatorWatchlistEntrySnapshot(nft);
  const body = {
    address,
    origin: window.location.origin,
    action,
    entry: snapshot,
    nonce: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
  };
  const capturedSigner = signer;
  const capturedAddress = address;
  const signature = await capturedSigner.signMessage(buildCreatorWatchlistAuthorizationMessage(body));
  if (capturedAddress !== window._wallet?.address || capturedSigner !== window._wallet?.signer) {
    throw new Error('Wallet changed; sign again');
  }
  const response = await fetchImpl(_watchlistUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, signature }),
    signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Watchlist request failed');
  if (capturedAddress !== window._wallet?.address || capturedSigner !== window._wallet?.signer) {
    throw new Error('Wallet changed; refresh your watchlist');
  }
  const watchlist = Array.isArray(result.profile?.watchlist) ? result.profile.watchlist.map(_clone) : [];
  _setState({ address: capturedAddress.toLowerCase(), watchlist, loading: false, error: '' });
  return result;
}

if (typeof document !== 'undefined' && document?.addEventListener) {
  document.addEventListener('wallet-connected', (event) => {
    void syncCreatorWatchlist(event.detail?.address || _currentAddress()).catch(() => {});
  });
  document.addEventListener('wallet-disconnected', () => {
    clearCreatorWatchlist();
  });
}
