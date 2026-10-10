const test = require('node:test');
const assert = require('node:assert/strict');
const cid = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';

test('title review holds existing and colliding titles without requiring another NFT scan', async () => {
  const { buildAlbumImportManifest, normalizeAlbumSongTitle } = await import('../discord-bot/album-audit.js');
  assert.equal(normalizeAlbumSongTitle('  520_My_Song.M4A '), '520 my song');
  assert.notEqual(normalizeAlbumSongTitle('520 my song'), normalizeAlbumSongTitle('521 my song'));
  const localFiles = ['first', 'second'].map((sha256, index) => ({ sourcePath: `AA/${index}/520_My_Song.m4a`,
    album: 'AA', filename: '520_My_Song.m4a', size: 1, sha256, cidCandidates: [cid] }));
  const result = buildAlbumImportManifest({ localFiles, verifiedDirectories: [], pinataFiles: [],
    playlist: [{ trackId: 'existing', title: 'Different display title', filename: '520 my song.m4a' }],
    duplicateMode: 'title', playlistVerified: true });
  assert.equal(result.nftScanComplete, false);
  assert.equal(result.counts.heldExistingTitles, 2);
  assert.equal(result.counts.localTitleCollisions, 2);
  assert.ok(result.recordings.every(recording => recording.action === 'hold-existing-title-match' &&
    !recording.blockers.includes('nft-scan-incomplete')));
});

test('import plan includes only unblocked dual-pinned candidates and cannot apply itself', async () => {
  const { buildReviewedAlbumImportPlan } = await import('../discord-bot/album-audit.js');
  const candidate = { action: 'review-new-radio-entry', blockers: [], dualPinVerified: true,
    audioCid: cid, filename: '520_My_Song.m4a', albums: ['AA'], sources: ['AA/520_My_Song.m4a'], sha256: 'digest' };
  const manifest = { duplicateMode: 'title', playlistVerified: true,
    recordings: [candidate, { ...candidate, action: 'hold-existing-title-match' }] };
  const plan = buildReviewedAlbumImportPlan(manifest);
  assert.equal(plan.tracks.length, 1);
  assert.equal(plan.tracks[0].title, '520 My Song');
  assert.equal(plan.applyEnabled, false);
  assert.equal(plan.uploadsRequired, 0);
  assert.throws(() => buildReviewedAlbumImportPlan({ ...manifest, recordings: [candidate, candidate] }), /duplicate/);
  assert.throws(() => buildReviewedAlbumImportPlan({ ...manifest,
    recordings: [{ ...candidate, blockers: ['dual-pin-not-verified'] }] }), /unresolved/);
});

test('album parser extracts literal audio manifests without executing player scripts', async () => {
  const { extractAlbumTracks, extractCatalogAlbums } = await import('../discord-bot/album-audit.js');
  const html = `<script>globalThis.executed = true; const tracks = [{title: 'One', src: 'one.mp3'}, {title: 'Two', url: 'two.mp3'}];</script>
    <audio><source src="one.mp3"></audio><a href="three.mp3">Three</a>`;
  const tracks = extractAlbumTracks(html, `https://ipfs.io/ipfs/${cid}`);
  assert.equal(globalThis.executed, undefined);
  assert.equal(tracks.length, 3);
  assert.equal(new Set(tracks.map(track => track.audioKey)).size, 3);
  assert.ok(tracks.every(track => track.audioKey.startsWith(`${cid}/`)));
  const albums = extractCatalogAlbums(`<a class="album-card" href="https://ipfs.io/ipfs/${cid}"><h3>AA</h3></a>`, 'https://catalog.example/');
  assert.equal(albums[0].title, 'AA');
});

test('audit keeps distinct files in one directory and links repeats to existing songs', async () => {
  const { canonicalAudioKey, auditAlbumTracks } = await import('../discord-bot/album-audit.js');
  const first = { audioKey: `${cid}/one.mp3`, url: `ipfs://${cid}/one.mp3`, title: 'One' };
  const second = { audioKey: `${cid}/two.mp3`, url: `ipfs://${cid}/two.mp3`, title: 'Two' };
  assert.notEqual(canonicalAudioKey(first.url), canonicalAudioKey(second.url));
  const report = auditAlbumTracks([{ title: 'AA', tracks: [first, second] }, { title: 'AB', tracks: [first] }],
    { playlist: [{ trackId: 'existing', ipfsCid: `${cid}/one.mp3`, title: 'One' }, { trackId: 'reencoded', title: 'Two' }] });
  assert.equal(report.recordings.length, 2);
  assert.equal(report.recordings[0].disposition, 'reuse-existing');
  assert.deepEqual(report.recordings[0].albums, ['AA', 'AB']);
  assert.equal(report.recordings[1].disposition, 'review-possible-reencoding');
  assert.equal(report.importEnabled, false);
});

test('live audit reports inaccessible players as blocked rather than empty imported albums', async () => {
  const { auditLiveAlbumCatalog } = await import('../discord-bot/album-audit.js');
  const report = await auditLiveAlbumCatalog({ fetchImpl: async url => url.includes('eth.limo')
    ? new Response(`<a class="album-card" href="https://ipfs.io/ipfs/${cid}"><h3>AA</h3></a>`)
    : new Response('', { status: 429 }) });
  assert.deepEqual(report.blockedAlbums, ['AA']);
  assert.equal(report.albums[0].error, 'HTTP 429');
  assert.equal(report.recordings.length, 0);
});

