// IndexedDB schema (step.md step 5.2, extended by step.md step 13 / plan.md
// §18). `sections` and `assessments` (v5) replace the single-value `config`
// store: a Section is the durable, semester-long thing (course, label,
// semester, ID digits, the class list); an Assessment is one quiz's
// question config plus its own export state, scoped to a Section.
// `records` is indexed on serial, studentId AND (v5) assessmentId.
//
// The serial/studentId indexes must permit duplicates — a repeated serial
// is exactly what step 7's identity cross-check exists to surface (plan.md
// §10). A unique index would throw on write instead of letting two
// conflicting records sit side by side for the instructor to compare.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RosterUpload } from './roster';
import type { Assessment, QuizConfig, Section, StudentRecord } from './types';
import { normalizeSerial } from './validateMarks';

interface ScanDB extends DBSchema {
  records: {
    key: string;
    value: StudentRecord;
    indexes: { 'by-serial': string; 'by-studentId': string; 'by-assessment': string };
  };
  // v2 (step 11.2.5). A separate store rather than another key alongside
  // sections/assessments, for one specific reason: resetAll() clears
  // those, and the source id must survive that. It identifies a *writer*,
  // not a session — regenerating it on every "Reset everything" would
  // split one person's collected handwriting across several prefixes and
  // defeat the held-out-writer evaluation it exists to make possible
  // (plan.md §16).
  meta: {
    key: string;
    value: string;
  };
  // v5 (step.md step 13, plan.md §18). The durable, semester-long thing.
  // Course is not its own field — `courseCode`, grouped by sections.ts.
  sections: {
    key: string;
    value: Section;
  };
  // v5. One quiz's config plus its export state, scoped to a Section.
  // Replaces the single-value `config` store (retired below, not
  // repurposed — QuizConfig's fields live inside this instead of having
  // two homes that could drift).
  assessments: {
    key: string;
    value: Assessment;
  };
  // Retired at v5 (13.1) — declared here ONLY so the migration code below
  // can read/delete them with real types instead of casting through
  // `any`. Nothing outside upgrade() may reference these; there is no
  // `loadConfig`/`saveConfig` any more, on purpose.
  config: {
    key: string;
    value: QuizConfig;
  };
  rosterUpload: {
    key: string;
    value: RosterUpload;
  };
}

const DB_NAME = 'marks';
const DB_VERSION = 5;
const SOURCE_ID_KEY = 'sourceId';

