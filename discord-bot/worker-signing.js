import { Wallet } from 'ethers';

// One signing lane per account prevents reward sends racing DJuke/DVert nonces.
export function createWorkerSigningCoordinator({ enabled = false, makeWallet = (key, provider) => new Wallet(key, provider) } = {}) {
  const lanes = new Map();
  const laneFor = signer => {
    const key = signer.address.toLowerCase();
    if (!lanes.has(key)) lanes.set(key, {queue:Promise.resolve(), blocked:null});
    return lanes.get(key);
  };
  const exclusive = (signer, action) => {
    const lane = laneFor(signer);
    const task = lane.queue.then(async () => {
      if (lane.blocked) throw new Error(`Worker signing paused: ${lane.blocked}`);
      return action();
    });
    lane.queue = task.then(() => undefined, () => undefined);
    return task;
  };
  const block = (signer, reason) => { laneFor(signer).blocked = reason; };
  const unblock = (signer, reason) => {
    const lane = laneFor(signer);
    if (lane.blocked === reason) lane.blocked = null;
  };
  return {
    exclusive, block, unblock,
    wallet(key, provider) {
      const signer = makeWallet(key, provider);
      if (!enabled) return signer;
      const original = signer.sendTransaction.bind(signer);
      signer.sendTransaction = transaction => exclusive(signer, async () => {
        let tx;
        try {
          const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [signer.address, 'pending'])));
          tx = await original({...transaction, nonce:transaction.nonce ?? nonce});
          await tx.wait(1);
          return tx;
        } catch (error) {
          // Known mined reverts/replacements have consumed their nonce; ambiguous sends must stop.
          const receipt = error.receipt;
          if ((!receipt || ![0, 1].includes(receipt.status)) && error.action !== 'estimateGas') {
            block(signer, tx?.hash || 'an ambiguous worker transaction; reconcile before restart');
          }
          throw error;
        }
      });
      return signer;
    },
  };
}
