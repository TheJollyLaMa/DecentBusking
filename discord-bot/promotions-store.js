import { closeSync, lstatSync, openSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePromotionCheckpoint } from './promotions.js';

const emptyState = () => ({ schemaVersion: 1, revision: 0, campaigns: [], claims: [], members: [], votes: [] });

async function sqlite() {
  try { return (await import('node:sqlite')).DatabaseSync; }
  catch { throw new Error('Promotions require Node SQLite; enable --experimental-sqlite on supported Node 22 releases'); }
}

export async function initializePromotionStore({ file }) {
  if (!file) throw new Error('Choose a persistent promotions database path');
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
        state TEXT NOT NULL,
        checkpoint_uri TEXT NOT NULL,
        pending TEXT NOT NULL DEFAULT ''
      );`);
    db.prepare('INSERT INTO promotions_state (id, revision, state, checkpoint_uri) VALUES (1, 0, ?, ?)')
      .run(JSON.stringify(emptyState()), '');
  } catch (error) {
    db?.close();
    rmSync(file, { force: true });
    throw error;
  }
  db.close();
}

export async function createPromotionStore({ file, checkpoint }) {
  if (!file || !lstatSync(file).isFile()) throw new Error('An initialized persistent promotions database is required');
  if (!checkpoint?.restore || !checkpoint?.save || !checkpoint?.getLatestSnapshotUri) {
    throw new Error('Public Pinata checkpoints are required for promotions');
  }
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    const check = db.prepare('PRAGMA quick_check').get();
    if (Object.values(check || {})[0] !== 'ok') throw new Error('Promotions database integrity check failed');
    const read = db.prepare('SELECT revision, state, checkpoint_uri, pending FROM promotions_state WHERE id = 1');
    const update = db.prepare("UPDATE promotions_state SET revision = ?, state = ?, checkpoint_uri = ?, pending = '' WHERE id = 1 AND revision = ? AND pending = ?");
    const local = () => {
      const row = read.get();
      if (!row) throw new Error('Promotions database has no initialized state');
      const value = JSON.parse(row.state);
      validatePromotionCheckpoint(value);
      if (value.revision !== row.revision) throw new Error('Promotions database revision does not match public state');
      if (row.pending) {
        const pending = JSON.parse(row.pending);
        validatePromotionCheckpoint(pending);
        if (pending.revision !== value.revision + 1) throw new Error('Invalid pending promotions revision');
      }
      return { value, uri: row.checkpoint_uri, pending: row.pending };
    };
    const stale = () => {
      const error = new Error('Promotions changed concurrently; refresh and retry');
      error.code = 'PROMOTIONS_STALE';
      return error;
    };
    // Capture the local revision before the network read so startup cannot overwrite a concurrent commit.
    const initial = local();
    const remote = await checkpoint.restore();
    if (remote) {
      validatePromotionCheckpoint(remote);
      if (remote.revision < initial.value.revision ||
          remote.revision === initial.value.revision && JSON.stringify(remote) !== JSON.stringify(initial.value)) {
        throw new Error('Public promotions checkpoint is stale or inconsistent; reconcile before enabling writes');
      }
      const uri = checkpoint.getLatestSnapshotUri();
      if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Public promotions checkpoint URI is missing');
      if (initial.pending && remote.revision > initial.value.revision && JSON.stringify(remote) !== initial.pending) {
        throw new Error('Public promotions checkpoint conflicts with pending publication; reconcile before enabling writes');
      }
      if (!initial.pending &&
          update.run(remote.revision, JSON.stringify(remote), uri, initial.value.revision, '').changes !== 1) throw stale();
    } else if (initial.value.revision !== 0 || initial.uri) {
      throw new Error('Public promotions checkpoint is missing; refusing to reset the journal');
    }
    if (initial.pending) {
      const pending = JSON.parse(initial.pending);
      const uri = remote?.revision === pending.revision
        ? checkpoint.getLatestSnapshotUri() : await checkpoint.save(pending);
      if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Pending public promotions checkpoint did not confirm');
      if (update.run(pending.revision, initial.pending, uri, initial.value.revision, initial.pending).changes !== 1) throw stale();
    }
    return {
      restore: async () => {
        const row = local();
        if (row.pending) throw new Error('Promotions publication is pending; stop writers and restart to reconcile');
        return row.value;
      },
      getCheckpointUri: () => local().uri,
      async save(value, expectedRevision) {
        validatePromotionCheckpoint(value);
        if (!Number.isSafeInteger(expectedRevision) || value.revision !== expectedRevision + 1) {
          throw new Error('Invalid promotions database revision');
        }
        const serialized = JSON.stringify(value);
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = local();
          if (current.value.revision !== expectedRevision || current.pending) throw stale();
          db.prepare('UPDATE promotions_state SET pending = ? WHERE id = 1').run(serialized);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); }
          catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Promotions write and rollback failed; stop and reconcile');
          }
          throw error;
        }
        // A durable pending record fences every process, even if the upload response is lost.
        const uri = await checkpoint.save(structuredClone(value));
        if (!/^ipfs:\/\//.test(uri || '')) throw new Error('Public promotions checkpoint did not confirm');
        if (update.run(value.revision, serialized, uri, expectedRevision, serialized).changes !== 1) throw stale();
        return uri;
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
    console.error('Usage: node promotions-store.js init <persistent-file>');
    process.exitCode = 1;
  } else {
    try {
      await initializePromotionStore({ file: process.argv[3] });
      console.log('Initialized public promotions journal. Startup restores the latest verified Pinata checkpoint.');
    } catch (error) {
      console.error(`Promotions database initialization failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
