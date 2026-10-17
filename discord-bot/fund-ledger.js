import { Contract, Interface, id } from 'ethers';
import { DEVERT_QUEUE_ABI, devertQueueAbi } from '../js/devert-queue.mjs';
import { configuredSettlementFunds } from '../js/settlement-funds.mjs';
import { normalizeKnownAddress } from '../js/known-addresses.mjs';

const FUND_EVENT_ABI = [
  'event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)',
  'event PayrollPaid(bytes32 indexed fundId, address indexed asset, address indexed recipient, uint256 amount, bytes32 workReference, bytes32 repositoryIdHash, bytes32 contributorIdHash, string metadataUri, bytes32 metadataHash)',
];
const eventInterface = new Interface(FUND_EVENT_ABI);
const FUNDED_TOPIC = eventInterface.getEvent('FundFunded').topicHash;
const PAID_TOPIC = eventInterface.getEvent('PayrollPaid').topicHash;
const paidAdvertInterface = new Interface(DEVERT_QUEUE_ABI);
const PAID_AD_TOPIC = paidAdvertInterface.getEvent('AdFulfilled').topicHash;

function normalizeAddress(value) {
  return String(value || '').toLowerCase();
}

function toBigIntString(value) {
  return typeof value === 'bigint' ? value.toString() : String(value || '0');
}

