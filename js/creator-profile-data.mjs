export function normalizeCreatorProfile(input = {}) {
  const profile = {};
  for (const [field, limit] of [['displayName', 80], ['bio', 1000], ['avatarURI', 300], ['bannerURI', 300]]) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw new Error(`Invalid ${field}`);
    profile[field] = value.trim();
  }
  for (const field of ['avatarURI', 'bannerURI']) {
    if (profile[field] && !/^ipfs:\/\/[a-zA-Z0-9]+$/.test(profile[field])) throw new Error('Uploaded profile images must use an IPFS file URI');
  }
  return profile;
}

export function musicianCareDay(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(timestamp));
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function normalizeMusicianCareEntry(input = {}) {
  const { id, activity, amount, unit, timestamp, timeZone } = input;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '') ||
      !['water', 'breathwork', 'chanting', 'vocal'].includes(activity) ||
      !Number.isSafeInteger(amount) || amount <= 0 ||
      unit !== (activity === 'water' ? 'glasses' : 'seconds') || (activity === 'water' && amount !== 1) ||
      typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) ||
      new Date(timestamp).toISOString() !== timestamp ||
      typeof timeZone !== 'string' || !timeZone || timeZone.length > 80) {
    throw new Error('Invalid musician-care entry: log one glass of water or completed practice in seconds.');
  }
  let date;
  try { date = musicianCareDay(timestamp, timeZone); }
  catch { throw new Error('Musician-care time zone is invalid.'); }
  return { version: 1, id: id.toLowerCase(), activity, amount, unit, timestamp, timeZone, date,
    source: { app: 'decentbusking', surface: 'bignuten-widget' } };
}

export function normalizeMusicianCareState(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.entries)) {
    throw new Error('Musician-care profile tracking is unavailable. The profile service needs the musician-care update.');
  }
  const ids = new Set();
  return { version: 1, entries: input.entries.map(record => {
    const entry = normalizeMusicianCareEntry(record);
    if (record.version !== 1 || record.source?.app !== 'decentbusking' ||
        record.source?.surface !== 'bignuten-widget' || record.date !== entry.date) {
      throw new Error('Invalid musician-care provenance or local date.');
    }
    if (ids.has(entry.id)) throw new Error('Duplicate musician-care entry in profile.');
    ids.add(entry.id);
    const removedAt = record.removedAt ?? null;
    if (removedAt !== null && (typeof removedAt !== 'string' || !Number.isFinite(Date.parse(removedAt)) ||
        new Date(removedAt).toISOString() !== removedAt)) throw new Error('Invalid musician-care correction.');
    return { ...entry, removedAt };
  }) };
}

export function musicianCareTotals(state, date) {
  const totals = { water: 0, breathwork: 0, chanting: 0, vocal: 0 };
  for (const entry of state.entries) {
    if (entry.removedAt || (date && entry.date !== date)) continue;
    totals[entry.activity] += entry.amount;
    if (!Number.isSafeInteger(totals[entry.activity])) throw new Error('Musician-care total exceeds the supported range.');
  }
  return totals;
}

export function buildMusicianCareAuthorizationMessage({ address, origin, action, nonce, issuedAt, visibility, entry }) {
  return ['DecentBusking public musician-care activity', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`, `Visibility: ${visibility}`,
    'This activity is public and stored in public IPFS profile history. No blockchain transaction.',
    `Entry: ${JSON.stringify(normalizeMusicianCareEntry(entry))}`].join('\n');
}

export function normalizeCreatorWatchlistEntry(input = {}) {
  const chainId = Number(input.chainId ?? 8453);
  const tokenId = Number(input.tokenId);
  const contractAddress = typeof input.contractAddress === 'string' ? input.contractAddress.trim() : '';
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress) ||
      !Number.isSafeInteger(tokenId) || tokenId < 0 || /^0x0{40}$/i.test(contractAddress)) {
    throw new Error('Invalid watchlist NFT');
  }
  const entry = { chainId, contractAddress: contractAddress.toLowerCase(), tokenId };
  for (const [field, limit] of [['title', 120], ['artist', 120], ['artworkURI', 300], ['metadataUri', 300], ['audioUrl', 300]]) {
    const value = input[field] ?? '';
    if (typeof value !== 'string' || value.length > limit) throw new Error(`Invalid watchlist ${field}`);
    entry[field] = value.trim();
  }
  return entry;
}

export function buildCreatorAuthorizationMessage({ address, origin, action, nonce, issuedAt, profile = {} }) {
  return ['DecentBusking creator profile', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`,
    `Profile: ${JSON.stringify(normalizeCreatorProfile(profile))}`].join('\n');
}

