import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { directory } from './handoff.mjs';
import { accountingReport } from './accounting.mjs';

const db = new DatabaseSync(path.resolve(process.env.DBUSKER_STATE_FILE || path.join(directory, 'state.sqlite')));
try {
  if (process.argv[2] === 'reviews') {
    db.prepare('DELETE FROM shared_reviews WHERE expires_at<=?').run(Date.now());
    console.log(JSON.stringify({ privateStewardReview: true, automaticTraining: false,
      reviews: db.prepare('SELECT id,wallet,created_at AS createdAt,expires_at AS expiresAt,exchange FROM shared_reviews ORDER BY created_at DESC')
        .all().map(row => ({ ...row, exchange: JSON.parse(row.exchange) })) }, null, 2));
  } else console.log(JSON.stringify(accountingReport(db), null, 2));
} finally { db.close(); }
