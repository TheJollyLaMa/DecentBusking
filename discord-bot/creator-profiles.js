import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { buildCreatorAuthorizationMessage, normalizeCreatorProfile } from '../js/creator-profile-data.mjs';

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
  return {
    initialize: () => serialize(async () => {
      if (ready) return;
      const snapshot = await restore();
      if (snapshot && (snapshot.schemaVersion !== 1 || !snapshot.profiles || Array.isArray(snapshot.profiles))) throw new Error('Invalid creator checkpoint');
      profiles = snapshot?.profiles || {};
      ready = true;
    }),
    get(address) {
      requireReady();
      if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) throw new Error('Invalid creator wallet');
      return structuredClone({ address: address.toLowerCase(), ...profiles[address.toLowerCase()] });
    },
    update: (body, origin) => serialize(async () => {
      const { address, profile } = authorize(body, origin, 'save');
      await persist({ ...profiles, [address]: { ...profiles[address], ...profile, updatedAt: new Date(now()).toISOString() } });
      return { ok: true, profile: { address, ...profiles[address] } };
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