import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import {
  getSourceId,
  resetAll,
  findRecordsByStudentId,
  findRecordsBySerial,
  getAllRecords,
  loadConfig,
  saveConfig,
  saveRecord,
} from './db';
import type { QuizConfig, StudentRecord } from './types';

const config: QuizConfig = {
  quizName: 'CSE211L Quiz 1',
  idDigits: 7,
  questions: [
    { q: 1, max: 5 },
    { q: 2, max: 5 },
  ],
  totalMax: 10,
};

function makeRecord(overrides: Partial<StudentRecord>): StudentRecord {
  return {
    id: crypto.randomUUID(),
    studentId: '1912345',
    serial: '07',
    questions: [
      { q: 1, value: 4 },
      { q: 2, value: 3.5 },
    ],
    total: 7.5,
    confirmed: true,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  // fresh IndexedDB per test — db.ts caches its connection promise, but a
  // fresh backing store per test still isolates each test's records/config
  indexedDB = new IDBFactory();
});

describe('config persistence', () => {
  it('round-trips a saved config', async () => {
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
  });

  it('returns undefined when nothing has been saved yet', async () => {
    const loaded = await loadConfig();
    expect(loaded).toBeUndefined();
  });
});

describe('records store — indexes must permit duplicates (plan.md §10)', () => {
  it('allows two records with the same serial to coexist', async () => {
    const a = makeRecord({ serial: '07', studentId: '1111111' });
    const b = makeRecord({ serial: '07', studentId: '2222222' });

    await saveRecord(a);
    await saveRecord(b);

    const bySerial = await findRecordsBySerial('07');
    expect(bySerial).toHaveLength(2);
    expect(bySerial.map((r) => r.studentId).sort()).toEqual(['1111111', '2222222']);
  });

  it('allows two records with the same studentId to coexist', async () => {
    const a = makeRecord({ studentId: '1912345', serial: '01' });
    const b = makeRecord({ studentId: '1912345', serial: '02' });

    await saveRecord(a);
    await saveRecord(b);

    const byId = await findRecordsByStudentId('1912345');
    expect(byId).toHaveLength(2);
  });

  it('getAllRecords returns everything saved', async () => {
    await saveRecord(makeRecord({}));
    await saveRecord(makeRecord({}));
    const all = await getAllRecords();
    expect(all).toHaveLength(2);
  });
});

// Step 11.2.5 — the per-browser writer tag. Each of these asserts a
// property the tag's purpose depends on, not just that the function runs.
describe('source id', () => {
  it('is stable across calls, so one browser is one writer', async () => {
    const first = await getSourceId();
    const second = await getSourceId();
    expect(first).toBe(second);
    expect(first).toBeTruthy();
  });

  it('survives resetAll, because it identifies a writer and not a session', async () => {
    // Regenerating on every "Reset everything" would split one person's
    // collected handwriting across unrelated prefixes and defeat the
    // held-out-writer evaluation the tag exists for (plan.md §16).
    const before = await getSourceId();
    await saveConfig(config);
    await resetAll();

    expect(await loadConfig()).toBeUndefined(); // the reset really happened
    expect(await getSourceId()).toBe(before);
  });

  it('differs between browsers', async () => {
    const first = await getSourceId();
    indexedDB = new IDBFactory(); // a different machine/browser entirely
    expect(await getSourceId()).not.toBe(first);
  });

  it('contains nothing the user typed', async () => {
    await saveConfig(config); // quizName: 'CSE211L Quiz 1'
    const id = await getSourceId();
    expect(id.toLowerCase()).not.toContain('cse211l');
    expect(id).toMatch(/^[A-Za-z0-9-]+$/); // safe as a path/key segment
  });
});

describe('v1 -> v2 migration', () => {
  it('keeps existing records when the meta store is added', async () => {
    // The real risk case: an instructor mid-pilot, with a v1 database
    // holding real records, opens a build that adds the meta store. An
    // unguarded upgrade() would throw on re-creating 'records', and a
    // wrong one would drop what they had already scanned.
    const v1 = await openDB('marks', 1, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
      },
    });
    await v1.put('records', makeRecord({ studentId: '2632711', serial: '07' }));
    await v1.put('config', config, 'current');
    v1.close();

    // Anything that opens the DB now triggers the v2 upgrade.
    const sourceId = await getSourceId();

    expect(sourceId).toBeTruthy();
    const survivors = await getAllRecords();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].studentId).toBe('2632711');
    expect(await loadConfig()).toEqual(config);
  });
});
