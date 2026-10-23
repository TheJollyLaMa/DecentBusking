const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '../js/fund-display.mjs')).href;

test('unknown fund amounts and unavailable source history never render as zero or an empty verified history', async () => {
  const { renderUsdcAmount, renderFundDisclosure, renderFundSourcesTable } = await import(url);
  for (const value of [null, undefined]) {
    assert.match(renderUsdcAmount(value), /Unavailable/);
    assert.doesNotMatch(renderUsdcAmount(value), /\$0\.00/);
  }
  assert.match(renderUsdcAmount('0'), /\$0\.00/);
  const fund = { label: 'Fund', balanceUnits: null, availableUnits: null, sourcesAvailable: false, sources: [] };
  assert.doesNotMatch(renderFundDisclosure(fund), /\$0\.00/);
  assert.match(renderFundSourcesTable(fund), /unavailable or still indexing/);
});

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

test('fund summary features only the prize pool and preserves unavailable-budget warnings', async () => {
  const { renderFundSummary } = await import(url);
  const details = { balanceUnits: 17500000n, reservedUnits: 5000000n, budgetUnits: 12500000n, inflowUnits: 20000000n, outflowUnits: 2500000n, netUnits: 17500000n };
  const html = renderFundSummary(details);
  assert.match(html, /This week's prize pool/);
  assert.match(html, /fund-prize-amount[\s\S]*?\$12\.50/);
  assert.doesNotMatch(html, /fund-flow|Total balance|Reserved for older weeks|Total in|Total out|Net|Unreserved|subject to approved allocation|fund-prize-caption/);
  assert.equal((html.match(/class="fund-prize-dollar"/g) || []).length, 6);
  assert.equal((html.match(/&#128184;/g) || []).length, 3);
  assert.match(html, /aria-hidden="true"/);
  const indexing = renderFundSummary({ ...details, budgetUnits: null }, { indexing: true });
  assert.match(indexing, /Current fund balance/);
  assert.match(indexing, /\$17\.50/);
  assert.match(indexing, /History is still indexing/);
  assert.doesNotMatch(indexing, /This week's prize pool/);
  assert.match(renderFundSummary({ balanceUnits: 0n, budgetUnits: 0n }), /This week's prize pool/);
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
  assert.match(html, /<details class="fund-payment-info">\s*<summary aria-label="About pending fund payments">i<\/summary>\s*<p class="fund-pending-notice">/);
  assert.equal((html.match(/class="fund-pending-notice"/g) || []).length, 1);
  assert.doesNotMatch(html, /<details class="fund-payment-info" open/);
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
  const queue = await resolveWalletLabel('0xe54609f022a8d760417e7cc0eea6360b6e1d11bb', null, {});
  const queueHtml = renderWalletButton(queue, { role: 'advert' });
  assert.match(queueHtml, /📜 DVert paid queue v0\.2/);
  assert.match(queueHtml, /basescan\.org\/address\/0xe54609f022A8D760417E7cc0Eea6360b6E1D11Bb#code/);
  assert.doesNotMatch(queueHtml, /data-creator/);
});

test('fund wallet labels use the contributor whitelist without replacing ENS or labeling unknown wallets', async t => {
  const { resolveWalletLabel, renderWalletButton } = await import(url);
  const accounts = JSON.parse(fs.readFileSync(path.join(__dirname, '../contributor-accounts.json'), 'utf8'));
  const contributor = accounts.contributors.find(account => account.github === 'withinthevacuum');
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: 'https://site.example/DecentBusking/' } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async request => {
    requests++;
    assert.match(request.pathname, /\/contributor-accounts\.json$/);
    return { ok: true, json: async () => accounts };
  });
  const provider = { lookupAddress: async () => null };
  const label = await resolveWalletLabel(contributor.walletAddress.toLowerCase(), provider);
  assert.equal(label.label, 'withinthevacuum');
  assert.match(renderWalletButton(label), /withinthevacuum/);
  assert.match(renderWalletButton(label), /data-creator="0x405bb3cdf23833bb27bad6629b7cd4f01688235f"/);
  assert.match(renderWalletButton(label), /title="0x405bb3cdf23833bb27bad6629b7cd4f01688235f"/);
  const unknown = await resolveWalletLabel(`0x${'a'.repeat(40)}`, provider);
  assert.equal(unknown.label, '0xaaaa…aaaa');
  assert.equal(requests, 1, 'the maintainer whitelist is shared across wallet lookups');
  const ens = await resolveWalletLabel(contributor.walletAddress, {
    lookupAddress: async () => 'verified.eth', resolveName: async () => contributor.walletAddress,
    getResolver: async () => null,
  });
  assert.equal(ens.label, 'verified.eth', 'verified ENS still takes precedence');
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

test('advert funding source keeps the purchaser separate from the DeVert contract badge', async () => {
  const { renderFundSourcesTable } = await import(url);
  const html = renderFundSourcesTable({ sources: [{
    kind: 'advert',
    amountUnits: '4500000',
    walletHtml: '<a>DeVert v0.1</a>',
    advertiser: `0x${'1'.repeat(40)}`,
    advertiserHtml: '<button data-creator="buyer">buyer.eth</button>',
  }] });
  assert.match(html, /DeVert v0\.1/);
  assert.match(html, /<button data-creator="buyer">buyer\.eth<\/button>/);
  assert.doesNotMatch(html, /&lt;button/);
  assert.match(renderFundSourcesTable({ sources: [{ kind: 'advert', amountUnits: '1' }] }), /Purchaser unavailable/);
});

test('paid advert funding shows settlement and identifies the paying wallet', async () => {
  const { renderFundSourcesTable } = await import(url);
  const html = renderFundSourcesTable({ sources: [{
    kind: 'advert', paidAdvert: true, amountUnits: '450000', requestId: '8', campaignId: '9',
    payer: `0x${'1'.repeat(40)}`, advertiser: `0x${'2'.repeat(40)}`,
  }] });
  assert.match(html, /Paid advert playback/);
  assert.match(html, /Paid request #8/);
  assert.match(html, new RegExp(`payer 0x${'1'.repeat(40)}`));
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
