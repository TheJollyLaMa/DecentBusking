import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';
import { chainIntent, createChainReader } from '../chain.mjs';
import { DJUKE_EARNING_CONTRACTS, ROUTER_ADDRESS, USDC_ADDRESS } from '../../js/creator-earnings.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const hash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`;
const contract = DJUKE_EARNING_CONTRACTS[1].address;
const iface = new Interface([
  'event ArtistPaid(address indexed artist,uint256 amount,uint256 cumulativePaid)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
  'event PlaylistBatchFeeSettled(uint256 indexed batchId,uint256 fee,uint256 playback,uint256 topTen,uint256 pinners,uint256 repoDev)',
  'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
  'function artistLedger(address) view returns(uint256 totalPaid,uint256 payoutCount)',
  'function artistCredits(address) view returns(uint256)',
]);
function log(name, args, address, index) {
  const encoded = iface.encodeEventLog(iface.getEvent(name), args);
  return { ...encoded, address, logIndex: `0x${index.toString(16)}` };
}
function fixture({ index, receipt, rpc, unavailable = false } = {}) {
  const calls = [];
  const record = {
    transactionHash: hash, from: other, to: contract, blockNumber: '0x64', blockHash,
    status: '0x1', gasUsed: '0x64', effectiveGasPrice: '0x2', l1Fee: '0x5',
    logs: [log('Transfer', [contract, wallet, 450000n], USDC_ADDRESS, 0),
      log('ArtistPaid', [wallet, 450000n, 1125000n], contract, 1)],
    ...receipt,
  };
  const reader = createChainReader({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (unavailable) return new Response('PRIVATE upstream', { status: 429 });
    if (url.includes('/api/earnings/')) return Response.json(index || {
      ready: true, through: 102, lastCheckedAt: '2026-10-28T17:00:00Z',
      entries: [{ artist: wallet, txHash: hash, blockNumber: 100, logIndex: 1, units: '450000' }],
    });
    const request = JSON.parse(options.body), params = request.params;
    let result;
    if (rpc) result = rpc(request);
    if (result === undefined) {
      switch (request.method) {
        case 'eth_chainId': result = '0x2105'; break;
        case 'eth_blockNumber': result = '0x66'; break;
        case 'eth_getTransactionReceipt': result = record; break;
        case 'eth_getTransactionByHash': result = { hash, from: record.from, to: record.to, blockHash: record.blockHash, value: '0x0' }; break;
        case 'eth_getBlockByNumber': result = { number: '0x64', hash: blockHash, timestamp: '0x69000000' }; break;
        case 'eth_call': {
          const call = iface.parseTransaction({ data: params[0].data });
          result = iface.encodeFunctionResult(call.name, call.name === 'artistLedger' ? [1125000n, 3n] : [100000n]);
          break;
        }
        default: throw Error(`Unexpected RPC ${request.method}`);
      }
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  } });
  return { reader, calls };
}

test('intent uses connected wallet only for first-person questions; names never infer identity', () => {
  assert.deepEqual(chainIntent('How much have I been paid historically?', wallet), { kind: 'wallet', address: wallet });
  assert.deepEqual(chainIntent(`When was ${other} last paid?`, wallet), { kind: 'wallet', address: other });
  assert.match(chainIntent('When was Zaal last paid?', wallet).clarification, /Names alone/);
  assert.match(chainIntent('When was José last paid?', wallet).clarification, /Names alone/);
  assert.equal(chainIntent('Where does the money come from?', wallet), null);
  assert.equal(chainIntent('What is DJuke?', wallet), null);
  assert.deepEqual(chainIntent(`Trace https://basescan.org/tx/${hash}`, wallet), { kind: 'transaction', hash });
  assert.match(chainIntent(`Compare ${wallet} and ${other} earnings`, wallet).clarification, /one public wallet/);
  assert.deepEqual(chainIntent('More about those payments', wallet, { kind: 'wallet', address: other }),
    { kind: 'wallet', address: other });
});

test('trace separates exact token amounts, semantic events and sender-paid gas with block references', async () => {
  const { reader, calls } = fixture();
  const source = await reader({ kind: 'transaction', hash });
  const data = JSON.parse(source.text);
  assert.equal(data.chainId, 8453);
  assert.equal(data.block, 100);
  assert.equal(data.gasWei, '205');
  assert.equal(data.gasPaidBy, other);
  assert.equal(data.events[0].units, '450000');
  assert.equal(data.events[1].cumulativePaidUnits, '1125000');
  assert.match(data.limits, /SAME money/);
  assert.ok(source.references.some(item => item.url === 'https://basescan.org/block/100'));
  assert.ok(calls.every(call => ['https://base-rpc.publicnode.com'].includes(call.url)));
  assert.ok(calls.every(call => !/sendRawTransaction|sign/.test(call.options.body || '')));
});

test('history reuses scoped DJuke ledgers and verifies indexed receipts rather than trusting labels', async () => {
  const { reader, calls } = fixture();
  const source = await reader({ kind: 'wallet', address: wallet });
  const data = JSON.parse(source.text);
  assert.equal(data.djukeDirectUnits, '2250000');
  assert.equal(data.contractTotals[0].unclaimedUnits, '100000');
  assert.equal(data.contractTotals[0].paid, '1.125 USDC', 'No fractional-cent income is rounded away');
  assert.equal(data.latestVerifiedIndexedPayment.units, '450000');
  assert.equal(data.latestVerifiedIndexedPayment.contract, contract);
  assert.match(data.limits, /NOT a complete/);
  assert.match(data.limits, /v0.4/);
  assert.match(data.limits, /NOT guaranteed latest/);
  assert.ok(source.references.some(item => item.url.endsWith(hash)));
  for (const call of calls.filter(call => call.options.body && JSON.parse(call.options.body).method === 'eth_call')) {
    assert.equal(JSON.parse(call.options.body).params[1], '0x64', 'ledger read pinned to confirmed block');
  }
});

