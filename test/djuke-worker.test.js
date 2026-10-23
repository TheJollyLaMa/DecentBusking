const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { id } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');

test('DJuke reads a canonical confirmed queue and maps only registered matching recordings', async () => {
  const { createDjukeQueueReader } = await import('../discord-bot/djuke.js');
  const address = `0x${'1'.repeat(40)}`;
  const wallet = `0x${'2'.repeat(40)}`;
  const track = { trackId: 'song', title: 'Song', ipfsCid: 'recording', mintStatus: 'minted', mintRecipient: wallet };
  const optionsSeen = [];
  let calls = 0;
  const contract = {
    headRequestId: async options => { optionsSeen.push(options); calls++; return 0n; },
    nextRequestId: async () => 1n,
    getRequest: async () => ({ songId: id('song'), payer: wallet, amount: 250000n, fulfilled: false, revision: 0n }),
    getSong: async () => ({ audioURI: 'ipfs://recording', enabled: true }),
  };
  let hash = 'canonical';
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 100,
    getBlock: async () => ({ hash }) };
  let clock = 0;
  const read = createDjukeQueueReader({ contractAddress: address, contract, provider, getPlaylist: () => [track], now: () => clock });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first.blockNumber, 99);
  assert.deepEqual(optionsSeen, [{ blockTag: 99 }]);
  assert.equal(first.requests[0].trackId, 'song');
  assert.equal(first.requests[0].playable, true);
  assert.equal(first.priceUnits, '250000');
  assert.equal(first.paymentsEnabled, false);
  contract.getSong = async () => ({ audioURI: 'ipfs://other', enabled: true });
  clock = 300001;
  const mismatch = await read();
  assert.equal(mismatch.requests[0].playable, false);
  assert.equal(mismatch.tracks.length, 0);
  let blocks = 0;
  provider.getBlock = async () => ({ hash: ++blocks === 1 ? 'canonical' : 'reorg' });
  await assert.rejects(read(), /changed during verification/);
});

test('DJuke refuses wrong-chain and incomplete snapshots rather than inventing an empty queue', async () => {
  const { createDjukeQueueReader } = await import('../discord-bot/djuke.js');
  const provider = { getNetwork: async () => ({ chainId: 137n }) };
  const read = createDjukeQueueReader({ contractAddress: `0x${'1'.repeat(40)}`, contract: {}, provider, getPlaylist: () => [] });
  await assert.rejects(read(), /Base-only/);
});

test('DJuke catalog accepts radio-eligible artist-attributed songs, including unminted album imports', async () => {
  const { djukeCatalog } = await import('../discord-bot/djuke.js');
  const wallet = `0x${'2'.repeat(40)}`;
  const songs = djukeCatalog([
    { trackId: 'album', source: 'album', ipfsCid: 'a', mintStatus: 'unminted', mintRecipient: wallet },
    { trackId: 'site-pending', source: 'site', ipfsCid: 'b', mintStatus: 'requested', mintRecipient: wallet },
    { trackId: 'no-wallet', ipfsCid: 'c', mintStatus: 'minted' },
  ]);
  assert.deepEqual(songs.map(entry => entry.track.trackId), ['album']);
  assert.equal(songs[0].songId, id('album'));
});

test('DJuke song manifest registers each radio song once with its artist wallet', async () => {
  const { buildDjukeSongManifest } = await import('../discord-bot/djuke-songs.js');
  const wallet = `0x${'2'.repeat(40)}`;
  const manifest = buildDjukeSongManifest([
    { trackId: 'album:1', title: 'Album song', source: 'album', ipfsCid: 'bafy-a', mintStatus: 'unminted', mintRecipient: wallet },
    { trackId: 'unattributed', title: 'No wallet', ipfsCid: 'bafy-b', mintStatus: 'minted' },
  ]);
  assert.deepEqual(manifest.songs, [{ songId: id('album:1'), trackId: 'album:1', title: 'Album song',
    audioURI: 'ipfs://bafy-a', recipients: [wallet], sharesBps: [10000] }]);
});

