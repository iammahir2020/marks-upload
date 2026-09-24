// The app's new entry point (step.md step 13.4, plan.md §18): semester ->
// course -> sections -> assessments, replacing config === null as the
// router (13.7). Self-contained, same pattern every other top-level
// screen already follows (Setup.tsx's old load-on-mount, Scan.tsx's
// record count) — fetches its own sections/assessments/counts rather than
// having App.tsx hold them.
//
// Also carries what used to live at the bottom of Setup.tsx: "Reset
// everything" and the privacy disclosure. Both belong to the app as a
// whole, not to any one quiz's config screen, and Library is now the
// first, always-visited screen the old Setup.tsx used to be.
import { Fragment, useEffect, useId, useState } from 'react';
import { deleteAssessment, deleteSection, getAllAssessments, getAllSections, getRecordsByAssessment, resetAll } from './db';
import {
  assessmentDeletePreview,
  assessmentsForSection,
  groupSections,
  lastActivityAt,
  needsResumeConfirmation,
  otherSemesters,
  purgePreview,
  sectionDeletePreview,
  sectionDisplayLabel,
  type AssessmentDeletePreview,
  type PurgePreview,
  type SectionDeletePreview,
} from './sections';
import type { Assessment, Section } from './types';

// A compact delete affordance for a tight row (section header, assessment
// row) where "Delete section"/"Delete quiz" as text was wide enough to
// push the row past a phone's viewport. `currentColor` picks up
// `.btn-danger`'s own color, so this needs no color prop of its own.
// Always paired with a `.btn-icon` button carrying its own `aria-label` —
// nothing here is visible to a screen reader on its own.
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path
        d="M4 7h16M9 7V4h6v3m-8 0 1 13h10l1-13"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface LibraryProps {
  // Step.md 13.18 — set for exactly one mount, right after creating a
  // section whose semester didn't exist before. null (the common case)
  // means no offer to show at all. See App.tsx's own comment on how this
  // stays a genuine one-shot rather than resurfacing on a later visit.
  pendingSemesterOffer?: string | null;
  // Step.md 14.4/14.9 — the landing page's own "way back": a returning
  // instructor never sees it again unprompted, but the explanation must
  // stay reachable for the moment it's actually wanted (showing a
  // colleague what this is). Lives as an always-visible "About" button in
  // the header (14.9) — it used to be a link inside the "How this works"
  // disclosure below, which collapses itself the moment a first section
  // exists, making it undiscoverable in exactly the state most real usage
  // is in. Optional so every existing render call and test stays valid
  // without passing a callback that isn't relevant to what they're
  // testing.
  onShowLanding?: () => void;
  onNewSection: () => void;
  onEditSection: (section: Section) => void;
  onNewAssessment: (section: Section) => void;
  onOpenAssessment: (section: Section, assessment: Assessment) => void;
}

const HOW_IT_WORKS = [
  {
    title: 'Add a section once',
    detail:
      'Course code, section label, semester, and how many digits the student ID has. Every quiz that section sits reuses it.',
  },
  {
    title: 'Start a quiz',
    detail: 'Question count and each question’s max mark — the ID digits are already set for the section.',
  },
  {
    title: 'Photograph each script',
    detail: 'Frame the marks grid at the top of the script and capture — the camera stays ready for the next one immediately.',
  },
  {
    title: 'Confirm, then export',
    detail: 'Each capture opens for review automatically. Every confirmed script is saved on this device, ready to export any time.',
  },
];