test('empty index is not represented as never paid or complete zero', async () => {
  const { reader } = fixture({ index: { ready: true, through: 100, lastCheckedAt: '2026-10-28T17:00:00Z', entries: [] } });
  const data = JSON.parse((await reader({ kind: 'wallet', address: wallet })).text);
  assert.equal(data.latestVerifiedIndexedPayment, null);
  assert.equal(data.djukeDirectUnits, '2250000');
  assert.match(data.limits, /unindexed payments are excluded/);
});

test('failed transactions have no successful token payments', async () => {
  const { reader } = fixture({ receipt: { status: '0x0' } });
  const data = JSON.parse((await reader({ kind: 'transaction', hash })).text);
  assert.equal(data.success, false);
  assert.deepEqual(data.events, []);
  assert.equal(data.gasWei, '205');
});

test('fund allocations and cumulative batch totals are not presented as new artist payments', async () => {
  const { reader } = fixture({ receipt: { logs: [
    log('FundFunded', [id('dbusk-pinners'), USDC_ADDRESS, contract, 250000n], ROUTER_ADDRESS, 0),
    log('PlaylistBatchFeeSettled', [4n, 3000000n, 750000n, 750000n, 750000n, 750000n], contract, 1),
  ] } });
  const data = JSON.parse((await reader({ kind: 'transaction', hash })).text);
  assert.equal(data.events[0].fund, 'Pinner rewards');
  assert.match(data.events[0].meaning, /NOT a beneficiary payout/);
  assert.equal(data.events[1].cumulativeBatchFee, '3.0 USDC');
  assert.match(data.events[1].meaning, /NOT a new charge/);
});

test('history verifies at most twelve receipts and discloses an indexed subset', async () => {
  const entries = Array.from({ length: 14 }, (_, i) => ({ artist: wallet, units: '450000',
    blockNumber: 100, logIndex: 1, txHash: `0x${(i + 1).toString(16).padStart(64, '0')}` }));
  const { reader, calls } = fixture({
    index: { ready: true, through: 100, lastCheckedAt: '2026-10-28T17:00:00Z', entries },
    rpc: request => request.method === 'eth_getTransactionReceipt' ? {
      transactionHash: request.params[0], from: other, to: contract, blockNumber: '0x64', blockHash,
      status: '0x1', logs: [log('ArtistPaid', [wallet, 450000n, 1125000n], contract, 1)],
    } : undefined,
  });
  const data = JSON.parse((await reader({ kind: 'wallet', address: wallet })).text);
  assert.equal(data.indexedCandidates, 14);
  assert.equal(data.verifiedPaymentCount, 12);
  assert.equal(calls.filter(item => item.options.body &&
    JSON.parse(item.options.body).method === 'eth_getTransactionReceipt').length, 12);
  assert.match(data.limits, /At most 12/);
});

test('chain errors fail explicitly instead of becoming successful zero balances', async () => {
  for (const [options, pattern] of [
    [{ unavailable: true }, /rate limited/],
    [{ rpc: request => request.method === 'eth_chainId' ? '0x1' : undefined }, /not from Base/],
    [{ receipt: { blockNumber: '0x65' } }, /confirmations/],
    [{ receipt: { blockHash: `0x${'c'.repeat(64)}` } }, /canonical/],
    [{ rpc: request => request.method === 'eth_getTransactionReceipt' ? null : undefined }, /not found/],
    [{ index: { ready: false } }, /not ready/],
    [{ index: { ready: true, through: 100, lastCheckedAt: '2026-10-28T17:00:00Z',
      entries: [{ artist: other, txHash: hash, blockNumber: 100, logIndex: 1 }] } }, /invalid recipient/],
    [{ index: { ready: true, through: 100, lastCheckedAt: '2026-10-28T17:00:00Z',
      entries: [{ artist: wallet, units: '1', txHash: hash, blockNumber: 100, logIndex: 1 }] } }, /did not match/],
  ]) {
    const { reader } = fixture(options);
    await assert.rejects(reader({ kind: options.index ? 'wallet' : 'transaction', address: wallet, hash }), pattern);
  }
});

test('payroll subtotal is receipt-verified, asset-separated and never merged into direct DJuke totals', async () => {
  const zero = `0x${'0'.repeat(64)}`;
  const payroll = log('PayrollPaid', [zero, USDC_ADDRESS, wallet, 450000n, zero, zero, zero, '', zero], ROUTER_ADDRESS, 1);
  const { reader } = fixture({ receipt: { logs: [payroll] } });
  const data = JSON.parse((await reader({ kind: 'wallet', address: wallet })).text);
  assert.equal(data.verifiedRecentPayrollSubtotals[0].units, '450000');
  assert.equal(data.djukeDirectUnits, '2250000');
  assert.equal(data.latestVerifiedIndexedPayment.event, 'PayrollPaid');
});