export function buildCreatorWatchlistAuthorizationMessage({ address, origin, action, nonce, issuedAt, entry = {} }) {
  return ['DecentBusking creator watchlist', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`,
    `Entry: ${JSON.stringify(normalizeCreatorWatchlistEntry(entry))}`].join('\n');
}

export function normalizeNamedPlaylist(input = {}) {
  const id = String(input.id || '').toLowerCase();
  const maker = String(input.maker || '').toLowerCase();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const revision = Number(input.revision);
  const songIds = input.songIds;
  if (!/^[a-f0-9]{32}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(maker) || !name || name.length > 60 ||
      !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(songIds) || songIds.length < 1 || songIds.length > 24 ||
      songIds.some(songId => !/^0x[0-9a-f]{64}$/i.test(songId)) ||
      new Set(songIds.map(songId => songId.toLowerCase())).size !== songIds.length) {
    throw new Error('Playlist needs a valid maker, ID, 1–60 character name, revision and 1–24 unique songs');
  }
  return { id, maker, name, revision, songIds: songIds.map(songId => songId.toLowerCase()) };
}

export function buildCreatorPlaylistAuthorizationMessage({ address, origin, action, nonce, expiresAt, playlist }) {
  const normalized = normalizeNamedPlaylist(playlist);
  return ['DecentBusking named DJuke playlist', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Nonce: ${nonce}`, `Expires At: ${expiresAt}`,
    `Playlist: ${JSON.stringify(normalized)}`].join('\n');
}

export function buildCreatorPlaylistCopyAuthorizationMessage({ address, origin, action, nonce, expiresAt, playlistId, revision }) {
  const reference = { id: String(playlistId || '').toLowerCase(), revision: Number(revision) };
  if (!/^[a-f0-9]{32}$/.test(reference.id) || !Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    throw new Error('Invalid saved playlist revision');
  }
  return ['DecentBusking saved DJuke playlist copy', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Nonce: ${nonce}`, `Expires At: ${expiresAt}`,
    `Playlist: ${JSON.stringify(reference)}`].join('\n');
}

export function creatorImageURL(value, gateway = 'https://gateway.pinata.cloud/ipfs/') {
  if (typeof value !== 'string') return '';
  if (/^ipfs:\/\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(value)) return `${gateway.replace(/\/$/, '')}/${value.slice(7)}`;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
}

function pickPreferredImage(primary, ...fallbacks) {
  const sources = [primary, ...fallbacks].filter(value => typeof value === 'string' && value.trim());
  const candidates = sources.filter(source => creatorImageURL(source));
  const source = candidates[0] || '';
  return {
    source,
    candidates,
    uri: source ? creatorImageURL(source) : '',
    fallbackUsed: !!source && source !== sources[0],
    primaryUnsupported: !!sources[0] && !creatorImageURL(sources[0]),
  };
}

export async function resolveCreatorENS(address, provider) {
  const name = await provider.lookupAddress(address);
  if (!name || String(await provider.resolveName(name)).toLowerCase() !== address.toLowerCase()) return null;
  const resolver = await provider.getResolver(name);
  if (!resolver) return { name, avatarURI: '', bannerURI: '' };
  const [avatar, banner, header] = await Promise.all([
    resolver.getAvatar().catch(() => null), resolver.getText('banner').catch(() => ''), resolver.getText('header').catch(() => ''),
  ]);
  return {
    name,
    avatarURI: typeof avatar === 'string' ? avatar : avatar?.url || creatorImageURL(await resolver.getText('avatar').catch(() => '')) || '',
    bannerURI: banner || header || '',
  };
}

export function creatorPresentation(profile = {}, ens = null) {
  const avatars = {
    ens: ens?.avatarURI || '',
    discord: profile.discord?.avatarURI || '',
    uploaded: profile.avatarURI || '',
  };
  const avatar = pickPreferredImage(avatars.ens, avatars.uploaded, avatars.discord);
  const banner = pickPreferredImage(ens?.bannerURI, profile.bannerURI, profile.discord?.bannerURI);
  return {
    name: profile.displayName || ens?.name || profile.discord?.displayName || 'Profile',
    avatarURI: avatar.source,
    avatars,
    bannerURI: banner.source,
    avatarCandidates: avatar.candidates,
    bannerCandidates: banner.candidates,
    avatarFallbackUsed: avatar.fallbackUsed,
    bannerFallbackUsed: banner.fallbackUsed,
    avatarUnsupported: avatar.primaryUnsupported,
    bannerUnsupported: banner.primaryUnsupported,
  };
}