export default function Library({
  pendingSemesterOffer = null,
  onShowLanding,
  onNewSection,
  onEditSection,
  onNewAssessment,
  onOpenAssessment,
}: LibraryProps) {
  const [loaded, setLoaded] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  // assessmentId -> how many scripts are saved against it. Loaded once
  // alongside the assessment list rather than per-row-on-mount, so
  // opening the library with a semester's worth of quizzes doesn't fire a
  // wave of individual effects.
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Step.md 13.14 — the same fetch that produces `counts` already has
  // every record's `capturedAt` in hand; `lastActivityAt` derives "when
  // was this assessment last touched" from it rather than storing a
  // separate field that could go stale.
  const [lastActivity, setLastActivity] = useState<Record<string, string | null>>({});
  const [confirmingReset, setConfirmingReset] = useState(false);
  // Step.md 13.14 — set when opening an assessment last touched before
  // today, so the app asks before dropping straight into the camera.
  // null means "nothing pending," the common case that adds no tap at all.
  const [pendingResume, setPendingResume] = useState<{ section: Section; assessment: Assessment } | null>(null);
  // Step.md 13.18 — semesters the instructor has already decided about
  // this mount, either by tapping "Not now" or by successfully purging
  // them. Local-only, never persisted: a genuine app reload naturally
  // re-derives whether the offer is still relevant, and pendingSemester
  // Offer itself only exists for one mount anyway (see App.tsx).
  const [dismissedSemesters, setDismissedSemesters] = useState<Set<string>>(new Set());
  // Which OTHER semester is currently expanded into its own review/
  // confirm/blocked view — null means the banner is just the summary list.
  const [reviewingSemester, setReviewingSemester] = useState<string | null>(null);
  // Deleting a single, individually-wrong section — a smaller, more
  // targeted escape hatch than the semester purge or the full "Reset
  // everything" wipe below, for when only one section was created by
  // mistake. null (the common case) means no section is mid-delete.
  const [deletingSection, setDeletingSection] = useState<Section | null>(null);
  // Step.md 13.24 — the same idea, one level narrower: a single wrongly-
  // added quiz, without touching the section it lives in or any sibling
  // quiz. null means no assessment is mid-delete.
  const [deletingAssessment, setDeletingAssessment] = useState<{ section: Section; assessment: Assessment } | null>(
    null,
  );

  async function load() {
    const [loadedSections, loadedAssessments] = await Promise.all([getAllSections(), getAllAssessments()]);
    setSections(loadedSections);
    setAssessments(loadedAssessments);
    const entries = await Promise.all(
      loadedAssessments.map(async (a) => {
        const records = await getRecordsByAssessment(a.id);
        return [a.id, records] as const;
      }),
    );
    setCounts(Object.fromEntries(entries.map(([id, records]) => [id, records.length])));
    setLastActivity(
      Object.fromEntries(entries.map(([id, records]) => [id, lastActivityAt(records.map((r) => r.capturedAt))])),
    );
    setLoaded(true);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleReset() {
    await resetAll();
    setConfirmingReset(false);
    await load();
  }

  // Step.md 13.14 — the one entry point for tapping an assessment row,
  // so "New assessment" (always today's, never confirmed) and "resume an
  // existing one" can't drift apart.
  function handleOpenAssessment(section: Section, assessment: Assessment) {
    if (needsResumeConfirmation(lastActivity[assessment.id] ?? null)) {
      setPendingResume({ section, assessment });
    } else {
      onOpenAssessment(section, assessment);
    }
  }

  // Step.md 13.18 — deletes every section under one semester (each
  // cascading to its own assessments and records via deleteSection,
  // step.md 13.1's own cascade primitive). Only ever reached past
  // PurgeReviewPanel's own block check below, never called directly.
  async function handlePurge(semester: string) {
    const toDelete = sections.filter((s) => s.semester === semester);
    for (const section of toDelete) {
      await deleteSection(section.id);
    }
    setReviewingSemester(null);
    setDismissedSemesters((prev) => new Set(prev).add(semester));
    await load();
  }

  // Deletes ONE section — itself, every assessment under it and every
  // record under those (deleteSection's own cascade, the same primitive
  // the semester purge uses). Only ever reached past
  // SectionDeleteReviewPanel's own block check below, never called
  // directly — same shape as handlePurge, one semester narrower.
  async function handleDeleteSection(sectionId: string) {
    await deleteSection(sectionId);
    setDeletingSection(null);
    await load();
  }

  // Deletes ONE assessment — itself and every record under it
  // (deleteAssessment's own cascade), leaving the section and every
  // sibling quiz untouched. Only ever reached past
  // AssessmentDeleteReviewPanel's own block check below.
  async function handleDeleteAssessment(assessmentId: string) {
    await deleteAssessment(assessmentId);
    setDeletingAssessment(null);
    await load();
  }

  if (!loaded) return null;

  const grouped = groupSections(sections);
  const totalRecords = Object.values(counts).reduce((sum, n) => sum + n, 0);
  // Step.md 13.18 — every OTHER semester the instructor hasn't already
  // dismissed or purged this mount. Empty (and the banner below renders
  // nothing) once pendingSemesterOffer is null, which is the common case.
  const candidateSemesters = pendingSemesterOffer
    ? otherSemesters(sections, pendingSemesterOffer).filter((s) => !dismissedSemesters.has(s))
    : [];

  return (
    <div className="page">
      <div className="app-header">
        <div>
          <span className="eyebrow">Script Mark Scanner</span>
          <h1>Your sections</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Step.md 14.4/14.9 — always visible, not tucked inside the
              collapsed "How this works" disclosure below (which closes
              itself the moment a first section exists, per its own
              `open={sections.length === 0}`). Found from real use: a
              way back that only exists while collapsed is, for practical
              purposes, no way back at all. */}
          {onShowLanding && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onShowLanding}>
              About
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={onNewSection}>
            + New section
          </button>
        </div>
      </div>

      {/* Step.md 13.14 — the one confirmation this screen adds a tap for,
          and only when it's genuinely earned: an assessment last touched
          before today. Cancelling leaves the library exactly as it was. */}
      {pendingResume && (
        <div className="banner banner-warning" role="alert">
          <p>
            Resume <strong>{sectionDisplayLabel(pendingResume.section)} · {pendingResume.assessment.quizName}</strong>
            {' — last scanned '}
            {new Date(lastActivity[pendingResume.assessment.id]!).toLocaleDateString()}?
          </p>
          <div className="banner-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                onOpenAssessment(pendingResume.section, pendingResume.assessment);
                setPendingResume(null);
              }}
            >
              Resume
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPendingResume(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step.md 13.18 — offered exactly once, right after creating a
          section in a semester that didn't exist before (App.tsx's
          pendingSemesterOffer). Never automatic, never on a timer — this
          is the only place a purge is ever offered at all. */}
      {candidateSemesters.length > 0 && (
        <div className="banner banner-warning" role="alert">
          <p>
            New semester: <strong>{pendingSemesterOffer}</strong>. Still saved on this device:
          </p>
          {reviewingSemester === null ? (
            <>
              <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                {candidateSemesters.map((semester) => {
                  const preview = purgePreview(semester, sections, assessments, counts);
                  return (
                    <li key={semester}>
                      <strong>{semester}</strong> — {preview.sections.length}{' '}
                      {preview.sections.length === 1 ? 'section' : 'sections'}, {preview.assessmentCount}{' '}
                      {preview.assessmentCount === 1 ? 'quiz' : 'quizzes'}, {preview.recordCount}{' '}
                      {preview.recordCount === 1 ? 'record' : 'records'}{' '}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setReviewingSemester(semester)}
                      >
                        Review
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="banner-actions">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setDismissedSemesters((prev) => new Set([...prev, ...candidateSemesters]))}
                >
                  Not now
                </button>
              </div>
            </>
          ) : (
            <PurgeReviewPanel
              preview={purgePreview(reviewingSemester, sections, assessments, counts)}
              onCancel={() => setReviewingSemester(null)}
              onConfirm={handlePurge}
            />
          )}
        </div>
      )}

      {sections.length === 0 ? (
        <div className="empty-state stack-sm">
          <span>No sections yet — add one to get started.</span>
          <button className="btn btn-primary" onClick={onNewSection}>
            + New section
          </button>
        </div>
      ) : (
        <div className="stack">
          {grouped.map((semesterGroup) => (
            <div key={semesterGroup.semester} className="stack-sm">
              <h2>{semesterGroup.semester}</h2>
              {semesterGroup.courses.map((courseGroup) => (
                <div key={courseGroup.courseCode} className="stack-sm">
                  <span className="text-sm muted" style={{ fontWeight: 600 }}>
                    {courseGroup.courseCode}
                  </span>
                  {courseGroup.sections.map((section) => {
                    const sectionAssessments = assessmentsForSection(assessments, section.id);
                    return (
                      <div key={section.id} className="card stack-sm" style={{ padding: 14 }}>
                        <div className="row-between">
                          <span style={{ fontWeight: 600 }}>{sectionDisplayLabel(section)}</span>
                          {/* Scoped flexWrap, not the shared .row class — same fix as
                              the mode-toggle overflow this project already hit once
                              (CLAUDE.md's own step-12 note): .btn's white-space: nowrap
                              plus a no-wrap row means these three buttons must fit on
                              one line or spill past a phone's viewport. */}
                          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => onEditSection(section)}>
                              Edit
                            </button>
                            <button className="btn btn-primary btn-sm" onClick={() => onNewAssessment(section)}>
                              + New assessment
                            </button>
                            <button
                              className="btn btn-danger btn-sm btn-icon"
                              onClick={() => setDeletingSection(section)}
                              aria-label="Delete section"
                              title="Delete section"
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </div>
                        {deletingSection?.id === section.id && (
                          <SectionDeleteReviewPanel
                            preview={sectionDeletePreview(section, assessments, counts)}
                            onCancel={() => setDeletingSection(null)}
                            onConfirm={handleDeleteSection}
                          />
                        )}
                        {sectionAssessments.length === 0 ? (
                          <span className="text-sm muted">No quizzes yet in this section.</span>
                        ) : (
                          <ul className="queue-list">
                            {sectionAssessments.map((assessment) => (
                              <Fragment key={assessment.id}>
                                {/* Scoped flexWrap, not the shared .queue-item class —
                                    Scan.tsx's upload queue uses that class too, and
                                    only THIS row (name + count + badge + delete, four
                                    items) is tight enough on a phone to need it. */}
                                <li className="queue-item" style={{ flexWrap: 'wrap' }}>
                                  <button
                                    className="btn btn-quiet flex-1"
                                    style={{ justifyContent: 'flex-start', textAlign: 'left', minWidth: 0 }}
                                    onClick={() => handleOpenAssessment(section, assessment)}
                                  >
                                    {assessment.quizName}
                                  </button>
                                  <span className="text-sm muted">
                                    {counts[assessment.id] ?? 0} scanned
                                  </span>
                                  {assessment.exportedAt ? (
                                    <span className="badge badge-success">Exported</span>
                                  ) : (
                                    <span className="badge badge-neutral">Not exported</span>
                                  )}
                                  <button
                                    className="btn btn-danger btn-sm btn-icon"
                                    onClick={() => setDeletingAssessment({ section, assessment })}
                                    aria-label="Delete quiz"
                                    title="Delete quiz"
                                  >
                                    <TrashIcon />
                                  </button>
                                </li>
                                {deletingAssessment?.assessment.id === assessment.id && (
                                  <li>
                                    <AssessmentDeleteReviewPanel
                                      preview={assessmentDeletePreview(assessment, counts)}
                                      onCancel={() => setDeletingAssessment(null)}
                                      onConfirm={handleDeleteAssessment}
                                    />
                                  </li>
                                )}
                              </Fragment>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {totalRecords > 0 && (
        <div className="card stack-sm">
          {!confirmingReset ? (
            <div className="row">
              <button className="btn btn-danger btn-sm" onClick={() => setConfirmingReset(true)}>
                Reset everything
              </button>
            </div>
          ) : (
            <div className="banner banner-danger" role="alert">
              <p>
                This deletes every section, quiz and saved record on this device — there's no
                undo. Make sure you've exported anything you need first.
              </p>
              <div className="banner-actions">
                <button className="btn btn-danger-solid btn-sm" onClick={handleReset}>
                  Yes, delete everything
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <details className="disclosure" open={sections.length === 0}>
        <summary>How this works</summary>
        <div className="disclosure-body">
          <ol className="steps-list">
            {HOW_IT_WORKS.map((step, i) => (
              <li key={step.title}>
                <span className="step-number">{i + 1}</span>
                <span className="step-text">
                  <strong>{step.title}</strong>
                  <span>{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-sm muted">
            Your marks stay on this device until you export them — there’s no account and no
            copy kept anywhere else. A photo that can’t be read clearly is always flagged for
            you to fix rather than guessed at.
          </p>
          <p className="text-sm muted">
            <strong>What’s kept to improve recognition.</strong> The photograph itself is
            never stored — it’s read and then discarded. What is saved is the individual
            cells it was cut into: one digit or one mark per image, each labelled with the
            value you confirmed. These are used to train and tune the handwriting
            recognition so it reads better over time. They carry no name, nothing that links
            them back to a student, and no way to reassemble a whole student ID from them.
            They’re deleted automatically after a year.
          </p>
          <p className="text-sm muted">
            <strong>Using your own class-list workbook</strong> (attached per section) holds
            the names on it on this device — shown next to a scanned ID so a misread is easy
            to catch — for as long as that section exists, and clears along with everything
            else via Reset everything above. Names are never sent anywhere; only the digits
            you confirm are used to improve recognition, exactly as above.
          </p>
        </div>
      </details>

      {/*
        Step 11.5.1 — deliberately OUTSIDE the <details> above, which
        collapses once a section exists. Someone using this for the
        tenth time would otherwise never see it again, and they are the
        person whose students' handwriting is actually being collected.
      */}
      <p className="text-sm muted data-note">
        Scripts are never stored. Individual cells — one digit or mark each — are kept with
        the values you confirm for up to a year, and used to train and tune handwriting
        recognition.
      </p>
      <p className="text-sm muted data-note">
        A class-list workbook attached to a section keeps the names on it on this device for
        as long as that section exists, cleared by Reset everything — never sent anywhere.
      </p>
    </div>
  );
}

interface PurgeReviewPanelProps {
  preview: PurgePreview;
  onCancel: () => void;
  onConfirm: (semester: string) => void;
}

// Step.md 13.18/13.19 — two states, in priority order, the same shape
// Results.tsx's own PendingExportPanel already uses for its duplicate
// block vs. plain confirm: an unexported assessment BLOCKS the purge
// outright, named individually, Cancel only; otherwise a plain confirm
// stating exactly what would go.
function PurgeReviewPanel({ preview, onCancel, onConfirm }: PurgeReviewPanelProps) {
  if (preview.blockedBy.length > 0) {
    return (
      <div className="stack-sm">
        <p>
          Can't purge <strong>{preview.semester}</strong> —{' '}
          {preview.blockedBy.length === 1
            ? '1 assessment hasn’t been exported yet:'
            : `${preview.blockedBy.length} assessments haven’t been exported yet:`}
        </p>
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          {preview.blockedBy.map(({ section, assessment }) => (
            <li key={assessment.id}>
              {sectionDisplayLabel(section)} · {assessment.quizName}
            </li>
          ))}
        </ul>
        {/* No way past this but exporting the work first — same rule
            plan.md §17/§18 already apply to a duplicate scanned script:
            deleting unrecovered work silently is the one outcome this
            feature must never produce. */}
        <div className="banner-actions">
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack-sm">
      <p>
        Delete <strong>{preview.semester}</strong>: {preview.sections.length}{' '}
        {preview.sections.length === 1 ? 'section' : 'sections'}, {preview.assessmentCount}{' '}
        {preview.assessmentCount === 1 ? 'quiz' : 'quizzes'}, {preview.recordCount}{' '}
        {preview.recordCount === 1 ? 'record' : 'records'} — there's no undo.
      </p>
      <div className="banner-actions">
        <button className="btn btn-danger-solid btn-sm" onClick={() => onConfirm(preview.semester)}>
          Yes, delete {preview.semester}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface TypedDeleteConfirmProps {
  expected: string;
  itemLabel: string; // "section" or "quiz" — fills in the instruction text
  confirmLabel: string; // "Yes, delete CSE100-1"
  onConfirm: () => void;
  onCancel: () => void;
}

// Shared by SectionDeleteReviewPanel and AssessmentDeleteReviewPanel — a
// destructive delete only proceeds once the instructor has actually TYPED
// the name of the thing they're about to lose, not merely clicked a
// button they may not have read closely. Trimmed but otherwise exact:
// the point is confirming they read and typed the real name, not
// guessing at whether they roughly meant it.
function TypedDeleteConfirm({ expected, itemLabel, confirmLabel, onConfirm, onCancel }: TypedDeleteConfirmProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const matches = typed.trim() === expected;

  return (
    <div className="stack-sm">
      <label className="field">
        <span className="field-label">
          Type the {itemLabel}’s name, <strong>{expected}</strong>, to confirm
        </span>
        <input
          id={inputId}
          className="input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={expected}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </label>
      <div className="banner-actions">
        <button className="btn btn-danger-solid btn-sm" disabled={!matches} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface SectionDeleteReviewPanelProps {
  preview: SectionDeletePreview;
  onCancel: () => void;
  onConfirm: (sectionId: string) => void;
}

// The single-section counterpart to PurgeReviewPanel: a typed confirm
// (13.24) stating exactly what would go, no undo. Unlike the purge, an
// unexported quiz does not block this — it is named in the confirm so the
// loss is never silent (see sections.ts's hasUnexportedWork).
function SectionDeleteReviewPanel({ preview, onCancel, onConfirm }: SectionDeleteReviewPanelProps) {
  const label = sectionDisplayLabel(preview.section);

  return (
    <div className="banner banner-danger" role="alert">
      <p>
        Delete <strong>{label}</strong>: {preview.assessmentCount}{' '}
        {preview.assessmentCount === 1 ? 'quiz' : 'quizzes'}, {preview.recordCount}{' '}
        {preview.recordCount === 1 ? 'record' : 'records'} — there's no undo.
      </p>
      {preview.unexported.length > 0 && (
        <p>
          <strong>Never exported:</strong>{' '}
          {preview.unexported.map((a) => a.quizName).join(', ')}. Their marks exist only on this device.
        </p>
      )}
      <TypedDeleteConfirm
        expected={label}
        itemLabel="section"
        confirmLabel={`Yes, delete ${label}`}
        onConfirm={() => onConfirm(preview.section.id)}
        onCancel={onCancel}
      />
    </div>
  );
}

interface AssessmentDeleteReviewPanelProps {
  preview: AssessmentDeletePreview;
  onCancel: () => void;
  onConfirm: (assessmentId: string) => void;
}

// The single-assessment counterpart to SectionDeleteReviewPanel — same
// typed confirm, one level narrower: this one quiz, never the section it
// lives in or any sibling quiz. Never-exported work warns, never blocks.
function AssessmentDeleteReviewPanel({ preview, onCancel, onConfirm }: AssessmentDeleteReviewPanelProps) {
  const name = preview.assessment.quizName;

  return (
    <div className="banner banner-danger" role="alert">
      <p>
        Delete <strong>{name}</strong>: {preview.recordCount}{' '}
        {preview.recordCount === 1 ? 'record' : 'records'} — there's no undo.
      </p>
      {preview.unexported && (
        <p>
          <strong>Never exported.</strong> These marks exist only on this device.
        </p>
      )}
      <TypedDeleteConfirm
        expected={name}
        itemLabel="quiz"
        confirmLabel={`Yes, delete ${name}`}
        onConfirm={() => onConfirm(preview.assessment.id)}
        onCancel={onCancel}
      />
    </div>
  );
}