// Only used by the v5 migration, to read what a v1-v4 database had under
// the old single-value stores before they're deleted. Not exported —
// nothing at the current schema version should ever key by these again.
const OLD_CONFIG_KEY = 'current';
const OLD_ROSTER_UPLOAD_KEY = 'current';

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
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('by-serial', 'serial');
        records.createIndex('by-studentId', 'studentId');
        // NOT creating 'config' here any more (step.md 13.1 — retired,
        // not repurposed). A brand-new v5 install has no use for it at
        // all; an existing v1-v4 database already has one from when IT
        // first ran this branch, and the v5 block below reads it before
        // deleting it, so this only changes what a genuinely fresh
        // install creates.
      }
      if (oldVersion < 2) {
        db.createObjectStore('meta');
      }
      if (oldVersion < 3) {
        // v3 (issues.md #2). Serials used to be stored exactly as typed, so
        // "007" and "7" sat under two different keys of the by-serial index
        // and the duplicate cross-check never got the chance to compare
        // them — `findRecordsBySerial("7")` simply returned nothing and the
        // duplicate saved silently.
        //
        // saveRecord now normalizes on write. Records saved BEFORE that has
        // to be rewritten here, or the index stays half-normalized and the
        // lookup keeps missing exactly the older records a returning
        // instructor most needs matched. This also finally makes types.ts's
        // "normalized: leading zeros stripped" comment true, which described
        // the intended behaviour rather than the actual one.
        const store = transaction.objectStore('records');
        store.openCursor().then(function migrate(cursor): Promise<void> | void {
          if (!cursor) return;
          const normalized = normalizeSerial(cursor.value.serial);
          if (normalized !== cursor.value.serial) {
            cursor.update({ ...cursor.value, serial: normalized });
          }
          return cursor.continue().then(migrate);
        });
      }
      if (oldVersion < 4) {
        // rosterUpload existed only from v4 to v4 — created here, folded
        // into a Section and deleted again below at v5. Anyone who was
        // never at exactly v4 (a fresh install, or an old v1-v3 database
        // jumping straight to v5) never sees this store exist at all.
        if (oldVersion >= 1) {
          db.createObjectStore('rosterUpload');
        }
      }
      if (oldVersion < 5) {
        db.createObjectStore('sections', { keyPath: 'id' });
        db.createObjectStore('assessments', { keyPath: 'id' });
        const records = transaction.objectStore('records');
        records.createIndex('by-assessment', 'assessmentId');

        // step.md 13.2 — "the migration, written as the hard case." A v1-v4
        // database that had a saved config becomes exactly one Section
        // (courseCode "Imported", so it's visibly distinct from anything
        // created after this point) and one Assessment holding every
        // existing record, stamped with the new assessmentId. A v1-v4
        // database with no saved config (nobody had started a quiz)
        // produces nothing — there is nothing to fold in. Either way the
        // old stores are retired at the end, since their data now lives
        // here or never existed.
        //
        // Someone may be MID-QUIZ when this runs (rule 3 — the migration
        // folds an in-flight session, it never drops one), so `records`
        // read here can be non-empty even for a session that was never
        // "finished" by exporting.
        if (db.objectStoreNames.contains('config')) {
          const configStore = transaction.objectStore('config');
          const rosterStore = db.objectStoreNames.contains('rosterUpload')
            ? transaction.objectStore('rosterUpload')
            : null;

          Promise.all([
            configStore.get(OLD_CONFIG_KEY),
            rosterStore ? rosterStore.get(OLD_ROSTER_UPLOAD_KEY) : Promise.resolve(undefined),
            records.getAll(),
          ]).then(async ([oldConfig, oldRosterUpload, existingRecords]) => {
            if (oldConfig) {
              const now = new Date().toISOString();
              const sectionId = crypto.randomUUID();
              const assessmentId = crypto.randomUUID();

              const section: Section = {
                id: sectionId,
                courseCode: 'Imported',
                label: '1',
                semester: 'Imported',
                idDigits: oldConfig.idDigits,
                ...(oldRosterUpload
                  ? {
                      roster: oldRosterUpload.roster,
                      workbook: {
                        fileName: oldRosterUpload.fileName,
                        bytes: oldRosterUpload.workbookBytes,
                        capturedAt: now,
                        source: 'uploaded' as const,
                      },
                    }
                  : {}),
              };
              const assessment: Assessment = {
                id: assessmentId,
                sectionId,
                quizName: oldConfig.quizName,
                questions: oldConfig.questions,
                totalMax: oldConfig.totalMax,
                createdAt: now,
                exportedAt: null,
              };

              await transaction.objectStore('sections').put(section);
              await transaction.objectStore('assessments').put(assessment);
              for (const record of existingRecords) {
                await records.put({ ...record, assessmentId });
              }
            }

            // Retired either way — config's data has either just been
            // folded above, or never existed to fold.
            db.deleteObjectStore('config');
            if (db.objectStoreNames.contains('rosterUpload')) {
              db.deleteObjectStore('rosterUpload');
            }
          });
        }
      }
    },
  });
}

export async function saveSection(section: Section): Promise<void> {
  const db = await getDB();
  await db.put('sections', section);
}

export async function getAllSections(): Promise<Section[]> {
  const db = await getDB();
  return db.getAll('sections');
}

export async function getSection(id: string): Promise<Section | undefined> {
  const db = await getDB();
  return db.get('sections', id);
}

// Step.md 13.18/13.19 — the semester purge deletes a section wholesale:
// itself, every assessment under it, and every record under those
// assessments. Not used by anything before Phase D; defined here now so
// the store-level primitive exists alongside the ones it depends on.
export async function deleteSection(sectionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['sections', 'assessments', 'records'], 'readwrite');
  const assessments = await tx.objectStore('assessments').getAll();
  const toDelete = assessments.filter((a) => a.sectionId === sectionId);
  for (const assessment of toDelete) {
    const records = await tx.objectStore('records').index('by-assessment').getAllKeys(assessment.id);
    for (const key of records) {
      await tx.objectStore('records').delete(key);
    }
    await tx.objectStore('assessments').delete(assessment.id);
  }
  await tx.objectStore('sections').delete(sectionId);
  await tx.done;
}

export async function saveAssessment(assessment: Assessment): Promise<void> {
  const db = await getDB();
  await db.put('assessments', assessment);
}

// Step.md 13.24 — one quiz, wrongly added, without touching the section it
// belongs to or any other quiz in it. Narrower than deleteSection: itself,
// and every record under it, nothing else.
export async function deleteAssessment(assessmentId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['assessments', 'records'], 'readwrite');
  const records = await tx.objectStore('records').index('by-assessment').getAllKeys(assessmentId);
  for (const key of records) {
    await tx.objectStore('records').delete(key);
  }
  await tx.objectStore('assessments').delete(assessmentId);
  await tx.done;
}

