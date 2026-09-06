// Roster-aware matching at review/edit time (step.md step 12.10/12.11,
// plan.md §17). Pure, dependency-free — kept separate from roster.ts
// because that module owns *parsing* a workbook into a roster, while this
// one answers a different, live question asked on every keystroke: does
// this particular studentId belong to someone on the list, and if not, is
// there exactly one student it's plausibly a misread of?
import { normalizeIdForMatch, type ParsedRoster, type RosterStudent } from './roster';

// True only when `a` and `b` are the same length and differ at exactly
// one position — "one digit away," not "close enough." A fixed-length ID
// makes Hamming distance the right notion of "one digit away" rather than
// general edit distance (insertions/deletions don't apply to a field the
// recognizer always returns at a fixed width).
function hammingDistanceIsOne(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differences = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) differences += 1;
    if (differences > 1) return false;
  }
  return differences === 1;
}

// True when every non-'?' position in `pattern` agrees with `key` at the
// same position — the partial-read case, where both recognizers return
// '?' at a position they couldn't read (plan.md §10's "flag, never
// guess"). A pattern with no '?' at all still works here, but callers
// route that case through hammingDistanceIsOne instead — see
// suggestRosterCandidate.
function matchesWildcardPattern(pattern: string, key: string): boolean {
  if (pattern.length !== key.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '?' && pattern[i] !== key[i]) return false;
  }
  return true;
}

// A suggestion is offered ONLY when it is the unique explanation — never
// the closest of several, which would be a guess dressed up as a fact
// (rule 6: nothing is auto-corrected, and a suggestion that could
// plausibly be wrong is worse than no suggestion at all).
export function suggestRosterCandidate(
  studentId: string,
  idDigits: number,
  roster: ParsedRoster,
): RosterStudent | null {
  const trimmed = studentId.trim();
  if (trimmed.length !== idDigits) return null;

  if (trimmed.includes('?')) {
    if (!/^[0-9?]+$/.test(trimmed)) return null;
    const candidates = roster.students.filter((s) => matchesWildcardPattern(trimmed, s.studentIdKey));
    return candidates.length === 1 ? candidates[0] : null;
  }

  if (!/^\d+$/.test(trimmed)) return null;
  const candidates = roster.students.filter((s) => hammingDistanceIsOne(trimmed, s.studentIdKey));
  return candidates.length === 1 ? candidates[0] : null;
}

export type RosterMatch =
  | { status: 'no-roster' }
  | { status: 'blank' }
  | { status: 'matched'; student: RosterStudent }
  | { status: 'not-on-list'; suggestion: RosterStudent | null };

// The single entry point Review.tsx and Results.tsx both call, so the two
// screens can't drift on what "matched" or "not on the list" means (the
// same discipline that keeps validateMarks.ts's rules shared rather than
// each screen re-deriving its own).
export function matchAgainstRoster(
  studentId: string | null,
  idDigits: number,
  roster: ParsedRoster | null,
): RosterMatch {
  if (!roster) return { status: 'no-roster' };

  const trimmed = (studentId ?? '').trim();
  if (trimmed === '') return { status: 'blank' };

  // A partial read ("12?4567") never normalizes to a pure-digit key, so it
  // can never accidentally register as an exact match here — only a
  // fully-read ID can.
  const key = normalizeIdForMatch(trimmed, idDigits);
  const matched = key ? roster.students.find((s) => s.studentIdKey === key) : undefined;
  if (matched) return { status: 'matched', student: matched };

  return { status: 'not-on-list', suggestion: suggestRosterCandidate(trimmed, idDigits, roster) };
}
