export const SUBMISSION_MEDIA_TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/ogg', weba: 'audio/webm', mp4: 'video/mp4',
};

export function detectSubmissionMedia(bytes, { filename = '', type = '' } = {}) {
  const text = new TextDecoder('latin1').decode(bytes);
  const starts = value => text.startsWith(value);
  if (starts('RIFF') && text.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (starts('fLaC')) return 'audio/flac';
  if (starts('OggS')) return 'audio/ogg';
  if (starts('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)) return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (text.slice(4, 8) === 'ftyp') {
    if (text.includes('vide')) return 'video/mp4';
    if (text.slice(8, 12).startsWith('M4A') || text.includes('soun') || /\.m4a$/i.test(filename) || type === 'audio/mp4') return 'audio/mp4';
    if (type === 'video/mp4') return 'video/mp4';
    throw new Error('Could not distinguish audio from video in this MP4 file. Its media headers could not be read.');
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 &&
    (type === 'audio/webm' || /\.weba$/i.test(filename) || (text.includes('A_OPUS') && !text.includes('V_VP')))) return 'audio/webm';
  throw new Error('Could not detect supported media. Use MP3, WAV, M4A, OGG/Opus, FLAC, AAC, WebM audio or MP4 video.');
}

export function mediaFilename(type, filename = 'track') {
  const extension = Object.keys(SUBMISSION_MEDIA_TYPES).find(key => SUBMISSION_MEDIA_TYPES[key] === type);
  if (!extension) throw new Error('Unsupported media type');
  const base = filename.replace(/\.[^.]*$/, '').replace(/[/\\\r\n]/g, '-').slice(0, 145) || 'track';
  return `${base}.${extension}`;
}

export function evenCreatorSplits(wallets) {
  const base = Math.floor(10000 / wallets.length);
  return wallets.map((wallet, index) => ({ wallet, shareBps: base + (index < 10000 % wallets.length ? 1 : 0) }));
}

export function validateCreatorSplits(value, recipient) {
  if (value === undefined) value = [{ wallet: recipient, shareBps: 10000 }];
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error('Choose between 1 and 10 DJuke earning wallets');
  const seen = new Set();
  let total = 0;
  for (const entry of value) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(entry?.wallet || '') || /^0x0{40}$/i.test(entry.wallet)) throw new Error('Enter a valid nonzero wallet for every collaborator');
    const key = entry.wallet.toLowerCase();
    if (seen.has(key)) throw new Error('Each collaborator wallet must be unique');
    seen.add(key);
    if (!Number.isInteger(entry.shareBps) || entry.shareBps < 1 || entry.shareBps > 10000) throw new Error('Each earning share must be positive, with up to two decimal places');
    total += entry.shareBps;
  }
  if (total !== 10000) throw new Error('DJuke earning shares must total exactly 100%');
  if (!seen.has(recipient?.toLowerCase())) throw new Error('Include the artist recipient in the earning split');
  return value.map(({ wallet, shareBps }) => ({ wallet, shareBps }));
}
