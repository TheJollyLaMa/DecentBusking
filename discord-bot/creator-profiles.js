import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { buildCreatorAuthorizationMessage, buildCreatorWatchlistAuthorizationMessage, normalizeCreatorProfile,
  normalizeCreatorWatchlistEntry } from '../js/creator-profile-data.mjs';
import { nftIdentity } from '../js/nft-loader.js';

export function createCreatorProfiles({ restore, save, now = () => Date.now() }) {
  let ready = false;
  let profiles = {};
  let task = Promise.resolve();
  const challenges = new Map();
  const consumed = new Map();
  const requireReady = () => { if (!ready) throw new Error('Creator profiles are restoring'); };
  const serialize = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };
  const persist = async next => {
    const uri = await save({ schemaVersion: 1, profiles: next });
    if (typeof uri !== 'string' || !uri.startsWith('ipfs://')) throw new Error('Profile checkpoint did not confirm');
    profiles = next;
  };
  const watchlistKey = entry => nftIdentity(entry);
  const normalizeWatchlist = entries => entries.map(entry => {
    const normalized = normalizeCreatorWatchlistEntry(entry);
    return { ...normalized, nftId: watchlistKey(normalized), savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : new Date(now()).toISOString() };
  }).filter((entry, index, list) => list.findIndex(candidate => candidate.nftId === entry.nftId) === index);
  const currentWatchlist = address => normalizeWatchlist(profiles[address]?.watchlist || []);
  const profileRecord = address => ({ ...profiles[address], watchlist: currentWatchlist(address) });
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
      if (snapshot && (snapshot.schemaVersion !== 1 || !snapshot.profiles || Array.isArray(snapshot.profiles))) throw new Error('Invalid creator checkpoint');
      profiles = snapshot?.profiles || {};
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