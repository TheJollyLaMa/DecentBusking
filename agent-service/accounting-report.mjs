import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { directory } from './handoff.mjs';
import { accountingReport } from './accounting.mjs';

const db = new DatabaseSync(path.resolve(process.env.DBUSKER_STATE_FILE || path.join(directory, 'state.sqlite')));
try {
  if (['reviews', 'unknowns'].includes(process.argv[2])) {
    db.prepare('DELETE FROM shared_reviews WHERE expires_at<=?').run(Date.now());
    const unknownsOnly = process.argv[2] === 'unknowns' ? "WHERE json_extract(exchange,'$.capture')='unknown'" : '';
    console.log(JSON.stringify({ privateStewardReview: true, automaticTraining: false,
      reviews: db.prepare(`SELECT id,wallet,created_at AS createdAt,expires_at AS expiresAt,exchange FROM shared_reviews ${unknownsOnly} ORDER BY created_at DESC`)
        .all().map(row => ({ ...row, exchange: JSON.parse(row.exchange) })) }, null, 2));
  } else console.log(JSON.stringify(accountingReport(db), null, 2));
} finally { db.close(); }
