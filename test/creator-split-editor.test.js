const test = require('node:test');
const assert = require('node:assert/strict');

test('row editor accepts exact two-decimal percentages and resolves ENS without rounding', async () => {
  const { splitPercentToBps, resolveSplitEditorRows } = await import('../js/creator-split-editor.mjs');
  const first = `0x${'1'.repeat(40)}`;
  const second = `0x${'2'.repeat(40)}`;
  assert.equal(splitPercentToBps('33.33'), 3333);
  assert.equal(splitPercentToBps('0.01'), 1);
  for (const value of ['', '0', '-1', '100.01', '33.333', '1e2', 'NaN']) {
    assert.throws(() => splitPercentToBps(value));
  }
  assert.deepEqual(await resolveSplitEditorRows([
    { wallet: ` ${first} `, percent: '66.67', position: ' Performer ' },
    { wallet: 'producer.eth', percent: '33.33', position: 'Producer' },
  ], async name => name === 'producer.eth' ? second : null), [
    { wallet: first, shareBps: 6667, position: 'Performer' },
    { wallet: second, shareBps: 3333, position: 'Producer' },
  ]);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: first, percent: '50', position: '' },
    { wallet: 'alias.eth', percent: '50', position: '' },
  ], async () => first), /distinct/);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: 'missing.eth', percent: '100', position: '' },
  ], async () => null), /Could not resolve/);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: first, percent: '99.99', position: '' },
  ], async () => null), /exactly 100%/);
  await assert.rejects(resolveSplitEditorRows([
    { wallet: first, percent: '100', position: 'a'.repeat(81) },
  ], async () => null), /80 characters/);
});

test('song editor and album default controls are separate and have no freeform split text boxes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.doesNotMatch(html, /textarea name="splits"/);
  assert.match(html, /data-song-split-identity/);
  assert.match(html, /data-song-split-review/);
  assert.match(html, /data-song-split-editor/);
  assert.match(html, /data-album-split-editor/);
  assert.ok(html.indexOf('data-song-split-form') < html.indexOf('data-album-section'));
});
