const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.join(__dirname, '..', 'discord-bot', 'ipfs-backfill.js')).href;

function createStore(tracks) {
  const playlist = tracks.map((track) => ({ ...track }));
  const store = {
    saves: 0,
    getPlaylist: () => [...playlist],
    updateTrackPin(trackId, result, options) {
      assert.deepEqual(options, { save: false });
      const track = playlist.find((entry) => entry.trackId === trackId);
      track.pinStatus = result.status;
      if (result.ipfsCid) track.ipfsCid = result.ipfsCid;
      if (result.error) track.pinError = result.error;
      return track;
    },
    savePlaylist() { store.saves++; },
  };
  return { store, playlist };
}

test('only Discord-only tracks need IPFS pins; fresh uploads stay with the live handler', async () => {
  const { needsIpfsPin, audioMimeType } = await import(moduleUrl);
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(needsIpfsPin({ ipfsCid: 'bafy', pinStatus: 'pinned' }, now), false);
  assert.equal(needsIpfsPin({ pinStatus: 'untracked' }, now), true);
  assert.equal(needsIpfsPin({ pinStatus: 'failed' }, now), true);
  assert.equal(needsIpfsPin({ pinStatus: 'pending', addedAt: '2026-10-02T11:58:00Z' }, now), false);
  assert.equal(needsIpfsPin({ pinStatus: 'pending', addedAt: '2026-10-02T11:00:00Z' }, now), true);
  assert.equal(audioMimeType('Song.M4A'), 'audio/mp4');
  assert.equal(audioMimeType('Video.MP4'), 'video/mp4');
  assert.equal(audioMimeType('unknown'), 'audio/mpeg');
});

test('backfill pins legacy uploads, records missing originals, and checkpoints in batches', async () => {
  const { backfillIpfsPins } = await import(moduleUrl);
  const { store, playlist } = createStore([
    { trackId: 'pinned', title: 'Pinned', filename: 'p.mp3', ipfsCid: 'bafy-p', pinStatus: 'pinned' },
    { trackId: 'legacy-1', title: 'Legacy One', filename: 'one.m4a', pinStatus: 'untracked' },
    { trackId: 'legacy-2', title: 'Legacy Two', filename: 'two.mp3', pinStatus: 'failed' },
    { trackId: 'deleted', title: 'Deleted', filename: 'gone.mp3', pinStatus: 'untracked' },
  ]);
  const uploads = [];
  const quiet = { log() {}, warn() {} };
  const options = {
    client: {},
    maxBytes: 1024,
    delayMs: 0,
    checkpointEvery: 2,
    store,
    log: quiet,
    fetchAttachment: async (_client, track) => (track.trackId === 'deleted'
      ? null
      : { url: `https://cdn.example/${track.filename}`, size: 3, contentType: null }),
    fetchImpl: async (url) => new Response(`audio:${url}`),
    upload: async (buffer, filename, mimeType) => {
      uploads.push({ filename, mimeType, body: buffer.toString() });
      return `ipfs://bafy-${filename}`;
    },
  };

  const [first, concurrent] = await Promise.all([backfillIpfsPins(options), backfillIpfsPins(options)]);
  assert.equal(first, concurrent);
  assert.deepEqual(first, { pinned: 2, failed: 1, remaining: 1 });
  assert.deepEqual(uploads, [
    { filename: 'one.m4a', mimeType: 'audio/mp4', body: 'audio:https://cdn.example/one.m4a' },
    { filename: 'two.mp3', mimeType: 'audio/mpeg', body: 'audio:https://cdn.example/two.mp3' },
  ]);
  assert.deepEqual(playlist.map((track) => [track.trackId, track.pinStatus, track.ipfsCid ?? null]), [
    ['pinned', 'pinned', 'bafy-p'],
    ['legacy-1', 'pinned', 'bafy-one.m4a'],
    ['legacy-2', 'pinned', 'bafy-two.mp3'],
    ['deleted', 'failed', null],
  ]);
  assert.equal(playlist[3].pinError, 'Original Discord upload no longer exists');
  assert.equal(store.saves, 2);
});

test('Discord pin backfill rejects attachments above 10 MB before downloading', async () => {
  const { backfillIpfsPins } = await import(moduleUrl);
  const { store, playlist } = createStore([{ trackId: 'too-large', title: 'Large', filename: 'large.mp4', pinStatus: 'untracked' }]);
  let downloaded = false;
  const result = await backfillIpfsPins({ client: {}, store, maxBytes: 10 * 1024 * 1024, delayMs: 0,
    log: { log() {}, warn() {} },
    fetchAttachment: async () => ({ size: 10 * 1024 * 1024 + 1, url: 'https://cdn.example/large.mp4' }),
    fetchImpl: async () => { downloaded = true; }, upload: async () => { throw new Error('Must not upload'); },
  });
  assert.equal(downloaded, false);
  assert.equal(result.failed, 1);
  assert.equal(playlist[0].pinStatus, 'failed');
});
