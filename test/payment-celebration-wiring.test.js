const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('confirmed payment surfaces are wired to the shared celebration helper', () => {
  const root = path.join(__dirname, '../js');
  const files = [
    'djuke.mjs',
    'listens.mjs',
    'devert-tab.mjs',
    'stage.js',
    'payroll.js',
    'radio-payroll.mjs',
    'settlement-funds.mjs',
    'components/about-override.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /announcePaymentCelebration/);
    assert.match(source, /payment-celebration\.mjs/);
  }
});
