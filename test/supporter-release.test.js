const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

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
  assert.match(read('js/components/about-override.js'), /preparing a fresh Base version/);
});
