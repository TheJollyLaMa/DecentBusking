const test = require('node:test');
const assert = require('node:assert/strict');
const artist = `0x${'1'.repeat(40)}`;
const other = `0x${'2'.repeat(40)}`;

test('media detection reads file signatures rather than guessing MP3 or trusting a renamed extension', async () => {
  const { detectSubmissionMedia, mediaFilename } = await import('../js/submission-media.mjs');
  const cases = [
    ['ID3music', 'audio/mpeg'], ['RIFF1234WAVEdata', 'audio/wav'], ['fLaCdata', 'audio/flac'],
    ['OggSOpusHead', 'audio/ogg'], ['\0\0\0\x18ftypM4A ', 'audio/mp4'], ['\0\0\0\x18ftypisomvide', 'video/mp4'],
  ];
  for (const [bytes, expected] of cases) assert.equal(detectSubmissionMedia(Buffer.from(bytes), { filename: 'wrong.png' }), expected);
  assert.equal(detectSubmissionMedia(new Uint8Array([0xff, 0xf1, 0x50])), 'audio/aac');
  assert.equal(detectSubmissionMedia(new Uint8Array([0xff, 0xfb, 0x90])), 'audio/mpeg');
  assert.equal(detectSubmissionMedia(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('A_OPUS')])), 'audio/webm');
  assert.equal(mediaFilename('audio/wav', 'renamed.mp3'), 'renamed.wav');
  assert.throws(() => detectSubmissionMedia(Buffer.from('not media'), { filename: 'fake.mp4', type: 'video/mp4' }), /Could not detect/);
  assert.throws(() => mediaFilename('video/unknown'), /Unsupported/);
});

test('creator earning splits default evenly with exact basis-point precision and reject invalid shares', async () => {
  const { evenCreatorSplits, validateCreatorSplits } = await import('../js/submission-media.mjs');
  const third = `0x${'3'.repeat(40)}`;
  assert.deepEqual(evenCreatorSplits([artist, other, third]).map(entry => entry.shareBps), [3334, 3333, 3333]);
  assert.deepEqual(validateCreatorSplits(undefined, artist), [{ wallet: artist, shareBps: 10000 }]);
  assert.deepEqual(validateCreatorSplits([{ wallet: artist, shareBps: 7000 }, { wallet: other, shareBps: 3000 }], artist),
    [{ wallet: artist, shareBps: 7000 }, { wallet: other, shareBps: 3000 }]);
  for (const invalid of [
    [], [{ wallet: artist, shareBps: 9999 }], [{ wallet: artist, shareBps: 10000.1 }],
    [{ wallet: artist, shareBps: 0 }, { wallet: other, shareBps: 10000 }],
    [{ wallet: artist, shareBps: 5000 }, { wallet: artist, shareBps: 5000 }],
    [{ wallet: `0x${'0'.repeat(40)}`, shareBps: 10000 }], [{ wallet: 'bad', shareBps: 10000 }],
    [{ wallet: other, shareBps: 10000 }],
  ]) assert.throws(() => validateCreatorSplits(invalid, artist));
});

test('submitted collaborator shares survive the durable approval checkpoint and conflicting resubmissions fail', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'briefcase-splits-'));
  const previous = process.env.JUKELOOP_PLAYLIST_PATH;
  process.env.JUKELOOP_PLAYLIST_PATH = path.join(folder, 'playlist.json');
  const store = await import(`../discord-bot/playlist-store.js?briefcase=${Date.now()}`);
  if (previous === undefined) delete process.env.JUKELOOP_PLAYLIST_PATH;
  else process.env.JUKELOOP_PLAYLIST_PATH = previous;
  t.after(() => fs.rmSync(folder, { recursive: true }));
  let snapshot;
  store.configureRemotePersistence(async value => { snapshot = value; });
  store.loadPlaylist([]);
  const submission = { address: artist, title: 'Our song', artist: 'The band', ipfsCid: 'recording',
    mediaType: 'audio/mpeg', filename: 'song.mp3', recipient: artist,
    creatorSplits: [{ wallet: artist, shareBps: 7000 }, { wallet: other, shareBps: 3000 }] };
  const track = store.submitMediaTrack(submission);
  await store.waitForRemotePersistence();
  assert.equal(track.mintStatus, 'requested');
  assert.deepEqual(snapshot[0].creatorSplits, submission.creatorSplits);
  const restored = store.loadPlaylist(JSON.parse(JSON.stringify(snapshot)))[0];
  assert.deepEqual(restored.creatorSplits, submission.creatorSplits);
  assert.equal(store.submitMediaTrack(submission).trackId, track.trackId);
  assert.throws(() => store.submitMediaTrack({ ...submission, creatorSplits: [{ wallet: artist, shareBps: 10000 }] }), /already submitted/);
  assert.throws(() => store.submitMediaTrack({ ...submission, isDevertAd: true }), /already submitted/);
});
