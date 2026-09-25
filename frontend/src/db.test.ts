import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import {
  deleteAssessment,
  deleteSection,
  findRecordsByStudentId,
  findRecordsBySerial,
  getAllAssessments,
  getAllRecords,
  getAllSections,
  getAssessment,
  getRecordsByAssessment,
  getSection,
  getShareCrops,
  getSourceId,
  resetAll,
  setShareCrops,
  saveAssessment,
  saveRecord,
  saveSection,
} from './db';
import type { RosterUpload } from './roster';
import type { Assessment, QuizConfig, Section, StudentRecord } from './types';

const config: QuizConfig = {
  quizName: 'CSE211L Quiz 1',
  idDigits: 7,
  questions: [
    { q: 1, max: 5 },
    { q: 2, max: 5 },
  ],
  totalMax: 10,
};

function makeSection(overrides: Partial<Section> = {}): Section {
  return {
    id: crypto.randomUUID(),
    courseCode: 'CSE203',
    label: '1',
    semester: 'Fall 2026',
    idDigits: 7,
    ...overrides,
  };
}

function makeAssessment(sectionId: string, overrides: Partial<Assessment> = {}): Assessment {
  return {
    id: crypto.randomUUID(),
    sectionId,
    quizName: 'Quiz 1',
    questions: config.questions,
    totalMax: config.totalMax,
    createdAt: new Date().toISOString(),
    exportedAt: null,
    ...overrides,
  };
}

function makeRecord(assessmentId: string, overrides: Partial<StudentRecord> = {}): StudentRecord {
  return {
    id: crypto.randomUUID(),
    assessmentId,
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

// --- step.md step 13 — sections and assessments (plan.md §18) -------------

describe('sections and assessments', () => {
  it('round-trips a saved section', async () => {
    const section = makeSection();
    await saveSection(section);
    expect(await getSection(section.id)).toEqual(section);
  });

  it('lists every saved section', async () => {
    await saveSection(makeSection({ courseCode: 'CSE100' }));
    await saveSection(makeSection({ courseCode: 'CSE203', label: '1' }));
    await saveSection(makeSection({ courseCode: 'CSE203', label: '2' }));
    const all = await getAllSections();
    expect(all).toHaveLength(3);
  });

  it('round-trips a saved assessment, scoped to its section', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id);
    await saveSection(section);
    await saveAssessment(assessment);
    expect(await getAssessment(assessment.id)).toEqual(assessment);
  });

  it('an assessment starts with exportedAt null and can be stamped', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id);
    await saveAssessment(assessment);
    expect((await getAssessment(assessment.id))?.exportedAt).toBeNull();

    const stamped: Assessment = { ...assessment, exportedAt: new Date().toISOString() };
    await saveAssessment(stamped);
    expect((await getAssessment(assessment.id))?.exportedAt).not.toBeNull();
  });

  it('getAllAssessments returns assessments across every section', async () => {
    const s1 = makeSection({ courseCode: 'CSE100' });
    const s2 = makeSection({ courseCode: 'CSE203' });
    await saveAssessment(makeAssessment(s1.id));
    await saveAssessment(makeAssessment(s2.id));
    expect(await getAllAssessments()).toHaveLength(2);
  });
});

describe('records scoped by assessment (step.md 13.8)', () => {
  it('getRecordsByAssessment returns only that assessment’s records', async () => {
    const section = makeSection();
    const a1 = makeAssessment(section.id, { quizName: 'Quiz 1' });
    const a2 = makeAssessment(section.id, { quizName: 'Quiz 2' });
    await saveRecord(makeRecord(a1.id, { studentId: '1111111' }));
    await saveRecord(makeRecord(a1.id, { studentId: '2222222' }));
    await saveRecord(makeRecord(a2.id, { studentId: '3333333' }));

    const quiz1Records = await getRecordsByAssessment(a1.id);
    expect(quiz1Records).toHaveLength(2);
    expect(quiz1Records.map((r) => r.studentId).sort()).toEqual(['1111111', '2222222']);

    const quiz2Records = await getRecordsByAssessment(a2.id);
    expect(quiz2Records).toHaveLength(1);
    expect(quiz2Records[0].studentId).toBe('3333333');
  });

  it('getAllRecords still returns everything, unscoped', async () => {
    const section = makeSection();
    const a1 = makeAssessment(section.id);
    const a2 = makeAssessment(section.id);
    await saveRecord(makeRecord(a1.id));
    await saveRecord(makeRecord(a2.id));
    expect(await getAllRecords()).toHaveLength(2);
  });
});