test('DJuke collaborator shares reach both the manifest and actual registration calldata', async () => {
  const { buildDjukeSongManifest } = await import('../discord-bot/djuke-songs.js');
  const { createDjukeSongRegistrar, DJUKE_ABI } = await import('../discord-bot/djuke.js');
  const { Interface } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');
  const wallet = `0x${'1'.repeat(40)}`;
  const other = `0x${'2'.repeat(40)}`;
  const track = { trackId: 'collab', title: 'Collaboration', source: 'site', mintStatus: 'minted',
    ipfsCid: 'recording', mintRecipient: wallet, creatorSplits: [{ wallet, shareBps: 6500 }, { wallet: other, shareBps: 3500 }] };
  const song = buildDjukeSongManifest([track]).songs[0];
  assert.deepEqual(song.recipients, [wallet, other]);
  assert.deepEqual(song.sharesBps, [6500, 3500]);
  const contract = { interface: new Interface(DJUKE_ABI), getSong: async () => ({ audioURI: '' }),
    multicall: async calls => {
      const args = contract.interface.decodeFunctionData('registerSong', calls[0]);
      assert.deepEqual([...args[2]], [wallet, other]);
      assert.deepEqual([...args[3]], [6500n, 3500n]);
      return { hash: 'registration', wait: async () => ({ status: 1 }) };
    } };
  assert.equal(await createDjukeSongRegistrar({ contract, getPlaylist: () => [track], log: { log() {}, warn() {} } })(), 1);
  assert.equal(buildDjukeSongManifest([{ ...track, isDevertAd: true }]).songs.length, 0);
});

test('registrar catches up all eligible songs in batches, then picks up only new uploads', async () => {
  const { createDjukeSongRegistrar, DJUKE_ABI } = await import('../discord-bot/djuke.js');
  const { Interface } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');
  const wallet = `0x${'2'.repeat(40)}`;
  const onChain = new Map([[id('conflict'), 'ipfs://other']]);
  const batches = [];
  let lookups = 0;
  const contract = { interface: new Interface(DJUKE_ABI),
    getSong: async songId => { lookups++; return { audioURI: onChain.get(songId) || '' }; },
    multicall: async calls => {
      batches.push(calls.length);
      for (const call of calls) {
        const [songId, audioURI] = contract.interface.decodeFunctionData('registerSong', call);
        onChain.set(songId, audioURI);
      }
      return { hash: `0x${batches.length}`, wait: async () => ({ status: 1 }) };
    } };
  const playlist = Array.from({ length: 30 }, (_, index) => ({ trackId: `song-${index}`, ipfsCid: `cid-${index}`, mintRecipient: wallet }));
  playlist.push({ trackId: 'conflict', ipfsCid: 'mine', mintRecipient: wallet });
  const invalidated = [];
  const register = createDjukeSongRegistrar({ contract, getPlaylist: () => playlist,
    onRegistered: songIds => invalidated.push(...songIds), log: { log() {}, warn() {} } });
  const [first, overlap] = await Promise.all([register(), register()]);
  assert.equal(first, 30);
  assert.equal(overlap, 30);
  assert.deepEqual(batches, [25, 5]);
  assert.equal(invalidated.length, 30);
  assert.equal(onChain.get(id('conflict')), 'ipfs://other');
  lookups = 0;
  playlist.push({ trackId: 'fresh-upload', ipfsCid: 'new', mintRecipient: wallet });
  assert.equal(await register(), 1);
  assert.equal(lookups, 1);
  assert.deepEqual(batches, [25, 5, 1]);
});

