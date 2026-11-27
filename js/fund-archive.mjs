import { id } from '../discord-bot/node_modules/ethers/lib.esm/index.js';
import { currentPayrollPeriod, payrollPeriodFromKey, payrollPeriods } from './payroll-week.mjs';
import { BASE_USDC_ADDRESS } from './settlement-funds.mjs?v=20261017-mercury-release';

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

export function buildFundWeeklyArchive({ fundSlug, fund, weeklyPayflow = {}, now = Date.now(), activity = false }) {
  const allocations = Array.isArray(weeklyPayflow.allocations) ? weeklyPayflow.allocations : [];
  const payouts = [...new Map((Array.isArray(fund?.payouts) ? fund.payouts : [])
    .filter(payout => (!payout.slug || payout.slug === fundSlug) && (!payout.asset || normalize(payout.asset) === normalize(BASE_USDC_ADDRESS)))
    .map(payout => [`${normalize(payout.txHash)}:${payout.logIndex ?? 0}`, payout])).values()];
  const relevantAllocations = allocations.filter(record => record?.allocation?.fundSlug === fundSlug);
  const payoutByReference = new Map();
  for (const payout of payouts) {
    for (const reference of [payout?.workReference, payout?.workReferenceText].filter(Boolean)) {
      const key = normalize(reference);
      const matches = payoutByReference.get(key) || [];
      matches.push(payout);
      payoutByReference.set(key, matches);
    }
  }
  const matchedPayouts = new Set();
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
      const payments = [...new Set([...(payoutByReference.get(normalize(id(workReferenceText))) || []),
        ...(payoutByReference.get(normalize(workReferenceText)) || [])])];
      for (const payment of payments) matchedPayouts.add(payment);
      const payout = payments[0];
      const amountUnits = parseBigInt(entry.amountUnits);
      const paidUnits = payments.reduce((sum, payment) => sum + parseBigInt(payment.amountUnits), 0n);
      const creditedUnits = payments.filter(payment => normalize(payment.recipient) === normalize(entry.wallet))
        .reduce((sum, payment) => sum + parseBigInt(payment.amountUnits), 0n);
      const paymentMismatch = payments.length > 0 && (paidUnits !== amountUnits || creditedUnits !== amountUnits ||
        payments.some(payment => !/^0x[0-9a-f]{64}$/i.test(payment.txHash || '') ||
          (payment.metadataUri && record.metadataUri && payment.metadataUri !== record.metadataUri)));
      const base = {
        wallet: entry.wallet || '',
        artist: entry.artist || '',
        trackId: entry.trackId || '',
        title: entry.title || '',
        plays: Number.isSafeInteger(entry.plays) ? entry.plays : 0,
        votes: Number.isSafeInteger(entry.votes) ? entry.votes : undefined,
        rank: Number.isSafeInteger(entry.rank) ? entry.rank : undefined,
        workReferenceText,
        amountUnits: amountUnits.toString(),
        paidUnits: paidUnits.toString(),
        remainingUnits: (amountUnits > creditedUnits ? amountUnits - creditedUnits : 0n).toString(),
        paymentMismatch,
        paid: payments.length > 0 && !paymentMismatch,
        payments,
        txHash: payout?.txHash || '',
        blockNumber: Number(payout?.blockNumber || 0),
        timestamp: Number(payout?.timestamp || 0),
        metadataUri: record.metadataUri || '',
      };
      return base;
    });
    const totalUnits = weekData.entries.reduce((sum, entry) => sum + parseBigInt(entry.amountUnits), 0n);
    const paidUnits = weekData.entries.reduce((sum, entry) => sum + parseBigInt(entry.paidUnits), 0n);
    weekData.totalUnits = totalUnits.toString();
    weekData.paidUnits = paidUnits.toString();
    weekData.remainingUnits = weekData.entries.reduce((sum, entry) => sum + parseBigInt(entry.remainingUnits), 0n).toString();
    weekData.status = weekData.entries.some(entry => entry.paymentMismatch) ? 'mismatch'
      : paidUnits === 0n ? 'queued' : totalUnits > paidUnits ? 'partial' : 'paid';
    weeks.set(week, weekData);
  }
  if (activity) {
    for (const [field, entries] of [['sources', fund?.sources || []], ['activityPayouts', payouts]]) {
      for (const entry of entries) {
        if (!Number.isFinite(entry.timestamp) || entry.timestamp <= 0) continue;
        const period = currentPayrollPeriod(entry.timestamp * 1000);
        const data = weeks.get(period.week) || {
          week: period.week, period, fundSlug, entries: [], totalUnits: '0', paidUnits: '0',
          status: 'activity', closed: period.week !== currentPayrollPeriod(now).week,
        };
        (data[field] ||= []).push(entry);
        weeks.set(period.week, data);
      }
    }
    for (const data of weeks.values()) {
      data.sources ||= [];
      data.activityPayouts ||= [];
      data.incomeUnits = data.sources.reduce((sum, entry) => sum + parseBigInt(entry.amountUnits), 0n).toString();
      data.outflowUnits = data.activityPayouts.reduce((sum, entry) => sum + parseBigInt(entry.amountUnits), 0n).toString();
    }
  }
  const orderedWeeks = [...weeks.values()].sort((first, second) => second.period.startAt.localeCompare(first.period.startAt));
  const unmatchedPayouts = payouts.filter(payout => !matchedPayouts.has(payout));
  return { fundSlug, weeks: orderedWeeks, unmatchedPayouts,
    payoutsAvailable: fund?.payoutsAvailable !== false,
    unmatchedPaidUnits: unmatchedPayouts.reduce((sum, payout) => sum + parseBigInt(payout.amountUnits), 0n).toString(),
    currentWeek: weeklyPayflow.currentPeriod || null, now };
}

export function projectFundState(state, view, now = Date.now()) {
  if (!['summary', 'recent'].includes(view)) throw new Error('Invalid fund view');
  const start = Date.parse(payrollPeriods(3, now)[0].startAt) / 1000;
  const end = Date.parse(currentPayrollPeriod(now).endAt) / 1000;
  return { ...state, historyScope: view, historyStartAt: new Date(start * 1000).toISOString(),
    funds: Object.fromEntries(Object.entries(state.funds || {}).map(([slug, fund]) => {
      const { sources = [], payouts = [], bookings, ...summary } = fund;
      const total = entries => entries.reduce((sum, entry) => sum + parseBigInt(entry.amountUnits), 0n).toString();
      const recent = entries => entries.filter(entry => entry.timestamp >= start && entry.timestamp < end);
      return [slug, { ...summary,
        largeSponsorDepositCount: fund.sourcesAvailable === false ? null :
          sources.filter(source => source.kind === 'sponsor' && parseBigInt(source.amountUnits) >= 100_000_000n).length,
        inflowUnits: fund.sourcesAvailable === false ? null : total(sources),
        outflowUnits: fund.payoutsAvailable === false ? null : total(payouts),
        ...(view === 'recent' ? { sources: recent(sources), payouts: recent(payouts) } : {}),
      }];
    })) };
}
