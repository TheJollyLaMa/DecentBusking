import { id } from 'ethers';
import { currentPayrollPeriod, PAYROLL_TIME_ZONE } from '../js/payroll-week.mjs';
import { finalizeRadioAllocation, previewPlaybackPayroll, previewTopTenPayroll, validateRadioReceipt } from '../js/radio-payroll.mjs';
import { BASE_USDC_ADDRESS } from '../js/settlement-funds.mjs';

export function createWeeklyPayflow({ router, config, getReports, upload, restore = async () => null, save, getClosingBalance, now = () => Date.now() }) {
  const minimumUnits = BigInt(config.radioPayflow?.minimumPayoutUnits || '10000');
  const significantUnits = BigInt(config.radioPayflow?.significantShareUnits || '1000000');
  const shareBps = config.radioPayflow?.fundShareBps ?? 10000;
  if (config.radioPayflow?.timeZone && config.radioPayflow.timeZone !== PAYROLL_TIME_ZONE) throw new Error('Weekly payflow timezone must be America/New_York');
  if (!Number.isInteger(shareBps) || shareBps < 1 || shareBps > 10000 || minimumUnits < 1n || significantUnits < minimumUnits) throw new Error('Invalid weekly payflow policy');
  const asset = config.assets.USDC.address;
  if (asset.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) throw new Error('Weekly payflow requires native Base USDC');
  let allocations = [];
  let funds = {};
  let ready = false;
  let backupPending = false;
  let lastCheckedAt = null;
  let lastError = '';
  let pending = null;
  let latestReports = [];
  const receiptConfig = { routerAddress: config.routerAddress, assetAddress: asset, funds: config.radioFunds };
  async function initialize() {
    const saved = await restore();
    if (saved) {
      if (saved.schemaVersion !== 1 || saved.routerAddress?.toLowerCase() !== config.routerAddress.toLowerCase() || !Array.isArray(saved.allocations)) throw new Error('Invalid weekly payflow checkpoint');
      const keys = new Set();
      for (const record of saved.allocations) {
        validateRadioReceipt(record.allocation, receiptConfig);
        if (record.allocation.schemaVersion !== 3 || id(JSON.stringify(record.allocation)) !== record.metadataHash || !/^ipfs:\/\/[^/\s]+$/.test(record.metadataUri)) throw new Error('Scheduled allocation proof is invalid');
        const key = `${record.allocation.week}:${record.allocation.category}`;
        if (keys.has(key)) throw new Error('Duplicate scheduled allocation');
        keys.add(key);
      }
      allocations = saved.allocations.map(record => ({ ...record, published: true }));
    }
    ready = true;
    return tick();
  }
  async function persist() {
    if (!backupPending) return;
    const checkpoint = { schemaVersion: 1, routerAddress: config.routerAddress,
      allocations: allocations.map(record => ({ ...record, published: true })) };
    const uri = await save(checkpoint);
    if (!/^ipfs:\/\//.test(uri)) throw new Error('Weekly checkpoint did not return an IPFS URI');
    for (const record of allocations) record.published = true;
    backupPending = false;
  }
  async function update() {
    if (!ready) throw new Error('Weekly payflow is restoring');
    if (Number((await router.runner.getNetwork()).chainId) !== 8453) throw new Error('Weekly payflow is Base-only');
    await persist();
    latestReports = await getReports();
    const approved = await router.approvedAssets(asset);
    const paid = new Map();
    const isPaid = async entry => {
      if (!paid.has(entry.workReferenceText)) paid.set(entry.workReferenceText, await router.completedWorkReferences(id(entry.workReferenceText)));
      return paid.get(entry.workReferenceText);
    };
    const reservedFor = async category => {
      let reserved = 0n;
      for (const record of allocations.filter(value => value.allocation.category === category)) {
        for (const entry of record.allocation.entries) if (!await isPaid(entry)) reserved += BigInt(entry.amountUnits);
      }
      return reserved;
    };
    for (const [category, slug] of [['playback', config.radioFunds.playback], ['top10', config.radioFunds.topTen]]) {
      const fund = await router.funds(id(slug));
      const balance = (fund.exists ?? fund[2]) ? await router.fundBalances(id(slug), asset) : 0n;
      let reserved = await reservedFor(category);
      let available = balance > reserved ? balance - reserved : 0n;
      for (const report of latestReports.filter(value => !value.current && value.week.startsWith('NY-') && value.tracks.length)
        .sort((first, second) => first.startAt.localeCompare(second.startAt))) {
        if (!approved || !(fund.active ?? fund[1]) || allocations.some(record => record.allocation.category === category && record.allocation.week === report.week)) continue;
        const closing = getClosingBalance ? await getClosingBalance({ report, fundSlug: slug, allocations: allocations.filter(record => record.allocation.category === category) }) : available;
        const cap = closing < available ? closing : available;
        const budget = cap * BigInt(shareBps) / 10000n;
        const plan = category === 'playback' ? previewPlaybackPayroll({ tracks: report.tracks, budgetUnits: budget, minimumUnits })
          : previewTopTenPayroll({ tracks: report.tracks, budgetUnits: budget, minimumUnits });
        if (!plan.entries.some(entry => entry.payable)) continue;
        const allocation = finalizeRadioAllocation({ report, category, budgetUnits: budget, minimumUnits,
          fundSlug: slug, routerAddress: config.routerAddress, assetAddress: asset, now: now() });
        const json = JSON.stringify(allocation);
        const metadataUri = await upload(Buffer.from(json), `${allocation.week}-${category}-allocation.json`, 'application/json');
        if (!/^ipfs:\/\/[^/\s]+$/.test(metadataUri)) throw new Error('Scheduled allocation did not receive a valid IPFS URI');
        allocations.push({ allocation, metadataUri, metadataHash: id(json), published: false });
        backupPending = true;
        await persist();
        reserved += BigInt(allocation.allocatedUnits);
        available = balance > reserved ? balance - reserved : 0n;
      }
      const current = latestReports.find(report => report.current);
      const budget = available * BigInt(shareBps) / 10000n;
      const preview = category === 'playback' ? previewPlaybackPayroll({ tracks: current?.tracks || [], budgetUnits: budget, minimumUnits })
        : previewTopTenPayroll({ tracks: current?.tracks || [], budgetUnits: budget, minimumUnits });
      const average = preview.entries.length ? budget / BigInt(preview.entries.length) : 0n;
      const warning = !(fund.exists ?? fund[2]) ? 'Fund has not been created' : !approved ? 'USDC not approved' : balance < reserved
        ? 'Balance is below unpaid scheduled allocations; add funds before paying' : available === 0n ? 'No unreserved USDC for this week'
        : preview.entries.length && average < significantUnits ? 'Average estimated share is below the significant-share warning threshold' : '';
      funds[category] = { slug, exists: Boolean(fund.exists ?? fund[2]), active: Boolean(fund.active ?? fund[1]),
        balanceUnits: balance.toString(), reservedUnits: reserved.toString(), availableUnits: available.toString(), budgetUnits: budget.toString(),
        recipientCount: preview.entries.length,
        allocatedUnits: preview.allocatedUnits.toString(), remainderUnits: preview.remainderUnits.toString(), warning,
        estimatedShares: preview.entries.map(entry => ({ ...entry, amountUnits: entry.amountUnits.toString() })) };
    }
    lastCheckedAt = new Date(now()).toISOString();
    return getState();
  }
  function tick() {
    if (!pending) pending = update().then(result => { lastError = ''; return result; })
      .catch(error => { lastError = error.message; throw error; }).finally(() => { pending = null; });
    return pending;
  }
  function getState({ wallet } = {}) {
    const period = currentPayrollPeriod(now());
    const result = { schemaVersion: 1, chainId: 8453, routerAddress: config.routerAddress, ready: ready && Boolean(lastCheckedAt), timeZone: PAYROLL_TIME_ZONE, currentPeriod: period, nextCloseAt: period.endAt,
      minimumPayoutUnits: minimumUnits.toString(), significantShareUnits: significantUnits.toString(), fundShareBps: shareBps,
      lastCheckedAt, lastError, backupPending, funds,
      accountingStartedAt: latestReports.find(report => report.current)?.accountingStartedAt || null,
      partial: Boolean(latestReports.find(report => report.current)?.partial),
      allocations: allocations.filter(record => record.published) };
    if (!wallet) return result;
    const key = wallet.toLowerCase();
    const totalPlays = (funds.playback?.estimatedShares || []).reduce((sum, entry) => sum + BigInt(entry.plays), 0n);
    const songs = (latestReports.find(report => report.current)?.tracks || []).filter(track => track.wallet?.toLowerCase() === key)
      .map(track => ({ title: track.title, plays: track.plays, votes: track.votes,
        estimatedPlaybackUnits: (totalPlays ? BigInt(funds.playback.budgetUnits) * BigInt(track.plays) / totalPlays : 0n).toString() }));
    return { ...result, funds: Object.fromEntries(Object.entries(funds).map(([category, fund]) => [category,
      { ...fund, estimatedShares: fund.estimatedShares.filter(entry => entry.wallet.toLowerCase() === key) }])), currentSongs: songs };
  }
  return { initialize, tick, getState };
}