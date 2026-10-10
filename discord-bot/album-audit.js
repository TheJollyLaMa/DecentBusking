import { load } from 'cheerio';
import { parse } from 'acorn';
import { CID } from 'multiformats/cid';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import { create as createDigest } from 'multiformats/hashes/digest';

const AUDIO_EXTENSION = /\.(mp3|wav|ogg|aac|m4a|flac|opus|mp4)(?:[?#]|$)/i;

export async function reconstructLocalAlbumDirectory(directory, { rawLeaves = false, includeFinderMetadata = false } = {}) {
  const sources = [];
  async function walk(path) {
    const entries = (await readdir(path, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      if (!includeFinderMetadata && entry.name === '.DS_Store') continue;
      const source = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Album directory contains a symlink; manual review required');
      if (entry.isDirectory()) await walk(source);
      else if (entry.isFile()) sources.push({ path: relative(directory, source), source, before: await stat(source) });
    }
  }
  await walk(directory);
  if (!sources.length) throw new Error('Album directory is empty');
  const results = [];
  for await (const entry of importer(sources.map(file => ({ path: file.path, content: createReadStream(file.source) })),
    { put: async () => {} }, { cidVersion: 1, rawLeaves, chunker: fixedSize({ chunkSize: 262144 }), wrapWithDirectory: true })) {
    results.push({ path: entry.path || '', cid: entry.cid.toV1().toString(), dagBytes: String(entry.size) });
  }
  for (const file of sources) {
    const after = await stat(file.source);
    if (after.size !== file.before.size || after.mtimeMs !== file.before.mtimeMs) throw new Error('Album changed during directory verification');
  }
  const root = results.find(entry => entry.path === '');
  if (!root) throw new Error('Reconstructed album root is unavailable');
  return { rootCid: root.cid, rawLeaves, includeFinderMetadata, files: results.filter(entry => entry.path),
    sourceBytes: sources.reduce((sum, file) => sum + file.before.size, 0) };
}

export async function inventoryLocalAlbumFiles(root) {
  const files = [];
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((first, second) => first.name.localeCompare(second.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && AUDIO_EXTENSION.test(entry.name)) {
        const before = await stat(path);
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        const digest = hash.digest();
        const cidCandidates = [CID.createV1(0x55, createDigest(0x12, digest)).toString()];
        for (const rawLeaves of [false, true]) {
          for await (const result of importer([{ content: createReadStream(path) }], { put: async () => {} }, {
            cidVersion: 1, rawLeaves, chunker: fixedSize({ chunkSize: 262144 }),
          })) cidCandidates.push(result.cid.toV1().toString());
        }
        const after = await stat(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error(`Source file changed during audit: ${entry.name}`);
        const sourcePath = relative(root, path);
        files.push({ sourcePath, album: sourcePath.split('/')[0], filename: entry.name,
          size: before.size, sha256: digest.toString('hex'), cidCandidates: [...new Set(cidCandidates)] });
      }
    }
  }
  await walk(root);
  return files;
}

export async function listPublicPinataFiles({ pinataJwt, fetchImpl = fetch, maxPages = 100 }) {
  if (!pinataJwt) throw new Error('Pinata listing credentials are required');
  const files = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL('https://api.pinata.cloud/v3/files/public');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('order', 'DESC');
    if (cursor) url.searchParams.set('pageToken', cursor);
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${pinataJwt}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Pinata read-only listing failed (${response.status}); stop and retry later`);
    const result = await response.json();
    if (!Array.isArray(result.data?.files)) throw new Error('Invalid Pinata inventory response');
    files.push(...result.data.files.map(({ id, cid, name, size, mime_type, number_of_files }) =>
      ({ id, cid, name, size, mimeType: mime_type, fileCount: number_of_files })));
    cursor = result.data.next_page_token;
    if (!cursor) return files;
    if (cursors.has(cursor)) throw new Error('Pinata inventory pagination repeated; coverage incomplete');
    cursors.add(cursor);
  }
  throw new Error('Pinata inventory exceeded page limit; coverage incomplete');
}

export function compareLocalPinataInventory(localFiles, pinataFiles, playlist = []) {
  const pins = new Map();
  for (const file of pinataFiles) {
    const key = canonicalAudioKey(`ipfs://${file.cid}`);
    if (!key) continue;
    const matches = pins.get(key) || [];
    matches.push(file);
    pins.set(key, matches);
  }
  const recordings = new Map();
  for (const file of localFiles) {
    if (recordings.has(file.sha256)) {
      recordings.get(file.sha256).sources.push(file.sourcePath);
      continue;
    }
    const exactPins = file.cidCandidates.flatMap(cid => pins.get(cid) || []);
    const pinataCandidates = exactPins.length ? [] : pinataFiles.filter(pin => pin.name === file.filename && pin.size === file.size);
    const playlistMatches = playlist.filter(track => file.cidCandidates.includes(canonicalAudioKey(`ipfs://${track.ipfsCid || ''}`)));
    recordings.set(file.sha256, { ...file, sources: [file.sourcePath], exactPins,
      pinataCandidates, playlistMatches: playlistMatches.map(({ trackId, tokenId, mintStatus }) => ({ trackId, tokenId, mintStatus })),
      disposition: exactPins.length ? 'reuse-pinata' : pinataCandidates.length ? 'verify-existing-candidate' : 'not-found-in-file-inventory' });
  }
  const unique = [...recordings.values()];
  return { schemaVersion: 1, readOnly: true, dualPinRequired: true, uploadsPerformed: 0,
    fileCount: localFiles.length, uniqueRecordings: unique.length, duplicateLocalCopies: localFiles.length - unique.length,
    localMediaBytes: localFiles.reduce((sum, file) => sum + file.size, 0),
    uniqueMediaBytes: unique.reduce((sum, file) => sum + file.size, 0),
    exactReusableRecordings: unique.filter(file => file.exactPins.length).length,
    exactReusableBytes: unique.filter(file => file.exactPins.length).reduce((sum, file) => sum + file.size, 0),
    unmatchedBytesUpperBound: unique.filter(file => !file.exactPins.length).reduce((sum, file) => sum + file.size, 0),
    recordings: unique,
    note: 'Public file inventory only. Unmatched files may exist inside pinned directories, legacy pins, or other import layouts. Do not upload from this report without resolving those cases and checking plan capacity.' };
}

export function normalizeAlbumSongTitle(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\.(mp3|m4a|mp4|wav|ogg|aac|flac|opus)$/i, '')
    .replace(/[_\s]+/g, ' ').trim();
}

export function buildReviewedAlbumImportPlan(manifest) {
  if (manifest?.duplicateMode !== 'title' || !manifest.playlistVerified || !Array.isArray(manifest.recordings)) {
    throw new Error('Verified title-review manifest required');
  }
  const tracks = [];
  const titleKeys = new Set();
  const audioKeys = new Set();
  for (const recording of manifest.recordings) {
    if (recording.action !== 'review-new-radio-entry') continue;
    if (!Array.isArray(recording.blockers) || recording.blockers.length || !recording.dualPinVerified ||
      !canonicalAudioKey(`ipfs://${recording.audioCid || ''}`)) throw new Error('Import candidate has unresolved safety blockers');
    const title = String(recording.filename).replace(/\.(mp3|m4a|mp4|wav|ogg|aac|flac|opus)$/i, '').replace(/_/g, ' ').trim();
    const key = normalizeAlbumSongTitle(title);
    if (!key || titleKeys.has(key) || audioKeys.has(recording.audioCid)) throw new Error('Import plan contains a duplicate title or audio reference');
    titleKeys.add(key);
    audioKeys.add(recording.audioCid);
    tracks.push({ title, filename: recording.filename, ipfsCid: recording.audioCid, sha256: recording.sha256,
      albums: recording.albums, sources: recording.sources, dualPinVerified: true });
  }
  return { schemaVersion: 1, applyEnabled: false, sourceGeneratedAt: manifest.generatedAt,
    duplicateMode: 'title', uploadsRequired: 0, nftVerification: 'not-performed-by-user-request', tracks,
    requirements: ['recheck-current-playlist-titles-before-apply', 'confirm-artist-attribution',
      'persist-radio-and-album-state-without-changing-existing-history'] };
}

export function buildAlbumImportManifest({ localFiles, verifiedDirectories, pinataFiles, playlist, nfts = [],
  duplicateMode = 'content', nftScanComplete = false, playlistVerified = false, localPinnedRoots = [], generatedAt = new Date().toISOString() }) {
  if (!['content', 'title'].includes(duplicateMode)) throw new Error('Invalid album duplicate mode');
  const roots = new Set(localPinnedRoots.map(cid => canonicalAudioKey(`ipfs://${cid}`)));
  const children = [];
  for (const album of verifiedDirectories.filter(album => album.matched)) {
    for (const file of album.files || []) {
      if (!AUDIO_EXTENSION.test(file.path)) continue;
      children.push({ cid: file.cid, name: file.path, parentCid: album.cid, parentName: album.name });
    }
  }
  const report = compareLocalPinataInventory(localFiles, [...pinataFiles, ...children], playlist);
  const references = entry => canonicalAudioKey(entry.audioUrl || entry.animation_url ||
    (entry.ipfsCid ? `ipfs://${entry.ipfsCid}` : ''));
  const titleKey = normalizeAlbumSongTitle;
  const directoriesByFolder = new Map(verifiedDirectories.map(album => [album.localFolder, album]));
  const recordings = report.recordings.map(recording => {
    const candidates = new Set(recording.cidCandidates);
    for (const pin of recording.exactPins) {
      candidates.add(canonicalAudioKey(`ipfs://${pin.cid}`));
      if (pin.parentCid) candidates.add(canonicalAudioKey(`ipfs://${pin.parentCid}/${pin.name}`));
    }
    const playlistMatches = playlist.filter(track => candidates.has(references(track)));
    const nftMatches = nfts.filter(nft => candidates.has(references(nft)));
    const aliases = localFiles.filter(file => file.sha256 === recording.sha256);
    const titles = new Set(aliases.map(file => titleKey(file.filename)));
    const titleMatches = playlist.filter(entry => [entry.title, entry.name, entry.filename].some(value =>
      value && titles.has(titleKey(value))));
    const localTitleMatches = localFiles.filter(file => file.sha256 !== recording.sha256 && titles.has(titleKey(file.filename)));
    const possibleDuplicates = [...playlist, ...nfts].filter(entry => !candidates.has(references(entry)) &&
      titles.has(titleKey(entry.title || entry.name || entry.filename))).map(entry => ({
        trackId: entry.trackId || null, tokenId: entry.tokenId ?? null, title: entry.title || entry.name || entry.filename,
      }));
    const pinned = recording.exactPins.find(pin => roots.has(canonicalAudioKey(`ipfs://${pin.parentCid || pin.cid}`)));
    const albums = [...new Set(aliases.map(file => file.album))];
    const blockers = [];
    if (!playlistVerified) blockers.push('live-playlist-not-verified');
    if (!nftScanComplete && duplicateMode !== 'title') blockers.push('nft-scan-incomplete');
    if (!pinned) blockers.push('dual-pin-not-verified');
    if (duplicateMode === 'title' && titleMatches.length) blockers.push('existing-song-title-match');
    if (duplicateMode === 'title' && localTitleMatches.length) blockers.push('local-song-title-collision');
    if (possibleDuplicates.length && duplicateMode !== 'title') blockers.push('possible-alternate-encoding');
    if (albums.some(album => directoriesByFolder.has(album) && !directoriesByFolder.get(album).matched)) blockers.push('album-directory-mismatch');
    if (!albums.some(album => directoriesByFolder.get(album)?.matched)) blockers.push('outside-verified-ens-albums');
    if (playlistMatches.length > 1) blockers.push('multiple-existing-playlist-identities');
    return { sha256: recording.sha256, filename: recording.filename, bytes: recording.size,
      sources: recording.sources, albums, audioCid: pinned ? canonicalAudioKey(`ipfs://${pinned.cid}`) : null,
      dualPinVerified: !!pinned,
      playlistMatches: playlistMatches.map(track => ({ trackId: track.trackId, tokenId: track.tokenId ?? null, mintStatus: track.mintStatus })),
      nftMatches: nftMatches.map(nft => ({ chainId: nft.chainId, contractAddress: nft.contractAddress, tokenId: nft.tokenId })),
      titleMatches: titleMatches.map(track => ({ trackId: track.trackId, title: track.title, filename: track.filename })),
      localTitleMatches: localTitleMatches.map(file => file.sourcePath),
      possibleDuplicates, blockers,
      action: duplicateMode === 'title' && titleMatches.length ? 'hold-existing-title-match' :
        playlistMatches.length ? 'reuse-existing-song-and-attach-albums' :
        nftMatches.length ? 'reuse-existing-nft-review-radio-entry' : blockers.length ? 'blocked-review' : 'review-new-radio-entry' };
  });
  return { schemaVersion: 1, generatedAt, importEnabled: false, duplicateMode, nftScanComplete, playlistVerified,
    fileCount: localFiles.length, uniqueRecordings: recordings.length, duplicateLocalCopies: report.duplicateLocalCopies,
    verifiedAlbums: verifiedDirectories.filter(album => album.matched).map(album => ({ album: album.name, cid: album.cid,
      localRecursivePinned: roots.has(canonicalAudioKey(`ipfs://${album.cid}`)) })),
    directoryMismatches: verifiedDirectories.filter(album => !album.matched).map(album => album.name),
    counts: {
      reuseExistingSongs: recordings.filter(recording => recording.playlistMatches.length).length,
      existingNfts: recordings.filter(recording => recording.nftMatches.length).length,
      dualPinnedRecordings: recordings.filter(recording => recording.dualPinVerified).length,
      newRadioCandidates: recordings.filter(recording => recording.action === 'review-new-radio-entry').length,
      blockedRecordings: recordings.filter(recording => recording.blockers.length).length,
      heldExistingTitles: recordings.filter(recording => recording.titleMatches.length).length,
      localTitleCollisions: recordings.filter(recording => recording.localTitleMatches.length).length,
    }, recordings };
}

export function canonicalAudioKey(uri) {
  if (typeof uri !== 'string') return null;
  let path;
  if (uri.startsWith('ipfs://')) path = uri.replace(/^ipfs:\/\/(?:ipfs\/)?/, '');
  else {
    try {
      const url = new URL(uri);
      path = url.pathname.startsWith('/ipfs/') ? url.pathname.slice(6) :
        url.hostname.includes('.ipfs.') ? `${url.hostname.split('.ipfs.')[0]}${url.pathname}` : null;
    } catch { return null; }
  }
  if (!path) return null;
  const [root, ...segments] = path.split(/[?#]/)[0].split('/');
  try {
    const cid = CID.parse(root).toV1().toString();
    return `${cid}${segments.length ? `/${segments.join('/')}` : ''}`;
  } catch { return null; }
}

export function extractCatalogAlbums(html, baseUrl) {
  const document = load(html);
  const albums = [];
  document('a.album-card[href]').each((_index, element) => {
    const link = document(element);
    const url = new URL(link.attr('href'), baseUrl).href;
    if (!canonicalAudioKey(url)) throw new Error('Catalog album is not an IPFS player');
    albums.push({ title: link.find('h3').text().trim() || link.text().trim(), url });
  });
  if (!albums.length) throw new Error('No album cards found in the current catalog');
  return albums;
}

function literal(node) {
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'ArrayExpression') return node.elements.map(literal);
  if (node?.type === 'ObjectExpression') return Object.fromEntries(node.properties.map(property => {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init') throw new Error('Nonliteral track manifest');
    return [property.key.name || property.key.value, literal(property.value)];
  }));
  throw new Error('Nonliteral track manifest');
}

export function extractAlbumTracks(html, albumUrl) {
  const document = load(html);
  const tracks = new Map();
  const baseUrl = albumUrl.endsWith('/') ? albumUrl : `${albumUrl}/`;
  const add = (value, title = '') => {
    if (typeof value !== 'string' || !value.trim()) return;
    let url;
    try { url = new URL(value, baseUrl).href; } catch { return; }
    const audioKey = canonicalAudioKey(url);
    if (!audioKey) return;
    if (!tracks.has(audioKey)) tracks.set(audioKey, { audioKey, url,
      title: title || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Untitled recording') });
  };
  const addManifest = entries => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (typeof entry === 'string') add(entry);
      else if (entry && typeof entry === 'object') {
        add(entry.audioUrl || entry.audio || entry.url || entry.src || entry.file || entry.path,
          typeof entry.title === 'string' ? entry.title : typeof entry.name === 'string' ? entry.name : '');
      }
    }
  };
  document('audio[src], audio source[src]').each((_index, element) => add(document(element).attr('src')));
  document('a[href]').each((_index, element) => {
    const link = document(element);
    if (AUDIO_EXTENSION.test(link.attr('href') || '')) add(link.attr('href'), link.text().trim());
  });
  document('script:not([src])').each((_index, element) => {
    const source = document(element).html() || '';
    if (document(element).attr('type') === 'application/json') {
      try { const manifest = JSON.parse(source); addManifest(Array.isArray(manifest) ? manifest : manifest.tracks || manifest.songs || manifest.playlist); } catch {}
      return;
    }
    let ast;
    try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { return; }
    for (const statement of ast.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations) {
        if (!['tracks', 'songs', 'playlist', 'audioFiles'].includes(declaration.id.name)) continue;
        try { addManifest(literal(declaration.init)); } catch {}
      }
    }
  });
  return [...tracks.values()];
}

export function auditAlbumTracks(albums, { playlist = [], nfts = [] } = {}) {
  const known = new Map();
  for (const entry of [...playlist, ...nfts]) {
    const audioKey = canonicalAudioKey(entry.audioUrl || entry.animation_url || (entry.ipfsCid ? `ipfs://${entry.ipfsCid}` : ''));
    if (audioKey) {
      const matches = known.get(audioKey) || [];
      matches.push({ trackId: entry.trackId || null, contractAddress: entry.contractAddress || null, tokenId: entry.tokenId ?? null });
      known.set(audioKey, matches);
    }
  }
  const imported = new Map();
  const recordings = [];
  for (const album of albums) for (const track of album.tracks || []) {
    if (imported.has(track.audioKey)) {
      imported.get(track.audioKey).albums.push(album.title);
      continue;
    }
    const titleKey = track.title.toLowerCase().replace(/\.[a-z0-9]+$/i, '').trim();
    const possibleReencodedMatch = [...playlist, ...nfts].some(entry =>
      String(entry.title || entry.name || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').trim() === titleKey);
    const recording = { ...track, albums: [album.title], matches: known.get(track.audioKey) || [],
      disposition: known.has(track.audioKey) ? 'reuse-existing' : possibleReencodedMatch ? 'review-possible-reencoding' : 'review-new-recording' };
    imported.set(track.audioKey, recording);
    recordings.push(recording);
  }
  return { schemaVersion: 1, importEnabled: false, albums, recordings,
    blockedAlbums: albums.filter(album => album.error || !album.tracks?.length).map(album => album.title),
    note: 'CID/path matches are exact references, not perceptual audio matches. Review rights and alternate encodings before importing.' };
}

export async function auditLiveAlbumCatalog({ catalogUrl = 'https://decentbusking.thejollylama.eth.limo/',
  playlist = [], nfts = [], fetchImpl = fetch } = {}) {
  const getHtml = async url => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (html.length > 5 * 1024 * 1024) throw new Error('Album HTML exceeds audit limit');
    return html;
  };
  const albums = extractCatalogAlbums(await getHtml(catalogUrl), catalogUrl);
  for (const album of albums) {
    try {
      album.tracks = extractAlbumTracks(await getHtml(album.url), album.url);
      if (!album.tracks.length) album.error = 'No supported literal audio manifest found; external manifests need review';
    } catch (error) { album.tracks = []; album.error = error.message; }
  }
  return auditAlbumTracks(albums, { playlist, nfts });
}