// Step.md 13.15 (Phase C) — the actual bug: a shared serial or student ID
// across two different courses is normal, and the identity cross-check
// (plan.md §2's highest-value check) must not fire across that boundary.
describe('findRecordsBySerial / findRecordsByStudentId are scoped to one assessment (step.md 13.15)', () => {
  it('does not match the same serial in a different assessment', async () => {
    const cse100 = makeSection({ courseCode: 'CSE100' });
    const cse203 = makeSection({ courseCode: 'CSE203' });
    const a1 = makeAssessment(cse100.id);
    const a2 = makeAssessment(cse203.id);
    await saveRecord(makeRecord(a1.id, { serial: '7', studentId: '1111111' }));
    await saveRecord(makeRecord(a2.id, { serial: '7', studentId: '2222222' }));

    const a1Matches = await findRecordsBySerial('7', a1.id);
    expect(a1Matches).toHaveLength(1);
    expect(a1Matches[0].studentId).toBe('1111111');

    const a2Matches = await findRecordsBySerial('7', a2.id);
    expect(a2Matches).toHaveLength(1);
    expect(a2Matches[0].studentId).toBe('2222222');
  });

  it('does not match the same student ID in a different assessment', async () => {
    const a1 = crypto.randomUUID();
    const a2 = crypto.randomUUID();
    await saveRecord(makeRecord(a1, { studentId: '1912345', serial: '1' }));
    await saveRecord(makeRecord(a2, { studentId: '1912345', serial: '2' }));

    expect(await findRecordsByStudentId('1912345', a1)).toHaveLength(1);
    expect(await findRecordsByStudentId('1912345', a2)).toHaveLength(1);
  });

  it('still finds every record sharing a serial WITHIN the same assessment', async () => {
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { id: 'a', serial: '7', studentId: '1111111' }));
    await saveRecord(makeRecord(assessmentId, { id: 'b', serial: '7', studentId: '2222222' }));

    expect(await findRecordsBySerial('7', assessmentId)).toHaveLength(2);
  });

  it('returns nothing for an assessment with no matching records at all', async () => {
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { serial: '7' }));
    expect(await findRecordsBySerial('7', 'a-different-assessment')).toHaveLength(0);
  });
});

describe('deleteSection (step.md 13.18) cascades to its assessments and records', () => {
  it('deletes the section, its assessments, and every record under them', async () => {
    const section = makeSection();
    const other = makeSection({ courseCode: 'CSE100' });
    const a1 = makeAssessment(section.id);
    const a2 = makeAssessment(section.id);
    const keep = makeAssessment(other.id);
    await saveSection(section);
    await saveSection(other);
    await saveAssessment(a1);
    await saveAssessment(a2);
    await saveAssessment(keep);
    await saveRecord(makeRecord(a1.id));
    await saveRecord(makeRecord(a2.id));
    await saveRecord(makeRecord(keep.id));

    await deleteSection(section.id);

    expect(await getSection(section.id)).toBeUndefined();
    expect(await getAssessment(a1.id)).toBeUndefined();
    expect(await getAssessment(a2.id)).toBeUndefined();
    expect(await getRecordsByAssessment(a1.id)).toHaveLength(0);
    expect(await getRecordsByAssessment(a2.id)).toHaveLength(0);

    // The other section, and everything under it, is untouched.
    expect(await getSection(other.id)).toEqual(other);
    expect(await getAssessment(keep.id)).toEqual(keep);
    expect(await getRecordsByAssessment(keep.id)).toHaveLength(1);
  });
});

describe('deleteAssessment (step.md 13.24) cascades to its records only', () => {
  it('deletes one assessment and every record under it', async () => {
    const section = makeSection();
    const toDelete = makeAssessment(section.id);
    const sibling = makeAssessment(section.id);
    await saveSection(section);
    await saveAssessment(toDelete);
    await saveAssessment(sibling);
    await saveRecord(makeRecord(toDelete.id));
    await saveRecord(makeRecord(toDelete.id, { studentId: '2632700' }));
    await saveRecord(makeRecord(sibling.id));

    await deleteAssessment(toDelete.id);

    expect(await getAssessment(toDelete.id)).toBeUndefined();
    expect(await getRecordsByAssessment(toDelete.id)).toHaveLength(0);

    // The section it belonged to, and the sibling assessment, are untouched.
    expect(await getSection(section.id)).toEqual(section);
    expect(await getAssessment(sibling.id)).toEqual(sibling);
    expect(await getRecordsByAssessment(sibling.id)).toHaveLength(1);
  });
});

