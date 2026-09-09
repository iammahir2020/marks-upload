import { describe, expect, it } from 'vitest';
import {
  assessmentConfig,
  assessmentDeletePreview,
  assessmentsForSection,
  currentSemesterSeason,
  formatSemesterLabel,
  groupSections,
  isDuplicateSection,
  lastActivityAt,
  needsResumeConfirmation,
  otherSemesters,
  parseSemesterLabel,
  purgePreview,
  sectionDeletePreview,
  sectionDisplayLabel,
} from './sections';
import type { Assessment, Section } from './types';

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
    questions: [{ q: 1, max: 5 }],
    totalMax: 5,
    createdAt: new Date().toISOString(),
    exportedAt: null,
    ...overrides,
  };
}

describe('sectionDisplayLabel', () => {
  it('combines course code and label with a dash', () => {
    expect(sectionDisplayLabel({ courseCode: 'CSE203', label: '2' })).toBe('CSE203-2');
  });
});

describe('isDuplicateSection', () => {
  it('flags the same course code and label under the same semester', () => {
    const existing = [makeSection({ courseCode: 'CSE203', label: '2', semester: 'Fall 2026' })];
    expect(isDuplicateSection(existing, 'Fall 2026', 'CSE203', '2')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    const existing = [makeSection({ courseCode: 'CSE203', label: '2', semester: 'Fall 2026' })];
    expect(isDuplicateSection(existing, ' fall 2026 ', ' cse203 ', ' 2 ')).toBe(true);
  });

  it('does not flag a different label under the same course', () => {
    const existing = [makeSection({ courseCode: 'CSE203', label: '1' })];
    expect(isDuplicateSection(existing, 'Fall 2026', 'CSE203', '2')).toBe(false);
  });

  it('does not flag the same course/label under a different semester', () => {
    const existing = [makeSection({ courseCode: 'CSE203', label: '1', semester: 'Fall 2026' })];
    expect(isDuplicateSection(existing, 'Spring 2027', 'CSE203', '1')).toBe(false);
  });

  it('excludes the section being edited from its own collision check', () => {
    const section = makeSection({ courseCode: 'CSE203', label: '1' });
    expect(isDuplicateSection([section], section.semester, 'CSE203', '1', section.id)).toBe(false);
  });
});

describe('groupSections', () => {
  it('groups the real semester from the design discussion: CSE100, CSE200, two CSE203 sections', () => {
    const sections = [
      makeSection({ courseCode: 'CSE100', label: '1' }),
      makeSection({ courseCode: 'CSE200', label: '1' }),
      makeSection({ courseCode: 'CSE203', label: '1' }),
      makeSection({ courseCode: 'CSE203', label: '2' }),
    ];
    const grouped = groupSections(sections);

    expect(grouped).toHaveLength(1); // one semester
    expect(grouped[0].semester).toBe('Fall 2026');
    expect(grouped[0].courses.map((c) => c.courseCode)).toEqual(['CSE100', 'CSE200', 'CSE203']);

    const cse203 = grouped[0].courses.find((c) => c.courseCode === 'CSE203')!;
    expect(cse203.sections).toHaveLength(2);
    expect(cse203.sections.map((s) => s.label)).toEqual(['1', '2']);
  });

  it('sorts course codes alphabetically', () => {
    const sections = [makeSection({ courseCode: 'CSE300' }), makeSection({ courseCode: 'CSE100' })];
    const grouped = groupSections(sections);
    expect(grouped[0].courses.map((c) => c.courseCode)).toEqual(['CSE100', 'CSE300']);
  });

  it('sorts section labels numerically, not lexically ("10" after "2")', () => {
    const sections = [
      makeSection({ label: '10' }),
      makeSection({ label: '2' }),
      makeSection({ label: '1' }),
    ];
    const grouped = groupSections(sections);
    expect(grouped[0].courses[0].sections.map((s) => s.label)).toEqual(['1', '2', '10']);
  });

  it('separates sections that share a course but sit different semesters', () => {
    const sections = [
      makeSection({ semester: 'Fall 2026', label: '1' }),
      makeSection({ semester: 'Spring 2027', label: '1' }),
    ];
    const grouped = groupSections(sections);
    expect(grouped.map((g) => g.semester)).toEqual(['Fall 2026', 'Spring 2027']);
    expect(grouped[0].courses[0].sections).toHaveLength(1);
    expect(grouped[1].courses[0].sections).toHaveLength(1);
  });

  it('returns nothing for an empty list', () => {
    expect(groupSections([])).toEqual([]);
  });
});

describe('assessmentsForSection', () => {
  it('returns only assessments belonging to that section, newest first', () => {
    const section = makeSection();
    const other = makeSection({ courseCode: 'CSE100' });
    const older = makeAssessment(section.id, { quizName: 'Quiz 1', createdAt: '2026-09-01T00:00:00.000Z' });
    const newer = makeAssessment(section.id, { quizName: 'Quiz 2', createdAt: '2026-09-08T00:00:00.000Z' });
    const elsewhere = makeAssessment(other.id, { quizName: 'Quiz 1' });

    const result = assessmentsForSection([older, newer, elsewhere], section.id);
    expect(result.map((a) => a.quizName)).toEqual(['Quiz 2', 'Quiz 1']);
  });

  it('returns an empty array for a section with no assessments yet', () => {
    expect(assessmentsForSection([], 'nonexistent')).toEqual([]);
  });
});

describe('assessmentConfig', () => {
  it('combines an assessment with its section into a QuizConfig, reading idDigits from the SECTION', () => {
    const section = makeSection({ idDigits: 8 });
    const assessment = makeAssessment(section.id, {
      quizName: 'Quiz 2',
      questions: [{ q: 1, max: 10 }],
      totalMax: 10,
    });

    expect(assessmentConfig(assessment, section)).toEqual({
      quizName: 'Quiz 2',
      idDigits: 8, // from the section, not duplicated on the assessment
      questions: [{ q: 1, max: 10 }],
      totalMax: 10,
    });
  });
});

describe('lastActivityAt', () => {
  it('returns the latest capturedAt among several', () => {
    const values = ['2026-09-08T10:00:00.000Z', '2026-09-09T09:00:00.000Z', '2026-09-01T00:00:00.000Z'];
    expect(lastActivityAt(values)).toBe('2026-09-09T09:00:00.000Z');
  });

  it('returns null for an empty list — a brand-new assessment', () => {
    expect(lastActivityAt([])).toBeNull();
  });

  it('handles a single value', () => {
    expect(lastActivityAt(['2026-09-09T09:00:00.000Z'])).toBe('2026-09-09T09:00:00.000Z');
  });
});

describe('needsResumeConfirmation (step.md 13.14)', () => {
  // Built relative to a fixed "now" using plain millisecond arithmetic
  // (never a hardcoded UTC-midnight-adjacent string) so the fixtures are
  // correct in whatever timezone the test actually runs in — an offset of
  // a couple of hours around a UTC day boundary reads as a DIFFERENT local
  // calendar day in some timezones and the SAME one in others, which is
  // exactly the trap a naive fixture falls into.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date('2026-09-09T15:00:00.000Z');

  it('does not confirm a brand-new assessment (no activity yet)', () => {
    expect(needsResumeConfirmation(null, now)).toBe(false);
  });

  it('does not confirm an assessment last touched earlier TODAY', () => {
    const earlierToday = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    expect(needsResumeConfirmation(earlierToday.toISOString(), now)).toBe(false);
  });

  it('confirms an assessment last touched a couple of days ago', () => {
    const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);
    expect(needsResumeConfirmation(twoDaysAgo.toISOString(), now)).toBe(true);
  });

  it('confirms an assessment last touched weeks ago', () => {
    const threeWeeksAgo = new Date(now.getTime() - 21 * DAY_MS);
    expect(needsResumeConfirmation(threeWeeksAgo.toISOString(), now)).toBe(true);
  });

  it('compares by LOCAL calendar day, not a rolling 24-hour window', () => {
    // Same local calendar day as `now`, however many hours apart — must
    // not confirm, even though it isn't "the same moment."
    const sameDayEarlier = new Date(now);
    sameDayEarlier.setHours(0, 1, 0, 0);
    expect(needsResumeConfirmation(sameDayEarlier.toISOString(), now)).toBe(false);
  });
});

