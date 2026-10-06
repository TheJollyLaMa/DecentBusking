const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const url = pathToFileURL(path.join(__dirname, '../js/radio-payroll.mjs')).href;
const track = (wallet, plays) => ({ wallet: `0x${String(wallet).repeat(40)}`, plays, artist: `Artist ${wallet}` });

test('playback preview groups artists, caps its budget, and retains dust and rounding', async () => {
  const { previewPlaybackPayroll } = await import(url);
  const result = previewPlaybackPayroll({ tracks: [track(1, 1), track(1, 1), track(2, 1), track(3, 1), { plays: 999 }],
    budgetUnits: 3000000n, minimumUnits: 1000000n });
  assert.equal(result.entries.length, 3);
  assert.equal(result.totalPlays, 4n);
  assert.equal(result.allocatedUnits, 1500000n);
  assert.equal(result.remainderUnits, 1500000n);
  assert.equal(result.entries[0].amountUnits, 1500000n);
  assert.equal(result.entries[1].payable, false);
  const empty = previewPlaybackPayroll({ tracks: [], budgetUnits: 1000000n });
  assert.equal(empty.remainderUnits, 1000000n);
  const zeroAddress = previewPlaybackPayroll({ tracks: [track(0, 10)], budgetUnits: 1000000n });
  assert.equal(zeroAddress.entries.length, 0);
});

test('Top 10 preview ranks unique artists and splits only its capped prize budget', async () => {
  const { previewTopTenPayroll } = await import(url);
  const result = previewTopTenPayroll({ tracks: [track(1, 5), track(1, 4), track(2, 8), track(3, 2)], budgetUnits: 1000001n });
  assert.equal(result.entries.length, 3);
  assert.equal(result.entries[0].plays, 9);
  assert.equal(result.allocatedUnits, 999999n);
  assert.equal(result.remainderUnits, 2n);
  const many = previewTopTenPayroll({ tracks: Array.from({ length: 13 }, (_value, index) => track((index + 1).toString(16), 20 - index)), budgetUnits: 10000000n });
  assert.equal(many.entries.length, 10);
  assert.equal(many.allocatedUnits, 10000000n);
  assert.throws(() => previewTopTenPayroll({ tracks: [], budgetUnits: -1n }), /nonnegative/);
});