test('registrar skips a persistently failing lookup without blocking other song registrations', async () => {
  const { createDjukeSongRegistrar, DJUKE_ABI } = await import('../discord-bot/djuke.js');
  const { Interface } = createRequire(path.join(__dirname, '../discord-bot/package.json'))('ethers');
  const wallet = `0x${'2'.repeat(40)}`;
  const flakyId = id('flaky-song');
  const onChain = new Map();
  let flaky = true;
  const batches = [];
  const contract = { interface: new Interface(DJUKE_ABI),
    getSong: async songId => {
      if (songId === flakyId && flaky) throw new Error('temporary RPC failure');
      return { audioURI: onChain.get(songId) || '' };
    },
    multicall: async calls => {
      batches.push(calls.length);
      for (const call of calls) {
        const [songId, audioURI] = contract.interface.decodeFunctionData('registerSong', call);
        onChain.set(songId, audioURI);
      }
      return { hash: `0x${batches.length}`, wait: async () => ({ status: 1 }) };
    } };
  const playlist = ['flaky-song', 'healthy-song'].map(trackId => ({ trackId, ipfsCid: `${trackId}-cid`, mintRecipient: wallet }));
  const register = createDjukeSongRegistrar({ contract, getPlaylist: () => playlist, readRetryAttempts: 2,
    readRetryDelayMs: 0, log: { log() {}, warn() {} } });

  assert.equal(await register(), 1);
  assert.equal(onChain.has(id('healthy-song')), true);
  assert.equal(onChain.has(flakyId), false);
  flaky = false;
  assert.equal(await register(), 1);
  assert.equal(onChain.has(flakyId), true);
  assert.deepEqual(batches, [1, 1]);
});

test('DJuke catalog retries transient song reads and does not cache failed lookups', async () => {
  const { createDjukeQueueReader } = await import('../discord-bot/djuke.js');
  const wallet = `0x${'2'.repeat(40)}`;
  const track = { trackId: 'retry-song', title: 'Retry Song', ipfsCid: 'retry-cid', mintRecipient: wallet };
  let shouldFail = true;
  let lookups = 0;
  const contract = {
    headRequestId: async () => 0n,
    nextRequestId: async () => 0n,
    getSong: async () => {
      lookups++;
      if (shouldFail) throw new Error('temporary RPC failure');
      return { audioURI: 'ipfs://retry-cid', enabled: true };
    },
  };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlockNumber: async () => 100,
    getBlock: async () => ({ hash: 'canonical' }) };
  const read = createDjukeQueueReader({ contractAddress: `0x${'1'.repeat(40)}`, contract, provider,
    getPlaylist: () => [track], readRetryAttempts: 2, readRetryDelayMs: 0, log: { warn() {} } });

  const incomplete = await read();
  assert.deepEqual(incomplete.tracks, []);
  assert.equal(incomplete.catalogReadErrors, 1);
  assert.equal(lookups, 2);
  shouldFail = false;
  const recovered = await read();
  assert.equal(recovered.catalogReadErrors, 0);
  assert.deepEqual(recovered.tracks.map(entry => entry.trackId), ['retry-song']);
  assert.equal(lookups, 3);
});

function memoryJournal(api) {
  let snapshot = null;
  return api.createDjukePlaybackJournal({ restore: async () => snapshot,
    save: async value => { snapshot = structuredClone(value); return 'ipfs://journal'; } });
}

test('public queue shows all twelve named songs while querying only the playable lane head', async () => {
  const { createDjukeQueueReader, createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  const wallet = `0x${'2'.repeat(40)}`;
  const tracks = Array.from({ length: 12 }, (_, i) => ({ trackId: `named-${i}`, title: `Song ${i + 1}`,
    ipfsCid: `cid-${i}`, mintRecipient: wallet }));
  const batch = { batchId: '0', name: 'BoogieNight', songs: tracks.map((track, i) => ({
    songId: id(track.trackId), laneId: String(i), title: track.title, status: 'pending' })) };
  let itemReads = 0;
  const contract = { headRequestId: async () => 0n, nextRequestId: async () => 0n,
    playlistHeadId: async () => 0n, playlistNextId: async () => 12n, playlistPendingCount: async () => 12n,
    getPlaylistItem: async () => { itemReads++; return { status: 0, payer: wallet, amount: 250000n, songId: id('named-0'), batchId: 0n }; },
    getSong: async songId => ({ enabled: true, audioURI: `ipfs://${tracks.find(track => id(track.trackId) === songId).ipfsCid}` }) };
  const read = createDjukeQueueReader({ provider: { getNetwork: async () => ({ chainId: 8453 }),
    getBlockNumber: async () => 100, getBlock: async () => ({ hash: 'canonical' }) }, contract,
    contractAddress: `0x${'1'.repeat(40)}`, playlistLaneEnabled: true, getPlaylist: () => tracks,
    getPlaylistBatches: () => [batch] });
  const snapshot = await read();
  assert.equal(itemReads, 1);
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.playlistPending, 12);
  assert.equal(snapshot.playlistBatches[0].songs.length, 12);
  assert.equal(snapshot.playlistBatches[0].name, 'BoogieNight');
  assert.deepEqual(snapshot.requests[0].playlist, { batchId: '0', name: 'BoogieNight', songCount: 12, remaining: 12 });
  const journal = createDjukePlaybackJournal({ restore: async () => null, save: async () => 'ipfs://journal' });
  await journal.initialize();
  await journal.synchronize(snapshot.requests);
  assert.deepEqual((await journal.reserveNext()).playlist, snapshot.requests[0].playlist);
});

