const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { Wallet, Interface, verifyTypedData } = createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');

test('worker signs bounded Base gas quotes including L1 fee with doubled contribution', async () => {
  const { createDjukeGasQuoteReader, GAS_QUOTE_TYPES } = await import('../discord-bot/djuke-gas.js');
  const signer = Wallet.createRandom(), listener = Wallet.createRandom().address, target = Wallet.createRandom().address;
  const contract = { target, interface: new Interface(['function fulfill(uint256,bytes32,uint256,bytes32)']),
    gasWorker: async () => signer.address, maxGasContributionWei: async () => 1000000000000000n,
    gasQuoteNonces: async () => 0n, quote: async () => 250000n, getSong: async () => ({ enabled: true }), nextRequestId: async () => 0n };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getFeeData: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 1n }) };
  const reader = createDjukeGasQuoteReader({ provider, contract, signer, fulfillmentGasUnits: 100000n, staticCacheMs: 0,
    oracle: { getL1Fee: async bytes => { assert.match(bytes, /^0x/); return 1000n; } }, now: () => 1000000 });
  const quote = await reader({ listener, songId: `0x${'a'.repeat(64)}` });
  assert.equal(quote.fulfillmentCostWei, '100000001000');
  assert.equal(quote.contributionWei, '200000002000');
  assert.equal(quote.deadline, 1120);
  assert.equal(verifyTypedData({ name: 'DecentJukeBox', version: '0.2', chainId: 8453, verifyingContract: target }, GAS_QUOTE_TYPES, quote, quote.signature), signer.address);
  contract.maxGasContributionWei = async () => 1n;
  await assert.rejects(reader({ listener, songId: `0x${'a'.repeat(64)}` }), /exceeds/);
  provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(reader({ listener, songId: `0x${'a'.repeat(64)}` }), /Base-only/);
});

