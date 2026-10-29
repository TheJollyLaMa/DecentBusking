import { getAddress } from 'ethers';

export const REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const UNKNOWN_PER_WALLET = 50;
const problem = (status, message) => Object.assign(new Error(message), { status });
const normalized = wallet => getAddress(wallet).toLowerCase();

export function validUsage(value) {
  return value && ['inputTokens', 'outputTokens'].every(key =>
    Number.isSafeInteger(value[key]) && value[key] >= 0) ? value : null;
}

export function createAccounting(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_meta (
    id INTEGER PRIMARY KEY CHECK(id=1), started_at TEXT NOT NULL, legacy_calls INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_usage (
      wallet TEXT PRIMARY KEY, calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL, usage_missing INTEGER NOT NULL,
      failed INTEGER NOT NULL, cancelled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shared_reviews (
      id TEXT PRIMARY KEY, wallet TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, exchange TEXT NOT NULL);`);
  db.prepare(`INSERT OR IGNORE INTO accounting_meta
    SELECT 1, ?, calls FROM budget WHERE id=1`).run(new Date(now()).toISOString());
  const globalReserve = db.prepare('UPDATE budget SET calls=calls+1 WHERE id=1 AND calls < ? RETURNING calls');
  const walletReserve = db.prepare(`INSERT INTO wallet_usage VALUES (?,1,0,0,1,0,0)
    ON CONFLICT(wallet) DO UPDATE SET calls=calls+1, usage_missing=usage_missing+1`);
  const finish = db.prepare(`UPDATE wallet_usage SET input_tokens=input_tokens+?, output_tokens=output_tokens+?,
    usage_missing=usage_missing-?, failed=failed+?, cancelled=cancelled+? WHERE wallet=?`);
  const purge = () => db.prepare('DELETE FROM shared_reviews WHERE expires_at<=?').run(now());
  return {
    reserve(wallet, maxCalls) {
      const address = normalized(wallet);
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = globalReserve.get(maxCalls);
        if (row) walletReserve.run(address);
        db.exec('COMMIT');
        return Boolean(row);
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    finish(wallet, outcome, suppliedUsage) {
      const usage = validUsage(suppliedUsage);
      finish.run(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage ? 1 : 0,
        outcome === 'error' ? 1 : 0, outcome === 'cancelled' ? 1 : 0, normalized(wallet));
    },
    usage(wallet) {
      const meta = db.prepare('SELECT started_at FROM accounting_meta WHERE id=1').get();
      return { startedAt: meta.started_at,
        ...(db.prepare(`SELECT calls, input_tokens AS inputTokens, output_tokens AS outputTokens,
          usage_missing AS usageMissing, failed, cancelled FROM wallet_usage WHERE wallet=?`).get(normalized(wallet)) ||
          { calls: 0, inputTokens: 0, outputTokens: 0, usageMissing: 0, failed: 0, cancelled: 0 }) };
    },
    share(wallet, exchange) {
      purge();
      const existing = db.prepare('SELECT id,expires_at AS expiresAt FROM shared_reviews WHERE id=? AND wallet=?')
        .get(exchange.id, normalized(wallet));
      if (existing) return existing;
      if (db.prepare('SELECT count(*) AS count FROM shared_reviews').get().count >= 500) {
        throw problem(429, 'The steward review inbox is full. Nothing was shared.');
      }
      if (db.prepare(`SELECT count(*) AS count FROM shared_reviews WHERE wallet=?
        AND json_extract(exchange,'$.capture') IS NULL`).get(normalized(wallet)).count >= 10) {
        throw problem(429, 'You have ten shared exchanges. Delete an older one before sharing another.');
      }
      const expiresAt = now() + REVIEW_RETENTION_MS;
      db.prepare('INSERT INTO shared_reviews VALUES (?,?,?,?,?)')
        .run(exchange.id, normalized(wallet), now(), expiresAt, JSON.stringify(exchange));
      return { id: exchange.id, expiresAt };
    },
    // Questions DBusker could not answer are kept for steward review under the disclosed retention, never for automatic training.
    capture(wallet, exchange) {
      purge();
      if (db.prepare('SELECT count(*) AS count FROM shared_reviews').get().count >= 500 ||
          db.prepare(`SELECT count(*) AS count FROM shared_reviews WHERE wallet=?
            AND json_extract(exchange,'$.capture')='unknown'`).get(normalized(wallet)).count >= UNKNOWN_PER_WALLET) return null;
      const expiresAt = now() + REVIEW_RETENTION_MS;
      db.prepare('INSERT INTO shared_reviews VALUES (?,?,?,?,?)')
        .run(exchange.id, normalized(wallet), now(), expiresAt, JSON.stringify({ ...exchange, capture: 'unknown' }));
      return { id: exchange.id, expiresAt };
    },
    reviews(wallet) {
      purge();
      return db.prepare(`SELECT id,created_at AS createdAt,expires_at AS expiresAt,
        CASE WHEN json_extract(exchange,'$.capture')='unknown' THEN 'unknown' ELSE 'shared' END AS kind
        FROM shared_reviews WHERE wallet=? ORDER BY created_at DESC`).all(normalized(wallet));
    },
    remove(wallet, reviewId) {
      purge();
      if (!db.prepare('DELETE FROM shared_reviews WHERE id=? AND wallet=?').run(reviewId, normalized(wallet)).changes) {
        throw problem(404, 'Shared exchange was not found for this wallet.');
      }
    },
    purge,
  };
}

export function accountingReport(db) {
  const meta = db.prepare('SELECT started_at AS startedAt,legacy_calls AS legacyUnattributedCalls FROM accounting_meta WHERE id=1').get();
  return { ...meta, globalCalls: db.prepare('SELECT calls FROM budget WHERE id=1').get().calls,
    wallets: db.prepare(`SELECT wallet,calls,input_tokens AS inputTokens,output_tokens AS outputTokens,
      usage_missing AS usageMissing,failed,cancelled FROM wallet_usage ORDER BY calls DESC,wallet`).all(),
    note: 'One credit = one reserved provider pass, including failures/cancellations. Missing usage includes unresolved passes after interruption. Token totals are lower bounds when usage is missing, not dollar charges. Legacy calls cannot be attributed retrospectively. No conversations in this report.' };
}
