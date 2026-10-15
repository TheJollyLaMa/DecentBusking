import { BASE_USDC_ADDRESS } from './settlement-funds.mjs?v=20261014-celebrate';
import { announcePaymentCelebration } from './payment-celebration.mjs';
import { previewTopTenSongPayroll } from './top-ten-prizes.mjs';

function formatUsdc(units) {
  const amount = typeof units === 'bigint' ? units : BigInt(units);
  const whole = amount / 1000000n;
  const fraction = String(amount % 1000000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
import { payrollPeriodFromKey, PAYROLL_TIME_ZONE, overlappingUtcWeeks } from './payroll-week.mjs';

const WALLET = /^0x[0-9a-fA-F]{40}$/;

function eligibleArtists(tracks) {
  const artists = new Map();
  for (const track of tracks) {
    if (!WALLET.test(track.wallet || '') || /^0x0{40}$/i.test(track.wallet) || !Number.isSafeInteger(track.plays) || track.plays <= 0) continue;
    const key = track.wallet.toLowerCase();
    const artist = artists.get(key) || { wallet: track.wallet, artist: track.artist, plays: 0, tracks: 0 };
    artist.plays += track.plays;
    if (!Number.isSafeInteger(artist.plays)) throw new Error('Playback total exceeds safe accounting precision');
    artist.tracks++;
    artists.set(key, artist);
  }
  return [...artists.values()].sort((first, second) => second.plays - first.plays || first.wallet.localeCompare(second.wallet));
}

function checkBudget(budgetUnits, minimumUnits) {
  if (typeof budgetUnits !== 'bigint' || budgetUnits < 0n || typeof minimumUnits !== 'bigint' || minimumUnits < 0n) {
    throw new Error('Budgets must be nonnegative token-unit amounts');
  }
}

export function previewPlaybackPayroll({ tracks, budgetUnits, minimumUnits = 0n }) {
  checkBudget(budgetUnits, minimumUnits);
  const artists = eligibleArtists(tracks);
  const totalPlays = artists.reduce((total, artist) => total + BigInt(artist.plays), 0n);
  let allocated = 0n;
  const entries = artists.map(artist => {
    const amountUnits = totalPlays ? budgetUnits * BigInt(artist.plays) / totalPlays : 0n;
    const payable = amountUnits > 0n && amountUnits >= minimumUnits;
    if (payable) allocated += amountUnits;
    return { ...artist, amountUnits, payable };
  });
  return { entries, totalPlays, allocatedUnits: allocated, remainderUnits: budgetUnits - allocated };
}

function voteRankedArtists(tracks) {
  const artists = new Map();
  for (const track of tracks) {
    if (!WALLET.test(track.wallet || '') || /^0x0{40}$/i.test(track.wallet) || !Number.isSafeInteger(track.votes)) continue;
    const key = track.wallet.toLowerCase();
    const artist = artists.get(key) || { wallet: track.wallet, artist: track.artist, plays: 0, votes: 0, tracks: 0 };
    artist.votes += track.votes;
    artist.plays += Number.isSafeInteger(track.plays) && track.plays >= 0 ? track.plays : 0;
    if (!Number.isSafeInteger(artist.votes) || !Number.isSafeInteger(artist.plays)) throw new Error('Vote total exceeds safe accounting precision');
    artist.tracks++;
    artists.set(key, artist);
  }
  return [...artists.values()].filter(artist => artist.votes > 0)
    .sort((first, second) => second.votes - first.votes || first.wallet.toLowerCase().localeCompare(second.wallet.toLowerCase()));
}

function normalizeTopTenRanking(ranking) {
  const value = String(ranking || 'votes').replace(/-halving$/, '');
  return value === 'plays' ? 'plays' : 'votes';
}

function previewLegacyTopTenPayroll({ tracks, budgetUnits, minimumUnits = 0n, ranking = 'votes' }) {
  const artists = (normalizeTopTenRanking(ranking) === 'votes' ? voteRankedArtists(tracks) : eligibleArtists(tracks)).slice(0, 10);
  const amountUnits = artists.length ? budgetUnits / BigInt(artists.length) : 0n;
  const entries = artists.map((artist, index) => ({ ...artist, rank: index + 1, amountUnits,
    payable: amountUnits > 0n && amountUnits >= minimumUnits }));
  const allocated = entries.reduce((total, entry) => total + (entry.payable ? entry.amountUnits : 0n), 0n);
  return { entries, allocatedUnits: allocated, remainderUnits: budgetUnits - allocated };
}

function previewHalvingTopTenPayroll({ tracks, budgetUnits, minimumUnits = 0n, ranking = 'votes' }) {
  const artists = (normalizeTopTenRanking(ranking) === 'votes' ? voteRankedArtists(tracks) : eligibleArtists(tracks)).slice(0, 10);
  if (!artists.length || budgetUnits === 0n) return { entries: [], allocatedUnits: 0n, remainderUnits: budgetUnits };
  const theoretical = [];
  let remaining = budgetUnits;
  for (let index = 0; index < artists.length; index++) {
    const amount = index === artists.length - 1 ? remaining : budgetUnits / (2n ** BigInt(index + 1));
    theoretical.push(amount);
    remaining -= amount;
  }
  let payableCount = artists.length;
  for (let index = 0; index < theoretical.length - 1; index++) {
    if (theoretical[index] < minimumUnits) { payableCount = index === 0 ? 1 : index; break; }
  }
  const entries = artists.slice(0, payableCount).map((artist, index) => {
    const amountUnits = index < payableCount - 1
      ? theoretical[index]
      : budgetUnits - theoretical.slice(0, index).reduce((sum, amount) => sum + amount, 0n);
    return { ...artist, rank: index + 1, amountUnits, payable: amountUnits > 0n && amountUnits >= minimumUnits };
  });
  const allocated = entries.reduce((sum, entry) => sum + entry.amountUnits, 0n);
  return { entries, allocatedUnits: allocated, remainderUnits: budgetUnits - allocated };
}

export function previewTopTenPayroll({ tracks, budgetUnits, minimumUnits = 0n, ranking = 'votes' }) {
  checkBudget(budgetUnits, minimumUnits);
  const normalized = normalizeTopTenRanking(ranking);
  if (!['votes', 'plays'].includes(normalized)) throw new Error('Invalid Top 10 ranking');
  return previewHalvingTopTenPayroll({ tracks, budgetUnits, minimumUnits, ranking: normalized });
}

export function radioWorkReferenceText({ week, category, wallet, trackId }) {
  const ny = String(week || '').startsWith('NY-');
  if (ny) payrollPeriodFromKey(week);
  if ((!ny && !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(week || '')) || !['playback', 'top10'].includes(category) || !WALLET.test(wallet || '')) {
    throw new Error('Invalid radio payout identity');
  }
  if (trackId !== undefined) {
    if (category !== 'top10' || typeof trackId !== 'string' || !trackId.trim() || trackId.length > 512) throw new Error('Invalid song payout identity');
    return `decentbusking:radio:v4:8453:${week}:${category}:${wallet.toLowerCase()}:${encodeURIComponent(trackId)}`;
  }
  return `decentbusking:radio:${ny ? 'v3' : 'v1'}:8453:${week}:${category}:${wallet.toLowerCase()}`;
}

export function radioAllocationMatchesReport(report, allocation) {
  try {
    if (!report || !allocation || report.current || report.week !== allocation.week || !Array.isArray(report.tracks)) return false;
    const budgetUnits = BigInt(allocation.budgetUnits);
    const minimumUnits = BigInt(allocation.minimumUnits);
    const ranking = allocation.schemaVersion === 1 ? 'plays' : normalizeTopTenRanking(allocation.ranking);
    const plan = allocation.category === 'playback'
      ? previewPlaybackPayroll({ tracks: report.tracks, budgetUnits, minimumUnits })
      : (allocation.schemaVersion >= 5
        ? previewTopTenSongPayroll({ tracks: report.tracks, budgetUnits, minimumUnits })
        : allocation.schemaVersion < 4
        ? previewLegacyTopTenPayroll({ tracks: report.tracks, budgetUnits, minimumUnits, ranking })
        : previewTopTenPayroll({ tracks: report.tracks, budgetUnits, minimumUnits, ranking }));
    const expectedEntries = plan.entries.filter(entry => entry.payable);
    if (BigInt(allocation.allocatedUnits) !== plan.allocatedUnits || BigInt(allocation.remainderUnits) !== plan.remainderUnits ||
        expectedEntries.length !== allocation.entries?.length) return false;
    return expectedEntries.every((expected, index) => {
      const actual = allocation.entries[index];
      return actual.wallet?.toLowerCase() === expected.wallet.toLowerCase() && actual.plays === expected.plays &&
        (expected.votes === undefined || actual.votes === expected.votes) &&
        (expected.rank === undefined || actual.rank === expected.rank) &&
        (allocation.schemaVersion < 5 || actual.trackId === expected.trackId) &&
        BigInt(actual.amountUnits) === expected.amountUnits &&
        actual.workReferenceText === radioWorkReferenceText({ week: report.week, category: allocation.category, wallet: expected.wallet,
          ...(allocation.schemaVersion >= 5 ? { trackId: expected.trackId } : {}) });
    });
  } catch {
    return false;
  }
}

export function finalizeRadioAllocation({ report, category, budgetUnits, minimumUnits, fundSlug, routerAddress, assetAddress, ranking = 'votes', topTenScheduleVersion = 2, now = Date.now() }) {
  if (!report || report.current || report.week === 'all-time') throw new Error('Only a completed week can be finalized');
  radioWorkReferenceText({ week: report.week, category, wallet: `0x${'1'.repeat(40)}` });
  const period = report.week.startsWith('NY-') ? payrollPeriodFromKey(report.week) : null;
  if (period) {
    if (now < Date.parse(period.endAt)) throw new Error('The selected New York week has not completed');
  } else {
    const [year, week] = report.week.split('-W').map(Number);
    const monday = new Date(Date.UTC(year, 0, 4));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) + (week - 1) * 7);
    const thursday = new Date(monday); thursday.setUTCDate(thursday.getUTCDate() + 3);
    if (thursday.getUTCFullYear() !== year || now < monday.getTime() + 7 * 86400000) throw new Error('The selected UTC week has not completed');
  }
  if (!WALLET.test(routerAddress || '') || !WALLET.test(assetAddress || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fundSlug || '')) throw new Error('Invalid settlement configuration');
  if (budgetUnits <= 0n) throw new Error('Set a positive reviewed budget');
  const plan = category === 'playback' ? previewPlaybackPayroll({ tracks: report.tracks, budgetUnits, minimumUnits })
    : (topTenScheduleVersion >= 3
      ? previewTopTenSongPayroll({ tracks: report.tracks, budgetUnits, minimumUnits })
      : topTenScheduleVersion === 1
      ? previewLegacyTopTenPayroll({ tracks: report.tracks, budgetUnits, minimumUnits, ranking })
      : previewTopTenPayroll({ tracks: report.tracks, budgetUnits, minimumUnits, ranking }));
  const entries = plan.entries.filter(entry => entry.payable);
  if (!entries.length) throw new Error('No payouts meet the minimum threshold');
  const songPrizes = category === 'top10' && topTenScheduleVersion >= 3;
  if (songPrizes && entries.some(entry => !WALLET.test(entry.wallet || '') || /^0x0{40}$/i.test(entry.wallet))) throw new Error('Link the artist wallet for every winning song before finalizing Top 10');
  return { schemaVersion: songPrizes ? 5 : category === 'top10' ? 4 : period ? 3 : 2, ...(period ? { timeZone: PAYROLL_TIME_ZONE, startAt: period.startAt, endAt: period.endAt, partial: Boolean(report.partial) } : {}),
    ranking: category === 'playback' ? 'qualified-plays' : songPrizes ? 'song-votes-halving' : `${normalizeTopTenRanking(ranking)}-halving`, station: 'decentbusking', chainId: 8453, category, week: report.week,
    routerAddress, assetAddress, fundSlug, budgetUnits: budgetUnits.toString(), minimumUnits: minimumUnits.toString(),
    allocatedUnits: plan.allocatedUnits.toString(), remainderUnits: plan.remainderUnits.toString(),
    finalizedAt: new Date(now).toISOString(),
    entries: entries.map(entry => ({ wallet: entry.wallet, artist: entry.artist || '', plays: entry.plays,
      ...(songPrizes ? { trackId: entry.trackId, title: entry.title || '' } : {}),
      ...(category === 'top10' ? { votes: entry.votes, rank: entry.rank } : {}),
      amountUnits: entry.amountUnits.toString(), workReferenceText: radioWorkReferenceText({ week: report.week, category, wallet: entry.wallet,
        ...(songPrizes ? { trackId: entry.trackId } : {}) }) })) };
}

