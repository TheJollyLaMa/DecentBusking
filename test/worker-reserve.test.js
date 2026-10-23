const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet, Transaction, keccak256 } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

test('reserve defaults to monitoring only and never restores, signs or sends without approval', async () => {
  const { createWorkerReserve } = await import('../discord-bot/worker-reserve.js');
  const workerAddress = Wallet.createRandom().address;
  const reserve = createWorkerReserve({ workerAddress,
    provider: { getNetwork: async () => ({ chainId: 8453 }), getBalance: async () => 0n },
    restore: () => { throw new Error('No write/signing journal needed in disabled mode'); }, save: () => {} });
  const status = await reserve.check();
  assert.equal(status.enabled, false);
  assert.equal(status.low, true);
});

test('refills respect transfer/daily caps and resume the exact journaled transaction after a crash', async () => {
  const { createWorkerReserve } = await import('../discord-bot/worker-reserve.js');
  const wallet = Wallet.createRandom(), workerAddress = Wallet.createRandom().address;
  let snapshot, nonce = 0, broadcasts = [], receipt = null, failBroadcast = true, writes = 0, day = 1000000;
  const signer = { getAddress: async () => wallet.address,
    populateTransaction: async tx => ({ ...tx, nonce: nonce++, gasLimit: 21000, gasPrice: 1n }),
    signTransaction: tx => wallet.signTransaction(tx) };
  const provider = { getNetwork: async () => ({ chainId: 8453 }),
    getBalance: async address => address === workerAddress ? 0n : 10n ** 18n,
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => null,
    broadcastTransaction: async raw => {
      assert.ok(snapshot.refills.some(entry => entry.hash === keccak256(raw)), 'must journal before send');
      broadcasts.push(raw);
      if (failBroadcast) throw new Error('Network disconnected');
      return { hash: keccak256(raw) };
    } };
  const options = { workerAddress, signer, provider, enabled: true, now: () => day,
    restore: async () => snapshot, save: async value => { writes++; snapshot = structuredClone(value); return 'ipfs://reserve'; } };
  let reserve = createWorkerReserve(options);
  await assert.rejects(reserve.check(), /Network disconnected/);
  assert.equal(writes, 1);
  assert.equal(Transaction.from(broadcasts[0]).value, 2_000_000_000_000_000n);
  reserve = createWorkerReserve(options);
  failBroadcast = false;
  await reserve.check();
  assert.equal(broadcasts[0], broadcasts[1], 'restart must rebroadcast, not create a duplicate refill');
  receipt = { status: 1 };
  await reserve.check();
  for (let i = 0; i < 2; i++) { receipt = null; await reserve.check(); receipt = { status: 1 }; await reserve.check(); }
  await assert.rejects(reserve.check(), /daily cap/);
  assert.equal(snapshot.refills.reduce((n, entry) => n + BigInt(entry.valueWei), 0n), 6_000_000_000_000_000n);
  day += 86400000; receipt = null;
  await reserve.check();
  assert.equal(snapshot.refills.at(-1).day, '1970-01-02');
});

test('reserve refuses persisted transactions exceeding the network fee cap on every retry', async () => {
  const { createWorkerReserve } = await import('../discord-bot/worker-reserve.js');
  const wallet = Wallet.createRandom(), workerAddress = Wallet.createRandom().address;
  const rawTransaction = await wallet.signTransaction({ to: workerAddress, value: 1n, chainId: 8453,
    gasLimit: 21000n, gasPrice: 10n ** 15n, nonce: 0 });
  const reserve = createWorkerReserve({ enabled: true, workerAddress, signer: { getAddress: async () => wallet.address },
    provider: { getNetwork: async () => ({ chainId: 8453 }), getBalance: async () => 0n,
      broadcastTransaction: async () => assert.fail('invalid restored transfer must never broadcast') },
    save: async () => assert.fail('invalid journal must not be rewritten'),
    restore: async () => ({ schemaVersion: 1, reserveAddress: wallet.address, worker: workerAddress,
      refills: [{ rawTransaction, hash: keccak256(rawTransaction), valueWei: '1', day: '2026-10-23', status: 'pending' }] }) });
  await assert.rejects(reserve.check(), /Invalid reserve journal transfer/);
  await assert.rejects(reserve.check(), /Invalid reserve journal transfer/);
});

test('reserve stops on missing funds or failed journal writes and handles known pending and reverted transactions', async () => {
  const { createWorkerReserve } = await import('../discord-bot/worker-reserve.js');
  const wallet = Wallet.createRandom(), workerAddress = Wallet.createRandom().address;
  let funded = false, writable = false, snapshot, broadcasts = 0, receipt = null;
  const reserve = createWorkerReserve({ enabled: true, workerAddress,
    signer: { getAddress: async () => wallet.address,
      populateTransaction: async tx => ({ ...tx, nonce: 0, gasLimit: 21000n, gasPrice: 1n }),
      signTransaction: tx => wallet.signTransaction(tx) },
    provider: { getNetwork: async () => ({ chainId: 8453 }),
      getBalance: async address => address === wallet.address && funded ? 10n ** 18n : 0n,
      getTransactionReceipt: async () => receipt, getTransaction: async () => ({ pending: true }),
      broadcastTransaction: async raw => { broadcasts++; return { hash: keccak256(raw) }; } },
    restore: async () => null, save: async value => {
      if (!writable) throw new Error('Journal unavailable');
      snapshot = structuredClone(value); return 'ipfs://reserve';
    } });
  await assert.rejects(reserve.check(), /cannot cover refill/);
  funded = true;
  await assert.rejects(reserve.check(), /Journal unavailable/);
  assert.equal(broadcasts, 0);
  writable = true;
  await reserve.check();
  await reserve.check();
  assert.equal(broadcasts, 1, 'known pending transaction must not be sent twice');
  receipt = { status: 0 };
  await assert.rejects(reserve.check(), /refill reverted/);
  assert.equal(snapshot.refills[0].status, 'failed');
});
