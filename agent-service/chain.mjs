import { createHash } from 'node:crypto';
import { Interface, getAddress, id, formatUnits } from 'ethers';
import {
  DJUKE_EARNING_CONTRACTS, ROUTER_ADDRESS, ROUTER_START_BLOCK, USDC_ADDRESS, ART_ADDRESS,
  FUND_LABELS,
} from '../js/creator-earnings.mjs';

const RPC = 'https://base-rpc.publicnode.com';
const INDEX = 'https://decentbusking.onrender.com/api/earnings/';
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const events = new Interface([
  'event ArtistPaid(address indexed artist,uint256 amount,uint256 cumulativePaid)',
  'event ArtistWithdrawal(address indexed artist,uint256 amount)',
  'event PayrollPaid(bytes32 indexed fundId,address indexed asset,address indexed recipient,uint256 amount,bytes32 workReference,bytes32 repositoryIdHash,bytes32 contributorIdHash,string metadataUri,bytes32 metadataHash)',
  'event FundFunded(bytes32 indexed fundId,address indexed asset,address indexed funder,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 amount)',
  'event PlaylistSongDelivered(uint256 indexed laneId,uint256 indexed batchId,bytes32 indexed songId,uint256 amount,bytes32 playbackProof)',
  'event PlaylistBatchFeeSettled(uint256 indexed batchId,uint256 fee,uint256 playback,uint256 topTen,uint256 pinners,uint256 repoDev)',
  'event PlaylistBatchRequested(uint256 indexed batchId,address indexed payer,bytes32[] songIds,uint256 subtotal,uint256 platformFee,uint256 firstLaneId)',
]);
const views = new Interface([
  'function artistLedger(address) view returns(uint256 totalPaid,uint256 payoutCount)',
  'function artistCredits(address) view returns(uint256)',
]);
const funds = new Map(Object.entries(FUND_LABELS).map(([slug, label]) => [id(slug), label]));
const djukes = new Map(DJUKE_EARNING_CONTRACTS.map(item => [item.address.toLowerCase(), item.label]));
const fail = (status, message) => Object.assign(new Error(message), { status });
const quantity = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw fail(503, 'Chain evidence returned an invalid quantity.');
  return BigInt(value);
};
const number = value => {
  const result = Number(quantity(value));
  if (!Number.isSafeInteger(result) || result < 0) throw fail(503, 'Chain evidence returned an invalid block or index.');
  return result;
};
const hex = value => `0x${value.toString(16)}`;
const proof = hash => `https://basescan.org/tx/${hash}`;
const asset = address => address.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 'USDC'
  : address.toLowerCase() === ART_ADDRESS.toLowerCase() ? 'ART' : null;
const formatAmount = (units, symbol = 'USDC') => `${formatUnits(units, symbol === 'USDC' ? 6 : 18)} ${symbol}`;

export function chainIntent(message, wallet, previous) {
  const hashes = [...new Set(message.match(/0x[0-9a-f]{64}\b/gi) || [])];
  if (hashes.length > 1) return { clarification: 'Please trace one Base transaction at a time.' };
  if (hashes.length) return { kind: 'transaction', hash: hashes[0] };
  const addresses = [...new Set((message.match(/0x[0-9a-f]{40}\b/gi) || []).map(value => value.toLowerCase()))];
  if (addresses.length > 1) return { clarification: 'Please investigate one public wallet at a time.' };
  const financial = /\b(paid|payments?|payouts?|payroll|earnings?|earned|received|income|money|history|historically|last|latest|total|credits?|withdrawals?|breakdown)\b/i.test(message);
  if (addresses.length) return { kind: 'wallet', address: addresses[0] };
  if (financial && /\b(my|me|mine|I|our connected wallet)\b/i.test(message)) return { kind: 'wallet', address: wallet };
  if (financial && /(?:\b(zaal|jolly|someone|they|their|another wallet)\b|\bjos[eé](?=\s|[?.!,]|$))/i.test(message)) {
    return { clarification: 'Paste the public 0x wallet address you want to explore. Names alone do not prove which wallet belongs to someone.' };
  }
  if (previous && financial && /\b(that|this|it|those|more|again)\b/i.test(message)) return previous;
  return null;
}

