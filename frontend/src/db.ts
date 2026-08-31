// IndexedDB schema (step.md step 5.2). Two stores: records (keyed by uuid,
// indexed on serial and studentId) and config (a single QuizConfig).
//
// The indexes must permit duplicates — a repeated serial is exactly what
// step 7's identity cross-check exists to surface (plan.md §10). A unique
// index would throw on write instead of letting two conflicting records
// sit side by side for the instructor to compare.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { QuizConfig, StudentRecord } from './types';

interface ScanDB extends DBSchema {
  records: {
    key: string;
    value: StudentRecord;
    indexes: { 'by-serial': string; 'by-studentId': string };
  };
  config: {
    key: string;
    value: QuizConfig;
  };
  // v2 (step 11.2.5). A separate store rather than another key in
  // `config` for one specific reason: resetAll() clears `config`, and the
  // source id must survive that. It identifies a *writer*, not a session
  // — regenerating it on every "Reset everything" would split one
  // person's collected handwriting across several prefixes and defeat the
  // held-out-writer evaluation it exists to make possible (plan.md §16).
  meta: {
    key: string;
    value: string;
  };
}

const DB_NAME = 'marks';
const DB_VERSION = 2;
const CONFIG_KEY = 'current';
const SOURCE_ID_KEY = 'sourceId';

// No module-level connection caching on purpose: idb/the browser already
// pool repeated opens to the same DB name+version cheaply, and caching a
// promise here made tests order-dependent (a fresh fake IndexedDB per test
// had no effect on an already-resolved cached connection from an earlier
// test). Simpler and more correct to just open fresh each call.
function getDB(): Promise<IDBPDatabase<ScanDB>> {
  return openDB<ScanDB>(DB_NAME, DB_VERSION, {
    // Guarded by oldVersion so an existing v1 database (the instructor's
    // own browser, mid-pilot, with real records in it) migrates instead
    // of throwing on a store that already exists.
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
      }
      if (oldVersion < 2) {
        db.createObjectStore('meta');
      }
    },
  });
}

export async function saveConfig(config: QuizConfig): Promise<void> {
  const db = await getDB();
  await db.put('config', config, CONFIG_KEY);
}

export async function loadConfig(): Promise<QuizConfig | undefined> {
  const db = await getDB();
  return db.get('config', CONFIG_KEY);
}

export async function saveRecord(record: StudentRecord): Promise<void> {
  const db = await getDB();
  await db.put('records', record);
}

export async function getAllRecords(): Promise<StudentRecord[]> {
  const db = await getDB();
  return db.getAll('records');
}

export async function findRecordsBySerial(serial: string): Promise<StudentRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('records', 'by-serial', serial);
}

export async function findRecordsByStudentId(studentId: string): Promise<StudentRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('records', 'by-studentId', studentId);
}

// An opaque, random per-browser tag sent with each harvest request so
// pooled training crops can be split by writer (step 11.2.4/11.2.5).
//
// Three properties are load-bearing, and each is a decision rather than a
// detail:
//
// - **Random, never anything typed.** Its only job is to separate
//   writers, not to identify one. A name or an email here would turn a
//   pile of anonymous digits into attributable handwriting.
// - **Per-faculty, not per-scan.** Coarse enough that one prefix holds a
//   whole class mixed together and isolates nobody; fine enough to hold
//   out one faculty member entirely and measure against them. A per-scan
//   id would regroup one student's seven ID digits and undo step 11.0.2.
// - **Generated client-side.** Step 11 deploys one shared backend behind
//   one URL, so a server-side constant would label every faculty member
//   identically.
export async function getSourceId(): Promise<string> {
  const db = await getDB();
  const existing = await db.get('meta', SOURCE_ID_KEY);
  if (existing) return existing;
  // randomUUID needs a secure context, which this app always has
  // (getUserMedia requires one too — plan.md §9). The fallback is for
  // test environments and older browsers, not for production.
  const generated =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `src-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await db.put('meta', generated, SOURCE_ID_KEY);
  return generated;
}

// Full session reset: every saved record and the quiz config itself, so
// the next screen the app shows is Setup, not a Scan screen for a config
// that no longer has anywhere to save to.
//
// Deliberately does NOT clear `meta`. The source id identifies this
// browser as a writer across sessions; wiping it on every reset would
// fragment one person's collected handwriting into unrelated prefixes.
export async function resetAll(): Promise<void> {
  const db = await getDB();
  await db.clear('records');
  await db.clear('config');
}
