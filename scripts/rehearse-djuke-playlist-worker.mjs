import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createDjukePlaylistGasQuoteReader } from '../discord-bot/djuke-gas.js';
import { createDjukePlaybackJournal, createDjukeQueueReader, createDjukeRuntime, createDjukeFulfiller, verifyDjukePlaylistWorker } from '../discord-bot/djuke.js';
import { createDjukePlaylistBatchReconciler } from '../discord-bot/djuke-playlist-batches.js';
import { createWorkerRequestHandler } from '../discord-bot/ipfs-worker.js';

// Called only by the contract repository's in-process Base-fork rehearsal.
export async function rehearsePlaylistWorker({ provider, jukebox, worker, listener, token, router, fundIds, songs,
  oracle, sponsored = false, quoteProvider = provider, readFundBalance = id => router.fundBalances(id, token.target) }) {
  assert.equal(Number((await provider.getNetwork()).chainId), 8453);
  const mine = () => provider.send('hardhat_mine', ['0x2']);
  const listenerAddress = await listener.getAddress();
  const workerContract = jukebox.connect(worker);
  await verifyDjukePlaylistWorker({ provider, contract: workerContract, workerAddress: await worker.getAddress(),
    version: sponsored ? '0.5' : '0.4' });
  const ids = songs.slice(0, 12).map(song => song.songId);
  assert.equal(ids.length, 12);
  const tracks = songs.map(song => ({ trackId: song.trackId, ipfsCid: song.audioURI.slice(7),
    mintRecipient: song.recipients[0], title: song.trackId, uploader: 'Fork rehearsal' }));
  const journalStore = () => {
    let checkpoint;
    return { restore: async () => structuredClone(checkpoint),
      save: async value => { checkpoint = structuredClone(value); return 'ipfs://fork-only-checkpoint'; } };
  };
  const startBlock = await provider.getBlockNumber();
  const batchesStore = journalStore();
  let batches = createDjukePlaylistBatchReconciler({ provider, contract: jukebox, startBlock, ...batchesStore });
  await batches.initialize();
  const playbackStore = journalStore();
  const readState = createDjukeQueueReader({ provider, contract: jukebox, contractAddress: jukebox.target,
    getPlaylist: () => tracks, playlistLaneEnabled: true, paymentsEnabled: true });
  const createRuntime = () => createDjukeRuntime({ readState, journal: createDjukePlaybackJournal(playbackStore),
    fulfill: createDjukeFulfiller(workerContract), getTrack: id => tracks.find(track => track.trackId === id),
    refundPlaylistBatch: async batchId => {
      assert.equal((await (await workerContract.refundUndeliveredPlaylist(batchId)).wait()).status, 1);
    } });
  let runtime = createRuntime();
  const getQuote = createDjukePlaylistGasQuoteReader({ provider: quoteProvider, contract: jukebox, signer: worker, oracle, sponsored,
    now: () => clock * 1000 });
  let clock = (await provider.getBlock('latest')).timestamp;
  const handler = createWorkerRequestHandler({ allowedOrigins: [], ownerWallet: await worker.getAddress(),
    getDjukePlaylistGasQuote: getQuote });
  async function quote(songIds) {
    clock = (await provider.getBlock('latest')).timestamp;
    const request = Readable.from([]);
    request.method = 'GET';
    request.url = '/api/djuke/playlist-gas-quote?' + new URLSearchParams([
      ['listener', listenerAddress], ...songIds.map(song => ['songId', song]),
    ]);
    request.headers = {};
    const response = { writeHead(status) { this.status = status; },
      end(bytes) { this.body = JSON.parse(bytes); } };
    await handler(request, response);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
  async function purchase(songIds) {
    const q = await quote(songIds);
    const receipt = await (await jukebox.connect(listener).requestPlaylistWithGas(songIds,
      q.maxTotal, q.fulfillmentCostWei, q.deadline, q.signature, { value: q.contributionWei })).wait();
    const event = receipt.logs.map(log => {
      try { return jukebox.interface.parseLog(log); } catch { return null; }
    }).find(event => event?.name === 'PlaylistBatchRequested');
    assert.ok(event);
    await mine();
    await batches.reconcile();
    return { quote: q, batchId: event.args.batchId.toString(), firstLaneId: event.args.firstLaneId.toString() };
  }
  const before = await Promise.all(fundIds.map(readFundBalance));
  const artistBefore = new Map();
  const artistExpected = new Map();
  for (let i = 0; i < ids.length; i++) {
    const song = songs[i];
    const payout = (250000n << BigInt(Math.floor(i / 8))) * 90n / 100n;
    let allocated = 0n;
    for (let j = 0; j < song.recipients.length; j++) {
      const recipient = song.recipients[j];
      const amount = j + 1 === song.recipients.length ? payout - allocated : payout * BigInt(song.sharesBps[j]) / 10000n;
      allocated += amount;
      artistExpected.set(recipient, (artistExpected.get(recipient) || 0n) + amount);
      if (!artistBefore.has(recipient)) artistBefore.set(recipient, await token.balanceOf(recipient));
    }
  }
  const purchaseResult = await purchase(ids);
  assert.equal(purchaseResult.quote.subtotalUnits, '4000000');
  assert.equal(purchaseResult.quote.feeUnits, '3000000');
  assert.equal(purchaseResult.quote.maxTotal, '7000000');
  assert.equal(BigInt(purchaseResult.quote.contributionWei), BigInt(purchaseResult.quote.fulfillmentCostWei) * 24n);
  if (sponsored) {
    assert.equal(purchaseResult.quote.fulfillmentCostWei, '0');
    assert.equal(purchaseResult.quote.contributionWei, '0');
  }
  const first = await runtime.nextPaid();
  assert.ok(first, 'worker must acquire the confirmed first playlist song');
  assert.equal(first.record.playlistLaneId, purchaseResult.firstLaneId);
  assert.equal(first.record.songId, ids[0]);
  // A restart before completion must not settle an unheard song.
  runtime = createRuntime();
  const resumed = await runtime.nextPaid();
  assert.equal(resumed.record.requestId, first.record.requestId);
  assert.equal(Number((await jukebox.getPlaylistItem(first.record.playlistLaneId)).status), 0);
  for (let i = 0; i < ids.length; i++) {
    const selection = i === 0 ? resumed : await runtime.nextPaid();
    assert.ok(selection, `playlist song ${i + 1} must be playable`);
    assert.equal(selection.record.songId, ids[i]);
    await runtime.complete(selection.record, { playId: `fork-worker-playlist-${i}`, audibleMs: 180000 });
    await runtime.reconcile();
    await mine();
    if (sponsored) {
      const funds = await Promise.all(fundIds.slice(0, 2).map(readFundBalance));
      assert.deepEqual(funds.map((value, index) => value - before[index]),
        [BigInt(Math.floor((i + 1) / 4)) * 250000n, BigInt(Math.floor((i + 1) / 4)) * 250000n]);
      if (i < 11) {
        await batches.reconcile();
        assert.equal(batches.getState().find(b => b.batchId === purchaseResult.batchId).status, 'pending');
      }
    }
  }
  await batches.reconcile();
  assert.equal(batches.getState().find(b => b.batchId === purchaseResult.batchId).status, 'settled');
  for (const [recipient, expected] of artistExpected) {
    assert.equal(await token.balanceOf(recipient) - artistBefore.get(recipient), expected, 'direct creator settlement');
  }
  const after = await Promise.all(fundIds.map(readFundBalance));
  assert.deepEqual(after.map((value, i) => value - before[i]), [750000n, 750000n, 1070000n, 830000n]);

  // Main paid requests cut in before an acquired lane song can settle.
  const cutIn = await purchase(ids.slice(0, 2));
  const laneSong = await runtime.nextPaid();
  assert.ok(laneSong);
  const price = await jukebox.quote();
  const cost = sponsored ? 0n : 1000000n;
  const deadline = (await provider.getBlock('latest')).timestamp + 180;
  const singleQuote = { listener: listenerAddress, songId: ids[2], maxPrice: price, fulfillmentCostWei: cost,
    nonce: await jukebox.gasQuoteNonces(listenerAddress), deadline };
  const signature = await worker.signTypedData({ name: 'DecentJukeBox', version: '0.2', chainId: 8453,
    verifyingContract: jukebox.target }, { GasQuote: [
    { name: 'listener', type: 'address' }, { name: 'songId', type: 'bytes32' }, { name: 'maxPrice', type: 'uint256' },
    { name: 'fulfillmentCostWei', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ] }, singleQuote);
  await (await jukebox.connect(listener).requestPlayWithGas(ids[2], price, cost, deadline, signature, { value: cost * 2n })).wait();
  await mine();
  await runtime.complete(laneSong.record, { playId: 'fork-worker-cut-in-lane', audibleMs: 180000 });
  await runtime.reconcile();
  assert.equal(Number((await jukebox.getPlaylistItem(laneSong.record.playlistLaneId)).status), 0);
  runtime = createRuntime();
  const main = await runtime.nextPaid();
  assert.ok(main);
  assert.equal(main.record.playlistLaneId, undefined);
  await runtime.complete(main.record, { playId: 'fork-worker-cut-in-main', audibleMs: 180000 });
  await runtime.reconcile();
  await mine();
  await runtime.reconcile();
  await mine();
  assert.equal(Number((await jukebox.getPlaylistItem(laneSong.record.playlistLaneId)).status), 1);
  const remaining = await runtime.nextPaid();
  assert.ok(remaining);
  await runtime.complete(remaining.record, { playId: 'fork-worker-cut-in-last', audibleMs: 180000 });
  await runtime.reconcile();
  await mine();
  await batches.reconcile();
  assert.equal(batches.getState().find(b => b.batchId === cutIn.batchId).status, 'settled');

  const refund = await purchase(ids.slice(0, 2));
  const payerBefore = await token.balanceOf(listenerAddress);
  await (await workerContract.refundUndeliveredPlaylist(refund.batchId)).wait();
  await mine();
  batches = createDjukePlaylistBatchReconciler({ provider, contract: jukebox, startBlock, ...batchesStore });
  await batches.initialize();
  await batches.reconcile();
  assert.equal(batches.getState().find(b => b.batchId === refund.batchId).status, 'refunded');
  assert.equal(await token.balanceOf(listenerAddress) - payerBefore, 3500000n);
  assert.equal((await readState()).requests.length, 0);
  const suffix = await purchase(ids.slice(0, 2));
  const prefix = await runtime.nextPaid();
  assert.ok(prefix);
  const prefixPayerBefore = await token.balanceOf(listenerAddress);
  const prefixArtistBefore = await token.balanceOf(songs[0].recipients[0]);
  const prefixFundsBefore = await Promise.all(fundIds.map(readFundBalance));
  await runtime.complete(prefix.record, { playId: 'fork-worker-delivered-prefix', audibleMs: 180000 });
  await runtime.reconcile();
  await mine();
  const shortPlay = await runtime.nextPaid();
  assert.ok(shortPlay);
  await runtime.complete(shortPlay.record, { playId: 'fork-worker-too-short', audibleMs: 1000 });
  await mine();
  await batches.reconcile();
  const refunded = batches.getState().find(b => b.batchId === suffix.batchId);
  assert.equal(refunded.status, 'refunded');
  assert.deepEqual(refunded.deliveredLaneIds, [suffix.firstLaneId]);
  assert.deepEqual(refunded.refundedLaneIds, [(BigInt(suffix.firstLaneId) + 1n).toString()]);
  assert.equal(await token.balanceOf(listenerAddress) - prefixPayerBefore, 3250000n);
  assert.ok(await token.balanceOf(songs[0].recipients[0]) > prefixArtistBefore);
  const prefixFundsAfter = await Promise.all(fundIds.map(readFundBalance));
  assert.deepEqual(prefixFundsAfter.map((value, i) => value - prefixFundsBefore[i]), [0n, 0n, 20000n, 5000n]);
  assert.equal((await readState()).requests.length, 0);
  return { workerHttpGasQuote: true, sponsored, twelveSongTotalUsdc: '7.00', orderedSongsSettled: 12,
    directArtistSettlement: true, fourFundSettlement: true, restartRecovery: true, mainRequestCutIn: true,
    fullRefundUsdc: '3.50', shortPlaybackSuffixRefundUsdc: '3.25', realBaseTransactions: 0 };
}
