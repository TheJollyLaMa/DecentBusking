const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const songId = `0x${'a'.repeat(64)}`;
async function load() {
  const source = fs.readFileSync(path.join(__dirname, '../js/listens.mjs'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '')
    .replace(/^if \(typeof document[^\n]*$/m, '');
  const context = vm.createContext({ crypto, setInterval, clearInterval, setTimeout, Promise, BigInt, JSON, AbortSignal });
  vm.runInContext(`${source}\nglobalThis.api = { createListenController, createListenPlaylist, purchaseListens, audioCid, formatUsdc };`, context);
  return context.api;
}

test('listen gate plays free while payments are off and previews 30 seconds once live', async () => {
  const api = await load();
  const media = { currentTime: 0, paused: false, pause() { this.paused = true; }, play: async function () { this.paused = false; } };
  let session = null;
  let live = null;
  const played = [];
  const gates = [];
  const controller = api.createListenController({ getLive: async () => live,
    play: song => { session = song.sessionId; played.push(song.title); },
    freePlay: song => played.push(`free:${song.title}`), getSession: () => session, getMedia: () => media,
    onPreviewEnded: gate => gates.push(gate), pollMs: 5 });
  const song = { title: 'Song', audioUrl: 'ipfs://bafyaudio' };
  assert.equal(await controller.playSong(song), 'free');
  live = { songIdForCid: cid => (cid === 'bafyaudio' ? songId : '') };
  assert.equal(await controller.playSong(song), 'preview');
  media.currentTime = 29;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gates.length, 0);
  media.currentTime = 30;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gates.length, 1);
  assert.equal(media.paused, true);
  assert.equal(gates[0].song.songId, songId);
  gates[0].resume();
  assert.equal(media.paused, false);
  assert.equal(await controller.playSong({ title: 'Unregistered', audioUrl: 'ipfs://other' }), 'free');
  assert.deepEqual(played, ['free:Song', 'Song', 'free:Unregistered']);
});

test('switching songs during a preview cancels the old gate', async () => {
  const api = await load();
  const media = { currentTime: 0, pause() {}, play: async () => {} };
  let session = null;
  const gates = [];
  const controller = api.createListenController({ getLive: async () => ({ songIdForCid: () => songId }),
    play: song => { session = song.sessionId; }, freePlay: () => {}, getSession: () => session,
    getMedia: () => media, onPreviewEnded: gate => gates.push(gate), pollMs: 5 });
  await controller.playSong({ title: 'First', audioUrl: 'ipfs://a' });
  session = 'radio-took-over';
  media.currentTime = 45;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(gates.length, 0);
});

test('purchased playlists play straight through without preview gates', async () => {
  const api = await load();
  const plays = [];
  const controller = api.createListenController({ getLive: async () => null, freePlay: () => {},
    play: song => plays.push(song), getSession: () => null, getMedia: () => null, onPreviewEnded: () => { throw new Error('No gate'); } });
  controller.playPurchased([{ title: 'One' }, { title: 'Two' }]);
  assert.equal(plays.length, 1);
  assert.equal(plays[0].onEnded(), true);
  assert.deepEqual(plays.map(song => song.title), ['One', 'Two']);
  assert.equal(plays[1].onEnded(), false);
});

test('playlist storage dedupes, caps size and survives broken storage', async () => {
  const api = await load();
  const values = new Map();
  const playlist = api.createListenPlaylist({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) });
  assert.equal(playlist.add({ songId, title: 'Song', audioUrl: 'ipfs://a' }), true);
  assert.equal(playlist.add({ songId, title: 'Song', audioUrl: 'ipfs://a' }), false);
  for (let index = 1; index < 50; index++) playlist.add({ songId: `0x${index.toString(16).padStart(64, '0')}`, title: `${index}`, audioUrl: 'ipfs://a' });
  assert.throws(() => playlist.add({ songId: `0x${'f'.repeat(64)}`, title: 'Too many', audioUrl: 'ipfs://a' }), /up to 50/);
  playlist.remove(songId);
  assert.equal(playlist.list().length, 49);
  const broken = api.createListenPlaylist({ getItem: () => '{bad', setItem: () => { throw new Error('quota'); } });
  assert.deepEqual([...broken.list()], []);
});

function purchaseFixture({ chainId = 8453n, balance = 10_000_000n, allowance = 0n } = {}) {
  const calls = [];
  const confirmed = hash => ({ hash, wait: async () => ({ status: 1 }) });
  const purchaseListens = async (ids, total) => { calls.push(['purchase', ids.length, total]); return confirmed('0xlisten'); };
  purchaseListens.staticCall = async () => {};
  return { calls, signer: { provider: { getNetwork: async () => ({ chainId }) }, getAddress: async () => `0x${'1'.repeat(40)}` },
    djuke: { target: `0x${'d'.repeat(40)}`, purchaseListens },
    usdc: { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: async () => 6n, balanceOf: async () => balance,
      allowance: async () => allowance, approve: async (_spender, amount) => { calls.push(['approve', amount]); return confirmed('0xapprove'); } } };
}

test('listen purchases approve exactly 0.25 USDC per song and refuse unsafe states before prompting', async () => {
  const api = await load();
  const fixture = purchaseFixture();
  const result = await api.purchaseListens({ ...fixture, songIds: [songId, songId, songId] });
  assert.equal(result.totalUnits, 750000n);
  assert.deepEqual(fixture.calls, [['approve', 750000n], ['purchase', 3, 750000n]]);
  for (const [options, ids, message] of [[{ chainId: 1n }, [songId], /Base/], [{ balance: 1n }, [songId], /need 0.25 USDC/],
    [{}, [], /1 to 50/], [{}, Array(51).fill(songId), /1 to 50/], [{}, ['0xbad'], /1 to 50/]]) {
    const unsafe = purchaseFixture(options);
    await assert.rejects(api.purchaseListens({ ...unsafe, songIds: ids }), message);
    assert.deepEqual(unsafe.calls, []);
  }
  assert.equal(api.audioCid('ipfs://bafyx'), 'bafyx');
  assert.equal(api.audioCid('https://gateway.pinata.cloud/ipfs/bafyy?x=1'), 'bafyy');
  assert.equal(api.formatUsdc(750000n), '0.75');
});