describe('otherSemesters (step.md 13.18)', () => {
  it('lists every semester except the current one', () => {
    const sections = [
      makeSection({ semester: 'Fall 2026' }),
      makeSection({ semester: 'Spring 2026' }),
      makeSection({ semester: 'Spring 2027' }),
    ];
    expect(otherSemesters(sections, 'Spring 2027')).toEqual(['Fall 2026', 'Spring 2026']);
  });

  it('returns nothing when there is only the current semester', () => {
    const sections = [makeSection({ semester: 'Fall 2026' })];
    expect(otherSemesters(sections, 'Fall 2026')).toEqual([]);
  });

  it('treats differently-cased labels as DISTINCT semesters, surfacing drift rather than hiding it', () => {
    const sections = [makeSection({ semester: 'Fall 2026' }), makeSection({ semester: 'fall 2026' })];
    expect(otherSemesters(sections, 'Spring 2027')).toEqual(['Fall 2026', 'fall 2026']);
  });

  it('deduplicates repeated semester labels', () => {
    const sections = [
      makeSection({ semester: 'Fall 2026', courseCode: 'CSE100' }),
      makeSection({ semester: 'Fall 2026', courseCode: 'CSE203' }),
    ];
    expect(otherSemesters(sections, 'Spring 2027')).toEqual(['Fall 2026']);
  });
});