export function createFundLedger({
  provider,
  router,
  config,
  getWeeklyPayflow,
  readDevertState,
  readDjukeState,
  restore = async () => null,
  save = null,
  schedule,
  startBlock = 0,
  chunkSize = 2000,
  now = () => Date.now(),
  log = console,
}) {
  const routerAddress = normalizeAddress(router?.target || router?.address || config.routerAddress);
  const funds = configuredSettlementFunds(config);
  const fundIds = new Map(funds.map(fund => [normalizeAddress(id(fund.slug)), fund]));
  let scannedFrom = null;
  let scannedThrough = null;
  let lastCheckedAt = null;
  let lastError = '';
  let backupPending = false;
  let sources = [];
  // Payouts are indexed alongside deposits (same getLogs call) so browsers never need a log indexer.
  let payouts = [];
  let task = Promise.resolve();
  const blockCache = new Map();
  const txCache = new Map();
  const receiptCache = new Map();
  const paidAdAddress = normalizeAddress(config.devertQueueContractAddress);
  const paidAdQueues = new Map();
  const legacyAdAddress = '0x9ebf98367319e6c8b15b5517d808ccfeb3ddda61';
  paidAdQueues.set(legacyAdAddress, new Contract(legacyAdAddress, devertQueueAbi(1), provider));
  if (paidAdAddress) paidAdQueues.set(paidAdAddress,
    new Contract(paidAdAddress, devertQueueAbi(config.devertQueueVersion ?? 1), provider));

  const run = operation => {
    const result = task.then(operation);
    task = result.catch(() => {});
    return result;
  };

  function snapshot() {
    return {
      schemaVersion: 1,
      chainId: 8453,
      routerAddress,
      scannedFrom,
      scannedThrough,
      lastCheckedAt,
      sources,
      payouts,
    };
  }

  async function getBlockTimestamp(blockNumber) {
    if (!blockCache.has(blockNumber)) {
      blockCache.set(blockNumber, provider.getBlock(blockNumber).then(block => block?.timestamp ? Number(block.timestamp) : 0));
    }
    return blockCache.get(blockNumber);
  }

  async function getTransaction(txHash) {
    if (!txCache.has(txHash)) txCache.set(txHash, provider.getTransaction(txHash).catch(() => null));
    return txCache.get(txHash);
  }

  async function classifySource(entry, snapshots = {}) {
    const fundId = normalizeAddress(entry.fundId);
    const fund = fundIds.get(fundId);
    if (!fund) return null;
    const funder = normalizeAddress(entry.funder);
    const txHash = normalizeAddress(entry.txHash);
    const amount = toBigIntString(entry.amountUnits);
    const paidAdQueue = paidAdQueues.get(funder);
    if (paidAdQueue) {
      let receipt = receiptCache.get(txHash);
      if (!receipt) {
        receipt = await provider.getTransactionReceipt(txHash);
        if (receipt?.status !== 1) throw new Error(`Paid advert settlement receipt unavailable: ${txHash}`);
        receiptCache.set(txHash, receipt);
      }
      const fulfilled = receipt.logs.find(logEntry => normalizeAddress(logEntry.address) === funder &&
        logEntry.topics[0] === PAID_AD_TOPIC && Number(logEntry.index ?? logEntry.logIndex) > entry.logIndex);
      if (!fulfilled) throw new Error(`Paid advert settlement event unavailable: ${txHash}:${entry.logIndex}`);
      const { args } = paidAdvertInterface.parseLog(fulfilled);
      const request = await paidAdQueue.getRequest(args.requestId, { blockTag: entry.blockNumber });
      return { ...entry, slug: fund.slug, label: fund.label, description: fund.description,
        kind: 'advert', paidAdvert: true, requestId: args.requestId.toString(),
        campaignId: request.campaignId.toString(), title: request.title,
        payer: request.payer, advertiser: request.advertiser,
        ...(request.tier !== undefined ? { priorityTier: Number(request.tier) } : {}) };
    }
    const devertContract = normalizeKnownAddress(config.devertContractAddress || '0x135Cbc573F87637158eb3186C87c584fb0B34CD9');
    const djukeContract = normalizeKnownAddress(config.djukeContractAddress || '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9');
    const devert = snapshots.devert ?? await (readDevertState ? readDevertState().catch(() => null) : Promise.resolve(null));
    const djuke = snapshots.djuke ?? await (readDjukeState ? readDjukeState().catch(() => null) : Promise.resolve(null));
    const campaign = devert?.campaigns?.find(item =>
      (txHash && normalizeAddress(item.txHash || item.purchaseTxHash || item.transactionHash || item.eventTxHash) === txHash) ||
      (normalizeAddress(item.advertiser) === funder && toBigIntString(item.paidUnits) === amount));
    if (funder === devertContract || campaign) {
      return {
        ...entry,
        slug: fund.slug,
        label: fund.label,
        description: fund.description,
        kind: 'advert',
        campaignId: campaign?.campaignId,
        title: campaign?.title,
        advertiser: campaign?.advertiser,
      };
    }
    const request = djuke?.requests?.find(item =>
      (txHash && normalizeAddress(item.txHash || item.purchaseTxHash || item.transactionHash || item.eventTxHash) === txHash) ||
      (normalizeAddress(item.payer) === funder && toBigIntString(item.amountUnits) === amount));
    if (funder === djukeContract || request) {
      return {
        ...entry,
        slug: fund.slug,
        label: fund.label,
        description: fund.description,
        kind: 'djuke',
        payer: request?.payer,
        requestId: request?.chainRequestId,
      };
    }
    return {
      ...entry,
      slug: fund.slug,
      label: fund.label,
      description: fund.description,
      kind: 'sponsor',
    };
  }

  async function fetchLogs(fromBlock, toBlock) {
    if (typeof provider.getLogs === 'function') {
      return provider.getLogs({ address: routerAddress, topics: [[FUNDED_TOPIC, PAID_TOPIC]], fromBlock, toBlock });
    }
    const filter = router.filters?.FundFunded?.();
    return router.queryFilter(filter, fromBlock, toBlock);
  }

  async function scanRange(fromBlock, toBlock, snapshots = {}) {
    if (fromBlock > toBlock) return false;
    const logs = await fetchLogs(fromBlock, toBlock);
    if (!logs.length) return false;
    const existing = new Map(sources.map(source => [`${source.txHash}:${source.logIndex}`, source]));
    const existingPayouts = new Map(payouts.map(payout => [`${payout.txHash}:${payout.logIndex}`, payout]));
    let changed = false;
    let payoutsChanged = false;
    for (const logEntry of logs) {
      const parsed = eventInterface.parseLog(logEntry);
      if (!parsed) continue;
      const logIndex = Number(logEntry.index ?? logEntry.logIndex ?? 0);
      const key = `${logEntry.transactionHash}:${logIndex}`;
      if (parsed.name === 'PayrollPaid') {
        const fund = fundIds.get(normalizeAddress(parsed.args.fundId));
        if (!fund || existingPayouts.has(key)) continue;
        existingPayouts.set(key, {
          fundId: parsed.args.fundId,
          slug: fund.slug,
          asset: parsed.args.asset,
          recipient: parsed.args.recipient,
          amountUnits: parsed.args.amount.toString(),
          workReference: parsed.args.workReference,
          metadataUri: parsed.args.metadataUri,
          txHash: logEntry.transactionHash,
          blockNumber: logEntry.blockNumber,
          timestamp: await getBlockTimestamp(logEntry.blockNumber),
          logIndex,
        });
        payoutsChanged = true;
        continue;
      }
      const tx = await getTransaction(logEntry.transactionHash);
      const next = await classifySource({
        fundId: parsed.args.fundId,
        funder: parsed.args.funder || tx?.from || '',
        amountUnits: parsed.args.amount.toString(),
        txHash: logEntry.transactionHash,
        blockNumber: logEntry.blockNumber,
        timestamp: await getBlockTimestamp(logEntry.blockNumber),
        logIndex,
      }, snapshots);
      if (!next) continue;
      if (JSON.stringify(existing.get(key)) !== JSON.stringify(next)) {
        existing.set(key, next);
        changed = true;
      }
    }
    const newestFirst = (first, second) => second.blockNumber - first.blockNumber || second.logIndex - first.logIndex;
    if (changed) sources = [...existing.values()].sort(newestFirst);
    if (payoutsChanged) payouts = [...existingPayouts.values()].sort(newestFirst);
    return changed || payoutsChanged;
  }

  async function persistIfNeeded() {
    if (!backupPending) return;
    if (typeof save !== 'function') { backupPending = false; return; }
    const next = await save(snapshot());
    if (!/^ipfs:\/\//.test(next)) throw new Error('Fund source checkpoint did not return an IPFS URI');
    backupPending = false;
  }

  async function refresh() {
    return run(async () => {
      try {
        lastError = '';
        const head = await provider.getBlockNumber();
        const previousCursor = scannedThrough;
        const snapshots = {
          devert: readDevertState ? await readDevertState().catch(() => null) : null,
          djuke: readDjukeState ? await readDjukeState().catch(() => null) : null,
        };
        if (scannedFrom == null) scannedFrom = Number.isSafeInteger(startBlock) && startBlock >= 0 ? startBlock : 0;
        if (scannedThrough == null) scannedThrough = scannedFrom - 1;
        const end = head;
        let changed = false;
        for (let from = Math.max(scannedFrom, scannedThrough + 1); from <= end; from += chunkSize) {
          const to = Math.min(end, from + chunkSize - 1);
          if (await scanRange(from, to, snapshots)) changed = true;
          scannedThrough = to;
        }
        lastCheckedAt = new Date(now()).toISOString();
        if (changed || previousCursor === null) backupPending = true;
        else if (scannedThrough !== previousCursor) {
          if (schedule && !backupPending) schedule(snapshot());
          else backupPending = true;
        }
        await persistIfNeeded();
      } catch (error) {
        lastError = error.message;
        throw error;
      }
      return buildFundState();
    });
  }

  async function initialize() {
    const saved = typeof restore === 'function' ? await restore() : null;
    if (saved) {
      if (saved.schemaVersion !== 1 || saved.chainId !== 8453 || normalizeAddress(saved.routerAddress) !== routerAddress || !Array.isArray(saved.sources)) {
        throw new Error('Invalid fund source checkpoint');
      }
      scannedFrom = saved.scannedFrom;
      scannedThrough = saved.scannedThrough;
      lastCheckedAt = saved.lastCheckedAt || null;
      sources = saved.sources;
      if (Array.isArray(saved.payouts)) payouts = saved.payouts;
      // Checkpoints from before payouts were indexed rescan once from the start to backfill them.
      else if (typeof provider.getLogs === 'function') scannedThrough = null;
      if (scannedFrom != null && (!Number.isSafeInteger(scannedFrom) || scannedFrom < 0)) throw new Error('Invalid fund scan checkpoint');
      if (scannedThrough != null && (!Number.isSafeInteger(scannedThrough) || scannedThrough < scannedFrom - 1)) throw new Error('Invalid fund scan checkpoint');
    }
    return refresh();
  }

  async function buildFundState() {
    const weekly = getWeeklyPayflow ? await Promise.resolve().then(() => getWeeklyPayflow()).catch(() => null) : null;
    const weeklyFunds = weekly?.funds || {};
    const bySlug = new Map();
    for (const fund of funds) {
      const balanceUnits = await router.fundBalances(id(fund.slug), config.assets.USDC.address).then(value => value.toString()).catch(() => '0');
      const reservedUnits = fund.slug === 'dbusk-playback'
        ? weeklyFunds.playback?.reservedUnits
        : fund.slug === 'dbusk-top10'
          ? weeklyFunds.top10?.reservedUnits
          : null;
      const availableUnits = fund.slug === 'dbusk-playback'
        ? weeklyFunds.playback?.availableUnits
        : fund.slug === 'dbusk-top10'
          ? weeklyFunds.top10?.availableUnits
          : balanceUnits;
      bySlug.set(fund.slug, {
        slug: fund.slug,
        label: fund.label,
        description: fund.description,
        balanceUnits,
        ...(reservedUnits != null ? { reservedUnits } : {}),
        availableUnits: availableUnits ?? balanceUnits,
      });
    }
    const grouped = new Map(funds.map(fund => [fund.slug, []]));
    for (const source of sources) {
      const list = grouped.get(source.slug);
      if (list) list.push(source);
    }
    const paidBySlug = new Map(funds.map(fund => [fund.slug, []]));
    for (const payout of payouts) paidBySlug.get(payout.slug)?.push(payout);
    const payoutsIndexed = typeof provider.getLogs === 'function';
    return {
      schemaVersion: 1,
      chainId: 8453,
      routerAddress,
      lastCheckedAt,
      lastError,
      ready: Boolean(lastCheckedAt),
      sponsorAliases: config.sponsorAliases || {},
      funds: Object.fromEntries([...bySlug.values()].map(fund => {
        const sourceList = (grouped.get(fund.slug) || []).sort((first, second) => second.blockNumber - first.blockNumber || second.logIndex - first.logIndex);
        const totals = sourceList.reduce((acc, source) => {
          acc[source.kind] = (acc[source.kind] || 0n) + BigInt(source.amountUnits || '0');
          return acc;
        }, { advert: 0n, sponsor: 0n, djuke: 0n });
        return [fund.slug, {
          ...fund,
          ...bySlug.get(fund.slug),
          sources: sourceList,
          ...(payoutsIndexed ? {
            payouts: paidBySlug.get(fund.slug) || [],
            payoutUnits: (paidBySlug.get(fund.slug) || []).reduce((sum, payout) => sum + BigInt(payout.amountUnits || '0'), 0n).toString(),
          } : {}),
          advertUnits: totals.advert.toString(),
          sponsorUnits: totals.sponsor.toString(),
          djukeUnits: totals.djuke.toString(),
        }];
      })),
    };
  }

  function getState() {
    return {
      ...snapshot(),
      lastCheckedAt,
      lastError,
      backupPending,
      ready: Boolean(lastCheckedAt),
      sponsorAliases: config.sponsorAliases || {},
      funds: Object.fromEntries(funds.map(fund => [fund.slug, {
        slug: fund.slug,
        label: fund.label,
        description: fund.description,
        balanceUnits: '0',
        availableUnits: '0',
        sources: [],
        advertUnits: '0',
        sponsorUnits: '0',
        djukeUnits: '0',
      }])),
    };
  }

  return { initialize, refresh, getState, getCurrentState: buildFundState };
}
