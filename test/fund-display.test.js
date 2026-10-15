const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const url = pathToFileURL(path.join(__dirname, '../js/fund-display.mjs')).href;

test('USDC amounts trim trailing zeros but keep two decimals minimum', async () => {
  const { formatUsdcUnits } = await import(url);
  assert.equal(formatUsdcUnits(0n), '0.00');
  assert.equal(formatUsdcUnits(1200000n), '1.20');
  assert.equal(formatUsdcUnits(1234500n), '1.2345');
  assert.equal(formatUsdcUnits(1234000n), '1.234');
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

test('fund UI files include the live fund summary and unavailable state copy', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const aboutSource = fs.readFileSync(path.join(__dirname, '../js/components/about-override.js'), 'utf8');
  const topTenSource = fs.readFileSync(path.join(__dirname, '../js/top-ten-board.mjs'), 'utf8');
  assert.match(indexHtml, /id="top-ten-fund-summary"/);
  assert.match(indexHtml, /id="dbusk-top10-button"/);
  assert.match(indexHtml, /id="dbusk-playback-button"/);
  assert.match(indexHtml, /id="fund-breakdown-dialog"/);
  assert.match(aboutSource, /community-funds-section/);
  assert.match(aboutSource, /Fund balances unavailable right now/);
  assert.match(topTenSource, /Top 10 fund:/);
});
