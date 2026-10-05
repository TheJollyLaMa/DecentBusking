import { CID } from 'multiformats/cid';
export const DISCORD_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export function isDiscordAttachmentWithinLimit(attachment) {
  return Number.isInteger(attachment.size) && attachment.size > 0 && attachment.size <= DISCORD_UPLOAD_MAX_BYTES;
}

export const MEDIA_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4',
};

export function mediaTypeFor(filename = '', declaredType = '') {
  const extension = String(filename || '').split('.').pop().toLowerCase();
  return MEDIA_TYPES[extension] || (Object.values(MEDIA_TYPES).includes(declaredType) ? declaredType : '');
}

export function normalizeMediaCid(value) {
  const text = String(value || '').trim().replace(/^ipfs:\/\//i, '');
  try {
    return CID.parse(text).toV1().toString();
  } catch {
    throw new Error('Enter a valid file CID or ipfs://CID, without a directory path or gateway URL');
  }
}

export function buildSubmissionAuthorizationMessage(payload) {
  const { address, origin, issuedAt, title, artist, ipfsCid, mediaType, filename,
    recipient, artworkCid = '', tipWallet = '', parentTokenId = 0 } = payload;
  return [
    'DecentBusking media submission for owner approval',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Issued At: ${issuedAt}`,
    JSON.stringify({ title, artist, ipfsCid, mediaType, filename, recipient, artworkCid, tipWallet, parentTokenId }),
  ].join('\n');
}