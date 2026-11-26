// One row per album membership. A blank album means a standalone recording.
export const MAX_RELEASE_TRACKS = 20;
export const MAX_RELEASE_ROWS = 40;

export function parseReleaseSheet(text) {
  if (typeof text !== 'string' || text.length > 16000) throw Error('Release sheet is too large');
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    const fields = line.split('|').map(value => value.trim());
    if (fields.length !== 4) throw Error(`Row ${i + 1}: use Album | Title | Format | File CID`);
    const [album, title, format, cid] = fields;
    return { album, title, format, cid };
  });
}

export function prepareRelease(rows, normalizeCid, formats) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_RELEASE_ROWS) throw Error(`Use 1–${MAX_RELEASE_ROWS} release rows`);
  const tracks = new Map(), positions = new Map();
  for (const [i, row] of rows.entries()) {
    const { album, title, format } = row || {};
    if (typeof album !== 'string' || album.length > 100 || typeof title !== 'string' || !title.trim() ||
        title.length > 120 || /[\x00-\x1f\x7f]/.test(album + title) || typeof format !== 'string' || !Object.hasOwn(formats, format) ||
        typeof row.cid !== 'string' || row.cid.length > 160) throw Error(`Row ${i + 1}: invalid album, title, format or CID`);
    const cid = normalizeCid(row.cid);
    const name = album.trim().normalize('NFC'), key = name.toLowerCase();
    let track = tracks.get(cid);
    if (!track) {
      track = { cid, title: title.trim(), format, memberships: [] };
      tracks.set(cid, track);
    } else if (track.title !== title.trim() || track.format !== format) {
      throw Error(`Row ${i + 1}: the same recording has conflicting titles or formats`);
    }
    if (name && !track.memberships.some(m => m.album.toLowerCase() === key)) {
      const position = (positions.get(key) || 0) + 1;
      positions.set(key, position);
      track.memberships.push({ album: name, position });
    }
  }
  if (tracks.size > MAX_RELEASE_TRACKS) throw Error(`Use at most ${MAX_RELEASE_TRACKS} different recordings per batch`);
  return [...tracks.values()];
}

export function releaseAuthorization({ address, origin, issuedAt, artist, artworkCid = '', rows }) {
  return ['DecentBusking song batch for owner mint approval (no transaction)',
    `Wallet: ${address.toLowerCase()}`, `Origin: ${origin}`, `Issued At: ${issuedAt}`,
    JSON.stringify({ artist, artworkCid, rows: rows.map(({ album, title, format, cid }) => [album, title, format, cid]) })].join('\n');
}