export async function settleRadioAllocation({ allocation, metadataUri, metadataHash, router, signer, owner, hashReference, onStep = () => {}, onConfirmed = async () => {} }) {
  if (!allocation || allocation.chainId !== 8453 || allocation.routerAddress?.toLowerCase() !== router.target.toLowerCase()) throw new Error('Finalized allocation does not match this Base router');
  if (!/^ipfs:\/\/[^/\s]+$/.test(metadataUri || '') || !/^0x[0-9a-fA-F]{64}$/.test(metadataHash || '')) throw new Error('An immutable IPFS allocation receipt is required');
  if (allocation.assetAddress?.toLowerCase() !== BASE_USDC_ADDRESS.toLowerCase()) throw new Error('Radio settlement supports native Base USDC only');
  const validated = finalizeRadioAllocation({ report: { week: allocation.week, current: false,
    tracks: allocation.entries },
    category: allocation.category, budgetUnits: BigInt(allocation.budgetUnits), minimumUnits: BigInt(allocation.minimumUnits),
    ranking: allocation.schemaVersion === 1 ? 'plays' : allocation.ranking,
    topTenScheduleVersion: allocation.schemaVersion >= 5 ? 3 : allocation.schemaVersion < 4 ? 1 : 2,
    fundSlug: allocation.fundSlug, routerAddress: allocation.routerAddress, assetAddress: allocation.assetAddress });
  if (validated.week !== allocation.week) throw new Error('Invalid completed week');
  if (allocation.schemaVersion >= 5 && !radioAllocationMatchesReport({ week: allocation.week, current: false, tracks: allocation.entries }, allocation)) throw new Error('Song prizes do not match the frozen chart allocation');
  if (Number((await signer.provider.getNetwork()).chainId) !== 8453 || (await signer.getAddress()).toLowerCase() !== owner?.toLowerCase()) throw new Error('Connect the Base owner wallet');
  if (await router.paused()) throw new Error('Settlement router is paused');
  if (!await router.hasRole(await router.PAYROLL_ROLE(), owner)) throw new Error('PAYROLL_ROLE is required');
  if (!await router.approvedAssets(allocation.assetAddress)) throw new Error('USDC is not approved');
  const fundId = hashReference(allocation.fundSlug);
  const fund = await router.funds(fundId);
  if (!(fund.exists ?? fund[2]) || !(fund.active ?? fund[1])) throw new Error('Create and activate this fund first');
  const unpaid = [];
  let reviewedTotal = 0n;
  const identities = new Set();
  for (const entry of allocation.entries) {
    const identity = radioWorkReferenceText({ week: allocation.week, category: allocation.category, wallet: entry.wallet,
      ...(allocation.schemaVersion >= 5 ? { trackId: entry.trackId } : {}) });
    if (identity !== entry.workReferenceText || identities.has(identity) || BigInt(entry.amountUnits) <= 0n) throw new Error('Invalid or duplicate allocation entry');
    identities.add(identity);
    reviewedTotal += BigInt(entry.amountUnits);
    const workReference = hashReference(identity);
    if (await router.completedWorkReferences(workReference)) continue;
    if (allocation.schemaVersion >= 5 && await router.completedWorkReferences(hashReference(radioWorkReferenceText({ week: allocation.week, category: allocation.category, wallet: entry.wallet })))) throw new Error('An artist-based prize was already paid for this week; manual reconciliation required');
    if (allocation.schemaVersion >= 3 && String(allocation.week).startsWith('NY-')) {
      for (const legacyWeek of overlappingUtcWeeks(payrollPeriodFromKey(allocation.week))) {
        const legacy = radioWorkReferenceText({ week: legacyWeek, category: allocation.category, wallet: entry.wallet });
        if (await router.completedWorkReferences(hashReference(legacy))) throw new Error('A paid legacy UTC receipt overlaps this New York period; manual reconciliation required');
      }
    }
    const recipient = await router.contributors(entry.wallet);
    if (!(recipient.approved ?? recipient[1])) throw new Error(`Recipient ${entry.wallet} is not approved on the shared router`);
    unpaid.push({ ...entry, workReference });
  }
  const total = unpaid.reduce((sum, entry) => sum + BigInt(entry.amountUnits), 0n);
  if (reviewedTotal !== BigInt(allocation.allocatedUnits) || total > reviewedTotal || reviewedTotal > BigInt(allocation.budgetUnits)) throw new Error('Allocation exceeds its reviewed budget or totals do not match');
  if (await router.fundBalances(fundId, allocation.assetAddress) < total) throw new Error('Fund has insufficient USDC for unpaid allocations');
  const confirmed = [];
  for (const entry of unpaid) {
    if (await router.completedWorkReferences(entry.workReference)) continue;
    const args = [fundId, allocation.assetAddress, entry.wallet, BigInt(entry.amountUnits), entry.workReference,
      hashReference('TheJollyLaMa/DecentBusking'), hashReference(`radio-artist:${entry.wallet.toLowerCase()}`), metadataUri, metadataHash];
    await router.payout.staticCall(...args);
    onStep(`Confirm ${entry.amountUnits} USDC base units to ${entry.wallet}`);
    const transaction = await router.payout(...args);
    if ((await transaction.wait())?.status !== 1) throw new Error('Radio payout did not confirm; refresh before retrying');
    confirmed.push({ wallet: entry.wallet, txHash: transaction.hash });
    announcePaymentCelebration({
      chainId: 8453,
      txHash: transaction.hash,
      amountText: formatUsdc(BigInt(entry.amountUnits)),
      assetText: 'USDC',
      summary: `${allocation.category === 'playback' ? 'Playback' : 'Top 10'} payout confirmed`,
      txLabel: `Paid ${entry.wallet.slice(0, 6)}…`,
    });
    await onConfirmed({ ...entry, txHash: transaction.hash });
  }
  return { confirmed, skipped: allocation.entries.length - unpaid.length };
}

