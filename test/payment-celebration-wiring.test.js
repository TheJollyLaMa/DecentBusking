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
    assert.match(source, file === 'devert-tab.mjs' ? /devert-payment\.mjs/ : /payment-celebration\.mjs/);
  }
});

test('DVert campaign and priority payments share a DVert-tagged popout and outside clicks preserve the panel', () => {
  const root = path.join(__dirname, '../js');
  for (const name of ['devert-tab.mjs', 'devert-queue.mjs']) {
    assert.match(fs.readFileSync(path.join(root, name), 'utf8'), /announcePaymentCelebration.*from '\.\/devert-payment\.mjs'/);
  }
  assert.match(fs.readFileSync(path.join(root, 'devert-payment.mjs'), 'utf8'), /\.\.\.payment, source: 'devert'/);
  assert.match(fs.readFileSync(path.join(root, 'devert-tab.mjs'), 'utf8'),
    /event\.composedPath\(\)\.some\(element => element\.id === 'payment-celebration-root' && element\.dataset\.source === 'devert'\)\) return/);
});
