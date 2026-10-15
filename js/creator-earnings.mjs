// On-chain creator earnings from DecentBusking contracts on Base. Every figure
// is read from a contract view or an emitted event, and carries a Basescan proof link.

export const BASESCAN = 'https://basescan.org';
export const ROUTER_ADDRESS = '0x8ecca903e2a6Daa8CCbB933700e4F2C58C44A4B5';
export const ROUTER_START_BLOCK = 51852000;
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const ART_ADDRESS = '0x44c4516768e47cd97cfF2561B81a74699F23f8Ec';

export const DJUKE_EARNING_CONTRACTS = [
  { label: 'DJuke v0.3', address: '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9', startBlock: 52526453, ledger: true },
  { label: 'DJuke v0.2', address: '0x333Aa353d6fc70aE79Cf91CE090645CD740FEf59', startBlock: 52445901 },
  { label: 'DJuke v0.1', address: '0x153ef59a57C9A88cbB7822252B5d9D0B11E48F0E', startBlock: ROUTER_START_BLOCK },
];

export const FUND_LABELS = {
  'dbusk-repo-dev': 'Repo dev payroll',
  'dbusk-pinners': 'Pinner rewards',
  'dbusk-playback': 'Playback rewards',
  'dbusk-top10': 'Top 10 rewards',
};

const DJUKE_ABI = [
  'function artistCredits(address) view returns (uint256)',
  'function artistLedger(address) view returns (uint256 totalPaid, uint256 payoutCount)',
];
const PAYROLL_EVENT = 'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)';
const WITHDRAW_EVENT = 'event ArtistWithdrawal(address indexed artist, uint256 amount)';
const CACHE_PREFIX = 'dbusk-earnings-v1:';
const EARNINGS_KIND = {
  payroll: 'payroll',
  withdrawal: 'withdrawal',
};

export const readProof = contract => `${BASESCAN}/address/${contract}#readContract`;
export const txProof = hash => `${BASESCAN}/tx/${hash}`;

export function assetSymbol(asset) {
  const value = String(asset || '').toLowerCase();
  if (value === USDC_ADDRESS.toLowerCase()) return 'USDC';
  if (value === ART_ADDRESS.toLowerCase()) return 'ART';
  return 'TOKEN';
}

export function assetDecimals(symbol) { return symbol === 'USDC' ? 6 : 18; }

export function formatAmount(units, symbol = 'USDC') {
  const value = BigInt(units || 0);
  const decimals = assetDecimals(symbol);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').slice(0, symbol === 'USDC' ? 6 : 4).replace(/0+$/, '');
  const shown = fraction.length < 2 ? (fraction + '00').slice(0, 2) : fraction;
  return `${whole.toLocaleString('en-US')}.${shown} ${symbol}`;
}

export function fundLabel(fundId, ethers) {
  const id = String(fundId || '').toLowerCase();
  if (/^0x0{64}$/.test(id)) return 'Unallocated payout';
  for (const [slug, label] of Object.entries(FUND_LABELS)) if (ethers.id(slug).toLowerCase() === id) return label;
  return 'Router payout';
}

// Reads that need only eth_call: DJuke direct artist payouts and unclaimed credits.
export async function readContractEarnings({ ethers, provider, address, contracts = DJUKE_EARNING_CONTRACTS }) {
  const entries = [];
  await Promise.all(contracts.map(async source => {
    const contract = new ethers.Contract(source.address, DJUKE_ABI, provider);
    if (source.ledger) {
      const ledger = await contract.artistLedger(address);
      const paid = BigInt(ledger.totalPaid ?? ledger[0]);
      if (paid > 0n) entries.push({ key: `${source.address}:ledger`, label: `${source.label} song plays`, status: 'paid', asset: 'USDC',
        units: paid, count: Number(ledger.payoutCount ?? ledger[1]), proofUrl: readProof(source.address), proofLabel: 'artistLedger' });
    }
    const credits = BigInt(await contract.artistCredits(address));
    if (credits > 0n) entries.push({ key: `${source.address}:credits`, label: `${source.label} song plays`, status: 'unclaimed', asset: 'USDC',
      units: credits, count: 0, proofUrl: readProof(source.address), proofLabel: 'artistCredits' });
  }));
  return entries;
}

