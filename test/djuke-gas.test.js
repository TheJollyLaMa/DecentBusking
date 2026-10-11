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
  const provider = { getNetwork: async () => ({ chainId: 8453n }), getFeeData: async () => ({ maxFeePerGas: 1000000n, maxPriorityFeePerGas: 1n }), getTransactionCount: async () => 0 };
  const reader = createDjukeGasQuoteReader({ provider, contract, signer, fulfillmentGasUnits: 100000n,
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