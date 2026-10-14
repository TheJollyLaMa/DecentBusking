import { Interface, id } from 'ethers';
import { configuredSettlementFunds } from '../js/settlement-funds.mjs';

const FUND_FUND_EVENT_ABI = ['event FundFunded(bytes32 indexed fundId, address indexed asset, address indexed funder, uint256 amount)'];
const eventInterface = new Interface(FUND_FUND_EVENT_ABI);

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
  let task = Promise.resolve();
  const blockCache = new Map();
  const txCache = new Map();

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
    const amount = toBigIntString(entry.amountUnits);
    const devert = snapshots.devert ?? await (readDevertState ? readDevertState().catch(() => null) : Promise.resolve(null));
    const djuke = snapshots.djuke ?? await (readDjukeState ? readDjukeState().catch(() => null) : Promise.resolve(null));
    const campaign = devert?.campaigns?.find(item => normalizeAddress(item.advertiser) === funder && toBigIntString(item.paidUnits) === amount);
    if (campaign) {
      return {
        ...entry,
        slug: fund.slug,
        label: fund.label,
        description: fund.description,
        kind: 'advert',
        campaignId: campaign.campaignId,
        title: campaign.title,
        advertiser: campaign.advertiser,
      };
    }
    const request = djuke?.requests?.find(item => normalizeAddress(item.payer) === funder && toBigIntString(item.amountUnits) === amount);
    if (request) {
      return {
        ...entry,
        slug: fund.slug,
        label: fund.label,
        description: fund.description,
        kind: 'djuke',
        payer: request.payer,
        requestId: request.chainRequestId,
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

  async function scanRange(fromBlock, toBlock, snapshots = {}) {
    if (fromBlock > toBlock) return false;
    const filter = router.filters?.FundFunded?.();
    const logs = filter
      ? await router.queryFilter(filter, fromBlock, toBlock)
      : await provider.getLogs({ address: routerAddress, topics: [eventInterface.getEvent('FundFunded').topicHash], fromBlock, toBlock });
    if (!logs.length) return false;
    const existing = new Map(sources.map(source => [`${source.txHash}:${source.logIndex}`, source]));
    let changed = false;
    for (const logEntry of logs) {
      const parsed = eventInterface.parseLog(logEntry);
      const key = `${logEntry.transactionHash}:${logEntry.index ?? logEntry.logIndex ?? 0}`;
      const tx = await getTransaction(logEntry.transactionHash);
      const next = await classifySource({
        fundId: parsed.args.fundId,
        funder: parsed.args.funder || tx?.from || '',
        amountUnits: parsed.args.amount.toString(),
        txHash: logEntry.transactionHash,
        blockNumber: logEntry.blockNumber,
        timestamp: await getBlockTimestamp(logEntry.blockNumber),
        logIndex: Number(logEntry.index ?? logEntry.logIndex ?? 0),
      }, snapshots);
      if (!next) continue;
      if (JSON.stringify(existing.get(key)) !== JSON.stringify(next)) {
        existing.set(key, next);
        changed = true;
      }
    }
    if (changed) sources = [...existing.values()].sort((first, second) => second.blockNumber - first.blockNumber || second.logIndex - first.logIndex);
    return changed;
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
        backupPending = true;
        lastCheckedAt = new Date(now()).toISOString();
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
      if (scannedFrom != null && (!Number.isSafeInteger(scannedFrom) || scannedFrom < 0)) throw new Error('Invalid fund scan checkpoint');
      if (scannedThrough != null && (!Number.isSafeInteger(scannedThrough) || scannedThrough < scannedFrom - 1)) throw new Error('Invalid fund scan checkpoint');
    }
    return refresh();
  }

  async function buildFundState() {
    const weekly = getWeeklyPayflow ? await getWeeklyPayflow().catch(() => null) : null;
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
