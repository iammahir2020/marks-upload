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
}

const DB_NAME = 'marks';
const DB_VERSION = 1;
const CONFIG_KEY = 'current';

// No module-level connection caching on purpose: idb/the browser already
// pool repeated opens to the same DB name+version cheaply, and caching a
// promise here made tests order-dependent (a fresh fake IndexedDB per test
// had no effect on an already-resolved cached connection from an earlier
// test). Simpler and more correct to just open fresh each call.
function getDB(): Promise<IDBPDatabase<ScanDB>> {
  return openDB<ScanDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const records = db.createObjectStore('records', { keyPath: 'id' });
      records.createIndex('by-serial', 'serial');
      records.createIndex('by-studentId', 'studentId');
      db.createObjectStore('config');
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
