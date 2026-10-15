const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ethers = require('../discord-bot/node_modules/ethers');

const url = pathToFileURL(path.join(__dirname, '../js/fund-header.mjs')).href;
const top10 = 'dbusk-top10';

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

test('fund header labels use the week number and a USDC icon', async () => {
  const { fundWeekNumber, fundButtonHtml } = await import(url);
  assert.equal(fundWeekNumber(Date.parse('2026-10-14T20:00:00-04:00')), 0);
  assert.equal(fundWeekNumber(Date.parse('2026-10-19T00:30:00-04:00')), 1);
  assert.equal(fundWeekNumber(Date.parse('2026-10-18T23:30:00-04:00')), 0);
  const html = fundButtonHtml({ emoji: '🏆', label: 'Top10 fund' }, '12250000', Date.parse('2026-10-14T20:00:00-04:00'));
  assert.equal(html, '🏆 Week 0 Top10 fund: $12.25 <img class="usdc-icon" src="img/usdc.svg" alt="USDC" width="16" height="16">');
});
