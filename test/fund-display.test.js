const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '../js/fund-display.mjs')).href;

test('pending fund tables show song estimates without pretending to be on-chain transactions', async () => {
  const { renderFundPendingTable, renderFundWeeklyArchive } = await import(url);
  const rows = [{ rank: 1, trackId: 'song-1', title: '<Song>', artist: 'Artist', wallet: `0x${'1'.repeat(40)}`, votes: 17, plays: 3, amountUnits: '6125000', walletHtml: '<button>artist.eth</button>' }];
  const top = renderFundPendingTable(rows, { fundSlug: 'dbusk-top10', week: 'NY-2026-10-12' });
  assert.match(top, /Pending · Top 10 song prizes/);
  assert.match(top, /fund-pending-row/);
  assert.match(top, /&lt;Song&gt;/);
  assert.match(top, /artist\.eth/);
  assert.match(top, /\$6\.13/);
  assert.match(top, /Net votes/);
  assert.doesNotMatch(top, /basescan\.org/);
  const playback = renderFundPendingTable(rows, { fundSlug: 'dbusk-playback' });
  assert.match(playback, /Qualified plays/);
  assert.match(playback, /Song contributions to artist-wallet payments/);
  assert.match(renderFundPendingTable(null, { fundSlug: 'dbusk-top10' }), /estimates unavailable/);
  const archive = renderFundWeeklyArchive({ weeks: [{ week: 'NY-2026-10-12', totalUnits: '6125000', paidUnits: '0', entries: rows }] });
  assert.match(archive, /fund-weekly-frozen/);
  assert.match(archive, /Frozen · awaiting payment/);
  assert.doesNotMatch(archive, /fund-pending-row/);
});

