import { id } from '../discord-bot/node_modules/ethers/lib.esm/index.js';
import { payrollPeriodFromKey } from './payroll-week.mjs';

function normalize(value) {
  return String(value || '').toLowerCase();
}

function parseBigInt(value) {
  return typeof value === 'bigint' ? value : BigInt(value || 0);
}

function emptyWeek(record) {
  return {
    week: record.allocation.week,
    category: record.allocation.category,
    fundSlug: record.allocation.fundSlug,
    metadataUri: record.metadataUri || '',
    metadataHash: record.metadataHash || '',
    period: payrollPeriodFromKey(record.allocation.week),
    entries: [],
    totalUnits: '0',
    paidUnits: '0',
    remainingUnits: '0',
    status: 'queued',
    closed: true,
  };
}

export function buildFundWeeklyArchive({ fundSlug, fund, weeklyPayflow = {}, now = Date.now() }) {
  const allocations = Array.isArray(weeklyPayflow.allocations) ? weeklyPayflow.allocations : [];
  const payouts = Array.isArray(fund?.payouts) ? fund.payouts : [];
  const relevantAllocations = allocations.filter(record => record?.allocation?.fundSlug === fundSlug);
  const payoutByReference = new Map();
  for (const payout of payouts) {
    for (const reference of [payout?.workReference, payout?.workReferenceText].filter(Boolean)) {
      payoutByReference.set(normalize(reference), payout);
    }
  }
  const weeks = new Map();
  for (const record of relevantAllocations) {
    const week = record?.allocation?.week;
    if (!week) continue;
    const entryList = Array.isArray(record.allocation.entries) ? record.allocation.entries : [];
    const weekData = weeks.get(week) || emptyWeek(record);
    weekData.metadataUri = record.metadataUri || weekData.metadataUri;
    weekData.metadataHash = record.metadataHash || weekData.metadataHash;
    weekData.entries = entryList.map(entry => {
      const workReferenceText = String(entry.workReferenceText || '');
      const payout = payoutByReference.get(normalize(id(workReferenceText))) || payoutByReference.get(normalize(workReferenceText)) || null;
      const amountUnits = parseBigInt(entry.amountUnits);
      const base = {
        wallet: entry.wallet || '',
        artist: entry.artist || '',
        plays: Number.isSafeInteger(entry.plays) ? entry.plays : 0,
        votes: Number.isSafeInteger(entry.votes) ? entry.votes : undefined,
        rank: Number.isSafeInteger(entry.rank) ? entry.rank : undefined,
        workReferenceText,
        amountUnits: amountUnits.toString(),
        paid: Boolean(payout),
        txHash: payout?.txHash || '',
        blockNumber: Number(payout?.blockNumber || 0),
        timestamp: Number(payout?.timestamp || 0),
        metadataUri: record.metadataUri || '',
      };
      return base;
    });
    const totalUnits = weekData.entries.reduce((sum, entry) => sum + parseBigInt(entry.amountUnits), 0n);
    const paidUnits = weekData.entries.reduce((sum, entry) => sum + (entry.paid ? parseBigInt(entry.amountUnits) : 0n), 0n);
    weekData.totalUnits = totalUnits.toString();
    weekData.paidUnits = paidUnits.toString();
    weekData.remainingUnits = (totalUnits - paidUnits).toString();
    weekData.status = paidUnits === 0n ? 'queued' : totalUnits > paidUnits ? 'partial' : 'paid';
    weeks.set(week, weekData);
  }
  const orderedWeeks = [...weeks.values()].sort((first, second) => second.period.startAt.localeCompare(first.period.startAt));
  if (!orderedWeeks.length) return { fundSlug, weeks: [], currentWeek: null, now };
  const latestWeek = orderedWeeks[0];
  if (latestWeek.status === 'queued' && weeklyPayflow?.currentPeriod?.week !== latestWeek.week) {
    latestWeek.status = 'pending';
  }
  return { fundSlug, weeks: orderedWeeks, currentWeek: weeklyPayflow.currentPeriod || null, now };
}
