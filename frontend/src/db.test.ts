import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
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