test('fund summary features the balance and distinguishes incoming and outgoing totals', async () => {
  const { renderFundSummary } = await import(url);
  const details = { balanceUnits: 17500000n, reservedUnits: 5000000n, budgetUnits: 12500000n, inflowUnits: 20000000n, outflowUnits: 2500000n, netUnits: 17500000n };
  const html = renderFundSummary(details);
  assert.match(html, /This week's prize pool/);
  assert.match(html, /fund-prize-amount[\s\S]*?\$12\.50/);
  assert.match(html, /fund-amount-in[\s\S]*?\$20\.00/);
  assert.match(html, /fund-amount-out[\s\S]*?\$2\.50/);
  assert.match(html, /subject to approved allocation/);
  assert.equal((html.match(/class="fund-prize-dollar"/g) || []).length, 6);
  assert.equal((html.match(/&#128184;/g) || []).length, 3);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Total balance[\s\S]*?\$17\.50/);
  assert.match(html, /Reserved for older weeks[\s\S]*?\$5\.00/);
  const indexing = renderFundSummary({ ...details, budgetUnits: null }, { indexing: true });
  assert.match(indexing, /Current fund balance/);
  assert.doesNotMatch(indexing, /This week's prize pool/);
});

test('pending payments preview four rows and put the remainder in a closed dropdown', async () => {
  const { renderFundPendingTable } = await import(url);
  const rows = Array.from({ length: 10 }, (_value, index) => ({ rank: index + 1, trackId: `song-${index}`, title: `Song ${index}`, votes: 10 - index, plays: 1, amountUnits: '1000000' }));
  for (const fundSlug of ['dbusk-top10', 'dbusk-playback']) {
    const html = renderFundPendingTable(rows, { fundSlug, week: 'NY-2026-10-12' });
    const [preview, rest] = html.split('<details');
    assert.equal((preview.match(/class="fund-pending-row"/g) || []).length, 4);
    assert.equal((rest.match(/class="fund-pending-row"/g) || []).length, 6);
    assert.match(rest, /Show 6 more pending payments/);
    assert.doesNotMatch(rest.split('>')[0], /\bopen\b/);
    assert.doesNotMatch(renderFundPendingTable(rows.slice(0, 4), { fundSlug }), /<details/);
  }
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /Payments are marked Pending because/);
  assert.match(html, /Sunday\/Monday midnight in New York/);
  assert.match(html, /Frozen allocations still await payment/);
});

test('archive markup distinguishes scheduled and paid amounts and surfaces unmatched payments', async () => {
  const { renderFundWeeklyArchive } = await import(url);
  const wallet = `0x${'1'.repeat(40)}`;
  const txHash = `0x${'2'.repeat(64)}`;
  const html = renderFundWeeklyArchive({ weeks: [{ week: 'NY-2026-10-12', status: 'mismatch', totalUnits: '1000000', paidUnits: '100000', entries: [
    { wallet, amountUnits: '1000000', paidUnits: '100000', paymentMismatch: true, txHash },
  ] }], unmatchedPayouts: [{ recipient: wallet, amountUnits: '250000', txHash }] });
  assert.match(html, /Scheduled<\/th><th>Paid/);
  assert.match(html, /Running paid total/);
  assert.match(html, /Payment mismatch/);
  assert.match(html, /Unmatched on-chain payments/);
  assert.match(html, /\$0\.10/);
  assert.match(renderFundWeeklyArchive({ unmatchedPayouts: [{ recipient: wallet, amountUnits: '250000', txHash }] }), /Unmatched on-chain payments/);
});

test('USDC display rounds to exactly two decimals without changing base units', async () => {
  const { formatUsdcUnits } = await import(url);
  assert.equal(formatUsdcUnits(0n), '0.00');
  assert.equal(formatUsdcUnits(1200000n), '1.20');
  assert.equal(formatUsdcUnits(1234500n), '1.23');
  assert.equal(formatUsdcUnits(1235000n), '1.24');
  assert.equal(formatUsdcUnits(6125000n), '6.13');
  assert.equal(formatUsdcUnits(999999n), '1.00');
  assert.equal(formatUsdcUnits(-6125000n), '-6.13');
  assert.equal(formatUsdcUnits(-1n), '0.00');
  assert.equal(formatUsdcUnits(123456789012345678901234n), '123456789012345678.90');
});

test('verified sponsor aliases are shown only when they forward-resolve to the same wallet', async () => {
  const { resolveWalletLabel, renderWalletButton } = await import(url);
  const provider = {
    lookupAddress: async () => 'thejollylama.eth',
    resolveName: async name => ({
      'thejollylama.eth': '0x807061DF657A7697c04045dA7d16D941861cAABc',
      'decentcanopy.eth': '0x807061DF657A7697c04045dA7d16D941861cAABc',
      'wrong.eth': '0x0000000000000000000000000000000000000001',
    }[name] || null),
   getResolver: async () => null,
  };
  const wallet = await resolveWalletLabel('0x807061DF657A7697c04045dA7d16D941861cAABc', provider,
   { '0x807061df657a7697c04045da7d16d941861caabc': ['thejollylama.eth', 'decentcanopy.eth', 'wrong.eth'] });
  assert.equal(wallet.label, 'thejollylama.eth');
  assert.deepEqual(wallet.aliases, ['decentcanopy.eth']);
  assert.match(renderWalletButton(wallet, { role: 'sponsor' }), /data-creator="0x807061DF657A7697c04045dA7d16D941861cAABc"/);
  assert.match(renderWalletButton(wallet, { role: 'sponsor' }), /title="0x807061DF657A7697c04045dA7d16D941861cAABc"/);
  assert.match(renderWalletButton(wallet, { role: 'sponsor' }), /fund-wallet-link/);
  assert.match(renderWalletButton({ address: wallet.address, label: wallet.address }, { role: 'sponsor' }), /creator-profile-wallet-icons/);
  const walletFromChecksumKey = await resolveWalletLabel('0x807061DF657A7697c04045dA7d16D941861cAABc', provider,
   { '0x807061DF657A7697c04045dA7d16D941861cAABc': ['thejollylama.eth', 'decentcanopy.eth'] });
  assert.deepEqual(walletFromChecksumKey.aliases, ['decentcanopy.eth']);
});

test('known contracts render as explorer badges instead of raw addresses', async () => {
  const { resolveWalletLabel, renderWalletButton } = await import(url);
  const wallet = await resolveWalletLabel('0x135Cbc573F87637158eb3186C87c584fb0B34CD9', null, {});
  const html = renderWalletButton(wallet, { role: 'advert' });
  assert.match(html, /📜 DeVert v0\.1/);
  assert.match(html, /basescan\.org\/address\/0x135Cbc573F87637158eb3186C87c584fb0B34CD9#code/);
});

test('fund disclosure markup includes proof links and campaign references', async () => {
  const { renderFundDisclosure, renderFundsSection } = await import(url);
  const markup = renderFundDisclosure({
    label: 'Top 10 Prize Payouts',
    description: 'Top 10 payouts for the week',
    balanceUnits: '12250000',
    availableUnits: '12250000',
    sources: [{
      kind: 'advert',
      amountUnits: '12250000',
      txHash: '0x' + 'a'.repeat(64),
      blockNumber: 123,
      displayLabel: 'thejollylama.eth',
      walletHtml: '<button type="button" class="nft-creator-profile fund-wallet-link" data-creator="0x1">thejollylama.eth</button>',
      campaignId: '7',
      title: 'Weekend shoutout',
      advertiserLabel: 'thejollylama.eth',
    }],
  });
  assert.match(markup, /Top 10 Prize Payouts/);
  assert.match(markup, /BaseScan/);
  assert.match(markup, /Campaign #7/);
  assert.match(markup, /nft-creator-profile/);
  assert.match(renderFundsSection([], 'Community Funds'), /Community Funds/);
});

test('weekly payout archive markup renders details rows and running totals', async () => {
  const { renderFundWeeklyArchive, renderWalletAddress } = await import(url);
  const html = renderFundWeeklyArchive({
    weeks: [{
      week: 'NY-2026-10-05',
      status: 'partial',
      totalUnits: '1000000',
      metadataUri: 'ipfs://bafy-week',
      period: { startAt: '2026-10-05T04:00:00.000Z' },
      entries: [{
        artist: 'Artist One',
        walletLabel: 'thejollylama.eth',
        walletHtml: renderWalletAddress('0x807061DF657A7697c04045dA7d16D941861cAABc'),
        amountUnits: '500000',
        paid: true,
        txHash: '0x' + '1'.repeat(64),
        plays: 12,
      }],
    }],
  });
  assert.match(html, /fund-weekly-details/);
  assert.match(html, /NY-2026-10-05/);
  assert.match(html, /partial/i);
  assert.match(html, /BaseScan/);
  assert.match(html, /IPFS JSON/);
  assert.match(html, /creator-profile-wallet-icons/);
});

test('fund details stay in the fund modals rather than the Top10 song panel', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const aboutSource = fs.readFileSync(path.join(__dirname, '../js/components/about-override.js'), 'utf8');
  const topTenSource = fs.readFileSync(path.join(__dirname, '../js/top-ten-board.mjs'), 'utf8');
  assert.doesNotMatch(indexHtml, /id="top-ten-fund-summary"/);
  assert.match(indexHtml, /id="dbusk-top10-button"/);
  assert.match(indexHtml, /id="dbusk-playback-button"/);
  assert.match(indexHtml, /id="fund-breakdown-dialog"/);
  assert.match(aboutSource, /community-funds-section/);
  assert.match(aboutSource, /Fund balances unavailable right now/);
  assert.doesNotMatch(topTenSource, /renderFundSourcesTable|renderFundWeeklyArchive|Funding ▾|fundsSummary/);
  assert.match(topTenSource, /weekly\?\.funds\?\.top10\?\.budgetUnits/);
  assert.match(topTenSource, /\/api\/payroll\/weekly/);
});
