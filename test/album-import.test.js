const test = require('node:test');
const assert = require('node:assert/strict');
const cid = 'bafybeidxx4rufx7xrn5lmt3npyaej6doupxajyh53ibb4fp43whdvgfm2u';
const artist = { name: 'thejollylama', uploaderId: 'jolly', wallet: `0x${'1'.repeat(40)}` };
const plan = { duplicateMode: 'title', uploadsRequired: 0, tracks: [{ title: 'A song', filename: 'A_song.m4a',
  ipfsCid: cid, sha256: 'content', albums: ['AA'], dualPinVerified: true }] };

test('album import preserves old histories, adds radio-ready unminted tracks and is idempotent', async () => {
  const { prepareAlbumPlaylistImport } = await import('../discord-bot/album-import.js');
  const original = [{ trackId: 'old', title: 'Older song', plays: 99, likes: 10, tokenId: '4', weeklyPlays: { past: 12 } }];
  const result = prepareAlbumPlaylistImport({ playlist: original, plan, artist });
  assert.deepEqual(result.playlist[0], original[0]);
  assert.equal(original.length, 1);
  assert.equal(result.added.length, 1);
  assert.equal(result.playlist[1].source, 'album');
  assert.equal(result.playlist[1].mintStatus, 'unminted');
  assert.equal(result.playlist[1].plays, 0);
  assert.equal(result.playlist[1].mintRequestedAt, undefined);
  const repeat = prepareAlbumPlaylistImport({ playlist: result.playlist, plan, artist });
  assert.equal(repeat.added.length, 0);
  assert.equal(repeat.playlist.length, 2);
});

test('album import rechecks changed display titles and rejects unverifiable candidates before any mutation', async () => {
  const { prepareAlbumPlaylistImport, resolveAlbumArtist } = await import('../discord-bot/album-import.js');
  const existing = [{ trackId: 'old', title: 'Different display name', filename: 'a_song.M4A' }];
  const result = prepareAlbumPlaylistImport({ playlist: existing, plan, artist });
  assert.equal(result.added.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.throws(() => prepareAlbumPlaylistImport({ playlist: [], artist,
    plan: { ...plan, tracks: [{ ...plan.tracks[0], dualPinVerified: false }] } }), /not verified/);
  assert.deepEqual(resolveAlbumArtist([{ uploader: artist.name, uploaderId: 'jolly', mintRecipient: artist.wallet }], artist), artist);
  assert.throws(() => resolveAlbumArtist([], artist), /missing or ambiguous/);
});

test('album checkpoint must succeed before caller can adopt imported state and retries skip existing songs', async () => {
  const { checkpointReviewedAlbumImport } = await import('../discord-bot/album-import.js');
  const original = [];
  await assert.rejects(checkpointReviewedAlbumImport({ playlist: original, plan, artist,
    verifyMirrorAvailable: async () => {}, mirrorCheckpoint: async () => {},
    save: async () => { throw new Error('Pinata unavailable'); } }), /Pinata unavailable/);
  assert.equal(original.length, 0);
  let saved;
  const result = await checkpointReviewedAlbumImport({ playlist: original, plan, artist,
    verifyMirrorAvailable: async () => {}, mirrorCheckpoint: async () => {},
    save: async playlist => { saved = playlist; return 'ipfs://checkpoint'; } });
  assert.deepEqual(saved, result.playlist);
  assert.equal(result.added.length, 1);
  const retry = await checkpointReviewedAlbumImport({ playlist: result.playlist, plan, artist,
    save: async () => { throw new Error('No extra checkpoint required'); } });
  assert.equal(retry.added.length, 0);
  assert.equal(retry.checkpointUri, null);
});

test('album checkpoint requires local mirror preflight before pinning and rejects incomplete dual pins', async () => {
  const { checkpointReviewedAlbumImport } = await import('../discord-bot/album-import.js');
  let saves = 0;
  const options = { playlist: [], plan, artist, save: async () => { saves++; return 'ipfs://checkpoint'; },
    mirrorCheckpoint: async () => { throw new Error('Local unavailable'); } };
  await assert.rejects(checkpointReviewedAlbumImport({ ...options,
    verifyMirrorAvailable: async () => { throw new Error('No local mirror'); } }), /No local mirror/);
  assert.equal(saves, 0);
  await assert.rejects(checkpointReviewedAlbumImport({ ...options, verifyMirrorAvailable: async () => {} }), /no state adopted/);
  assert.equal(saves, 1);
});

test('local-first checkpoint store can confirm import without post-publication mirror', async () => {
  const { checkpointReviewedAlbumImport } = await import('../discord-bot/album-import.js');
  let ready = false;
  const result = await checkpointReviewedAlbumImport({ playlist: [], plan, artist, mirrorBeforePublication: true,
    verifyMirrorAvailable: async () => { ready = true; }, save: async () => {
      assert.equal(ready, true); return 'ipfs://dual-pinned-checkpoint';
    } });
  assert.equal(result.added.length, 1);
  assert.equal(result.checkpointUri, 'ipfs://dual-pinned-checkpoint');
});