export async function fetchWorkerEarnings({ fetch: fetchImpl = globalThis.fetch, serviceUrl, address, timeoutMs = 15000 }) {
  const base = String(serviceUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Worker URL is not configured');
  const response = await fetchImpl(`${base}/api/earnings/${address}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Earnings index unavailable (${response.status})`);
  if (!result || typeof result !== 'object') throw new Error('Earnings index returned an invalid response');
  return result;
}

export async function verifyGroupedEarningsProofs({ ethers, provider, address, entries, contracts = DJUKE_EARNING_CONTRACTS }) {
  const iface = new ethers.Interface([PAYROLL_EVENT, WITHDRAW_EVENT]);
  const byHash = new Map();
  for (const entry of entries) {
    for (const tx of entry.transactions || []) {
      if (!byHash.has(tx.hash)) byHash.set(tx.hash, []);
      byHash.get(tx.hash).push({ entry, tx });
    }
  }
  const verifiedTx = new Set();
  const contractByAddress = new Map(contracts.map(source => [source.address.toLowerCase(), source]));
  for (const [txHash, pairings] of byHash) {
    const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
    if (!receipt || receipt.status !== 1) continue;
    const lowerAddress = address.toLowerCase();
    let matched = false;
    for (const log of receipt.logs || []) {
      let event;
      try { event = iface.parseLog(log); } catch { continue; }
      if (event?.name === 'PayrollPaid') {
        const recipient = String(event.args.recipient || '').toLowerCase();
        const fundId = String(event.args.fundId || '').toLowerCase();
        if (log.address?.toLowerCase() !== ROUTER_ADDRESS.toLowerCase() || recipient !== lowerAddress) continue;
        for (const { entry, tx } of pairings) {
          if (entry.kind !== EARNINGS_KIND.payroll) continue;
          if (entry.fundId && String(entry.fundId).toLowerCase() !== fundId) continue;
          if (String(tx.units || '0') !== String(event.args.amount.toString())) continue;
          matched = true;
          verifiedTx.add(txHash);
        }
      } else if (event?.name === 'ArtistWithdrawal') {
        const artist = String(event.args.artist || '').toLowerCase();
        if (artist !== lowerAddress) continue;
        const source = contractByAddress.get(log.address?.toLowerCase() || '');
        for (const { entry, tx } of pairings) {
          if (entry.kind !== EARNINGS_KIND.withdrawal) continue;
          if (entry.contract && entry.contract.toLowerCase() !== log.address.toLowerCase()) continue;
          if (String(tx.units || '0') !== String(event.args.amount.toString())) continue;
          matched = true;
          verifiedTx.add(txHash);
        }
      }
    }
    if (!matched) continue;
  }
  return entries.filter(entry => !entry.transactions?.length || entry.transactions.every(tx => verifiedTx.has(tx.hash)));
}

async function getLogsWithRetry(provider, filter, fromBlock, toBlock, wait, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await provider.getLogs({ ...filter, fromBlock, toBlock });
    } catch (error) {
      lastError = error;
      const message = `${error?.shortMessage || ''} ${error?.message || ''}`;
      if (!/limit|rate|timeout|too many|429|503|502|exceed/i.test(message) || attempt === attempts - 1) throw error;
      const delay = 250 * 2 ** attempt;
      await wait(delay);
    }
  }
  throw lastError;
}

