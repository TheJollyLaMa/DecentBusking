import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { parseReleaseSheet, releaseAuthorization } from '../js/release-batch.mjs';
import { planRelease, prepareMediaRelease } from '../discord-bot/release-batch.js';
import { discordReleaseRows } from '../discord-bot/release-discord.js';
import { nftCatalogPage } from '../js/nft-loader.js';
import { isEligibleRadioMusic } from '../js/radio-playlists.mjs';

const { Wallet } = createRequire(new URL('../discord-bot/package.json', import.meta.url))('ethers');
const a = 'bafkreibai6bgxexu2f5cvj7nejzr2aznro2qepqutjf6ghyywlik3b7li4', b = 'bafkreiflbz536bwgk35ejwi6pcn6c6eaoq3hdskmzlvkdhxpjpfo5mc2nu';
const rows = parseReleaseSheet(`A | First | m4a | ${a}\nA | Second | mp3 | ${b}\nB | First | m4a | ipfs://${a}`);
const actor = { source: 'discord', wallet: `0x${'1'.repeat(40)}`, uploader: 'artist', uploaderId: '42' };

test('cross-album references, ordering and retries survive a checkpoint and never change prior credits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'release-batch-'));
  try {
    process.env.JUKELOOP_PLAYLIST_PATH = join(dir, 'local.json');
    const store = await import('../discord-bot/playlist-store.js');
    store.loadPlaylist([]);
    let saved, writes = 0;
    store.configureRemotePersistence(async snapshot => { saved = snapshot; writes++; });
    const tracks = prepareMediaRelease(rows);
    await store.submitReleaseBatch(tracks, actor);
    assert.equal(writes, 1);
    assert.deepEqual(saved[0].releaseAlbums, [{ album: 'A', position: 1 }, { album: 'B', position: 1 }]);
    assert.equal(saved[1].releaseAlbums[0].position, 2);
    assert.ok(saved.every(t => isEligibleRadioMusic(t) && t.mintStatus === 'requested'));
    const original = structuredClone(saved);
    store.loadPlaylist(JSON.parse(await readFile(process.env.JUKELOOP_PLAYLIST_PATH)));
    const retry = await store.submitReleaseBatch(tracks, actor);
    assert.ok(retry.every(r => r.already)); assert.deepEqual(saved, original);
    await assert.rejects(store.submitReleaseBatch(tracks, { ...actor, wallet: `0x${'2'.repeat(40)}` }), /another submission/);
    assert.deepEqual(saved, original);
    assert.throws(() => prepareMediaRelease([...rows, { ...rows[0], title: 'Other' }]), /conflicting/);
    assert.throws(() => planRelease(saved, prepareMediaRelease([rows[1], rows[0]]), actor), /order/);
  } finally { delete process.env.JUKELOOP_PLAYLIST_PATH; await rm(dir, { recursive: true }); }
});

test('signed web batch binds group and order; receipt comes only after intake and site recordings remain private', async () => {
  const { createWorkerRequestHandler } = await import('../discord-bot/ipfs-worker.js');
  const wallet = Wallet.createRandom(), origin = 'https://briefcase.example';
  let accepted = 0;
  const handler = createWorkerRequestHandler({ allowedOrigins: [origin], ownerWallet: wallet.address,
    onReleaseBatch(tracks, actor) {
      accepted++;
      const plan = planRelease([], tracks, actor);
      assert.ok(plan.updates.every(({ track }) => track.source === 'site' && !isEligibleRadioMusic(track) && track.mintRecipient === wallet.address));
      return plan.results;
    } });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = { address: wallet.address, origin, artist: 'Artist', rows, issuedAt: new Date().toISOString() };
    body.signature = await wallet.signMessage(releaseAuthorization(body));
    const post = data => fetch(`http://127.0.0.1:${server.address().port}/api/media/submit-batch`,
      { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await post({ ...body, rows: [...rows].reverse() })).status, 400);
    const good = await post(body);
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).results.map(r => [r.cid, r.status]), [[a, 'requested'], [b, 'requested']]);
    assert.equal((await post(body)).status, 400); assert.equal(accepted, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('multi-attachment Discord posts must belong to the artist and be completely pinned before queuing', async () => {
  const post = '123456789012345678', files = [{ id: '1', name: 'first.m4a' }, { id: '2', name: 'second.mp3' }];
  const message = { author: { id: '42' }, channelId: 'room', attachments: new Map(files.map(f => [f.id, f])) };
  const interaction = { user: { id: '42' }, channelId: 'room', channel: { messages: { fetch: async () => message } },
    options: { getAttachment: () => null, getString: k => ({ post, album: 'A' })[k] } };
  const playlist = files.map((f, i) => ({ attachmentId: f.id, uploaderId: '42', title: f.name, ipfsCid: [a, b][i], pinStatus: 'pinned' }));
  const deps = { playlist, isAudioAttachment: () => true };
  assert.deepEqual(prepareMediaRelease(await discordReleaseRows(interaction, deps)).map(t => t.cid), [a, b]);
  playlist[1].pinStatus = 'pending';
  await assert.rejects(discordReleaseRows(interaction, deps), /wait for its IPFS pin/);
  message.author.id = 'other';
  await assert.rejects(discordReleaseRows(interaction, deps), /your own/);
});

test('public music catalog searches album memberships and separates same-titled albums by artist', () => {
  const base = { audioUrl: `ipfs://${a}`, contractAddress: actor.wallet, name: 'Song', chainId: 8453,
    releaseAlbums: [{ album: 'Studio Sessions', position: 1 }] };
  const nfts = [1, 2].map((n, i) => ({ ...base, tokenId: i, artist: `0x${String(n).repeat(40)}` }));
  const result = nftCatalogPage(nfts, { query: 'studio', limit: 1 });
  assert.equal(result.total, 2); assert.equal(result.nfts.length, 1); assert.equal(result.albums.length, 2);
  assert.deepEqual(nftCatalogPage(nfts, { wallet: actor.wallet }).albums, [{ album: 'Studio Sessions', wallet: actor.wallet }]);
});
