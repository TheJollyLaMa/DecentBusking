import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAccounting, accountingReport, REVIEW_RETENTION_MS } from '../accounting.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE budget(id INTEGER PRIMARY KEY,calls INTEGER); INSERT INTO budget VALUES(1,8)');
  t.after(() => db.close());
  let time = Date.now();
  return { db, store: createAccounting(db, () => time), advance: ms => { time += ms; } };
}
test('global and per-wallet reservations are atomic, durable before dispatch and preserve unattributed legacy calls', t => {
  const { db, store } = fixture(t);
  assert.equal(store.reserve(wallet, 10), true);
  assert.equal(store.usage(wallet).calls, 1);
  assert.equal(store.usage(wallet).usageMissing, 1, 'Interrupted pass stays counted with unknown tokens');
  store.finish(wallet, 'ready', { inputTokens: 200, outputTokens: 30 });
  assert.equal(store.reserve(other, 10), true);
  store.finish(other, 'error', null);
  assert.equal(store.reserve(wallet, 10), false);
  const restarted = createAccounting(db);
  assert.equal(restarted.usage(wallet).calls, 1);
  const report = accountingReport(db);
  assert.equal(report.globalCalls, 10);
  assert.equal(report.legacyUnattributedCalls, 8);
  assert.equal(report.wallets[0].inputTokens, 200);
  assert.equal(restarted.usage(other).failed, 1);
  assert.equal(restarted.usage(other).usageMissing, 1);
});
test('wallet-write failure cannot spend global budget alone', t => {
  const { db, store } = fixture(t);
  db.exec(`CREATE TRIGGER reject_wallet BEFORE INSERT ON wallet_usage BEGIN SELECT RAISE(FAIL,'test write failure'); END`);
  assert.throws(() => store.reserve(wallet, 100), /test write failure/);
  assert.equal(db.prepare('SELECT calls FROM budget').get().calls, 8);
});
test('cancellation and known usage on a failed response are both accounted', t => {
  const { store } = fixture(t);
  store.reserve(wallet, 100);
  store.finish(wallet, 'cancelled', { inputTokens: 5, outputTokens: 2 });
  store.reserve(wallet, 100);
  store.finish(wallet, 'error', { inputTokens: 10, outputTokens: 800 });
  const usage = store.usage(wallet);
  assert.equal(usage.calls, 2);
  assert.equal(usage.cancelled, 1);
  assert.equal(usage.failed, 1);
  assert.equal(usage.outputTokens, 802);
  assert.equal(usage.usageMissing, 0);
});
test('sharing is idempotent, private to owner, expiring and bounded; accounting contains no conversations', t => {
  const { db, store, advance } = fixture(t);
  assert.equal(db.prepare('SELECT count(*) AS n FROM shared_reviews').get().n, 0);
  const exchange = { id: 'a'.repeat(64), question: 'EXPLICITLY SHARED QUESTION', answer: 'Answer' };
  store.share(wallet, exchange);
  store.share(wallet, exchange);
  assert.equal(store.reviews(wallet).length, 1);
  assert.equal(store.reviews(other).length, 0);
  assert.throws(() => store.remove(other, exchange.id), /not found/);
  assert.ok(!JSON.stringify(accountingReport(db)).includes('EXPLICITLY'));
  store.remove(wallet, exchange.id);
  assert.equal(store.reviews(wallet).length, 0);
  for (let i = 0; i < 10; i++) store.share(wallet, { ...exchange, id: String(i).padStart(64, '0') });
  assert.throws(() => store.share(wallet, { ...exchange, id: 'b'.repeat(64) }), /ten shared/);
  advance(REVIEW_RETENTION_MS);
  assert.equal(store.reviews(wallet).length, 0);
});
