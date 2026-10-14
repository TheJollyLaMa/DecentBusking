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
  return { name, avatarURI: avatar?.url || '', bannerURI: banner || header || '' };
}

export function creatorPresentation(profile = {}, ens = null) {
  const avatar = pickPreferredImage(ens?.avatarURI, profile.avatarURI, profile.discord?.avatarURI);
  const banner = pickPreferredImage(ens?.bannerURI, profile.bannerURI, profile.discord?.bannerURI);
  return {
    name: profile.displayName || ens?.name || profile.discord?.displayName || 'Profile',
    avatarURI: avatar.source,
    bannerURI: banner.source,
    avatarCandidates: avatar.candidates,
    bannerCandidates: banner.candidates,
    avatarFallbackUsed: avatar.fallbackUsed,
    bannerFallbackUsed: banner.fallbackUsed,
    avatarUnsupported: avatar.primaryUnsupported,
    bannerUnsupported: banner.primaryUnsupported,
  };
}