describe('purgePreview (step.md 13.18/13.19)', () => {
  it('counts sections, assessments and records for one semester only', () => {
    const oldSection = makeSection({ semester: 'Fall 2026', courseCode: 'CSE203', label: '1' });
    const newSection = makeSection({ semester: 'Spring 2027', courseCode: 'CSE100', label: '1' });
    const a1 = makeAssessment(oldSection.id, { exportedAt: '2026-12-01T00:00:00.000Z' });
    const a2 = makeAssessment(oldSection.id, { exportedAt: '2026-12-05T00:00:00.000Z' });
    const newAssessment = makeAssessment(newSection.id, { exportedAt: null });

    const preview = purgePreview(
      'Fall 2026',
      [oldSection, newSection],
      [a1, a2, newAssessment],
      { [a1.id]: 20, [a2.id]: 18, [newAssessment.id]: 5 },
    );

    expect(preview.sections).toEqual([oldSection]);
    expect(preview.assessmentCount).toBe(2);
    expect(preview.recordCount).toBe(38); // 20 + 18, NOT the new semester's 5
    expect(preview.blockedBy).toEqual([]);
  });

  it('blocks on an unexported assessment that holds real records, naming it', () => {
    const section = makeSection({ semester: 'Fall 2026' });
    const exported = makeAssessment(section.id, { quizName: 'Quiz 1', exportedAt: '2026-12-01T00:00:00.000Z' });
    const unexported = makeAssessment(section.id, { quizName: 'Quiz 2', exportedAt: null });

    const preview = purgePreview('Fall 2026', [section], [exported, unexported], { [unexported.id]: 3 });

    expect(preview.blockedBy).toHaveLength(1);
    expect(preview.blockedBy[0].assessment.quizName).toBe('Quiz 2');
    expect(preview.blockedBy[0].section.id).toBe(section.id);
  });

  it('does NOT block on an unexported assessment that has no records at all', () => {
    // A brand-new, wrongly-created assessment is ALSO never exported —
    // blocking on exportedAt alone would make it impossible to ever
    // delete the exact thing this guard exists to let go of safely.
    // There is nothing to lose deleting an empty one.
    const section = makeSection({ semester: 'Fall 2026' });
    const emptyUnexported = makeAssessment(section.id, { quizName: 'Quiz 2', exportedAt: null });

    const preview = purgePreview('Fall 2026', [section], [emptyUnexported], {});

    expect(preview.blockedBy).toEqual([]);
  });

  it('a semester with no sections at all previews as empty, not an error', () => {
    const preview = purgePreview('Nonexistent Semester', [], [], {});
    expect(preview.sections).toEqual([]);
    expect(preview.assessmentCount).toBe(0);
    expect(preview.recordCount).toBe(0);
    expect(preview.blockedBy).toEqual([]);
  });

  it('a section with no assessments yet never blocks and counts zero', () => {
    const section = makeSection({ semester: 'Fall 2026' });
    const preview = purgePreview('Fall 2026', [section], [], {});
    expect(preview.sections).toEqual([section]);
    expect(preview.assessmentCount).toBe(0);
    expect(preview.blockedBy).toEqual([]);
  });
});