test('local inventory hashes bytes, distinguishes recordings and skips symlinks', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const { inventoryLocalAlbumFiles, compareLocalPinataInventory } = await import('../discord-bot/album-audit.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'album-inventory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'AA'));
  await fs.writeFile(path.join(directory, 'AA', 'one.mp3'), 'same audio bytes');
  await fs.writeFile(path.join(directory, 'AA', 'copy.mp3'), 'same audio bytes');
  await fs.writeFile(path.join(directory, 'AA', 'two.mp3'), 'different audio bytes');
  await fs.symlink(path.join(directory, 'AA', 'one.mp3'), path.join(directory, 'AA', 'link.mp3'));
  const files = await inventoryLocalAlbumFiles(directory);
  assert.equal(files.length, 3);
  const report = compareLocalPinataInventory(files, [{ cid: files[0].cidCandidates[1], name: 'old-name.mp3', size: files[0].size }]);
  assert.equal(report.uniqueRecordings, 2);
  assert.equal(report.duplicateLocalCopies, 1);
  assert.equal(report.exactReusableRecordings, 1);
  assert.equal(report.uploadsPerformed, 0);
});

test('Pinata inventory is read-only and stops on rate limits or repeated pagination', async () => {
  const { listPublicPinataFiles } = await import('../discord-bot/album-audit.js');
  const requests = [];
  const files = await listPublicPinataFiles({ pinataJwt: 'test', fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.method, undefined);
    return new Response(JSON.stringify({ data: { files: [{ cid, name: 'song.mp3', size: 5 }],
      next_page_token: requests.length === 1 ? 'next' : null } }));
  } });
  assert.equal(files.length, 2);
  assert.equal(new URL(requests[1]).searchParams.get('pageToken'), 'next');
  await assert.rejects(listPublicPinataFiles({ pinataJwt: 'test', fetchImpl: async () => new Response('', { status: 429 }) }), /stop and retry/);
  await assert.rejects(listPublicPinataFiles({ pinataJwt: 'test', fetchImpl: async () =>
    new Response(JSON.stringify({ data: { files: [], next_page_token: 'repeated' } })) }), /coverage incomplete/);
});

test('offline directory verification preserves filenames and detects changed contents without pinning', async t => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const os = require('node:os');
  const { reconstructLocalAlbumDirectory } = await import('../discord-bot/album-audit.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'album-directory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'song.mp3'), 'audio');
  await fs.writeFile(path.join(directory, 'playlist.json'), '["song.mp3"]');
  await fs.writeFile(path.join(directory, '.DS_Store'), 'Finder metadata');
  const first = await reconstructLocalAlbumDirectory(directory);
  assert.deepEqual(first.files.map(file => file.path).sort(), ['playlist.json', 'song.mp3']);
  assert.equal((await reconstructLocalAlbumDirectory(directory)).rootCid, first.rootCid);
  assert.notEqual((await reconstructLocalAlbumDirectory(directory, { includeFinderMetadata: true })).rootCid, first.rootCid);
  await fs.writeFile(path.join(directory, 'song.mp3'), 'different audio');
  assert.notEqual((await reconstructLocalAlbumDirectory(directory)).rootCid, first.rootCid);
});

test('import manifest verifies directory coverage and reuses song identity without merging distinct directory paths', async () => {
  const { buildAlbumImportManifest } = await import('../discord-bot/album-audit.js');
  const other = 'bafybeicsbobnagvxy7tw47kqahluncyv52umlvieplkmr643covtfimnua';
  const files = [{ sourcePath: 'AA/one.mp3', album: 'AA', filename: 'one.mp3', size: 3, sha256: 'first', cidCandidates: [other] },
    { sourcePath: 'AB/one.mp3', album: 'AB', filename: 'one.mp3', size: 3, sha256: 'first', cidCandidates: [other] },
    { sourcePath: 'AA/two.mp3', album: 'AA', filename: 'two.mp3', size: 4, sha256: 'second', cidCandidates: [cid] }];
  const options = { localFiles: files, verifiedDirectories: [{ name: 'AA', localFolder: 'AA', cid, matched: true,
    files: [{ path: 'one.mp3', cid: other }, { path: 'two.mp3', cid }] }], pinataFiles: [],
    playlist: [{ trackId: 'existing', ipfsCid: `${cid}/one.mp3` }], nfts: [],
    localPinnedRoots: [cid], playlistVerified: true, nftScanComplete: true };
  const manifest = buildAlbumImportManifest(options);
  assert.equal(manifest.uniqueRecordings, 2);
  assert.equal(manifest.recordings[0].action, 'reuse-existing-song-and-attach-albums');
  assert.deepEqual(manifest.recordings[0].albums, ['AA', 'AB']);
  assert.equal(manifest.recordings[1].action, 'review-new-radio-entry');
  assert.equal(manifest.counts.dualPinnedRecordings, 2);
  assert.equal(manifest.importEnabled, false);
  const blocked = buildAlbumImportManifest({ ...options, nftScanComplete: false });
  assert.ok(blocked.recordings.every(recording => recording.blockers.includes('nft-scan-incomplete')));
});