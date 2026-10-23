import { Transaction, getAddress, keccak256 } from 'ethers';

export const WORKER_RESERVE_POLICY = Object.freeze({
  thresholdWei: 1_000_000_000_000_000n,
  targetWei: 3_000_000_000_000_000n,
  maxRefillWei: 2_000_000_000_000_000n,
  dailyCapWei: 6_000_000_000_000_000n,
});

export function createWorkerReserve({ provider, signer, workerAddress, restore, save, enabled = false,
  policy = WORKER_RESERVE_POLICY, maxNetworkFeeWei = 20_000_000_000_000n, now = () => Date.now() }) {
  const worker = getAddress(workerAddress);
  if (/^0x0{40}$/i.test(worker) || typeof maxNetworkFeeWei !== 'bigint' || maxNetworkFeeWei <= 0n) throw new Error('Invalid worker or network fee cap');
  if (typeof restore !== 'function' || typeof save !== 'function') throw new Error('Durable reserve journal required');
  if (Object.values(policy).some(value => typeof value !== 'bigint' || value <= 0n) ||
      policy.thresholdWei >= policy.targetWei || policy.maxRefillWei > policy.dailyCapWei) throw new Error('Invalid reserve caps');
  let state;
  let queue = Promise.resolve();
  const run = operation => {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  };
  const commit = async next => {
    const uri = await save(next);
    if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Reserve journal did not confirm');
    state = next;
  };
  const verifyEntry = (entry, reserveAddress) => {
    const transaction = Transaction.from(entry.rawTransaction);
    const gasPrice = transaction.maxFeePerGas ?? transaction.gasPrice;
    if (transaction.chainId !== 8453n || transaction.to !== worker || transaction.data !== '0x' ||
        transaction.value !== BigInt(entry.valueWei) || transaction.value <= 0n || transaction.value > policy.maxRefillWei ||
        gasPrice == null || transaction.gasLimit <= 0n || transaction.gasLimit * gasPrice > maxNetworkFeeWei ||
        transaction.from?.toLowerCase() !== reserveAddress.toLowerCase() ||
        transaction.hash !== entry.hash || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) ||
        !['pending', 'confirmed', 'failed'].includes(entry.status)) throw new Error('Invalid reserve journal transfer');
  };
  return {
    check: () => run(async () => {
      if (Number((await provider.getNetwork()).chainId) !== 8453) throw new Error('Reserve funding is Base-only');
      const balance = await provider.getBalance(worker);
      if (!enabled) return { enabled: false, worker, balanceWei: balance.toString(),
        low: balance < policy.thresholdWei, reason: 'Reserve funding awaits explicit treasury approval' };
      if (!signer) throw new Error('Approved reserve signer is not configured');
      const reserveAddress = getAddress(await signer.getAddress());
      if (reserveAddress === worker) throw new Error('Worker cannot be its own reserve');
      if (!state) {
        const restored = await restore() || { schemaVersion: 1, reserveAddress, worker, refills: [] };
        if (restored.schemaVersion !== 1 || restored.reserveAddress !== reserveAddress || restored.worker !== worker ||
            !Array.isArray(restored.refills) || restored.refills.filter(entry => entry.status === 'pending').length > 1) {
          throw new Error('Invalid reserve journal');
        }
        restored.refills.forEach(entry => verifyEntry(entry, reserveAddress));
        const totals = new Map();
        for (const entry of restored.refills) totals.set(entry.day, (totals.get(entry.day) || 0n) + BigInt(entry.valueWei));
        if ([...totals.values()].some(total => total > policy.dailyCapWei)) throw new Error('Reserve journal exceeds daily cap');
        state = restored;
      }
      const pending = state.refills.find(entry => entry.status === 'pending');
      if (pending) {
        const receipt = await provider.getTransactionReceipt(pending.hash);
        if (receipt) {
          await commit({ ...state, refills: state.refills.map(entry => entry.hash === pending.hash
            ? { ...entry, status: receipt.status === 1 ? 'confirmed' : 'failed' } : entry) });
          if (receipt.status !== 1) throw new Error(`Reserve refill reverted: ${pending.hash}`);
          return { enabled: true, confirmed: pending.hash };
        }
        if (await provider.getTransaction(pending.hash)) return { enabled: true, pending: pending.hash };
        const sent = await provider.broadcastTransaction(pending.rawTransaction);
        if (sent.hash !== pending.hash) throw new Error('Reserve broadcast hash mismatch');
        return { enabled: true, pending: pending.hash };
      }
      if (balance >= policy.thresholdWei) return { enabled: true, low: false, balanceWei: balance.toString() };
      const day = new Date(now()).toISOString().slice(0, 10);
      const used = state.refills.filter(entry => entry.day === day).reduce((sum, entry) => sum + BigInt(entry.valueWei), 0n);
      const remaining = policy.dailyCapWei - used;
      if (remaining <= 0n) throw new Error('Worker refill daily cap reached');
      const value = [policy.targetWei - balance, policy.maxRefillWei, remaining].reduce((a, b) => a < b ? a : b);
      const transaction = await signer.populateTransaction({ to: worker, value, chainId: 8453 });
      const gasPrice = transaction.maxFeePerGas ?? transaction.gasPrice;
      if (gasPrice == null || transaction.gasLimit == null) throw new Error('Reserve gas budget unavailable');
      if (BigInt(transaction.gasLimit) * BigInt(gasPrice) > maxNetworkFeeWei) throw new Error('Reserve network fee exceeds cap');
      if (await provider.getBalance(reserveAddress) < value + BigInt(transaction.gasLimit) * BigInt(gasPrice)) {
        throw new Error('Approved ETH reserve cannot cover refill and network gas');
      }
      const rawTransaction = await signer.signTransaction(transaction);
      const entry = { rawTransaction, hash: keccak256(rawTransaction), valueWei: value.toString(), day, status: 'pending' };
      verifyEntry(entry, reserveAddress);
      await commit({ ...state, refills: [...state.refills, entry] });
      const sent = await provider.broadcastTransaction(rawTransaction);
      if (sent.hash !== entry.hash) throw new Error('Reserve broadcast hash mismatch');
      return { enabled: true, pending: entry.hash };
    }),
  };
}