test('runtime plays paid requests first, retries short plays, and fulfills only audible completions', async () => {
  const api = await import('../discord-bot/djuke.js');
  const request = { requestId: 'r0', chainRequestId: '0', songId: id('song'), revision: '0', trackId: 'song', playable: true };
  let state = { requests: [request] };
  const fulfilled = [];
  const runtime = api.createDjukeRuntime({ readState: async () => state, journal: memoryJournal(api),
    fulfill: async args => { fulfilled.push(args); }, getTrack: trackId => ({ trackId, title: 'Song' }), log: { warn() {} } });
  const first = await runtime.nextPaid();
  assert.equal(first.track.trackId, 'song');
  assert.equal(await runtime.nextPaid(), null);
  await runtime.complete(first.record, { playId: 'short', audibleMs: 5000 });
  const retry = await runtime.nextPaid();
  assert.equal(retry.record.attempts, 2);
  await runtime.complete(retry.record, { playId: 'full', audibleMs: 180000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(fulfilled.map(entry => [entry.chainRequestId, entry.playId]), [['0', 'full']]);
  state = { requests: [] };
  assert.equal(await runtime.nextPaid(), null);
});

test('runtime follows payer replacements and replays when a stale fulfillment is rejected', async () => {
  const api = await import('../discord-bot/djuke.js');
  const base = { requestId: 'r0', chainRequestId: '0', playable: true };
  let state = { requests: [{ ...base, songId: id('a'), revision: '0', trackId: 'a' }] };
  let rejectStale = true;
  const runtime = api.createDjukeRuntime({ readState: async () => state, journal: memoryJournal(api),
    fulfill: async ({ revision }) => { if (rejectStale && revision === '1') { rejectStale = false; throw new Error('Paid recording changed'); } },
    getTrack: trackId => ({ trackId }), log: { warn() {} } });
  const playing = await runtime.nextPaid();
  state = { requests: [{ ...base, songId: id('b'), revision: '1', trackId: 'b' }] };
  const replaced = await runtime.nextPaid();
  assert.equal(replaced.track.trackId, 'b');
  await assert.rejects(runtime.complete(playing.record, { playId: 'stale', audibleMs: 180000 }), /not playing that recording/);
  await runtime.complete(replaced.record, { playId: 'new', audibleMs: 180000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await runtime.nextPaid()).track.trackId, 'b');
});

test('runtime does not wait for the optional DeVert boost hook before returning a paid request', async () => {
  const api = await import('../discord-bot/djuke.js');
  let releaseBoost;
  let boostStarted = false;
  const request = { requestId: 'r0', chainRequestId: '0', songId: id('song'), revision: '0', trackId: 'song', playable: true };
  const runtime = api.createDjukeRuntime({ readState: async () => ({ requests: [request] }), journal: memoryJournal(api),
    onVerifiedRequests: async () => { boostStarted = true; await new Promise(resolve => { releaseBoost = resolve; }); },
    fulfill: async () => {}, getTrack: trackId => ({ trackId }), log: { warn() {} } });
  const paid = await runtime.nextPaid();
  assert.equal(paid.track.trackId, 'song');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(boostStarted, true);
  releaseBoost();
});

test('runtime gives radio a timely answer when the queue is slow or unplayable', async () => {
  const api = await import('../discord-bot/djuke.js');
  const slow = api.createDjukeRuntime({ readState: () => new Promise(() => {}), journal: memoryJournal(api),
    fulfill: async () => {}, getTrack: () => null, timeoutMs: 20 });
  await assert.rejects(slow.nextPaid(), /timed out/);
  const unplayable = api.createDjukeRuntime({ journal: memoryJournal(api), fulfill: async () => {}, getTrack: () => null,
    readState: async () => ({ requests: [{ requestId: 'r', chainRequestId: '0', songId: id('x'), revision: '0', trackId: 'x', playable: false }] }) });
  await assert.rejects(unplayable.nextPaid(), /not playable/);
});

test('runtime does not skip a paid request while a timed-out claim finishes', async () => {
  const api = await import('../discord-bot/djuke.js');
  const requests = ['a', 'b'].map((trackId, index) => ({
    requestId: `r${index}`, chainRequestId: String(index), songId: id(trackId),
    revision: '0', trackId, playable: true,
  }));
  let releaseFirstRead;
  let reads = 0;
  const runtime = api.createDjukeRuntime({
    readState: async () => {
      reads++;
      if (reads === 1) await new Promise(resolve => { releaseFirstRead = resolve; });
      return { requests };
    },
    journal: memoryJournal(api),
    fulfill: async () => {},
    getTrack: trackId => ({ trackId }),
    timeoutMs: 20,
    log: { warn() {} },
  });

  await assert.rejects(runtime.nextPaid(), /timed out/);
  let secondSettled = false;
  const second = runtime.nextPaid().then(result => {
    secondSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(secondSettled, false);

  releaseFirstRead();
  assert.equal((await second).track.trackId, 'a');
});

test('runtime can reserve the next paid request while the current paid track is playing', async () => {
  const api = await import('../discord-bot/djuke.js');
  const requests = ['a', 'b'].map((trackId, index) => ({
    requestId: `r${index}`, chainRequestId: String(index), songId: id(trackId),
    revision: '0', trackId, playable: true,
  }));
  const runtime = api.createDjukeRuntime({ readState: async () => ({ requests }), journal: memoryJournal(api),
    fulfill: async () => {}, getTrack: trackId => ({ trackId }), log: { warn() {} } });
  assert.equal((await runtime.nextPaid()).track.trackId, 'a');
  assert.equal((await runtime.nextPaid()).track.trackId, 'b');
  assert.equal(await runtime.nextPaid(), null);
});

test('durable playback journal retains failed requests and completed plays through restarts', async () => {
  const { createDjukePlaybackJournal } = await import('../discord-bot/djuke.js');
  let snapshot = null;
  let failSave = false;
  const storage = { restore: async () => snapshot, save: async value => {
    if (failSave) throw new Error('IPFS unavailable');
    snapshot = structuredClone(value);
    return 'ipfs://checkpoint';
  } };
  let journal = createDjukePlaybackJournal(storage);
  assert.throws(() => journal.getState(), /not restored/);
  await journal.initialize();
  const requests = [0, 1].map(index => ({ requestId: `request-${index}`, trackId: `track-${index}` }));
  await journal.synchronize(requests);
  failSave = true;
  await assert.rejects(journal.acquire(), /IPFS unavailable/);
  assert.equal(journal.getState()[0].state, 'pending');
  failSave = false;
  assert.equal((await journal.acquire()).requestId, 'request-0');
  assert.equal(await journal.acquire(), null);
  await journal.fail('request-0', 'Audio unavailable');
  assert.equal((await journal.acquire()).attempts, 2);
  journal = createDjukePlaybackJournal(storage);
  await journal.initialize();
  assert.equal((await journal.acquire()).requestId, 'request-0');
  await assert.rejects(journal.complete('request-0', { playId: 'play', audibleMs: 1, finished: false }), /Completed audible/);
  await journal.complete('request-0', { playId: 'play-0', audibleMs: 200000, finished: true });
  journal = createDjukePlaybackJournal(storage);
  await journal.initialize();
  assert.equal(journal.getState()[0].state, 'played');
  assert.equal(await journal.acquire(), null);
  await journal.confirmFulfilled('request-0');
  assert.equal((await journal.acquire()).requestId, 'request-1');
  await assert.rejects(journal.complete('request-1', { playId: 'play-0', audibleMs: 200000, finished: true }), /already used/);
  await journal.synchronize([]);
  assert.equal(journal.getState().length, 2);
});