describe('sectionDeletePreview (step.md 13.23)', () => {
  it('counts only this section’s assessments and records', () => {
    const section = makeSection();
    const other = makeSection({ courseCode: 'CSE100' });
    const a1 = makeAssessment(section.id, { exportedAt: '2026-12-01T00:00:00.000Z' });
    const a2 = makeAssessment(section.id, { exportedAt: '2026-12-05T00:00:00.000Z' });
    const otherAssessment = makeAssessment(other.id, { exportedAt: '2026-12-01T00:00:00.000Z' });

    const preview = sectionDeletePreview(section, [a1, a2, otherAssessment], {
      [a1.id]: 20,
      [a2.id]: 18,
      [otherAssessment.id]: 99,
    });

    expect(preview.assessmentCount).toBe(2);
    expect(preview.recordCount).toBe(38); // not the other section's 99
    expect(preview.blockedBy).toEqual([]);
  });

  it('blocks on an unexported assessment that holds real records, naming it', () => {
    const section = makeSection();
    const exported = makeAssessment(section.id, { quizName: 'Quiz 1', exportedAt: '2026-12-01T00:00:00.000Z' });
    const unexported = makeAssessment(section.id, { quizName: 'Quiz 2', exportedAt: null });

    const preview = sectionDeletePreview(section, [exported, unexported], { [unexported.id]: 5 });

    expect(preview.blockedBy).toEqual([unexported]);
  });

  it('does not block on an empty, never-exported assessment', () => {
    const section = makeSection();
    const emptyUnexported = makeAssessment(section.id, { exportedAt: null });

    const preview = sectionDeletePreview(section, [emptyUnexported], {});

    expect(preview.blockedBy).toEqual([]);
  });

  it('a section with no assessments yet never blocks and counts zero', () => {
    const section = makeSection();
    const preview = sectionDeletePreview(section, [], {});
    expect(preview.assessmentCount).toBe(0);
    expect(preview.recordCount).toBe(0);
    expect(preview.blockedBy).toEqual([]);
  });
});

describe('assessmentDeletePreview (step.md 13.24)', () => {
  it('is not blocked for a brand-new, empty assessment', () => {
    const assessment = makeAssessment(crypto.randomUUID());
    const preview = assessmentDeletePreview(assessment, {});
    expect(preview.recordCount).toBe(0);
    expect(preview.blocked).toBe(false);
  });

  it('is blocked when it holds real records and has never been exported', () => {
    const assessment = makeAssessment(crypto.randomUUID(), { exportedAt: null });
    const preview = assessmentDeletePreview(assessment, { [assessment.id]: 12 });
    expect(preview.recordCount).toBe(12);
    expect(preview.blocked).toBe(true);
  });

  it('is not blocked once it has been exported, even with real records', () => {
    const assessment = makeAssessment(crypto.randomUUID(), { exportedAt: '2026-12-01T00:00:00.000Z' });
    const preview = assessmentDeletePreview(assessment, { [assessment.id]: 12 });
    expect(preview.blocked).toBe(false);
  });
});

describe('formatSemesterLabel / parseSemesterLabel — the picker (plan.md §18)', () => {
  it('round-trips every season', () => {
    for (const [season, year] of [['Spring', 2027], ['Summer', 2027], ['Autumn', 2027]] as const) {
      const label = formatSemesterLabel(season, year);
      expect(label).toBe(`${season} ${year}`);
      expect(parseSemesterLabel(label)).toEqual({ season, year });
    }
  });

  it('rejects a label the picker could never have produced', () => {
    expect(parseSemesterLabel('Fall 2026')).toBeNull(); // not one of the three seasons
    expect(parseSemesterLabel('Winter 2026')).toBeNull();
    expect(parseSemesterLabel('F26')).toBeNull();
    expect(parseSemesterLabel('Spring 26')).toBeNull(); // year must be 4 digits
    expect(parseSemesterLabel('spring 2026')).toBeNull(); // case-sensitive — a real picker never lowercases
    expect(parseSemesterLabel('')).toBeNull();
  });

  it('tolerates surrounding whitespace on the way in, but never produces any on the way out', () => {
    expect(parseSemesterLabel('  Spring 2027  ')).toEqual({ season: 'Spring', year: 2027 });
  });
});

describe('currentSemesterSeason', () => {
  it('picks Spring for the first third of the year', () => {
    expect(currentSemesterSeason(new Date('2027-02-15'))).toBe('Spring');
  });

  it('picks Summer for the middle third', () => {
    expect(currentSemesterSeason(new Date('2027-06-15'))).toBe('Summer');
  });

  it('picks Autumn for the last third', () => {
    expect(currentSemesterSeason(new Date('2027-11-15'))).toBe('Autumn');
  });
});