export function validateRadioReceipt(allocation, { routerAddress, assetAddress, funds }) {
  if (!allocation || ![1, 2, 3, 4, 5].includes(allocation.schemaVersion) || allocation.chainId !== 8453 ||
      !['playback', 'top10'].includes(allocation.category) || allocation.station !== 'decentbusking' ||
      allocation.routerAddress?.toLowerCase() !== routerAddress.toLowerCase() || allocation.assetAddress?.toLowerCase() !== assetAddress.toLowerCase() ||
      allocation.fundSlug !== (allocation.category === 'playback' ? funds.playback : funds.topTen)) throw new Error('Receipt does not match this station, fund, asset, and router');
  if (!Array.isArray(allocation.entries) || !allocation.entries.length || allocation.entries.length > 1000) throw new Error('Invalid receipt entries');
  if (String(allocation.week).startsWith('NY-')) {
    const period = payrollPeriodFromKey(allocation.week);
    if (allocation.schemaVersion < 3 || allocation.timeZone !== PAYROLL_TIME_ZONE || allocation.startAt !== period.startAt || allocation.endAt !== period.endAt) throw new Error('Receipt payroll timezone or boundaries do not match');
  } else if (allocation.schemaVersion >= 3 && allocation.timeZone) throw new Error('New York receipts require the new payroll schema');
  finalizeRadioAllocation({ report: { week: allocation.week, current: false,
    tracks: allocation.entries },
    category: allocation.category, budgetUnits: BigInt(allocation.budgetUnits), minimumUnits: BigInt(allocation.minimumUnits),
    ranking: allocation.schemaVersion === 1 ? 'plays' : allocation.ranking,
    topTenScheduleVersion: allocation.schemaVersion >= 5 ? 3 : allocation.schemaVersion < 4 ? 1 : 2,
    fundSlug: allocation.fundSlug, routerAddress, assetAddress });
  if (allocation.schemaVersion >= 5 && !radioAllocationMatchesReport({ week: allocation.week, current: false, tracks: allocation.entries }, allocation)) throw new Error('Song prizes do not match the frozen chart allocation');
  const identities = new Set();
  let total = 0n;
  for (const entry of allocation.entries) {
    const identity = radioWorkReferenceText({ week: allocation.week, category: allocation.category, wallet: entry.wallet,
      ...(allocation.schemaVersion >= 5 ? { trackId: entry.trackId } : {}) });
    const validCount = allocation.category === 'top10' && normalizeTopTenRanking(allocation.ranking) === 'votes'
      ? Number.isSafeInteger(entry.votes) && entry.votes > 0 && Number.isSafeInteger(entry.plays) && entry.plays >= 0
      : Number.isSafeInteger(entry.plays) && entry.plays > 0;
    if (identity !== entry.workReferenceText || identities.has(identity) || !validCount || BigInt(entry.amountUnits) <= 0n) throw new Error('Receipt has invalid or duplicate payout entries');
    identities.add(identity); total += BigInt(entry.amountUnits);
  }
  if (total !== BigInt(allocation.allocatedUnits) || total > BigInt(allocation.budgetUnits)) throw new Error('Receipt totals exceed budget or do not match');
  return allocation;
}