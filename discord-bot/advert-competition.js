import { id, isAddress } from 'ethers';
import { currentPayrollPeriod, payrollPeriodFromKey } from '../js/payroll-week.mjs';

export const ADVERT_COMPETITION_POLICY = 'net-positive-ny-monday-wallet-uri-consecutive-v1';

export function advertIdentity(campaign) {
  if (!campaign || !isAddress(campaign.advertiser) || /^0x0{40}$/i.test(campaign.advertiser) ||
    typeof campaign.audioURI !== 'string' || !/^ipfs:\/\/[^\s?#]+$/.test(campaign.audioURI)) return null;
  return id(JSON.stringify([campaign.advertiser.toLowerCase(), campaign.audioURI]));
}

function followingWeek(week) {
  return currentPayrollPeriod(Date.parse(payrollPeriodFromKey(week).endAt)).week;
}

function tally(receipts, catalog) {
  const lifetime = new Map();
  const weekly = new Map();
  const unresolved = new Map();
  for (const receipt of receipts) {
    const week = currentPayrollPeriod(Date.parse(receipt.recordedAt)).week;
    const campaign = catalog.get(receipt.campaignId);
    if (!campaign) {
      unresolved.set(`${week}:${receipt.campaignId}`, { week, campaignId: receipt.campaignId,
        reason: 'Campaign identity unavailable; recover verified campaign metadata and retry' });
      continue;
    }
    const advertId = advertIdentity(campaign);
    for (const [rows, key, initial] of [[lifetime, advertId, { advertId }],
      [weekly, `${week}:${advertId}`, { advertId, week }]]) {
      if (!rows.has(key)) rows.set(key, { ...initial, up: 0, down: 0, net: 0 });
      const row = rows.get(key);
      if (receipt.vote === 1) row.up++;
      else row.down++;
      row.net += receipt.vote;
    }
  }
  return { lifetimeTotals: [...lifetime.values()], weeklyTotals: [...weekly.values()], unresolved: [...unresolved.values()] };
}

export function validateAdvertCompetition(state) {
  if (!state || state.schemaVersion !== 1 || state.policy !== ADVERT_COMPETITION_POLICY ||
    !Array.isArray(state.catalog) || !Array.isArray(state.closedWeeks) || !Array.isArray(state.grants) ||
    !Array.isArray(state.plays) || !Array.isArray(state.weeklyTotals) || !Array.isArray(state.lifetimeTotals) ||
    !Array.isArray(state.unresolved)) throw new Error('Invalid advert competition journal');
  payrollPeriodFromKey(state.nextWeek);
  const catalogIds = new Set();
  for (const campaign of state.catalog) {
    if (!advertIdentity(campaign) || !/^\d+$/.test(campaign.campaignId) || catalogIds.has(campaign.campaignId)) {
      throw new Error('Invalid advert competition catalog');
    }
    catalogIds.add(campaign.campaignId);
  }
  const advertIds = new Set(state.catalog.map(advertIdentity));
  for (const rows of [state.lifetimeTotals, state.weeklyTotals]) {
    const keys = new Set();
    for (const row of rows) {
      const key = `${row.week || ''}:${row.advertId}`;
      if (!advertIds.has(row.advertId) || keys.has(key) || !Number.isSafeInteger(row.up) || row.up < 0 ||
        !Number.isSafeInteger(row.down) || row.down < 0 || row.net !== row.up - row.down) {
        throw new Error('Invalid advert competition totals');
      }
      if (rows === state.weeklyTotals) payrollPeriodFromKey(row.week);
      keys.add(key);
    }
  }
  const weeks = new Set();
  for (const closed of state.closedWeeks) {
    if (weeks.has(closed.week) || !Array.isArray(closed.ranking) || !Array.isArray(closed.winners) ||
      !Number.isFinite(Date.parse(closed.closedAt))) throw new Error('Invalid closed advert competition week');
    payrollPeriodFromKey(closed.week);
    const expectedRanking = state.weeklyTotals.filter(row => row.week === closed.week)
      .sort((a, b) => b.net - a.net || a.advertId.localeCompare(b.advertId));
    const period = payrollPeriodFromKey(closed.week);
    if (JSON.stringify(closed.ranking) !== JSON.stringify(expectedRanking) ||
      closed.startAt !== period.startAt || closed.endAt !== period.endAt || closed.week >= state.nextWeek) {
      throw new Error('Invalid frozen advert competition ranking');
    }
    const winners = closed.ranking.length && closed.ranking[0].net > 0
      ? closed.ranking.filter(row => row.net === closed.ranking[0].net).map(row => row.advertId) : [];
    if (JSON.stringify(winners) !== JSON.stringify(closed.winners)) throw new Error('Invalid advert competition winners');
    weeks.add(closed.week);
  }
  const grantKeys = new Set();
  for (const grant of state.grants) {
    const period = payrollPeriodFromKey(followingWeek(grant.sourceWeek));
    const key = `${grant.sourceWeek}:${grant.advertId}`;
    if (grantKeys.has(key) || grant.rewardWeek !== period.week || grant.startAt !== period.startAt || grant.endAt !== period.endAt ||
      !state.closedWeeks.some(week => week.week === grant.sourceWeek && week.winners.includes(grant.advertId))) {
      throw new Error('Invalid advert competition reward grant');
    }
    grantKeys.add(key);
  }
  for (const closed of state.closedWeeks) {
    if (closed.winners.some(advertId => !grantKeys.has(`${closed.week}:${advertId}`))) {
      throw new Error('Missing advert competition reward grant');
    }
  }
  const playKeys = new Set();
  for (const play of state.plays) {
    const key = `${play.mainRadio}:${play.radioPlayId}`;
    if (playKeys.has(key) || typeof play.mainRadio !== 'boolean' || typeof play.radioPlayId !== 'string' || !play.radioPlayId ||
      !Number.isFinite(Date.parse(play.recordedAt)) || !Number.isFinite(Date.parse(play.startedAt)) ||
      !grantKeys.has(`${play.sourceWeek}:${play.advertId}`) ||
      !competitionGrant(state, { ...play, rewardWeek: followingWeek(play.sourceWeek) }, Date.parse(play.startedAt)) ||
      !state.catalog.some(campaign => campaign.campaignId === play.campaignId && advertIdentity(campaign) === play.advertId)) {
      throw new Error('Invalid free advert play receipt');
    }
    playKeys.add(key);
  }
}

export async function reconcileAdvertCompetition({ state, receipts, snapshot, readCampaign, now }) {
  if (snapshot.chainId !== 8453 || !Array.isArray(snapshot.campaigns)) throw new Error('Advert competition campaign snapshot unavailable');
  const catalog = new Map((state?.catalog || []).map(campaign => [campaign.campaignId, campaign]));
  for (const campaign of snapshot.campaigns) {
    if (advertIdentity(campaign)) {
      const previous = catalog.get(String(campaign.campaignId));
      if (previous && advertIdentity(previous) !== advertIdentity(campaign)) throw new Error('Advert campaign identity changed');
      catalog.set(String(campaign.campaignId), { ...campaign, campaignId: String(campaign.campaignId) });
    }
  }
  for (const campaignId of new Set(receipts.map(receipt => receipt.campaignId))) {
    if (catalog.has(campaignId) || !readCampaign) continue;
    const campaign = await readCampaign(campaignId, snapshot);
    if (campaign && String(campaign.campaignId) === campaignId && advertIdentity(campaign)) {
      catalog.set(campaignId, { ...campaign, campaignId });
    }
  }
  const current = currentPayrollPeriod(now);
  const totals = tally(receipts, catalog);
  const firstAt = receipts.reduce((earliest, receipt) => Math.min(earliest, Date.parse(receipt.recordedAt)), now);
  const next = { schemaVersion: 1, policy: ADVERT_COMPETITION_POLICY, catalog: [...catalog.values()],
    nextWeek: state?.nextWeek || currentPayrollPeriod(firstAt).week,
    closedWeeks: structuredClone(state?.closedWeeks || []), grants: structuredClone(state?.grants || []),
    plays: structuredClone(state?.plays || []), ...totals };
  // Bound a recovery pass; the persisted cursor resumes automatically on the next timer tick.
  for (let recovered = 0; next.nextWeek < current.week && recovered < 100; recovered++) {
    const week = next.nextWeek;
    if (next.unresolved.some(row => row.week === week)) break;
    if (!next.closedWeeks.some(row => row.week === week)) {
      const ranking = next.weeklyTotals.filter(row => row.week === week)
        .sort((a, b) => b.net - a.net || a.advertId.localeCompare(b.advertId));
      const winners = ranking.length && ranking[0].net > 0 ? ranking.filter(row => row.net === ranking[0].net).map(row => row.advertId) : [];
      next.closedWeeks.push({ week, ...payrollPeriodFromKey(week), closedAt: new Date(now).toISOString(), ranking, winners });
      const reward = payrollPeriodFromKey(followingWeek(week));
      for (const advertId of winners) next.grants.push({ advertId, sourceWeek: week, rewardWeek: reward.week,
        startAt: reward.startAt, endAt: reward.endAt });
    }
    next.nextWeek = followingWeek(week);
  }
  validateAdvertCompetition(next);
  return next;
}

export function competitionGrant(state, marker, at) {
  return state?.grants.find(grant => grant.advertId === marker?.advertId && grant.sourceWeek === marker?.sourceWeek &&
    grant.rewardWeek === marker?.rewardWeek && Date.parse(grant.startAt) <= at && at < Date.parse(grant.endAt));
}

export function competitionCandidates({ state, snapshot, now, isCampaignRemoved, resolveCampaignMedia }) {
  if (!state || snapshot.paused || snapshot.chainId !== 8453) return [];
  const campaigns = new Map(state.catalog.map(campaign => [campaign.campaignId, campaign]));
  for (const campaign of snapshot.campaigns) campaigns.set(String(campaign.campaignId), campaign);
  const candidates = [];
  for (const grant of state.grants) {
    if (!competitionGrant(state, grant, now)) continue;
    const matching = [...campaigns.values()].filter(campaign => advertIdentity(campaign) === grant.advertId);
    if (matching.some(campaign => campaign.removed || campaign.moderationBlocked || isCampaignRemoved(campaign.campaignId, campaign) ||
      snapshot.contentBlockedMedia?.includes(campaign.audioURI))) continue;
    const campaign = matching.reverse().find(campaign => typeof campaign.title === 'string' && campaign.title &&
      resolveCampaignMedia(campaign, campaign.audioURI.slice(7)));
    if (!campaign) continue;
    const plays = state.plays.filter(play => play.advertId === grant.advertId && play.sourceWeek === grant.sourceWeek);
    candidates.push({ campaign, grant, playCount: plays.length, lastPlayedAt: plays.at(-1)?.recordedAt || '' });
  }
  return candidates.sort((a, b) => a.playCount - b.playCount || a.lastPlayedAt.localeCompare(b.lastPlayedAt) ||
    a.grant.advertId.localeCompare(b.grant.advertId));
}
