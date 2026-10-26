const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

test('Supporter preparation and announcement use one pinned kit with approved 100-edition/100-USDC terms', () => {
  const read = file => readFileSync(join(__dirname, '..', file), 'utf8');
  const prepare = read('.github/workflows/supporter-release.yml');
  const announce = read('.github/workflows/supporter-announce.yml');
  const pin = prepare.match(/product-supporter-prepare\.yml@([a-f0-9]{40})/)[1];
  assert.match(prepare, new RegExp(`head_ref: ${pin}\\n`));
  assert.match(announce, new RegExp(`product-supporter-announce\\.yml@${pin}\\n`));
  assert.match(announce, new RegExp(`head_ref: ${pin}\\n`));
  assert.match(prepare, /quantity: '100'\n/);
  assert.match(prepare, /price_usdc: '100000000'\n/);
  assert.match(prepare, /ens_name: \$\{\{ vars\.SUPPORTER_ENS_NAME \}\}/);
  const configContext = { window: {} };
  vm.runInNewContext(read('decent.config.js'), configContext);
  const listing = configContext.window.DecentConfig.supporterDnft;
  assert.equal(listing.chainId, 8453);
  assert.equal(listing.contract, '0xe63EC9f8228720bAAC2fD528C0A6d06B3Dc5439B');
  assert.equal(listing.tokenId, '75');
  assert.equal(listing.escrowAddress, '0x31b07b83e99A9bdF379bf40225b8A80d3804C89d');
  assert.equal(listing.listingId, '5');
  assert.equal(listing.paymentToken, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  assert.equal(listing.expectedPriceAmount, '100000000');
});

test('About checkout is pinned to the exact Base listing and verifies one confirmed USDC purchase', () => {
  const read = file => readFileSync(join(__dirname, '..', file), 'utf8');
  const about = read('js/components/about-override.js');
  assert.match(about, /const _BASE_CHAIN_ID\s*=\s*8453n/);
  assert.doesNotMatch(about, /OPTIMISM|chainId: '0xa'/i);
  assert.match(about, /id="buy-cards"/);
  assert.match(about, /this\._loadDecentBuskingListings\(\)/);
  assert.match(about, /wallet \? wallet\.rawProvider : window\.ethereum/);
  assert.match(about, /l\.nftContract\.toLowerCase\(\).*_NFT_ADDRESS/);
  assert.match(about, /l\.tokenId === BigInt\(config\.tokenId\)/);
  assert.match(about, /l\.priceAmount === BigInt\(config\.expectedPriceAmount\)/);
  assert.match(about, /allowance !== tokenAmount/);
  assert.match(about, /await escrow\.purchaseWithToken\(listingId, 1\)/);
  assert.match(about, /event\?\.name === 'Purchased'/);
  assert.match(about, /approvalReceipt\?\.status !== 1/);
  assert.match(about, /receipt\?\.status !== 1/);
});