describe('records store — indexes must permit duplicates (plan.md §10)', () => {
  it('allows two records with the same serial to coexist', async () => {
    const assessmentId = crypto.randomUUID();
    const a = makeRecord(assessmentId, { serial: '07', studentId: '1111111' });
    const b = makeRecord(assessmentId, { serial: '07', studentId: '2222222' });

    await saveRecord(a);
    await saveRecord(b);

    const bySerial = await findRecordsBySerial('07', assessmentId);
    expect(bySerial).toHaveLength(2);
    expect(bySerial.map((r) => r.studentId).sort()).toEqual(['1111111', '2222222']);
  });

  it('allows two records with the same studentId to coexist', async () => {
    const assessmentId = crypto.randomUUID();
    const a = makeRecord(assessmentId, { studentId: '1912345', serial: '01' });
    const b = makeRecord(assessmentId, { studentId: '1912345', serial: '02' });

    await saveRecord(a);
    await saveRecord(b);

    const byId = await findRecordsByStudentId('1912345', assessmentId);
    expect(byId).toHaveLength(2);
  });

  it('getAllRecords returns everything saved', async () => {
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId));
    await saveRecord(makeRecord(assessmentId));
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
    await saveSection(makeSection());
    await resetAll();

    expect(await getAllSections()).toHaveLength(0); // the reset really happened
    expect(await getSourceId()).toBe(before);
  });

  it('differs between browsers', async () => {
    const first = await getSourceId();
    indexedDB = new IDBFactory(); // a different machine/browser entirely
    expect(await getSourceId()).not.toBe(first);
  });

  it('contains nothing the user typed', async () => {
    await saveSection(makeSection({ courseCode: 'CSE211L' }));
    const id = await getSourceId();
    expect(id.toLowerCase()).not.toContain('cse211l');
    expect(id).toMatch(/^[A-Za-z0-9-]+$/); // safe as a path/key segment
  });
});

describe('resetAll (step.md step 13 — full wipe, ahead of the real Phase D purge)', () => {
  it('clears sections, assessments and records together', async () => {
    const section = makeSection();
    const assessment = makeAssessment(section.id);
    await saveSection(section);
    await saveAssessment(assessment);
    await saveRecord(makeRecord(assessment.id));

    await resetAll();

    expect(await getAllSections()).toHaveLength(0);
    expect(await getAllAssessments()).toHaveLength(0);
    expect(await getAllRecords()).toHaveLength(0);
  });
});

describe('v1 -> v5 migration (step.md 13.2 — "the migration, written as the hard case")', () => {
  it('folds a v1 database’s config and records into one Section and one Assessment', async () => {
    // The real risk case: an instructor mid-pilot, with a v1 database
    // holding a real in-flight session, opens a build that jumps straight
    // to v5. Rule 3: this must fold what they had, never drop it.
    const v1 = await openDB('marks', 1, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
      },
    });
    await v1.put('records', {
      id: 'r1',
      studentId: '2632711',
      serial: '07',
      questions: [{ q: 1, value: 4 }],
      total: 4,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    });
    await v1.put('config', config, 'current');
    v1.close();

    // Anything that opens the DB now triggers the v5 upgrade.
    const sections = await getAllSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].courseCode).toBe('Imported');
    expect(sections[0].idDigits).toBe(config.idDigits);

    const assessments = await getAllAssessments();
    expect(assessments).toHaveLength(1);
    expect(assessments[0].sectionId).toBe(sections[0].id);
    expect(assessments[0].quizName).toBe(config.quizName);
    expect(assessments[0].totalMax).toBe(config.totalMax);
    expect(assessments[0].exportedAt).toBeNull();

    const records = await getRecordsByAssessment(assessments[0].id);
    expect(records).toHaveLength(1);
    expect(records[0].studentId).toBe('2632711');
    expect(records[0].id).toBe('r1');
  });

  it('produces nothing from an empty v1-v4 database — no config, no section', async () => {
    const v2 = await openDB('marks', 2, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
        db.createObjectStore('meta');
      },
    });
    v2.close();

    expect(await getAllSections()).toHaveLength(0);
    expect(await getAllAssessments()).toHaveLength(0);
  });

  it('folds a v4 database’s roster upload into the migrated Section', async () => {
    const rosterUpload: RosterUpload = {
      fileName: 'CSE211L-1.xlsx',
      workbookBytes: new ArrayBuffer(8),
      roster: {
        sheetName: 'data',
        headerRow: 1,
        students: [
          { sl: 1, row: 2, studentId: '1912345', studentIdKey: '1912345', studentName: 'Monem Tazwar' },
        ],
        duplicateIds: [],
      },
    };
    const v4 = await openDB('marks', 4, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
        db.createObjectStore('meta');
        db.createObjectStore('rosterUpload');
      },
    });
    await v4.put('config', config, 'current');
    await v4.put('rosterUpload', rosterUpload, 'current');
    v4.close();

    const sections = await getAllSections();
    expect(sections).toHaveLength(1);
    expect(sections[0].roster?.students).toEqual(rosterUpload.roster.students);
    expect(sections[0].workbook?.fileName).toBe('CSE211L-1.xlsx');
    expect(sections[0].workbook?.source).toBe('uploaded');
    expect(Object.prototype.toString.call(sections[0].workbook?.bytes)).toBe('[object ArrayBuffer]');
  });

  it('leaves a v5 database alone — no double migration', async () => {
    const section = makeSection();
    await saveSection(section);
    // Re-opening at the same version must not re-run any migration logic.
    expect(await getAllSections()).toEqual([section]);
  });

  it('never touches meta — the source id survives a jump from v1', async () => {
    const v1 = await openDB('marks', 1, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
      },
    });
    await v1.put('config', config, 'current');
    v1.close();

    const id = await getSourceId();
    expect(id).toBeTruthy();
    expect(await getSourceId()).toBe(id); // stable across the migration having run
  });
});