export async function getAllAssessments(): Promise<Assessment[]> {
  const db = await getDB();
  return db.getAll('assessments');
}

export async function getAssessment(id: string): Promise<Assessment | undefined> {
  const db = await getDB();
  return db.get('assessments', id);
}

// The serial is normalized on the way in, so the by-serial index has one
// key per real serial rather than one per spelling of it (issues.md #2).
// Doing it here rather than at each call site means no future writer can
// reintroduce the split — Review.tsx and Results.tsx both save through this.
export async function saveRecord(record: StudentRecord): Promise<void> {
  const db = await getDB();
  await db.put('records', { ...record, serial: normalizeSerial(record.serial) });
}

// Unscoped — every record in every assessment. Real uses are rare on
// purpose (step.md 13.8 scoped the two call sites that used to reach for
// this — Results' table, Scan's saved counter — to getRecordsByAssessment
// instead); kept as a primitive for whatever genuinely needs everything,
// such as Phase D's purge-preview counts.
export async function getAllRecords(): Promise<StudentRecord[]> {
  const db = await getDB();
  return db.getAll('records');
}

export async function getRecordsByAssessment(assessmentId: string): Promise<StudentRecord[]> {
  const db = await getDB();
  return db.getAllFromIndex('records', 'by-assessment', assessmentId);
}

// Queried with the NORMALIZED serial, matching how records are now stored.
// Passing the raw typed value here was the actual defect in issues.md #2:
// crossCheck normalizes both sides correctly, but it can only compare the
// records this lookup already returned, and an exact-match index lookup for
// "7" never returned the record saved as "007".
//
// Step.md 13.15 (Phase C) — scoped to ONE assessment, via an in-memory
// filter after the index lookup rather than a second index: `records`
// already carries `assessmentId` on every row, and the result set from
// `by-serial`/`by-studentId` is a handful of rows at this app's real
// scale (one class, one serial/ID), never worth a compound index for.
// Unscoped, a CSE100 student and a CSE203 student sharing serial "7" is
// normal and used to raise plan.md §2's identity cross-check across
// course boundaries — a warning that's usually wrong gets dismissed on
// the occasion it's right.
export async function findRecordsBySerial(serial: string, assessmentId: string): Promise<StudentRecord[]> {
  const db = await getDB();
  const normalized = normalizeSerial(serial);
  if (normalized === null) return [];
  const matches = await db.getAllFromIndex('records', 'by-serial', normalized);
  return matches.filter((r) => r.assessmentId === assessmentId);
}

export async function findRecordsByStudentId(studentId: string, assessmentId: string): Promise<StudentRecord[]> {
  const db = await getDB();
  const matches = await db.getAllFromIndex('records', 'by-studentId', studentId);
  return matches.filter((r) => r.assessmentId === assessmentId);
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

// issues.md N45 — whether Confirm shares this device's labelled cell crops
// (POST /api/harvest). On unless the instructor turns it off (the owner's
// decision, 2026-09-25). Kept in `meta` beside the source id for the same
// reason: resetAll() spares it, so clearing marks never silently turns
// sharing back on for someone who opted out.
const SHARE_CROPS_KEY = 'shareCrops';

export async function getShareCrops(): Promise<boolean> {
  const db = await getDB();
  // 'on'/'off' rather than a boolean: the meta store's schema holds strings.
  return (await db.get('meta', SHARE_CROPS_KEY)) !== 'off';
}

export async function setShareCrops(share: boolean): Promise<void> {
  const db = await getDB();
  await db.put('meta', share ? 'on' : 'off', SHARE_CROPS_KEY);
}

// Full wipe: every section, assessment and record. Step.md step 13's real
// replacement for this is the Phase D semester purge (scoped to one
// semester, blocked by an unexported assessment) — until that lands, this
// stays the only way back to a genuinely empty app, the same blast radius
// `resetAll()` always had, just aimed at the new stores instead of the
// retired `config`/`rosterUpload` ones.
//
// Deliberately does NOT clear `meta`. The source id identifies this
// browser as a writer across sessions; wiping it on every reset would
// fragment one person's collected handwriting into unrelated prefixes.
export async function resetAll(): Promise<void> {
  const db = await getDB();
  await db.clear('records');
  await db.clear('sections');
  await db.clear('assessments');
}