test('sponsored quotes require v0.5 and a funded worker and never charge listener ETH', async () => {
  const { createDjukeGasQuoteReader, createDjukePlaylistGasQuoteReader } = await import('../discord-bot/djuke-gas.js');
  const signer = Wallet.createRandom(), listener = Wallet.createRandom().address;
  let version = '0.5', balance = 3_000_000_000_000_000n;
  const contract = { target: Wallet.createRandom().address,
    interface: new Interface(['function fulfill(uint256,bytes32,uint256,bytes32)', 'function fulfillPlaylistSong(uint256,bytes32,uint256,bytes32)']),
    CONTRACT_VERSION: async () => version, gasWorker: async () => signer.address, maxGasContributionWei: async () => 10n ** 15n,
    gasQuoteNonces: async () => 0n, quote: async () => 250000n, quotePlaylist: async () => [4000000n, 3000000n, 7000000n],
    getSong: async () => ({ enabled: true }), nextRequestId: async () => 0n, playlistNextId: async () => 0n };
  const provider = { getNetwork: async () => ({ chainId: 8453 }), getBalance: async () => balance,
    getFeeData: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 1n }) };
  const options = { contract, provider, signer, sponsored: true, fulfillmentGasUnits: 100000n,
    oracle: { getL1Fee: async () => 1000n } };
  const single = createDjukeGasQuoteReader(options);
  const playlist = createDjukePlaylistGasQuoteReader(options);
  const songId = `0x${'a'.repeat(64)}`;
  for (const quote of [await single({ listener, songId }), await playlist({ listener, songIds: [songId] })]) {
    assert.equal(quote.fulfillmentCostWei, '0');
    assert.equal(quote.contributionWei, '0');
  }
  balance = 0n;
  await assert.rejects(single({ listener, songId }), /reserve is low/);
  await assert.rejects(playlist({ listener, songIds: [songId] }), /reserve is low/);
  balance = 3_000_000_000_000_000n; version = '0.4';
  await assert.rejects(single({ listener, songId }), /v0.5/);
});
test('gas quotes stay within RPC rate limits: cached statics, shared in-flight quotes, no nonce lookup, retry on 429', async () => {
  const { createDjukeGasQuoteReader, isRpcRateLimit } = await import('../discord-bot/djuke-gas.js');
  const signer = Wallet.createRandom(), listener = Wallet.createRandom().address;
  const counts = {};
  const counted = (name, value) => async () => { counts[name] = (counts[name] || 0) + 1; return value; };
  let limited = 1;
  const contract = { target: Wallet.createRandom().address, interface: new Interface(['function fulfill(uint256,bytes32,uint256,bytes32)']),
    gasWorker: counted('gasWorker', signer.address), maxGasContributionWei: counted('cap', 10n ** 15n),
    gasQuoteNonces: counted('nonces', 0n), quote: async () => {
      if (limited-- > 0) throw Object.assign(new Error('could not coalesce error'), { error: { code: -32007, message: '25/second request limit reached' } });
      return 250000n;
    }, getSong: async () => ({ enabled: true }), nextRequestId: async () => 0n };
  const provider = { getNetwork: counted('network', { chainId: 8453n }), getFeeData: counted('fees', { maxFeePerGas: 1000000n, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async () => { throw new Error('nonce lookup should not be needed'); } };
  const reader = createDjukeGasQuoteReader({ provider, contract, signer, fulfillmentGasUnits: 100000n,
    oracle: { getL1Fee: async () => 1000n }, retry: { delayMs: 1 } });
  const songId = `0x${'a'.repeat(64)}`;
  const [first, second] = await Promise.all([reader({ listener, songId }), reader({ listener, songId })]);
  assert.equal(first, second);
  assert.equal(counts.nonces, 1, 'concurrent identical quotes share one RPC round');
  await reader({ listener, songId });
  assert.equal(counts.gasWorker, 1);
  assert.equal(counts.cap, 1);
  assert.equal(counts.network, 1);
  assert.equal(counts.fees, 1);
  assert.equal(isRpcRateLimit(new Error('execution reverted')), false);
  limited = 10;
  await assert.rejects(reader({ listener, songId }), /coalesce/);
});

test('playlist worker quote hashes ordered song IDs and recovers against the contract v0.2 domain', async () => {
  const { createDjukePlaylistGasQuoteReader, PLAYLIST_GAS_QUOTE_TYPES } = await import('../discord-bot/djuke-gas.js');
  const { AbiCoder, keccak256 } = require('node:module').createRequire(require('node:path').join(__dirname, '../discord-bot/package.json'))('ethers');
  const signer = Wallet.createRandom(), listener = Wallet.createRandom().address, target = Wallet.createRandom().address;
  const songIds = [`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`];
  const contract = { target, interface: new Interface(['function fulfillPlaylistSong(uint256,bytes32,uint256,bytes32)']),
    gasWorker: async () => signer.address, maxGasContributionWei: async () => 1000000000000000n,
    gasQuoteNonces: async () => 3n, quotePlaylist: async () => [500000n, 3000000n, 3500000n],
    getSong: async () => ({ enabled: true }), playlistNextId: async () => 7n };
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getFeeData: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 1n }) };
  const reader = createDjukePlaylistGasQuoteReader({ provider, contract, signer, fulfillmentGasUnits: 100000n,
    oracle: { getL1Fee: async () => 1000n }, now: () => 1000000 });
  const quote = await reader({ listener, songIds });
  assert.equal(quote.maxTotal, '3500000');
  assert.equal(quote.nonce, '3');
  assert.equal(quote.deadline, 1120);
  assert.equal(quote.contributionWei, '400000004000');
  assert.equal(quote.songIdsHash, keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [songIds])));
  assert.equal(verifyTypedData({ name: 'DecentJukeBox', version: '0.2', chainId: 8453, verifyingContract: target },
    PLAYLIST_GAS_QUOTE_TYPES, quote, quote.signature), signer.address);
  await assert.rejects(reader({ listener, songIds: [songIds[0], songIds[0]] }), /Invalid playlist/);
});