export function createEarningsLedger({
  ethers,
  provider,
  restore = async () => null,
  save = async () => '',
  startBlock = ROUTER_START_BLOCK,
  chunkSize = 2000,
  contracts = DJUKE_EARNING_CONTRACTS,
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  now = () => Date.now(),
  log = console,
} = {}) {
  const iface = new ethers.Interface([PAYROLL_EVENT, WITHDRAW_EVENT]);
  const contractMap = new Map(contracts.map(source => [source.address.toLowerCase(), source]));
  let items = [];
  let scannedFrom = null;
  let scannedThrough = null;
  let lastCheckedAt = null;
  let lastError = '';
  let task = Promise.resolve();

  const run = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };

  function snapshot() {
    return { schemaVersion: 1, chainId: 8453, routerAddress: ROUTER_ADDRESS, scannedFrom, scannedThrough, lastCheckedAt, items };
  }

  async function getBlockTimestamp(blockNumber) {
    const block = await provider.getBlock(blockNumber).catch(() => null);
    return Number(block?.timestamp || 0);
  }

  async function scanRange(fromBlock, toBlock) {
    const [payroll, withdrawals] = await Promise.all([
      getLogsWithRetry(provider, {
        address: ROUTER_ADDRESS,
        topics: [iface.getEvent('PayrollPaid').topicHash],
      }, fromBlock, toBlock, wait),
      getLogsWithRetry(provider, {
        address: contracts.map(source => source.address),
        topics: [iface.getEvent('ArtistWithdrawal').topicHash],
      }, fromBlock, toBlock, wait),
    ]);
    const next = [];
    for (const logEntry of payroll) {
      const event = iface.parseLog(logEntry);
      if (!event || event.name !== 'PayrollPaid') continue;
      next.push({
        kind: EARNINGS_KIND.payroll,
        fundId: event.args.fundId,
        fundLabel: fundLabel(event.args.fundId, ethers),
        asset: assetSymbol(event.args.asset),
        units: event.args.amount.toString(),
        recipient: event.args.recipient,
        txHash: logEntry.transactionHash,
        logIndex: Number(logEntry.index ?? logEntry.logIndex ?? 0),
        blockNumber: Number(logEntry.blockNumber),
        timestamp: await getBlockTimestamp(logEntry.blockNumber),
      });
    }
    for (const logEntry of withdrawals) {
      const event = iface.parseLog(logEntry);
      if (!event || event.name !== 'ArtistWithdrawal') continue;
      const source = contractMap.get(String(logEntry.address || '').toLowerCase()) || null;
      next.push({
        kind: EARNINGS_KIND.withdrawal,
        contract: logEntry.address,
        contractLabel: source?.label || 'DJuke',
        asset: 'USDC',
        units: event.args.amount.toString(),
        artist: event.args.artist,
        txHash: logEntry.transactionHash,
        logIndex: Number(logEntry.index ?? logEntry.logIndex ?? 0),
        blockNumber: Number(logEntry.blockNumber),
        timestamp: await getBlockTimestamp(logEntry.blockNumber),
      });
    }
    return next;
  }

  async function refresh() {
    return run(async () => {
      try {
        const head = await provider.getBlockNumber();
        if (scannedFrom === null) scannedFrom = Number.isSafeInteger(startBlock) && startBlock >= 0 ? startBlock : ROUTER_START_BLOCK;
        if (scannedThrough === null) scannedThrough = scannedFrom - 1;
        let changed = false;
        for (let from = Math.max(scannedFrom, scannedThrough + 1); from <= head; from += chunkSize) {
          const to = Math.min(head, from + chunkSize - 1);
          const next = await scanRange(from, to);
          if (next.length) {
            const existing = new Map(items.map(item => [`${item.txHash}:${item.logIndex}`, item]));
            for (const item of next) existing.set(`${item.txHash}:${item.logIndex}`, item);
            items = [...existing.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
            changed = true;
          }
          scannedThrough = to;
        }
        lastCheckedAt = new Date(now()).toISOString();
        if (changed || !items.length) await save(snapshot());
      } catch (error) {
        lastError = error.message;
        throw error;
      }
      return getState();
    });
  }

  async function initialize() {
    const saved = await restore();
    if (saved) {
      if (saved.schemaVersion !== 1 || saved.chainId !== 8453 || saved.routerAddress?.toLowerCase() !== ROUTER_ADDRESS.toLowerCase() || !Array.isArray(saved.items)) {
        throw new Error('Invalid earnings checkpoint');
      }
      items = saved.items;
      scannedFrom = saved.scannedFrom;
      scannedThrough = saved.scannedThrough;
      lastCheckedAt = saved.lastCheckedAt || null;
    }
    return refresh();
  }

  function getState() {
    return {
      ...snapshot(),
      lastCheckedAt,
      lastError,
      ready: Boolean(lastCheckedAt),
    };
  }

  function getAddressState(address) {
    const normalized = String(address || '').toLowerCase();
    const filtered = items.filter(item => String(item.recipient || item.artist || '').toLowerCase() === normalized);
    return { ready: Boolean(lastCheckedAt), through: scannedThrough, lastCheckedAt, entries: filtered };
  }

  return { initialize, refresh, getState, getAddressState };
}

async function getLogsAdaptive(provider, filter, fromBlock, toBlock, budget) {
  if (budget.remaining-- <= 0) throw new Error('Log scan budget exhausted');
  try {
    return await provider.getLogs({ ...filter, fromBlock, toBlock });
  } catch (error) {
    let message = `${error?.shortMessage || ''} ${error?.message || ''}`;
    try { message += JSON.stringify(error?.error || error?.info || ''); } catch { /* non-serializable detail */ }
    if (toBlock - fromBlock < 2000 || !/range|too many|exceed|more than|results/i.test(message)) throw error;
    const middle = Math.floor((fromBlock + toBlock) / 2);
    const left = await getLogsAdaptive(provider, filter, fromBlock, middle, budget);
    return left.concat(await getLogsAdaptive(provider, filter, middle + 1, toBlock, budget));
  }
}

