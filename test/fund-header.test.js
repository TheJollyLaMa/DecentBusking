const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ethers = require('../discord-bot/node_modules/ethers');

const url = pathToFileURL(path.join(__dirname, '../js/fund-header.mjs')).href;
const top10 = 'dbusk-top10';

test('explicitly unavailable balances stay unknown instead of falling back to cached or weekly money', async () => {
  const { fundStateFor, loadFundBreakdown, fundButtonHtml } = await import(url);
  const state = { ready: true, funds: { [top10]: { balanceUnits: null, balanceAvailable: false, sources: [], payouts: [] } },
    weekly: { funds: { top10: { balanceUnits: '42', budgetUnits: '40', reservedUnits: '2' } } } };
  const fund = fundStateFor(state, top10, '99');
  assert.equal(fund.balanceUnits, null);
  assert.equal(fund.budgetUnits, null);
  assert.equal(fund.pendingRows, null);
  const details = await loadFundBreakdown({ fundSlug: top10, fundState: fund, fundBalanceUnits: 99n });
  assert.equal(details.balanceUnits, null);
  assert.equal(details.reconciles, false, 'empty history cannot verify an unknown balance as zero');
  assert.match(fundButtonHtml({ emoji: '🏆', label: 'Top10' }, null), /Unavailable/);
  assert.doesNotMatch(fundButtonHtml({ emoji: '🏆', label: 'Top10' }, null), /\$0\.00/);
  const unavailableHistory = await loadFundBreakdown({ fundSlug: top10,
    fundState: { balanceUnits: '0', sources: [], payouts: [], sourcesAvailable: false, payoutsAvailable: false } });
  assert.equal(unavailableHistory.historyAvailable, false);
  assert.equal(unavailableHistory.reconciles, false);
});

function fakeEnsProvider() {
  return {
    lookupAddress: async address => ({
      '0x807061df657a7697c04045da7d16d941861caabc': 'thejollylama.eth',
      '0x4444444444444444444444444444444444444444': 'djuke-wallet.eth',
    }[address.toLowerCase()] || null),
    resolveName: async name => ({
      'thejollylama.eth': '0x807061DF657A7697c04045dA7d16D941861cAABc',
      'decentcanopy.eth': '0x807061DF657A7697c04045dA7d16D941861cAABc',
      'djuke-wallet.eth': '0x4444444444444444444444444444444444444444',
    }[name] || null),
    getResolver: async () => null,
  };
}

