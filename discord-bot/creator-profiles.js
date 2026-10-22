import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { buildCreatorAuthorizationMessage, buildCreatorWatchlistAuthorizationMessage, buildCreatorPlaylistAuthorizationMessage,
  buildCreatorPlaylistCopyAuthorizationMessage, normalizeCreatorProfile, normalizeCreatorWatchlistEntry, normalizeNamedPlaylist } from '../js/creator-profile-data.mjs';
import { nftIdentity } from '../js/nft-loader.js';

export function createCreatorProfiles({ restore, save, now = () => Date.now() }) {
  let ready = false;
  let profiles = {};
  let playlists = {};
  let task = Promise.resolve();
  const challenges = new Map();
  const consumed = new Map();
  const requireReady = () => { if (!ready) throw new Error('Creator profiles are restoring'); };
  const serialize = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
  const persist = async (next, nextPlaylists = playlists) => {
    const playlistNonces = Object.fromEntries([...consumed].filter(([, expiry]) => expiry > now()));
    const uri = await save({ schemaVersion: 2, profiles: next, playlists: nextPlaylists, playlistNonces });
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('Profile checkpoint did not confirm');
    profiles = next;
    playlists = nextPlaylists;
  };
  const watchlistKey = entry => nftIdentity(entry);
  const normalizeWatchlist = entries => entries.map(entry => {
    const normalized = normalizeCreatorWatchlistEntry(entry);
    return { ...normalized, nftId: watchlistKey(normalized), savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : new Date(now()).toISOString() };
  }).filter((entry, index, list) => list.findIndex(candidate => candidate.nftId === entry.nftId) === index);
  const currentWatchlist = address => normalizeWatchlist(profiles[address]?.watchlist || []);
  const profileRecord = address => {
    const owned = Object.values(playlists).map(record => latestRevision(record))
      .filter(playlist => playlist?.maker === address).sort((a, b) => a.name.localeCompare(b.name));
    const saved = Array.isArray(profiles[address]?.playlists) ? profiles[address].playlists : [];
    return { ...profiles[address], watchlist: currentWatchlist(address), madePlaylists: owned, playlists: saved };
  };
  const latestRevision = record => record?.revisions?.[record.revisions.length - 1] || null;
  const authorizePlaylist = (body, origin, action, copy = false) => {
    requireReady();
    const expiresAt = Date.parse(body.expiresAt);
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || body.action !== action ||
        typeof body.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.nonce) ||
        !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 300000) {
      throw new Error('Invalid or expired playlist authorization');
    }
    for (const [key, expiry] of consumed) if (expiry < now()) consumed.delete(key);
    const address = body.address.toLowerCase();
    const playlist = copy ? { id: body.playlistId, revision: body.revision } : normalizeNamedPlaylist(body.playlist);
    const message = copy
      ? buildCreatorPlaylistCopyAuthorizationMessage({ ...body, address, origin, expiresAt: body.expiresAt })
      : buildCreatorPlaylistAuthorizationMessage({ ...body, address, origin, playlist, expiresAt: body.expiresAt });
    if (verifyMessage(message, body.signature).toLowerCase() !== address) throw new Error('Playlist signature does not match wallet');
    const key = `${address}:${body.nonce}`;
    if (consumed.has(key)) throw new Error('Playlist authorization already used');
    consumed.set(key, expiresAt);
    return { address, playlist };
  };
  const playlistListCount = address => Object.values(playlists).filter(record => record.maker === address).length +
    (Array.isArray(profiles[address]?.playlists) ? profiles[address].playlists.length : 0);
  const authorize = (body, origin, action) => {
    requireReady();
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || body.action !== action ||
        typeof body.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.nonce) ||
        !Number.isFinite(Date.parse(body.issuedAt)) || Math.abs(now() - Date.parse(body.issuedAt)) > 300000) {
      throw new Error('Invalid or expired creator authorization');
    }
    for (const [key, expiry] of consumed) if (expiry < now()) consumed.delete(key);
    const profile = normalizeCreatorProfile(body.profile);
    const address = body.address.toLowerCase();
    const recovered = verifyMessage(buildCreatorAuthorizationMessage({ ...body, origin, profile }), body.signature).toLowerCase();
    if (recovered !== address) throw new Error('Creator signature does not match wallet');
    const key = `${address}:${body.nonce}`;
    if (consumed.has(key)) throw new Error('Creator authorization already used');
    consumed.set(key, now() + 300000);
    return { address, profile };
  };
  const authorizeWatchlist = (body, origin, action) => {
    requireReady();
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.address || '') || body.action !== action ||
        typeof body.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.nonce) ||
        !Number.isFinite(Date.parse(body.issuedAt)) || Math.abs(now() - Date.parse(body.issuedAt)) > 300000) {
      throw new Error('Invalid or expired watchlist authorization');
    }
    for (const [key, expiry] of consumed) if (expiry < now()) consumed.delete(key);
    const entry = normalizeCreatorWatchlistEntry(body.entry);
    const address = body.address.toLowerCase();
    const recovered = verifyMessage(buildCreatorWatchlistAuthorizationMessage({ ...body, origin, entry }), body.signature).toLowerCase();
    if (recovered !== address) throw new Error('Watchlist signature does not match wallet');
    const key = `${address}:${body.nonce}`;
    if (consumed.has(key)) throw new Error('Watchlist authorization already used');
    consumed.set(key, now() + 300000);
    return { address, entry };
  };
  return {
    initialize: () => serialize(async () => {
      if (ready) return;
      const snapshot = await restore();
      if (snapshot && (![1, 2].includes(snapshot.schemaVersion) || !snapshot.profiles || Array.isArray(snapshot.profiles) ||
          (snapshot.playlists && (typeof snapshot.playlists !== 'object' || Array.isArray(snapshot.playlists))))) throw new Error('Invalid creator checkpoint');
      profiles = snapshot?.profiles || {};
      playlists = snapshot?.playlists || {};
      for (const [key, expiry] of Object.entries(snapshot?.playlistNonces || {})) {
        if (Number.isFinite(expiry) && expiry > now()) consumed.set(key, expiry);
      }
      for (const [address, profile] of Object.entries(profiles)) {
        profiles[address] = { ...profile, watchlist: currentWatchlist(address) };
      }
      ready = true;
    }),
    get(address) {
      requireReady();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('Invalid creator wallet');
      return structuredClone({ address: address.toLowerCase(), ...profileRecord(address.toLowerCase()) });
    },
    getByDiscordId(discordId) {
      requireReady();
      if (!/^\d{16,22}$/.test(discordId || '')) return null;
      const match = Object.entries(profiles).find(([, profile]) => profile.discord?.id === discordId);
      return match ? structuredClone({ address: match[0], ...profileRecord(match[0]) }) : null;
    },
    update: (body, origin) => serialize(async () => {
      const { address, profile } = authorize(body, origin, 'save');
      await persist({ ...profiles, [address]: { ...profiles[address], ...profile, watchlist: currentWatchlist(address), updatedAt: new Date(now()).toISOString() } });
      return { ok: true, profile: { address, ...profileRecord(address) } };
    }),
    updateWatchlist: (body, origin) => serialize(async () => {
      const action = body.action === 'remove-watchlist' ? 'remove-watchlist' : 'save-watchlist';
      const { address, entry } = authorizeWatchlist(body, origin, action);
      const watchlist = currentWatchlist(address);
      const key = watchlistKey(entry);
      const next = action === 'remove-watchlist'
        ? watchlist.filter(item => item.nftId !== key)
        : [{ ...entry, nftId: key, savedAt: watchlist.find(item => item.nftId === key)?.savedAt || new Date(now()).toISOString() },
          ...watchlist.filter(item => item.nftId !== key)];
      await persist({ ...profiles, [address]: { ...profiles[address], watchlist: next, updatedAt: new Date(now()).toISOString() } });
      return { ok: true, profile: { address, ...profileRecord(address) } };
    }),
    discoverPlaylists(query = '') {
      requireReady();
      const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
      return Object.values(playlists).map(latestRevision).filter(playlist => playlist &&
        (!normalizedQuery || playlist.name.toLocaleLowerCase().includes(normalizedQuery)))
        .map(playlist => structuredClone({ ...playlist, songCount: playlist.songIds.length }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.maker.localeCompare(b.maker) || a.id.localeCompare(b.id));
    },
    async savePlaylist(body, origin) {
      return serialize(async () => {
        const action = body.action;
        if (action !== 'create-playlist' && action !== 'update-playlist') throw new Error('Invalid playlist action');
        const { address, playlist } = authorizePlaylist(body, origin, action);
        if (playlist.maker !== address) throw new Error('Only the maker can edit this playlist');
        const record = playlists[playlist.id];
        if (action === 'create-playlist') {
          if (record) throw new Error('Playlist ID already exists');
          if (playlist.revision !== 1) throw new Error('A new playlist must start at revision 1');
          if (playlistListCount(address) >= 20) throw new Error('A profile can save at most 20 playlists');
          const nextPlaylists = { ...playlists, [playlist.id]: { maker: address, revisions: [playlist] } };
          await persist({ ...profiles, [address]: { ...profiles[address], updatedAt: new Date(now()).toISOString() } }, nextPlaylists);
          return { ok: true, playlist: structuredClone(playlist) };
        } else {
          if (!record || record.maker !== address) throw new Error('Only the maker can edit this playlist');
          const previous = latestRevision(record);
          if (playlist.revision !== previous.revision + 1) throw new Error('Playlist revision is stale');
          const nextPlaylists = { ...playlists, [playlist.id]: { ...record, revisions: [...record.revisions, playlist] } };
          await persist({ ...profiles, [address]: { ...profiles[address], updatedAt: new Date(now()).toISOString() } }, nextPlaylists);
        }
        return { ok: true, playlist: structuredClone(playlist) };
      });
    },
    savePlaylistCopy(body, origin) {
      return serialize(async () => {
        if (body.action !== 'save-playlist-copy' && body.action !== 'remove-playlist-copy') throw new Error('Invalid saved playlist action');
        const { address, playlist: reference } = authorizePlaylist(body, origin, body.action, true);
        const record = playlists[reference.id];
        const revision = record?.revisions?.find(item => item.revision === reference.revision);
        if (!revision) throw new Error('Playlist revision not found');
        const current = Array.isArray(profiles[address]?.playlists) ? profiles[address].playlists : [];
        const key = `${reference.id}:${reference.revision}`;
        const next = body.action === 'remove-playlist-copy'
          ? current.filter(item => `${item.id}:${item.revision}` !== key)
          : current.some(item => `${item.id}:${item.revision}` === key) ? current
            : [...current, { ...revision, savedAt: new Date(now()).toISOString(), attribution: { maker: revision.maker, playlistId: revision.id, revision: revision.revision } }];
        if (next.length + Object.values(playlists).filter(item => item.maker === address).length > 20) throw new Error('A profile can save at most 20 playlists');
        await persist({ ...profiles, [address]: { ...profiles[address], playlists: next, updatedAt: new Date(now()).toISOString() } });
        return { ok: true, profile: { address, ...profileRecord(address) } };
      });
    },
    startLink(body, origin) {
      const { address } = authorize(body, origin, 'link-discord');
      for (const [code, challenge] of challenges) if (challenge.expiresAt <= now() || challenge.address === address) challenges.delete(code);
      if (challenges.size >= 1000) throw new Error('Too many pending profile links');
      const code = randomBytes(12).toString('hex');
      challenges.set(code, { address, expiresAt: now() + 300000 });
      return { code, expiresAt: new Date(now() + 300000).toISOString() };
    },
    confirmDiscord: (code, user) => serialize(async () => {
      requireReady();
      const challenge = challenges.get(code);
      if (!challenge || challenge.expiresAt <= now()) throw new Error('Discord link code expired or invalid');
      if (!/^\d{16,22}$/.test(user.id || '')) throw new Error('Discord identity unavailable');
      const existing = profiles[challenge.address]?.discord;
      if (existing && existing.id !== user.id) throw new Error('Wallet already linked to another Discord account');
      if (Object.entries(profiles).some(([address, profile]) => address !== challenge.address && profile.discord?.id === user.id)) {
        throw new Error('Discord account already linked to another wallet');
      }
      const discord = { id: user.id, displayName: user.globalName || user.username,
        avatarURI: user.displayAvatarURL({ extension: 'png', size: 1024 }),
        bannerURI: user.bannerURL?.({ extension: 'png', size: 1024 }) || '', verifiedAt: new Date(now()).toISOString() };
      await persist({ ...profiles, [challenge.address]: { ...profiles[challenge.address], discord } });
      challenges.delete(code);
      return { ok: true };
    }),
  };
}