// --- issues.md #2: the leading-zero duplicate that was never surfaced ------

describe('serial normalization (issues.md #2)', () => {
  it('finds a record saved as "007" when looking up "7"', async () => {
    // This is the whole bug, in one assertion. crossCheck normalizes both
    // sides correctly, but it can only compare records this lookup already
    // returned — and an exact-match index lookup for "7" returned nothing
    // for a record stored as "007", so the duplicate saved silently.
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { id: 'a', serial: '007', studentId: '1912345' }));

    const found = await findRecordsBySerial('7', assessmentId);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('a');
  });

  it('normalizes on write so the index has one key per real serial', async () => {
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { id: 'a', serial: '007' }));
    const [stored] = await getAllRecords();
    expect(stored.serial).toBe('7');
  });

  it('matches across every spelling of the same serial', async () => {
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { id: 'a', serial: '2' }));
    for (const spelling of ['2', '02', '002', ' 002 ']) {
      expect(await findRecordsBySerial(spelling, assessmentId)).toHaveLength(1);
    }
  });

  it('keeps an all-zero serial as "0" rather than losing it', async () => {
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { id: 'a', serial: '000' }));
    expect(await findRecordsBySerial('0', assessmentId)).toHaveLength(1);
  });

  it('still permits duplicates in the index — the cross-check needs both', async () => {
    // A unique index would throw on write and lose the two records the
    // instructor needs to see side by side (CLAUDE.md).
    const assessmentId = crypto.randomUUID();
    await saveRecord(makeRecord(assessmentId, { id: 'a', serial: '07', studentId: '1912345' }));
    await saveRecord(makeRecord(assessmentId, { id: 'b', serial: '7', studentId: '1999999' }));
    expect(await findRecordsBySerial('007', assessmentId)).toHaveLength(2);
  });

  it('migrates serials already stored un-normalized by an older version', async () => {
    // A v2 database written before this fix, opened by the current code.
    globalThis.indexedDB = new IDBFactory();
    const legacy = await openDB('marks', 2, {
      upgrade(db) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        db.createObjectStore('config');
        db.createObjectStore('meta');
      },
    });
    await legacy.put('records', {
      id: 'old',
      studentId: '1912345',
      serial: '007',
      questions: [],
      total: null,
      confirmed: true,
      capturedAt: new Date().toISOString(),
    });
    legacy.close();

    // Opening at v5 runs both the v3 normalization migration and the v5
    // section/assessment fold; the old record is reachable by its
    // normalized serial, which is what the cross-check will query with.
    // This record predates `assessmentId` entirely — a v2 database has no
    // such field, and the v5 migration only invents one when a saved
    // `config` exists to fold (there isn't one here) — so `undefined` is
    // genuinely the only assessmentId this record could ever have, and
    // step.md 13.15's scoped filter correctly still matches it.
    const found = await findRecordsBySerial('7', undefined as unknown as string);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('old');
  });
});

// issues.md N45 — the instructor's choice to share labelled cell crops.
describe('share crops setting', () => {
  it('is on by default', async () => {
    expect(await getShareCrops()).toBe(true);
  });

  it('remembers being turned off, and on again', async () => {
    await setShareCrops(false);
    expect(await getShareCrops()).toBe(false);
    await setShareCrops(true);
    expect(await getShareCrops()).toBe(true);
  });

  it('survives resetAll, so clearing marks never silently turns sharing back on', async () => {
    await setShareCrops(false);
    await resetAll();
    expect(await getShareCrops()).toBe(false);
  });
});