function readCache(storage, address) {
  try { return JSON.parse(storage?.getItem(CACHE_PREFIX + address.toLowerCase()) || 'null'); } catch { return null; }
}

function writeCache(storage, address, value) {
  try { storage?.setItem(CACHE_PREFIX + address.toLowerCase(), JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

// Event-based earnings (router payroll payouts and DJuke credit withdrawals). Needs eth_getLogs,
// which public Base RPCs mostly refuse, so callers pass providers in preference order.
export async function scanLogEarnings({ ethers, providers, address, storage = globalThis.localStorage, contracts = DJUKE_EARNING_CONTRACTS, maxRequests = 96, timeoutMs = 25000 }) {
  const iface = new ethers.Interface([PAYROLL_EVENT, WITHDRAW_EVENT]);
  const recipientTopic = ethers.zeroPadValue(address, 32).toLowerCase();
  const cached = readCache(storage, address);
  let lastError = null;
  for (const provider of providers.filter(Boolean)) {
    let timer;
    try {
      const scan = scanProvider(provider);
      scan.catch(() => {});
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Log scan timed out')), timeoutMs); });
      const unique = await Promise.race([scan, timeout]);
      writeCache(storage, address, unique.cache);
      return { complete: true, entries: groupLogEarnings(unique.items, ethers, contracts) };
    } catch (error) { lastError = error; } finally { clearTimeout(timer); }
  }
  if (cached?.items) return { complete: false, partialThrough: cached.through, entries: groupLogEarnings(cached.items, ethers, contracts), error: lastError };
  return { complete: false, entries: [], error: lastError };

  async function scanProvider(provider) {
    const head = Number(await provider.getBlockNumber()) - 2;
    const from = Math.max(ROUTER_START_BLOCK, Number(cached?.through || 0) + 1);
    const items = [...(cached?.items || [])];
    if (from <= head) {
      const budget = { remaining: maxRequests };
      const payroll = await getLogsAdaptive(provider, { address: ROUTER_ADDRESS,
        topics: [iface.getEvent('PayrollPaid').topicHash, null, null, recipientTopic] }, from, head, budget);
      for (const log of payroll) {
        const event = iface.parseLog(log);
        items.push({ kind: 'payroll', fundId: event.args.fundId, asset: event.args.asset, units: event.args.amount.toString(),
          txHash: log.transactionHash, logIndex: Number(log.index ?? log.logIndex), blockNumber: Number(log.blockNumber) });
      }
      const withdrawals = await getLogsAdaptive(provider, { address: contracts.map(source => source.address),
        topics: [iface.getEvent('ArtistWithdrawal').topicHash, recipientTopic] },
        Math.max(from, Math.min(...contracts.map(source => source.startBlock))), head, budget);
      for (const log of withdrawals) {
        const event = iface.parseLog(log);
        items.push({ kind: 'withdrawal', contract: log.address, units: event.args.amount.toString(), txHash: log.transactionHash,
          logIndex: Number(log.index ?? log.logIndex), blockNumber: Number(log.blockNumber) });
      }
    }
    const unique = [...new Map(items.map(item => [`${item.txHash}:${item.logIndex}`, item])).values()];
    return { items: unique, cache: { through: Math.max(head, Number(cached?.through || 0)), items: unique } };
  }
}

export const BLOCKSCOUT_API = 'https://base.blockscout.com/api';

// Blockscout's indexed log API works from browsers without a key, unlike public eth_getLogs.
async function blockscoutLogs(fetchImpl, { address, fromBlock, topic0, topicIndex, topicValue, pageLimit = 20 }) {
  const logs = [];
  let from = fromBlock;
  for (let page = 0; page < pageLimit; page++) {
    const params = new URLSearchParams({ module: 'logs', action: 'getLogs', address, fromBlock: String(from), toBlock: 'latest',
      topic0, [`topic${topicIndex}`]: topicValue, [`topic0_${topicIndex}_opr`]: 'and' });
    const response = await fetchImpl(`${BLOCKSCOUT_API}?${params}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Blockscout logs unavailable (${response.status})`);
    const body = await response.json();
    const result = Array.isArray(body.result) ? body.result : [];
    if (body.status !== '1' && !(body.status === '0' && /no (records|logs)/i.test(body.message || '') && !result.length)) {
      throw new Error(`Blockscout logs: ${body.message || 'unexpected response'}`);
    }
    logs.push(...result);
    if (result.length < 1000) return logs;
    // A full page may end mid-block; resume from that block and dedupe later.
    from = Number(BigInt(result[result.length - 1].blockNumber));
  }
  throw new Error('Blockscout log pagination limit reached');
}

export async function scanBlockscoutEarnings({ ethers, address, fetch: fetchImpl = globalThis.fetch, contracts = DJUKE_EARNING_CONTRACTS, timeoutMs = 20000 }) {
  const iface = new ethers.Interface([PAYROLL_EVENT, WITHDRAW_EVENT]);
  const recipientTopic = ethers.zeroPadValue(address, 32).toLowerCase();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Blockscout scan timed out')), timeoutMs); });
  const parse = log => iface.parseLog({ topics: log.topics.filter(Boolean), data: log.data });
  const base = log => ({ txHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)), blockNumber: Number(BigInt(log.blockNumber)) });
  const scan = (async () => {
    const [payroll, ...withdrawals] = await Promise.all([
      blockscoutLogs(fetchImpl, { address: ROUTER_ADDRESS, fromBlock: ROUTER_START_BLOCK,
        topic0: iface.getEvent('PayrollPaid').topicHash, topicIndex: 3, topicValue: recipientTopic }),
      ...contracts.map(source => blockscoutLogs(fetchImpl, { address: source.address, fromBlock: source.startBlock,
        topic0: iface.getEvent('ArtistWithdrawal').topicHash, topicIndex: 1, topicValue: recipientTopic })),
    ]);
    const items = [];
    for (const log of payroll) {
      if (String(log.address).toLowerCase() !== ROUTER_ADDRESS.toLowerCase()) continue;
      const event = parse(log);
      if (event?.name !== 'PayrollPaid' || event.args.recipient.toLowerCase() !== address.toLowerCase()) continue;
      items.push({ kind: 'payroll', fundId: event.args.fundId, asset: event.args.asset, units: event.args.amount.toString(), ...base(log) });
    }
    withdrawals.flat().forEach(log => {
      const event = parse(log);
      if (event?.name !== 'ArtistWithdrawal' || event.args.artist.toLowerCase() !== address.toLowerCase()) return;
      items.push({ kind: 'withdrawal', contract: log.address, units: event.args.amount.toString(), ...base(log) });
    });
    return [...new Map(items.map(item => [`${item.txHash}:${item.logIndex}`, item])).values()];
  })();
  scan.catch(() => {});
  try {
    const items = await Promise.race([scan, timeout]);
    return { complete: true, source: 'blockscout', entries: groupLogEarnings(items, ethers, contracts) };
  } finally { clearTimeout(timer); }
}

export function groupLogEarnings(items, ethers, contracts = DJUKE_EARNING_CONTRACTS) {
  const groups = new Map();
  for (const item of items) {
    const asset = item.kind === 'payroll' ? assetSymbol(item.asset) : 'USDC';
    const label = item.kind === 'payroll' ? fundLabel(item.fundId, ethers)
      : `${contracts.find(source => source.address.toLowerCase() === String(item.contract).toLowerCase())?.label || 'DJuke'} claimed credits`;
    const key = `${label}:${asset}`;
    const group = groups.get(key) || { key, kind: item.kind, label, status: 'paid', asset, units: 0n, count: 0, transactions: [], ...(item.kind === 'payroll' ? { fundId: item.fundId } : {}), ...(item.kind === 'withdrawal' ? { contract: item.contract } : {}) };
    group.units += BigInt(item.units);
    group.count += 1;
    group.transactions.push({ hash: item.txHash, units: item.units, blockNumber: item.blockNumber, url: txProof(item.txHash) });
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({ ...group, transactions: group.transactions.sort((a, b) => b.blockNumber - a.blockNumber) }));
}

export function summarizeEarnings(entries) {
  const totals = {};
  for (const entry of entries) {
    const bucket = totals[entry.asset] ||= { paid: 0n, unclaimed: 0n };
    bucket[entry.status === 'unclaimed' ? 'unclaimed' : 'paid'] += BigInt(entry.units);
  }
  return totals;
}
