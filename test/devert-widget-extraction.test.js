const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('DVert controller imports are inert and leave radio startup to the site adapter', async () => {
  for (const file of ['devert-tab.mjs', 'devert-paid-queue.mjs', 'devert-history.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    assert.doesNotMatch(source, /DOMContentLoaded|from ['"].*radio-sync/);
    assert.match(source, /environment = \{\}/);
    assert.match(source, /destroy\(\)/);
    await import(`../js/${file}`);
  }
  const bootstrap = fs.readFileSync(path.join(__dirname, '../js/devert-site.mjs'), 'utf8');
  assert.match(bootstrap, /initDevertTab\(\{ radio \}\)/);
  assert.match(bootstrap, /initDevertPaidQueue\(\)/);
  assert.match(bootstrap, /initDevertHistory\(\)/);
});

test('standalone can override confirmation effects without importing global celebration UI', () => {
  for (const file of ['devert-tab.mjs', 'devert-queue.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '../js', file), 'utf8');
    assert.doesNotMatch(source, /from ['"].*payment-celebration/);
    assert.match(source, /onConfirmed = announcePaymentCelebration/);
    assert.match(source, /onConfirmed\(\{/);
  }
});