test('loadFundBreakdown groups inflows, payouts, and reconciles the balance', async () => {
  const { loadFundBreakdown } = await import(url);
  const state = {
    balanceUnits: '12250000',
    sources: [
      { txHash: '0x' + '1'.repeat(64), logIndex: 0, blockNumber: 10, timestamp: 1_700_000_010, amountUnits: '2250000', funder: '0x135Cbc573F87637158eb3186C87c584fb0B34CD9', kind: 'advert', campaignId: '7', title: 'Weekend shoutout', advertiser: '0x807061DF657A7697c04045dA7d16D941861cAABc' },
      { txHash: '0x' + '2'.repeat(64), logIndex: 0, blockNumber: 11, timestamp: 1_700_000_011, amountUnits: '1020000', funder: '0x5d07489163feBCdB39C9F579CCC36dff5A067FF9', kind: 'djuke', requestId: '42', payer: '0x4444444444444444444444444444444444444444' },
      { txHash: '0x' + '3'.repeat(64), logIndex: 0, blockNumber: 12, timestamp: 1_700_000_012, amountUnits: '11980000', funder: '0x807061DF657A7697c04045dA7d16D941861cAABc', kind: 'sponsor' },
    ],
    payouts: [
      { txHash: '0x' + '4'.repeat(64), logIndex: 0, blockNumber: 13, timestamp: 1_700_000_013, amountUnits: '3000000', recipient: '0x4444444444444444444444444444444444444444', slug: top10 },
    ],
  };
  const result = await loadFundBreakdown({
    fundSlug: top10,
    fundState: state,
    fundBalanceUnits: 12_250_000n,
    ensProvider: fakeEnsProvider(),
    sponsorAliases: {
      '0x807061df657a7697c04045da7d16d941861caabc': ['thejollylama.eth', 'decentcanopy.eth'],
      '0x807061DF657A7697c04045dA7d16D941861cAABc': ['thejollylama.eth', 'decentcanopy.eth'],
      '0x4444444444444444444444444444444444444444': ['djuke-wallet.eth'],
    },
  });

  assert.equal(result.historyAvailable, true);
  assert.equal(result.balanceUnits, 12_250_000n);
  assert.equal(result.inflowUnits, 15_250_000n);
  assert.equal(result.outflowUnits, 3_000_000n);
  assert.equal(result.netUnits, 12_250_000n);
  assert.equal(result.reconciles, true);

  const advert = result.rows.find(row => row.kind === 'advert');
  assert.ok(advert);
  assert.equal(advert.direction, 'in');
  assert.match(advert.sourceHtml, /📜 DeVert v0\.1/);
  assert.match(advert.sourceHtml, /Purchased by[\s\S]*thejollylama\.eth/);
  assert.match(advert.sourceHtml, /data-fund-role="advertiser"/);
  assert.match(advert.extra, /Campaign #7/);
  assert.match(advert.extra, /Weekend shoutout/);

  const djuke = result.rows.find(row => row.kind === 'djuke');
  assert.ok(djuke);
  assert.match(djuke.sourceHtml, /📜 DJuke v0\.3/);
  assert.match(djuke.extra, /DJuke request #42/);

  const sponsor = result.rows.find(row => row.kind === 'sponsor');
  assert.ok(sponsor);
  assert.match(sponsor.sourceHtml, /thejollylama\.eth/);
  assert.match(sponsor.sourceHtml, /decentcanopy\.eth/);
  assert.match(sponsor.typeLabel, /Sponsor deposit/);

  const payout = result.rows.find(row => row.direction === 'out');
  assert.ok(payout);
  assert.match(payout.txUrl, /basescan\.org\/tx\/0x4+/);
  assert.equal(result.rows[0].direction, 'out', 'rows are newest first');
});

test('loadFundBreakdown reports indexing instead of scanning logs when the worker has no payout history yet', async () => {
  const { loadFundBreakdown } = await import(url);
  const result = await loadFundBreakdown({ fundSlug: 'dbusk-playback', fundState: { balanceUnits: '5', sources: [] }, ensProvider: fakeEnsProvider() });
  assert.equal(result.historyAvailable, false);
  assert.match(result.error.message, /indexing/);
  assert.equal(result.balanceUnits, 5n);
});

test('advert purchasers render as wallet buttons without ENS and campaign text is escaped only at rendering', async () => {
  const { loadFundBreakdown } = await import(url);
  const buyer = `0x${'1'.repeat(40)}`;
  const result = await loadFundBreakdown({
    fundSlug: top10,
    fundState: {
      balanceUnits: '4500000', payouts: [],
      sources: [{ funder: '0x135Cbc573F87637158eb3186C87c584fb0B34CD9', kind: 'advert', amountUnits: '4500000', advertiser: buyer, title: '<Ad & music>', campaignId: '2' }],
    },
    ensProvider: null,
  });
  assert.match(result.rows[0].sourceHtml, /DeVert v0\.1/);
  assert.match(result.rows[0].sourceHtml, new RegExp(`data-creator="${buyer}"`));
  assert.match(result.rows[0].sourceHtml, /Purchased by/);
  assert.equal(result.rows[0].extra, 'Campaign #2 · <Ad & music>');
  const missing = await loadFundBreakdown({
    fundSlug: top10,
    fundState: { balanceUnits: '0', payouts: [], sources: [{ kind: 'advert', amountUnits: '1' }] },
    ensProvider: null,
  });
  assert.match(missing.rows[0].sourceHtml, /Purchaser unavailable/);
});

test('fund header labels use the week number and a USDC icon', async () => {
  const { fundWeekNumber, fundButtonHtml } = await import(url);
  assert.equal(fundWeekNumber(Date.parse('2026-10-14T20:00:00-04:00')), 0);
  assert.equal(fundWeekNumber(Date.parse('2026-10-19T00:30:00-04:00')), 1);
  assert.equal(fundWeekNumber(Date.parse('2026-10-18T23:30:00-04:00')), 0);
  const html = fundButtonHtml({ emoji: '🏆', label: 'Top10 fund' }, '12250000', Date.parse('2026-10-14T20:00:00-04:00'));
  assert.match(html, /Week 0 Top10 fund:/);
  assert.match(html, /\$12\.25/);
  assert.match(html, /class="usdc-icon"/);
  assert.match(html, /🏆<span class="fund-header-label"> Week 0 Top10 fund:<\/span>/);
});

test('fund snapshots refresh budgets and reservations and reject the previous week at turnover', async () => {
  const { loadFundState, fundStateFor } = await import(url);
  let balance = '17250000';
  let reserved = '12250000';
  let budget = '5000000';
  let week = 'NY-2026-10-19';
  let lastCheckedAt = '2026-10-19T04:00:30.000Z';
  const now = Date.parse('2026-10-19T00:01:00-04:00');
  const fetchImpl = async address => ({ ok: true, json: async () => address.endsWith('/api/funds')
    ? { ready: true, funds: { [top10]: { balanceUnits: balance, sources: [], payouts: [] } } }
    : { ready: true, chainId: 8453, currentPeriod: { week }, lastCheckedAt, funds: { top10: { budgetUnits: budget, reservedUnits: reserved } } } });
  const snapshot = await loadFundState({ serviceUrl: 'https://worker.example', fetchImpl, now });
  const first = fundStateFor(snapshot, top10);
  assert.equal(first.balanceUnits, '17250000');
  assert.equal(first.budgetUnits, '5000000');
  assert.equal(first.reservedUnits, '12250000');
  balance = '22250000'; budget = '10000000';
  const updated = fundStateFor(await loadFundState({ serviceUrl: 'https://worker.example', fetchImpl, now }), top10);
  assert.equal(updated.budgetUnits, '10000000');
  assert.equal(updated.reservedUnits, '12250000');
  balance = '10000000'; reserved = '0';
  const paid = fundStateFor(await loadFundState({ serviceUrl: 'https://worker.example', fetchImpl, now }), top10);
  assert.equal(paid.budgetUnits, '10000000');
  assert.equal(paid.reservedUnits, '0');
  week = 'NY-2026-10-12';
  const stale = fundStateFor(await loadFundState({ serviceUrl: 'https://worker.example', fetchImpl, now }), top10);
  assert.equal(stale.budgetUnits, null);
  week = 'NY-2026-10-19'; lastCheckedAt = '2026-10-19T03:59:59.000Z';
  const oldBudget = fundStateFor(await loadFundState({ serviceUrl: 'https://worker.example', fetchImpl, now }), top10);
  assert.equal(oldBudget.budgetUnits, null);
});

test('fund pending songs move with ranks and funding and keep Playback separate from Top10', async () => {
  const { fundPendingRows } = await import(url);
  const wallet = `0x${'1'.repeat(40)}`;
  const report = { current: true, tracks: [
    { trackId: 'first', title: 'First', wallet, votes: 17, plays: 3 },
    { trackId: 'second', title: 'Second', wallet, votes: 8, plays: 1 },
    { trackId: 'third', title: 'Third', wallet: `0x${'2'.repeat(40)}`, votes: 4, plays: 4 },
  ] };
  const rows = fundPendingRows({ fundSlug: top10, report, budgetUnits: '12250000' });
  assert.deepEqual(rows.map(row => row.amountUnits), ['6125000', '3062500', '3062500']);
  report.tracks[1].votes = 99;
  const changed = fundPendingRows({ fundSlug: top10, report, budgetUnits: '24500000' });
  assert.equal(changed[0].trackId, 'second');
  assert.equal(changed[0].amountUnits, '12250000');
  const playback = fundPendingRows({ fundSlug: 'dbusk-playback', report, budgetUnits: '8000001', minimumUnits: '1' });
  assert.deepEqual(playback.map(row => [row.trackId, row.amountUnits]), [['third', '4000000'], ['first', '3000000'], ['second', '1000000']]);
  assert.equal(playback.reduce((sum, row) => sum + BigInt(row.amountUnits), 0n), 8000000n);
  report.tracks.push({ trackId: 'unlinked', title: 'Unlinked', artist: 'No wallet', wallet: null, votes: 0, plays: 4 });
  const withUnlinked = fundPendingRows({ fundSlug: 'dbusk-playback', report, budgetUnits: '12000000', minimumUnits: '1' });
  assert.equal(withUnlinked.find(row => row.trackId === 'unlinked').amountUnits, '4000000');
  assert.equal(fundPendingRows({ fundSlug: top10, report, budgetUnits: null }), null);
  assert.equal(fundPendingRows({ fundSlug: top10, report: { ...report, current: false }, budgetUnits: '12250000' }), null);
});

test('fresh fund balances and estimates are not overwritten by a stale weekly balance', async () => {
  const { fundStateFor } = await import(url);
  const state = {
    ready: true,
    funds: { [top10]: { balanceUnits: '16750000' } },
    weekly: { fundShareBps: 10000, funds: { top10: {
      balanceUnits: '12250000', reservedUnits: '0', budgetUnits: '12250000',
    } } },
    currentReport: { current: true, tracks: [{ trackId: 'song', wallet: `0x${'1'.repeat(40)}`, votes: 1, plays: 1 }] },
  };
  const current = fundStateFor(state, top10);
  assert.equal(current.balanceUnits, '16750000');
  assert.equal(current.budgetUnits, '16750000');
  assert.equal(current.pendingRows[0].amountUnits, '16750000');
  state.weekly.funds.top10.reservedUnits = '5000000';
  state.weekly.fundShareBps = 5000;
  assert.equal(fundStateFor(state, top10).budgetUnits, '5875000');
  state.funds[top10].balanceUnits = '1000000';
  assert.equal(fundStateFor(state, top10).budgetUnits, '0');
  delete state.funds[top10];
  assert.equal(fundStateFor(state, top10).balanceUnits, '12250000');
  state.weekly = null;
  assert.equal(fundStateFor(state, top10, '9000000').balanceUnits, '9000000');
  assert.equal(fundStateFor(state, top10).budgetUnits, null);
});
