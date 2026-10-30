import { buildCreatorPlaylistAuthorizationMessage, buildCreatorPlaylistCopyAuthorizationMessage, normalizeNamedPlaylist } from './creator-profile-data.mjs?v=20261030-ad-cutoff';

export const DJUKE_PLAYLIST_MAX_SONGS = 24;
export const DJUKE_PLAYLIST_MAX_PER_PROFILE = 20;
export const DJUKE_PLAYLIST_BASE_RATE_UNITS = 250000n;
export const DJUKE_PLAYLIST_RADIO_FEE_UNITS = 3000000n;

export function matchesPlaylistRevision(playlist, songIds) {
  return Boolean(playlist && Array.isArray(songIds) && playlist.songIds.length === songIds.length &&
    playlist.songIds.every((songId, index) => String(songId).toLowerCase() === String(songIds[index]).toLowerCase()));
}

export function quoteNamedPlaylist(songCount, mode = 'private', listenPrices = []) {
  if (!Number.isInteger(songCount) || songCount < 1 || songCount > DJUKE_PLAYLIST_MAX_SONGS) throw new Error('Choose 1–24 songs');
  if (mode !== 'private' && mode !== 'radio') throw new Error('Unknown playlist playback mode');
  const subtotal = Array.from({ length: songCount }, (_, i) => mode === 'radio'
    ? DJUKE_PLAYLIST_BASE_RATE_UNITS << BigInt(Math.floor(i / 8))
    : BigInt(listenPrices[i] ?? DJUKE_PLAYLIST_BASE_RATE_UNITS)).reduce((a, b) => a + b, 0n);
  const fee = mode === 'radio' ? DJUKE_PLAYLIST_RADIO_FEE_UNITS * BigInt(Math.ceil(songCount / 12)) : 0n;
  return { songCount, subtotalUnits: subtotal, feeUnits: fee, totalUnits: subtotal + fee };
}

export function supportsDJukePlaylistBatch(config = {}) {
  return ['0.4', '0.5'].includes(config.djukePlaylistBatchVersion) &&
    /^0x[0-9a-fA-F]{40}$/.test(config.djukePlaylistBatchAddress || '') &&
    config.djukePlaylistBatchEnabled === true;
}

export function supportsDJukePlaylistRadio(config = {}) {
  return supportsDJukePlaylistBatch(config) && config.djukePlaylistRadioReady === true;
}

export function groupWatchlistByArtist(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const artist = String(entry.artist || entry.creator || 'Unknown artist').trim() || 'Unknown artist';
    if (!groups.has(artist)) groups.set(artist, []);
    groups.get(artist).push(entry);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([artist, songs]) => ({
    artist,
    entries: songs.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''))),
  }));
}

export function createNamedPlaylistClient({ fetchImpl = globalThis.fetch, origin = globalThis.location?.origin || '',
  getWallet = () => globalThis.window?._wallet, newNonce = () => globalThis.crypto.randomUUID(), now = () => Date.now(),
  getServiceUrl = () => globalThis.window?.DecentConfig?.ipfsUploadServiceUrl || '' } = {}) {
  async function signAndSend(path, action, data, copy = false) {
    const wallet = getWallet();
    const address = wallet?.address;
    const signer = wallet?.signer;
    if (!address || !signer) throw new Error('Connect your wallet in the page header');
    const expiresAt = new Date(now() + 5 * 60 * 1000).toISOString();
    const body = { address, origin, action, nonce: newNonce(), expiresAt, ...data };
    const message = copy
      ? buildCreatorPlaylistCopyAuthorizationMessage({ ...body, playlistId: body.playlistId, revision: body.revision })
      : buildCreatorPlaylistAuthorizationMessage({ ...body, playlist: normalizeNamedPlaylist(body.playlist) });
    const signature = await signer.signMessage(message);
    if (address.toLowerCase() !== String(getWallet()?.address || '').toLowerCase() || signer !== getWallet()?.signer) {
      throw new Error('Wallet changed; sign again');
    }
    const response = await fetchImpl(`${String(getServiceUrl()).replace(/\/$/, '')}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, signature }),
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Playlist request failed');
    if (address.toLowerCase() !== String(getWallet()?.address || '').toLowerCase() || signer !== getWallet()?.signer) {
      throw new Error('Wallet changed; refresh your playlist library');
    }
    return result;
  }
  return {
    saveOriginal(playlist) {
      const normalized = normalizeNamedPlaylist(playlist);
      const action = normalized.revision === 1 ? 'create-playlist' : 'update-playlist';
      return signAndSend('/api/creator/playlists', action, { playlist: normalized });
    },
    saveCopy(playlist, remove = false) {
      return signAndSend('/api/creator/playlists/copy', remove ? 'remove-playlist-copy' : 'save-playlist-copy',
        { playlistId: playlist.id, revision: playlist.revision }, true);
    },
    async discover(query = '') {
      const service = String(getServiceUrl()).replace(/\/$/, '');
      const response = await fetchImpl(`${service}/api/creator/playlists?${new URLSearchParams({ query })}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Playlist library unavailable');
      return result.playlists || [];
    },
    async profile(address) {
      const service = String(getServiceUrl()).replace(/\/$/, '');
      const response = await fetchImpl(`${service}/api/creator/profile?${new URLSearchParams({ address })}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Playlist profile unavailable');
      return result;
    },
  };
}

export function getPlaylistBatchAbi() {
  return [
    'function CONTRACT_VERSION() view returns (string)',
    'function quotePlaylist(bytes32[] songIds, bool radio) view returns (uint256 subtotal,uint256 fee,uint256 total)',
    'function purchasePlaylistPrivate(bytes32[] songIds,uint256 maxTotal) returns (uint256)',
    'function requestPlaylistWithGas(bytes32[] songIds,uint256 maxTotal,uint256 fulfillmentCostWei,uint256 deadline,bytes signature) payable returns (uint256)',
  ];
}