function source(evidence, url, label) {
  const text = JSON.stringify(evidence);
  if (Buffer.byteLength(text) > 16000) throw fail(413, 'Chain evidence is too large; ask about a single transaction.');
  const transactions = evidence.transaction ? [evidence.transaction]
    : [...new Set(evidence.verifiedRecentPayments.map(item => item.transaction))];
  const contracts = evidence.contractTotals?.map(item => item.contract)
    || [...new Set(evidence.events.map(item => item.contract))];
  return { id: `chain-${createHash('sha256').update(text).digest('hex').slice(0, 20)}`,
    kind: 'chain', file: label, line: 1, url, text,
    references: [
      ...transactions.map(hash => ({ url: proof(hash), label: `Transaction ${hash.slice(0, 10)}…` })),
      { url: `https://basescan.org/block/${evidence.block ?? evidence.confirmedThrough}`,
        label: `Base block ${evidence.block ?? evidence.confirmedThrough}` },
      ...contracts.map(address => ({ url: `https://basescan.org/address/${address}`, label: `Contract ${address}` })),
    ] };
}

export function createChainReader({ fetchImpl = fetch } = {}) {
  async function json(url, options, signal) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal }); }
    catch {
      if (signal?.aborted) throw signal.reason;
      throw fail(503, 'Public chain evidence is unavailable. No payment history was inferred.');
    }
    if (!response.ok) throw fail(503, 'Public chain evidence was rejected or rate limited. Try later.');
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2_000_000) throw fail(503, 'Public chain evidence exceeded the response limit.');
        chunks.push(chunk);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.status) throw error;
      throw fail(503, 'Public chain evidence could not be read.');
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); }
    catch { throw fail(503, 'Public chain evidence was unreadable.'); }
  }
  async function rpc(method, params, signal) {
    const body = await json(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, signal);
    if (!body || body.error || !Object.hasOwn(body, 'result')) throw fail(503, 'Public Base RPC could not supply verified evidence.');
    return body.result;
  }
  async function snapshot(signal) {
    if (quantity(await rpc('eth_chainId', [], signal)) !== 8453n) throw fail(503, 'Chain evidence is not from Base.');
    const head = number(await rpc('eth_blockNumber', [], signal));
    if (head < 2) throw fail(503, 'Base confirmation head is unavailable.');
    return head - 2;
  }
  async function receipt(hash, through, signal) {
    const result = await rpc('eth_getTransactionReceipt', [hash], signal);
    if (!result) throw fail(404, 'Transaction was not found on Base or is still pending.');
    if (result.transactionHash?.toLowerCase() !== hash.toLowerCase() || !Array.isArray(result.logs) ||
        !ADDRESS.test(result.from) || (result.to !== null && !ADDRESS.test(result.to))) {
      throw fail(503, 'Base returned an invalid transaction receipt.');
    }
    const height = number(result.blockNumber);
    if (height > through) throw fail(409, 'Wait for at least three Base confirmations before tracing this transaction.');
    const block = await rpc('eth_getBlockByNumber', [hex(height), false], signal);
    if (!block || block.hash !== result.blockHash || number(block.number) !== height) {
      throw fail(503, 'Transaction receipt did not match the canonical Base block.');
    }
    if (result.logs.length > 200) throw fail(413, 'This transaction has too many logs for the bounded pilot reader.');
    return { ...result, height, timestamp: new Date(number(block.timestamp) * 1000).toISOString() };
  }
  function decode(receipt) {
    const result = [];
    for (const log of receipt.logs) {
      if (!ADDRESS.test(log.address) || !Array.isArray(log.topics)) throw fail(503, 'Invalid chain event.');
      const contract = log.address.toLowerCase();
      const knownDjuke = djukes.has(contract);
      const router = contract === ROUTER_ADDRESS.toLowerCase();
      const token = asset(contract);
      if (!knownDjuke && !router && !token) continue;
      let event;
      try { event = events.parseLog(log); }
      catch { throw fail(503, 'Known-contract event could not be decoded.'); }
      if (!event) continue;
      const a = event.args;
      const base = { event: event.name, contract: log.address, logIndex: number(log.logIndex) };
      if (token && event.name === 'Transfer') result.push({ ...base, asset: token,
        from: a.from, to: a.to, units: String(a.amount), amount: formatAmount(a.amount, token) });
      if (knownDjuke && ['ArtistPaid', 'ArtistWithdrawal'].includes(event.name)) {
        result.push({ ...base, recipient: a.artist, asset: 'USDC', units: String(a.amount),
          amount: formatAmount(a.amount), ...(event.name === 'ArtistPaid' ? { cumulativePaidUnits: String(a.cumulativePaid) } : {}) });
      }
      if (router && ['PayrollPaid', 'FundFunded'].includes(event.name)) {
        const symbol = asset(a.asset);
        result.push({ ...base, fundId: a.fundId, fund: funds.get(a.fundId) || 'Other router fund',
          asset: symbol || a.asset, units: String(a.amount),
          ...(symbol ? { amount: formatAmount(a.amount, symbol) } : {}),
          ...(event.name === 'PayrollPaid' ? { recipient: a.recipient } : { funder: a.funder }),
          meaning: event.name === 'FundFunded' ? 'Fund deposit, NOT a beneficiary payout' : 'Recipient payout' });
      }
      if (knownDjuke && event.name === 'PlaylistSongDelivered') result.push({ ...base,
        batchId: String(a.batchId), laneId: String(a.laneId), songId: a.songId,
        songChargeUnits: String(a.amount), songCharge: formatAmount(a.amount) });
      if (knownDjuke && event.name === 'PlaylistBatchFeeSettled') result.push({ ...base,
        cumulativeBatchFee: formatAmount(a.fee), playback: formatAmount(a.playback), topTen: formatAmount(a.topTen),
        pinners: formatAmount(a.pinners), repoDev: formatAmount(a.repoDev),
        meaning: 'Cumulative batch allocation, NOT a new charge or necessarily all transferred in this transaction' });
      if (knownDjuke && event.name === 'PlaylistBatchRequested') result.push({ ...base, batchId: String(a.batchId),
        payer: a.payer, songCount: a.songIds.length, songSubtotal: formatAmount(a.subtotal), platformFee: formatAmount(a.platformFee) });
    }
    if (result.length > 60) throw fail(413, 'Too many decoded events; narrow the money-trail question.');
    return result;
  }
  async function trace(hash, through, signal) {
    const r = await receipt(hash, through, signal);
    const tx = await rpc('eth_getTransactionByHash', [hash], signal);
    if (!tx || tx.hash?.toLowerCase() !== hash.toLowerCase() ||
        tx.from?.toLowerCase() !== r.from.toLowerCase() || tx.to?.toLowerCase() !== r.to?.toLowerCase() ||
        tx.blockHash !== r.blockHash) throw fail(503, 'Transaction input did not match the confirmed receipt.');
    const status = number(r.status);
    if (![0, 1].includes(status)) throw fail(503, 'Unknown transaction status.');
    const gasWei = quantity(r.gasUsed) * quantity(r.effectiveGasPrice) + quantity(r.l1Fee || '0x0');
    return { chainId: 8453, transaction: hash, url: proof(hash), block: r.height, blockHash: r.blockHash,
      timestamp: r.timestamp, confirmedThrough: through, success: status === 1,
      nativeValueWei: String(quantity(tx.value)), nativeValueMeaning: status === 1
        ? 'Top-level ETH value only; internal transfers are not traced' : 'Requested value was not successfully transferred',
      from: r.from, to: r.to, gasPaidBy: r.from, gasWei: String(gasWei),
      gasMeaning: 'ETH network fee paid by transaction sender, separate from token payments; includes L1 fee when supplied by RPC',
      events: status === 1 ? decode(r) : [],
      limits: 'Recognized Base USDC/ART transfers, configured DJuke artist/playlist events and settlement-router events only. No internal ETH traces, arbitrary token metadata, identity attribution or automatic multi-hop history. Transfers and semantic events describe the SAME money: never add them together.' };
  }
  async function history(address, through, signal) {
    const wallet = getAddress(address);
    const indexed = await json(INDEX + wallet, {}, signal);
    if (!indexed || indexed.ready !== true || !Array.isArray(indexed.entries) ||
        !Number.isSafeInteger(indexed.through) || indexed.through < 0 ||
        !Number.isFinite(Date.parse(indexed.lastCheckedAt))) throw fail(503, 'Public earnings index is not ready or has invalid coverage.');
    const contractTotals = await Promise.all(DJUKE_EARNING_CONTRACTS.map(async contract => {
      const values = await Promise.all(['artistLedger', 'artistCredits'].map(async name => {
        const data = await rpc('eth_call', [{ to: contract.address, data: views.encodeFunctionData(name, [wallet]) }, hex(through)], signal);
        try { return views.decodeFunctionResult(name, data); }
        catch { throw fail(503, 'DJuke earnings view could not be decoded.'); }
      }));
      return { contract: contract.address, label: contract.label, sinceBlock: contract.startBlock,
        through, paidUnits: String(values[0][0]), paid: formatAmount(values[0][0]),
        payoutCount: String(values[0][1]), unclaimedUnits: String(values[1][0]), unclaimed: formatAmount(values[1][0]) };
    }));
    const candidates = indexed.entries.map(entry => {
      if (!entry || !HASH.test(entry.txHash) || !Number.isSafeInteger(entry.blockNumber) || entry.blockNumber < 0 ||
          !Number.isSafeInteger(entry.logIndex) || entry.logIndex < 0 ||
          String(entry.recipient || entry.artist).toLowerCase() !== wallet.toLowerCase()) {
        throw fail(503, 'Public earnings index returned an invalid recipient or reference.');
      }
      return entry;
    }).filter(entry => entry.blockNumber <= Math.min(through, indexed.through))
      .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    const hashes = [...new Set(candidates.map(entry => entry.txHash))].slice(0, 12);
    const payments = [];
    for (const hash of hashes) {
      const r = await receipt(hash, through, signal);
      if (number(r.status) !== 1) throw fail(503, 'Indexed payment has no successful receipt.');
      const decoded = decode(r);
      for (const entry of candidates.filter(item => item.txHash === hash)) {
        const event = decoded.find(item => item.logIndex === entry.logIndex &&
          ['ArtistPaid', 'ArtistWithdrawal', 'PayrollPaid'].includes(item.event) &&
          item.recipient.toLowerCase() === wallet.toLowerCase());
        if (!event || event.units !== entry.units || r.height !== entry.blockNumber) {
          throw fail(503, 'Indexed payment did not match its on-chain recipient, amount or block.');
        }
        if (payments.some(item => item.transaction === hash && item.logIndex === event.logIndex)) continue;
        payments.push({ ...event, transaction: hash, block: r.height, timestamp: r.timestamp, url: proof(hash) });
      }
    }
    const payroll = new Map();
    for (const payment of payments.filter(item => item.event === 'PayrollPaid' && ['USDC', 'ART'].includes(item.asset))) {
      const key = `${payment.fund}:${payment.asset}`;
      const previous = payroll.get(key);
      payroll.set(key, { fund: payment.fund, asset: payment.asset,
        units: String(BigInt(previous?.units || '0') + BigInt(payment.units)) });
    }
    const paidUnits = contractTotals.reduce((sum, item) => sum + BigInt(item.paidUnits), 0n);
    return { chainId: 8453, wallet, confirmedThrough: through, indexThrough: indexed.through,
      indexLagBlocks: Math.max(0, through - indexed.through),
      indexCheckedAt: indexed.lastCheckedAt, contractTotals, djukeDirectTotal: formatAmount(paidUnits),
      djukeDirectUnits: String(paidUnits), latestVerifiedIndexedPayment: payments[0] || null,
      verifiedRecentPayments: payments.slice(0, 12),
      shownPaymentCount: Math.min(payments.length, 12),
      verifiedRecentPayrollSubtotals: [...payroll.values()].map(item => ({ ...item, amount: formatAmount(item.units, item.asset) })),
      indexedCandidates: candidates.length, verifiedPaymentCount: payments.length,
      limits: 'NOT a complete family-wide/all-time history. DJuke direct totals come from artistLedger on listed contracts only; unclaimed credits are NOT paid. Latest means latest verified payment located by the public index, NOT guaranteed latest on chain. Index has no start-block/error coverage manifest. At most 12 indexed transactions are receipt-verified per question; payroll subtotals cover only those receipts. Withdrawals are shown separately; do not add ledger totals, withdrawals and event amounts as if distinct income. DJuke v0.1/v0.2/v0.4, other contracts/chains, external/private payments and unindexed payments are excluded.',
      router: { address: ROUTER_ADDRESS, configuredScanStart: ROUTER_START_BLOCK },
    };
  }
  return async (intent, { signal } = {}) => {
    const through = await snapshot(signal);
    const evidence = intent.kind === 'transaction'
      ? await trace(intent.hash, through, signal) : await history(intent.address, through, signal);
    return source(evidence, intent.kind === 'transaction' ? proof(intent.hash)
      : `https://basescan.org/address/${getAddress(intent.address)}`, intent.kind === 'transaction' ? 'Base transaction evidence' : 'Base wallet earnings evidence');
  };
}
