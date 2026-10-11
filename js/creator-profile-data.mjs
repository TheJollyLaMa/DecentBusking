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

export function buildCreatorAuthorizationMessage({ address, origin, action, nonce, issuedAt, profile = {} }) {
  return ['DecentBusking creator profile', `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`,
    `Action: ${action}`, `Nonce: ${nonce}`, `Issued At: ${issuedAt}`,
    `Profile: ${JSON.stringify(normalizeCreatorProfile(profile))}`].join('\n');
}

export function creatorImageURL(value, gateway = 'https://gateway.pinata.cloud/ipfs/') {
  if (typeof value !== 'string') return '';
  if (/^ipfs:\/\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(value)) return `${gateway.replace(/\/$/, '')}/${value.slice(7)}`;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
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
  return {
    name: profile.displayName || ens?.name || profile.discord?.displayName || 'Creator',
    avatarURI: profile.avatarURI || ens?.avatarURI || profile.discord?.avatarURI || '',
    bannerURI: profile.bannerURI || ens?.bannerURI || profile.discord?.bannerURI || '',
  };
}