import { closeSync, lstatSync, openSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promotionCheckpointCodec } from './promotions.js';

const emptyState = () => ({ schemaVersion: 1, revision: 0, campaigns: [], claims: [], members: [], votes: [] });
const receipt = 'sqlite://promotions';

async function sqlite() {
  try { return (await import('node:sqlite')).DatabaseSync; }
  catch { throw new Error('Promotions require Node SQLite; enable --experimental-sqlite on supported Node 22 releases'); }
}

function configure(db) {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
}

export async function initializePromotionStore({ file, keyHex }) {
  if (!file) throw new Error('Choose a persistent promotions database path');
  const codec = promotionCheckpointCodec(keyHex);
  const DatabaseSync = await sqlite();
  const fd = openSync(file, 'wx', 0o600);
  closeSync(fd);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec(`PRAGMA synchronous = FULL;
      CREATE TABLE promotions_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        sealed TEXT NOT NULL
      );`);
    db.prepare('INSERT INTO promotions_state (id, revision, sealed) VALUES (1, 0, ?)')
      .run(JSON.stringify(codec.serialize(emptyState())));
  } catch (error) {
    db?.close();
    rmSync(file, { force: true });
    throw error;
  }
  db.close();
}

export async function createPromotionStore({ file, keyHex }) {
  if (!file || !lstatSync(file).isFile()) throw new Error('An initialized persistent promotions database is required');
  const codec = promotionCheckpointCodec(keyHex);
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(file);
  try {
    configure(db);
    const check = db.prepare('PRAGMA quick_check').get();
    if (Object.values(check || {})[0] !== 'ok') throw new Error('Promotions database integrity check failed');
    const read = db.prepare('SELECT revision, sealed FROM promotions_state WHERE id = 1');
    const update = db.prepare('UPDATE promotions_state SET revision = ?, sealed = ? WHERE id = 1 AND revision = ?');
    const restore = async () => {
      const row = read.get();
      if (!row) throw new Error('Promotions database has no initialized state');
      const value = codec.deserialize(JSON.parse(row.sealed));
      if (!Number.isSafeInteger(row.revision) || value?.revision !== row.revision) {
        throw new Error('Promotions database revision does not match encrypted state');
      }
      return value;
    };
    await restore();
    return {
      restore,
      async save(value, expectedRevision) {
        if (!Number.isSafeInteger(expectedRevision) || value?.revision !== expectedRevision + 1) {
          throw new Error('Invalid promotions database revision');
        }
        const sealed = JSON.stringify(codec.serialize(value));
        db.exec('BEGIN IMMEDIATE');
        try {
          if (update.run(value.revision, sealed, expectedRevision).changes !== 1) {
            const error = new Error('Promotions changed concurrently; refresh and retry');
            error.code = 'PROMOTIONS_STALE';
            throw error;
          }
          db.exec('COMMIT');
          return receipt;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'init' || !process.argv[3] || process.argv.length !== 4) {
    console.error('Usage: PROMOTIONS_STORAGE_KEY=<server-only key> node promotions-store.js init <persistent-file>');
    process.exitCode = 1;
  } else {
    try {
      await initializePromotionStore({ file: process.argv[3], keyHex: process.env.PROMOTIONS_STORAGE_KEY });
      console.log('Initialized encrypted promotions database. Back up the database and key separately.');
    } catch (error) {
      console.error(`Promotions database initialization failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
