const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const JS_DIR = path.join(__dirname, '..', 'js');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sourceFiles(full);
    return /\.(m?js)$/.test(entry.name) ? [full] : [];
  });
}

const approveCalls = sourceFiles(JS_DIR).flatMap(file => {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  return lines.flatMap((line, index) => /\.approve\(/.test(line)
    ? [{ file: path.relative(JS_DIR, file), line: index + 1, text: line, before: lines.slice(Math.max(0, index - 6), index).join('\n') }]
    : []);
});

test('site code contains token approvals to guard', () => {
  assert.ok(approveCalls.length >= 4, `expected approval call sites, found ${approveCalls.length}`);
});

test('no token approval requests an unlimited allowance', () => {
  for (const call of approveCalls) {
    assert.doesNotMatch(call.text, /MaxUint|maxUint|2\s*\*\*\s*256|0xf{32,}|uint256\.max/i, `${call.file}:${call.line} must approve an exact amount`);
  }
  for (const file of sourceFiles(JS_DIR)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /ethers\.MaxUint256/, `${path.relative(JS_DIR, file)} must not reference MaxUint256`);
  }
});

test('every approval is skipped when the existing allowance already covers the payment', () => {
  for (const call of approveCalls) {
    assert.match(call.before, /allowance\(/, `${call.file}:${call.line} must check allowance before approving`);
  }
});

test('approval notice is calm, exact and does not duplicate the currency', async () => {
  const { approvalNotice } = await import('../js/base-chain.mjs');
  assert.match(approvalNotice('5 USDC'), /^Approve exactly 5 USDC — nothing more\./);
  assert.match(approvalNotice('1.50'), /^Approve exactly 1\.50 USDC/);
  assert.match(approvalNotice('2'), /verified on Basescan/);
});
