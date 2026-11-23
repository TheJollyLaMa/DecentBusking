import { id, ZeroHash } from 'ethers';

export function validDmtvEvidence(snapshot) {
  return snapshot?.dmtvEscrowEvidence === 1 && Array.isArray(snapshot.entries) &&
    snapshot.entries.every(entry => entry && (entry.lane === 0 || entry.lane === 1) &&
      /^\d{1,78}$/.test(entry.requestId) && /^0x[0-9a-f]{64}$/i.test(entry.proof));
}

export function createDmtvEscrowRuntime({ reader, writer, provider, store, resolveTrack, onSettled }) {
  let evidence;
  let serial = Promise.resolve();
  const held = new Map();
  const pendingWrite = new Map();
  const run = fn => {
    const pending = serial.then(fn);
    serial = pending.catch(() => {});
    return pending;
  };
  async function restore() {
    if (evidence) return;
    const snapshot = await store.restore();
    if (snapshot != null && !validDmtvEvidence(snapshot)) throw new Error('Invalid DMTv settlement checkpoint.');
    evidence = snapshot?.entries || [];
  }
  async function persist(entries) {
    if (!await store.save({ dmtvEscrowEvidence: 1, entries })) throw new Error('Could not save DMTv playback evidence.');
    evidence = entries;
  }
  async function settle(entry) {
    const { lane, requestId, proof } = entry;
    const request = await reader.requests(lane, requestId);
    const refund = proof === ZeroHash;
    if (Number(request.status) === 1 && (refund || Number(request.refundAt) > (await provider.getBlock('latest')).timestamp)) {
      const tx = await (refund ? writer.cancelAndRefund(lane, requestId) : writer.fulfill(lane, requestId, proof));
      if ((await tx.wait(2))?.status !== 1) throw new Error(`DMTv ${refund ? 'refund' : 'settlement'} not confirmed for ${requestId}.`);
      if (!refund) onSettled?.({ lane, requestId, txHash: tx.hash, creator: request.creator });
    }
    await persist(evidence.filter(item => item !== entry));
  }
  function forLane(lane) {
    async function flushOutcome() {
      const entry = pendingWrite.get(lane);
      if (entry) {
        await persist([...evidence, entry]);
        pendingWrite.delete(lane);
      }
      const prior = evidence.find(item => item.lane === lane);
      if (prior) await settle(prior);
    }

    async function recordCompletion(record, playId) {
      // Zero is forbidden as a fulfillment proof and journals a refund instead.
      pendingWrite.set(lane, { lane, requestId: record.requestId,
        proof: playId ? id(`dmtv:${lane}:${record.requestId}:${playId}`) : ZeroHash });
      await flushOutcome();
    }
    return {
      nextPaid: ({ acceptNew = true } = {}) => run(async () => {
        await restore();
        await flushOutcome();
        if (!acceptNew || held.has(lane) || await reader.paused()) return null;
        const latest = await provider.getBlockNumber();
        if (latest < 2) throw new Error('DMTv requires confirmed blocks.');
        const blockTag = latest - 1;
        const block = await provider.getBlock(blockTag);
        const bounds = { blockTag };
        const [head, tail] = await Promise.all([reader.head(lane, bounds), reader.tail(lane, bounds)]);
        for (let cursor = head; cursor < tail && cursor - head < 128n; cursor++) {
          const request = await reader.requests(lane, cursor, bounds);
          if (Number(request.status) !== 1 || Number(request.refundAt) <= block.timestamp) continue;
          const track = await resolveTrack(request.videoId, lane);
          const configured = await reader.videos(request.videoId, bounds);
          if (!track || id(track.videoUrl) !== request.mediaHash ||
              track.creator.toLowerCase() !== request.creator.toLowerCase() ||
              configured.mediaHash !== request.mediaHash ||
              configured.creator.toLowerCase() !== request.creator.toLowerCase() ||
              !(Number(configured.lanes) & (1 << lane))) {
            await recordCompletion({ requestId: String(cursor) }, null);
            return null;
          }
          const record = { kind: 'dmtv', requestId: String(cursor), lane, trackId: track.trackId };
          held.set(lane, record);
          return { record, track };
        }
        return null;
      }),
      complete: (record, play) => run(async () => {
        if (held.get(lane) !== record) return;
        held.delete(lane);
        if (!play?.finished || play.trackId !== record.trackId || !play.playId ||
            !(play.expectedMs > 0) || !(play.audibleMs >= play.expectedMs * 0.95)) {
          await recordCompletion(record, null);
          return;
        }
        await recordCompletion(record, play.playId);
      }),
      completePublished: (record, playId) => run(async () => {
        if (lane !== 0 || held.get(lane) !== record || !playId) throw new Error('Invalid DMTv station completion.');
        held.delete(lane);
        await recordCompletion(record, playId);
      }),
      completeVerifiedRadio: (record, playId) => run(async () => {
        if (lane !== 1 || held.get(lane) !== record || !playId) throw new Error('Invalid DMTv radio verification.');
        held.delete(lane);
        await recordCompletion(record, playId);
      }),
      release: record => run(() => { if (held.get(lane) === record) held.delete(lane); }),
      fail: record => run(async () => {
        if (held.get(lane) !== record) return;
        held.delete(lane);
        await recordCompletion(record, null);
      }),
      hasPendingSelection: () => held.has(lane),
    };
  }
  return { forLane, checkStorage: () => run(restore) };
}
