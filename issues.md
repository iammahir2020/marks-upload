# Issues

Two audits, recorded together.

**Audit 1 (2026-08-27)** — `code-review` (backend + frontend, targeted
directly at `backend/` and `frontend/` since the default diff-based mode
misses everything untracked in this not-yet-fully-committed repo),
`security-review`, and a pass against `fastapi-templates`,
`frontend-patterns`, and `product-ui-design`. Findings 1–15 below.

**Audit 2 (2026-08-31)** — a full re-read of every source file in the repo
after steps 3r.6, 11.0–11.5 and the live AWS deploy landed. Two jobs: check
whether audit 1's findings still hold against the current code, and find
what the last four days of work introduced. Findings N1–N28 below, followed
by an explicit list of **what this audit did not cover** — several files
were not opened, and that section says which, so their absence from the
findings is not mistaken for a clean result.

**Audit 2b (2026-08-31)** — a follow-up pass over version-control and build
ignore hygiene (`.gitignore`, `frontend/.gitignore`,
`backend/.dockerignore`), checking what is *actually tracked* rather than
what the ignore files claim. Result: **the ignore files are in good shape**
— every secret, credential, cert, crop directory and multi-gigabyte build
artifact is correctly excluded and none is tracked, and the Docker build
context is 2.0 MB with nothing sensitive in it. The gaps are forward-looking
and small (**N26**, **N27**, **N28**).

One correction to an earlier draft of this file: it recorded the committed
`testset/` photo batch as a disclosure of real student data. Per the repo
owner, the IDs, serials and marks in those photos are **fabricated** — real
handwriting, made-up values. That finding was wrong and has been removed;
**N26** now covers only the forward-looking gap, which is that a real
pilot's outputs (an exported `.xlsx` above all) have nothing ignoring them
yet.

**Headline from audit 2, as written: none of audit 1's 15 findings had been
fixed.** All 15 reproduced against the code as it stood, three were *worse*
than when first written (1, 4, 6), and one had shifted shape (5). Both test
suites passed — 148 backend, 79 frontend — so every finding was in territory
the suites did not cover.

**Update 2026-08-31, frontend pass: 12 findings are now FIXED** — the ones
addressable by frontend changes alone (1, 2, 4, 5, 6, 11, N3, N5, N6, N7,
N19, N25). That clears 5 of the 7 audit-1 High items and all four broken
invariants. The frontend suite went 79 → 109 tests, each new case written as
the failure rather than the implementation; one existing assertion in
`Review.test.tsx` had to change, because it was pinning bug #2. Nothing in
the backend has been touched, so **N1 and N2 — the two verified,
publicly-reachable ones — are still open.**

The audit-1 "Security review — clean" verdict is **superseded**: N1 is a
HIGH, verified, arbitrary-file-write on a now-publicly-deployed endpoint.

Findings were verified by running the code, not taken on a tool's word.
Where a finding was proven by execution it says so.

---

## At a glance

44 findings: 43 from the two audits, plus N29 found while mapping backend
findings to their frontend counterparts. **37 fixed, 2 partly fixed, 1
accepted, 4 open.** Grouped by state rather than by number, so the
actionable set is the first thing on the page. Search the `#` to jump to a
finding's full entry in Part A or Part B below.

Three rounds of fixes on 2026-08-31:

1. **Frontend pass** — the 12 addressable without touching the backend,
   plus 4 doc/drift items. Cleared all four broken invariants.
2. **Pair pass** — the 11 whose fix spans both sides, done as pairs rather
   than one half at a time. Closed both HIGH findings, **N1** (path
   traversal) and **N2** (unbounded config).
3. **Hot-path / cnn-path passes** — **N4** and **N18** first (the two
   correctness risks live on the default path), then N16, N17, N24 and 15,
   which closes the `cnn` path entirely. N4 is the one worth reading: a blank ID cell was
   producing a *confident fabricated digit*, demonstrated rather than
   inferred.
4. **Dormant pass** — the 4 that only fire on `remote`/`both`, cleared
   *ahead of* step 3r.6's comparison run rather than after it. They looked
   lowest-priority and were not: that run **is** `RECOGNIZER=both`, so all
   four activate the moment it starts, and two of them damage it — **#3**
   by handicapping the very baseline it measures, **N9** by writing student
   IDs to disk during a real class.

What is left — **every open finding is now Low**:

- **4 are deploy/infra**, recognizer-independent — N11, N15, N22, N23.
- **0 touch the `cnn` path.** Every finding on the path the app actually
  runs is closed.
- **0 are frontend, 0 are dormant, and nothing High or Med-on-a-hot-path
  remains open anywhere.**

Suites: **246 backend, 119 frontend** — from 148/79 before the audits. They
passed then too, which is the point worth internalising rather than a
footnote.

### Open — deploy and infra (recognizer-independent)

| # | Finding | What's wrong | Sev |
|---|---|---|---|
| N11 | `preflight.sh` gaps | Does not probe `apigatewayv2`, so a correctly-scoped deploy user passes then fails mid-deploy; its read-only check runs `HARVEST_ENABLED=false`, which is not the deployed config. | Low |
| N15 | Test deps in the production image | `pytest` and `httpx` ship in the container, which excludes `tests/`. | Low |
| N22 | Deploy smoke test skips silently | Guarded by `if [ -f ]`, so a deploy whose only end-to-end check never ran looks identical to one that passed. | Low |
| N23 | Predictable `/tmp` path in `deploy.sh` | Distribution config written to and read from a fixed, guessable filename. | Low |

### Backend findings with a frontend counterpart

Several open backend findings are one half of a pair. Worth knowing before
picking any of them up, because the fix is either already half-done, or
lands somewhere other than where the symptom appears.

| Backend / infra | Frontend side | Relationship |
|---|---|---|
| **N2** unbounded `QuizConfig.max` | **N19** ✅ fixed — `MAX_ID_DIGITS` / `MAX_QUESTIONS` / `MAX_MARK_PER_QUESTION` | Two halves of one bound. The form can no longer *produce* a bad config; the endpoint still *accepts* one from any caller. Doing only the frontend half is what makes N2 feel fixed when it is not. |
| **#10** no `q`-order check | `validateConfig.ts` always builds `{q: i+1, max}` in order | The frontend **is** the only enforcement today. The finding's own words: "an unenforced convention, not a backend guarantee." |
| **#14** `totalMax` accepted, never read | `validateConfig` computes and sends it; Review and Results now validate Total against `config.totalMax` | The frontend depends on `totalMax` being meaningful, the backend ignores it — and the #4/N6 fix **deepened** that dependence. Fixing #14 means deciding which side owns the number. |
| **#7** blocked event loop | `scanQueue.ts` is built for parallel in-flight requests, but `Scan.tsx`'s capture spinner (2026-08-30) now serialises captures anyway | A frontend change masked the symptom. Fixing #7 buys little until captures can overlap again, so the two want doing together or not at all. |
| **N14** `/api/harvest` 500s on an S3 error | `harvestScan` swallows every error by design | The frontend's swallow is *why* backend silence matters: a misconfigured bucket stops collection with no signal anywhere. N14's fix is a log line, not an error the client should see. |
| **N8** crops bucket has no retention | `Setup.tsx`'s disclosure says cells are kept, but not for how long | Adding a retention period is only half the work; the always-visible disclosure line should then state the duration, or it becomes true-but-incomplete in the same way 11.5 already corrected once. |
| **N13** `ALLOWED_ORIGINS` never set | `VITE_API_BASE=""` (same origin, CloudFront routes `/api/*`) | N13 is harmless **only** because the frontend is same-origin, so CORS never runs. Split the origins later and it becomes live immediately. |
| **N21** serial never validated server-side | Nothing validates serial shape client-side either | Not a pair — a shared gap. `isCompleteId` was added for the student ID (N5); the serial got no equivalent on either side. |

**One deliberate asymmetry, so nobody "fixes" it:** the serial sent to
`/api/harvest` is the **raw** typed value (`"07"`), while the record saved to
IndexedDB is **normalized** (`"7"`, per #2). That is correct and load-bearing
in both directions — the harvested crop image shows two glyphs, so `"07"` is
the only label that matches the picture, while the index needs one key per
real serial. Normalizing the harvest label to match the record would
silently mislabel training data.

### Partly fixed

| # | Finding | Done / still open |
|---|---|---|
| N12 | Deploy policy carries dead grants | **Documented** in `aws/README.md` (Function URL + CloudFront Function statements are unused; `apigateway:*` on `/apis/*` is account-wide). **Not removed** — that edits a live IAM policy. |
| N26 | Real session output could be committed | **`.gitignore` done** (`*.xlsx`, `collection_sheet*.docx`, with the template negated). **Open:** the convention for whether a genuinely-real photo batch may ever live in the repo. |

### Accepted — no fix intended

| # | Finding | Why |
|---|---|---|
| 12 | Portrait rotation hardcoded | Re-checked: a wrong-direction rotation yields `table_not_found`, which is the one reason that triggers the 4-way retry, and `_label_column_is_backwards` catches the 180° case. Cost is wasted detection passes, not a wrong read. |

### Fixed 2026-08-31 — cnn-path pass

The last four on the default path. None was High; three were latent
properties rather than live faults, and the fourth (15) only bites the
debugging harnesses.

| # | Finding | Fix |
|---|---|---|
| N16 | Prod imported a dev harness for two floats | New `cnn/thresholds.py`, importing nothing. Pinned by a test that blocks `cnn.accuracy` and asserts `local.py` still imports. |
| N24 | Decimal presence checked, not position | `_digits_of` returns the glyph index. Exposed a wrong existing test that passed an index the real pipeline never produces. |
| 15 | Rotation artifacts contradicted the answer | Retries write to `out_dir/_attempt`, promoted only on a win; a winning result now names the real source rather than a deleted temp file. |
| N17 | Contradictory harvest labels | Reported by `fetch-crops.sh` at assembly time. Not fixed at write time on purpose — `Store` is one method by design and the filename is the label. Real corpus checked: 0 conflicts. |

### Fixed 2026-08-31 — hot-path pass

The two correctness risks that were live on the default `cnn` path.

| # | Finding | Fix |
|---|---|---|
| **N4** | ID cells classified even when blank | `has_ink()` gate before classification, calibrated on 168 filled / 7 blank real cells. Verified: the real blank grid returned a fabricated `4` without it, `???????` with it. Largest-component rather than total ink, after a test showed total ink let a speck past. |
| N18 | Undecodable crops crashed as a 500 | One `app/cells.py::read_cell()` at all five sites. `exists()` was never the check — these files are written by the same request. |

### Fixed 2026-08-31 — dormant pass

The four that only fire on `remote`/`both`, cleared **ahead of step 3r.6's
comparison run** rather than after it. They looked lowest-priority and were
not: the comparison run *is* `RECOGNIZER=both`, so all four activate the
moment it starts, and two of them damage it — #3 by handicapping the
baseline it measures, N9 by writing student IDs to disk during a real class.

| # | Finding | Fix |
|---|---|---|
| **3** | Fallback discarded correct digit reads | Accept `fallback_text` when it is already a digit, same confidence floor. New `test_id_ocr.py` stubs Tesseract so the acceptance logic is testable at all. |
| 9 | Composite/prompt desync | Tile-count check → `model_error`, not an assert: a missing crop is a data condition, not a broken invariant. |
| N9 | Student IDs written to disk | Logged as a difference (positions + counts), never the digits. Serial and marks still log values — plan.md §12's line. Write wrapped so it cannot fail a scan. |
| 13 | Client rebuilt per request | Lazy module-level singleton; construction moved inside the `try` so a bad key is a `model_error`. |

### Fixed 2026-08-31 — pair pass

The eleven whose fix spans both sides of the wire, done as pairs rather than
one half at a time. Backend suite 163 → 196.

| # | Finding | Fix, both halves |
|---|---|---|
| **N1** | Path traversal via `serial` | `_sanitize_value` inside `add()` (the one funnel every field passes through), **plus** a containment assert in `LocalStore.put` so the invariant does not depend on callers. Original exploit re-run and blocked. |
| **N2** | Unbounded `QuizConfig.max` | Pydantic bounds mirroring `validateConfig.ts`, **pinned by a test that parses the TypeScript** and fails if either side moves alone. |
| 7 | Blocked event loop | `run_in_threadpool` around detection and both recognizer calls, on both endpoints. |
| 8 | Malformed config → 500 | `_parse()` → `HTTPException(400)` naming the field; **N29** makes the message visible to the instructor. |
| 10 | No `q`-order check | `model_validator` requiring `[1..n]`, failing loudly rather than sorting into place. |
| 14 | `totalMax` never checked | `model_validator` requiring `totalMax == sum(q.max)` — the number the review screen already validates against. |
| N8 | No crop retention | S3 lifecycle at `CROPS_RETENTION_DAYS` (365), **and** `Setup.tsx` now states the period, tied together by comment. |
| N13 | `ALLOWED_ORIGINS` never set | `apply_allowed_origins` after cdn, **plus** `lambda_env()` so the env list exists once — `update-function-configuration` replaces rather than merges. |
| N14 | Harvest failures invisible | try/except + a `harvest_failed` log carrying exception type and truncated message only, never its repr. |
| N21 | Serial never validated | `marks.validate_serial` **and** `validateMarks.isValidSerial`, same rule, both sides. |
| N29 | 413/429 detail discarded | `describeFailure` reads `detail` and appends `Retry-After` seconds. |

### Fixed 2026-08-31 — frontend pass

Twelve addressable without touching the backend, plus four doc/drift items.
Each has a regression test written as the failure rather than the
implementation; the frontend suite went 79 → 119 across both passes.

| # | Finding | Fix |
|---|---|---|
| 1 | `Setup.tsx` crashed on non-integer input | Array resize guarded behind an integer + bounds check; kills both the `RangeError` and the ~10¹¹-push hang. |
| 2 | Leading-zero serial duplicates never surfaced | Normalized on write, queried normalized, **DB v3 migration** for records saved earlier. |
| 4 | Review's Total had no legal-value check | Shared `parseMarkField` — one rule, both edit screens. |
| 5 | Conflict panel could overwrite a stale record | Editing an identity field clears the pending conflict and re-enables Confirm. |
| 6 | Transport failures were a dead end | **Dismiss** action on `'error'` queue entries. |
| 11 | Preview blob URLs leaked all session | Ref-based unmount cleanup; per-entry release on retake/dismiss (*not* on save — Review re-fetches that URL to harvest). |
| N3 | One hung upload wedged the session | 60 s `AbortController` timeout on both endpoints, so a hang becomes a recoverable error. |
| N5 | `?`-bearing ID saved as confirmed | `isCompleteId` blocks Confirm on a partial ID; a *cleared* ID is still allowed. `unverifiedReason` reports `ID incomplete`. |
| N6 | Results' Total had no check either | Same `parseMarkField` helper. |
| N7 | Excel download could abort on iOS | Anchor attached before `click()`, revoked on a timer, filename sanitized. **Still needs a real-device check.** |
| N19 | `validateConfig` had no upper bounds | `MAX_ID_DIGITS`/`MAX_QUESTIONS`/`MAX_MARK_PER_QUESTION`. Client half of N2 only. |
| N25 | Redundant IndexedDB writes on blur | `isUnchanged()` early return. |
| N10 | `deploy.sh` comment contradicted the deploy | Rewritten for API Gateway; states plainly that the backend is not private. |
| N20 | Stale comments | `.gitignore`, `requirements.txt`, `both.py` — each says what it used to claim and why that was wrong. |
| N27 | Ignore-file gaps | Editor/OS patterns, `*.xlsx`, `collection_sheet*.docx`. Verified nothing previously tracked became newly ignored. |
| N28 | `.env.example` drift | 4 MB not 5; `VITE_API_BASE=""` not a Function URL. |


# Part A — audit 1's findings, revalidated 2026-08-31

## High priority — real bugs

### 1. `Setup.tsx` crashes on non-integer input

**Status: FIXED 2026-08-31.** `handleQuestionCountChange` keeps the typed value (so the field stays editable and `validateConfig` can report a real error) but guards the array resize behind `Number.isInteger(next) && next >= 1 && next <= MAX_QUESTIONS`. Both the `RangeError` and the ~10^11-push hang are gone; bounds added to `validateConfig` in the same pass (N19).

**Status: STILL VALID, and worse than originally described.**
**File:** [Setup.tsx:81-89](frontend/src/Setup.tsx#L81-L89) (`handleQuestionCountChange`)

Typing `5.5` into "Number of questions" runs `copy.length = Math.max(next, 0)`
with `next = 5.5`. Setting `array.length` to a non-integer throws
`RangeError: Invalid array length` — the Setup screen crashes before
`validateConfig` ever runs, on the very first screen of the app.

Verified by execution (2026-08-31): `5.5` and `NaN` both throw
`RangeError: Invalid array length`.

The newly-noticed half is the line above it:

```ts
while (copy.length < next) copy.push(5);
```

`<input type="number">` accepts `99999999999`, which makes this loop push
~10<sup>11</sup> elements before the `length` assignment is ever reached —
the tab hangs and then dies. There is no upper bound on this field anywhere
(see also N19).

**Fix direction:** guard against non-integer and out-of-range input before
mutating array length — `Number.isInteger(next) && next >= 1 && next <= 50`,
or reject and leave the previous count in place.

### 2. Duplicate cross-check misses leading-zero duplicates

**Status: FIXED 2026-08-31.** `saveRecord` normalizes the serial on write, `findRecordsBySerial` queries with the normalized value, and a **DB v3 migration** rewrites records saved before this so the index is not left half-normalized. `types.ts`'s "normalized: leading zeros stripped" comment is now true. Six tests in `db.test.ts`, including the v2→v3 migration; `Review.test.tsx`'s save assertion changed from `'07'` to `'7'` — it had been pinning the bug.

**Status: STILL VALID, unchanged.**
**Files:** [Review.tsx:130-133](frontend/src/Review.tsx#L130-L133) (`handleConfirm`), [db.ts:82-85](frontend/src/db.ts#L82-L85) (`findRecordsBySerial`)

`handleConfirm` still calls `findRecordsBySerial(candidate.serial)` with the
*raw, un-normalized* typed serial, and `findRecordsBySerial` still does an
exact-match `getAllFromIndex` lookup. `validateMarks.ts`'s `crossCheck` does
normalize via `normalizeSerial`, but only compares against whatever the DB
query already returned.

A record saved with serial `"007"` and a later rescan typed as `"7"` are
never compared — `findRecordsBySerial("7")` returns nothing, so the
duplicate saves silently. Directly contradicts CLAUDE.md's stated invariant
"Serial comparison strips leading zeros."

Note the `StudentRecord.serial` doc comment in
[types.ts:23](frontend/src/types.ts#L23) already claims serials are stored
"normalized: leading zeros stripped" — nothing in the write path does that.
The comment describes the fix, not the code.

**Fix direction:** normalize before the serial is used as an index key —
store records with normalized serials (which would also make the type
comment true), or query with the normalized value.

### 3. ID-OCR fallback never accepts a digit read correctly by the fallback pass

**Status: FIXED 2026-08-31 (dormant pass).** The fallback branch now accepts `fallback_text` when it is already a digit (`in WHITELIST`) as well as when it maps through `DIGIT_LOOKALIKES`, under the same `FALLBACK_CONFIDENCE_FLOOR` — so it widens what is *accepted*, never how confident it must be. New `tests/test_id_ocr.py` stubs `_best_candidate` so the acceptance logic is testable without a Tesseract binary, and covers both the digit case and the original measured look-alike cases (`D`→0, `l`→1). **Fixed before the comparison run, deliberately**: left in place it would have depressed Tesseract's measured baseline in the very measurement meant to validate the CNN default.

**Status: STILL VALID. Impact reduced — `remote` path only.**
**File:** [id_ocr.py:116-126](backend/app/id_ocr.py#L116-L126) (`read_digit`)

The unconstrained fallback pass still only accepts a result if
`fallback_text in DIGIT_LOOKALIKES`, and `DIGIT_LOOKALIKES`'s keys are all
*letters*. A fallback pass that reads a crop correctly *as the actual digit*
fails that check and falls through to `return None`, discarding a
confidently-correct read as `?`.

Since step 3r.6e made `cnn` the default, this only fires under
`RECOGNIZER=remote` / `=both` — which is exactly the configuration a
comparison run would use, so it would depress Tesseract's measured baseline
in the very comparison the CNN default is meant to be validated against.

**Fix direction:** also accept `fallback_text` when it is already a digit
(`fallback_text in WHITELIST`), same confidence floor either way.

### 4. Review screen's Total field has no legal-value check

**Status: FIXED 2026-08-31.** A shared `parseMarkField(raw, max)` in `validateMarks.ts` is now the single parse rule for every editable mark-or-total field, used by Review and Results alike. Total is checked against `config.totalMax`, shows an inline error, and blocks Confirm.

**Status: STILL VALID, and now present in a second location.**
**File:** [Review.tsx:51-69](frontend/src/Review.tsx#L51-L69) (`markErrors`, `total`)

`markErrors` still iterates only `config.questions`. The Total input is a
plain text input with no `type`, so `"abc"` is typeable; `total =
Number("abc")` is `NaN`; `hasMarkErrors` stays false so Confirm is enabled;
and `commitSave` writes `StudentRecord.total = NaN` as a `confirmed: true`
record. IndexedDB uses structured clone, which preserves `NaN` faithfully —
it is genuinely stored, not coerced to null.

New in audit 2: the same gap exists on the Results screen's inline editor —
see **N6**.

**Fix direction:** apply the same legal-value/finite check to Total that
each question already gets, in both components.

### 5. Conflict Overwrite/Save-anyway can target a stale record

**Status: FIXED 2026-08-31.** Editing either identity field clears `pendingConflict` (and the save error) via a small `editIdentity` helper, which re-enables Confirm so the check re-runs against the corrected values. Marks edits deliberately do not clear it — they cannot change which record matched. Regression test saves an earlier record, provokes the warn, corrects the serial, and asserts the earlier record is untouched.

**Status: PARTLY VALID — the shape has shifted, the bug remains.**
**File:** [Review.tsx:250-287](frontend/src/Review.tsx#L250-L287)

The *values* written are no longer stale: `candidateForConflict`
([Review.tsx:153](frontend/src/Review.tsx#L153)) is recomputed every render
from current `studentId`/`serial`. But the *target* still is —
`pendingConflict.conflicts[0].record.id` is the snapshot taken before any
edit — and Confirm is still disabled while `pendingConflict` is set
([Review.tsx:302](frontend/src/Review.tsx#L302)), so there is no way to
re-run `crossCheck` against corrected values.

The live failure: the instructor sees a conflict, realizes the serial was
misread, corrects it so it no longer conflicts — and "Overwrite earlier
record" now writes the corrected record on top of an unrelated student's
saved record.

**Fix direction:** clear `pendingConflict` on any identity-field edit, so
Confirm must be pressed again for a fresh check.

### 6. Network-level scan failures are a dead end

**Status: FIXED 2026-08-31.** `'error'` entries now render a **Dismiss** button, which retires the entry and releases its preview blob through the same `dismissEntry` helper Retake uses. Paired with N3's timeout, since a dismiss is useless while the request is still notionally pending.

**Status: STILL VALID, and now session-blocking.**
**File:** [Scan.tsx:252-278](frontend/src/Scan.tsx#L252-L278)

An `'error'` entry still renders only static `Failed: {entry.error}` text.
The Review/Retake button block at line 270 is still gated on
`entry.status === 'done'`, so a transport-layer failure has no Retake, no
Review, and no recovery action anywhere.

Worse since the 2026-08-30 capture-button change: see **N3** — a request
that never settles at all now disables the capture button permanently.

**Fix direction:** give `'error'` entries a retry/dismiss action, at minimum
one that removes the entry so the instructor can capture again.

### 7. `POST /api/scan` blocks the event loop

**Status: FIXED 2026-08-31 (pair pass).** Detection, `read_id` and `read_marks` all go through `starlette.concurrency.run_in_threadpool`, as does the harvest endpoint's detection and harvesting. The route stays `async def` because `await image.read()` genuinely is async and the stages need to stay individually timed. Note the frontend counterpart: `Scan.tsx`'s capture spinner now serialises captures anyway, so the immediate win is that harvest and scan no longer block each other, and that a second client is not stuck behind the first.

**Status: STILL VALID, unchanged, and now matters more.**
**File:** [main.py:195-270](backend/app/main.py#L195-L270) (`async def scan`)

Detection (OpenCV), the ONNX inference session, and — on the remote path —
Tesseract and the Gemini SDK all still run synchronously inside the
`async def` handler. The only `await` is `await image.read()`.

This defeats `scanQueue.ts`'s own design ("multiple captures can be pending
at once"), and it now also interacts with the deployed shape: API Gateway's
30 s hard timeout means a second request queued behind a first request's
full detect+recognize cycle is materially closer to timing out than it was
on the laptop.

**Fix direction:** `starlette.concurrency.run_in_threadpool` around the
pipeline, or make the route a plain `def` so FastAPI thread-pools it
automatically.

---

## Medium priority

### 8. Malformed config JSON causes an unhandled 500

**Status: FIXED 2026-08-31 (pair pass).** All four `model_validate_json` calls go through `_parse()`, which raises `HTTPException(400)` naming the offending field. This mattered more once QuizConfig gained real rules — every new bound and both cross-field checks reject through this path, and "your quiz config is wrong" is a client error with a fixable cause. Paired with **N29**, so the message actually reaches the instructor instead of becoming `HTTP 400`.

**Status: STILL VALID, and the surface has grown.**
**File:** [main.py:202](backend/app/main.py#L202)

`QuizConfig.model_validate_json(config)` is still unguarded. `/api/harvest`
has since added **three more** unguarded parses on the same public surface
([main.py:295-297](backend/app/main.py#L295-L297)): `config`, `original`,
and `confirmed`. A raw `pydantic.ValidationError` inside a route body has no
default handler, so all four surface as a generic 500.

There is no test covering a malformed config on either endpoint.

**Fix direction:** parse inside try/except and raise `HTTPException(400)`.

### 9. A missing mark crop can desync the composite from the prompt

**Status: FIXED 2026-08-31 (dormant pass).** `build_composite` checks `len(sources) == questions + 2` (serial + one per question + total) and returns `(None, [])` on a mismatch, which `recognize` already maps to `model_error`. Returning rather than asserting is deliberate: the ID-exclusion `assert` above it guards an invariant that must never be false, while a missing crop is a data condition that legitimately can occur, and this project's answer to that is a retakeable failed scan, not a 500.

**Status: STILL VALID, unchanged.**
**File:** [marks.py:56-109](backend/app/marks.py#L56-L109) (`build_composite`)

Tiles are appended only `if crop_path.exists()`, while `build_prompt`
unconditionally describes all N questions. Gemini can return a legal-looking
value for a tile it was never shown, and `validate_payload` cannot detect
that — it only range-checks. Unlike the ID-exclusion guarantee, which has an
explicit `assert` two lines above, nothing catches this.

**Fix direction:** assert `len(labels) == len(question_maxes) + 2` (serial +
questions + total) before the call, rather than silently proceeding with a
mismatched composite/prompt pair.

### 10. No backend check that questions are in `q`-order

**Status: FIXED 2026-08-31 (pair pass).** A `model_validator` requires `[q.q ...] == [1..n]`. Fails loudly rather than sorting into place: a caller who sent them out of order has a different idea of the mapping than we do, and quietly picking ours is how Q4's mark lands in the Q3 column.

**Status: STILL VALID, unchanged.**
**File:** [main.py:241](backend/app/main.py#L241), [main.py:251-254](backend/app/main.py#L251-L254)

`question_maxes` is derived from `quiz.questions`' array order, and results
are re-labelled `q=i+1` — with nothing checking the two agree. Out-of-order
`q` values silently mislabel marks to the wrong question, each still passing
its own legal-value check against the wrong question's legal set. Only
`validateConfig.ts` prevents it today, which is a frontend convention on a
public endpoint.

**Fix direction:** validate that `[q.q for q in quiz.questions] == list(range(1, n+1))`
in the `QuizConfig` model, and fail loudly if not.

### 11. Preview blob URLs leak for the whole session

**Status: FIXED 2026-08-31.** The unmount cleanup reads `previews` through a ref rather than a mount-time closure, so it actually revokes; `releasePreview(id)` additionally frees a single entry the moment it is retaken or dismissed. Deliberately **not** called on save: `Review.commitSave` re-fetches that same blob URL to harvest *after* `onSaved` returns, so revoking there would silently break training-data collection.

**Status: STILL VALID, unchanged.**
**File:** [Scan.tsx:67-72](frontend/src/Scan.tsx#L67-L72)

The cleanup effect still has an empty dependency array with an
`eslint-disable` on it, so the closure captures `previews` as `{}` at mount
and revokes nothing — not even on unmount. No other `revokeObjectURL` exists
in the file. Every captured full-resolution JPEG accumulates for the whole
session, including ones discarded by Retake.

**Fix direction:** hold `previews` in a ref that the unmount cleanup reads,
and revoke an individual entry's URL when its scan is saved or dismissed.

### 12. Portrait-rotation direction is hardcoded from one device

**Status: STILL VALID, low impact — the backend net does appear to cover it.**
**File:** [Scan.tsx:128](frontend/src/Scan.tsx#L128)

`ctx.rotate(-Math.PI / 2)` is still hardcoded with a comment saying it
"matches this device's actual capture orientation."

On re-reading `detect_any_orientation`, the net does hold for this case: a
wrong-direction rotation produces `table_not_found` (not
`column_count_mismatch`), which is the one reason that triggers the 4-way
retry, and `_label_column_is_backwards` rejects the 180° false positive.
So the cost is four wasted detection passes per capture, not a wrong read.

**Fix direction:** none required. Leave as a known device-specific constant.

---

## Low priority

### 13. `genai.Client()` re-created every request

**Status: FIXED 2026-08-31 (dormant pass).** A lazily-built module-level singleton (`_get_client`). Lazy rather than at import because `marks.py` is imported on the CNN path too, where there is no API key and constructing one would fail. Construction also moved inside the `try`, so a missing or rejected key is now a `model_error` the instructor can act on rather than a 500.

**Status: STILL VALID, unchanged.** [marks.py:208](backend/app/marks.py#L208)

`remote` path only, so no longer on the default hot path.

### 14. `QuizConfig.totalMax` accepted but never checked

**Status: FIXED 2026-08-31 (pair pass).** A `model_validator` requires `totalMax == sum(q.max)`. This was the sharper half of a pair: the **review screen validates its Total field against `config.totalMax`** while the backend recomputes `sum(question_maxes)` — two numbers that must agree, with nothing checking they did, and the #4/N6 fix having just deepened the client's reliance on the first. If a "best 4 of 5" scheme ever arrives, this validator is the assumption to revisit deliberately.

**Status: STILL VALID, unchanged.** [models.py:35](backend/app/models.py#L35)

`totalMax` is required in every request and read nowhere in the backend;
`marks.py` and `local.py` both independently recompute `sum(question_maxes)`.
A `totalMax` disagreeing with the real sum goes unnoticed.

### 15. Failed-rotation debug artifacts reflect the wrong orientation

**Status: FIXED 2026-08-31 (cnn-path pass).** Each retry now writes into `out_dir/_attempt`, promoted into `out_dir` only when it wins, so a total failure leaves the 0° artifacts that match the returned reason. The second-order bug went with it: a winning attempt's `result["image"]` pointed at a temp file that had already been unlinked, and now names the real source. Two regression tests — one asserting the on-disk `result.json` agrees with the returned dict after a total failure, one asserting a promoted attempt puts its cells exactly where `main.py` looks.

**Status: STILL VALID, unchanged.** [detection.py:568-577](backend/app/detection.py#L568-L577)

All four rotation attempts still reuse the same `out_dir`, so after a total
failure the on-disk `overlay.jpg`/`result.json` reflect the 270° attempt
while the returned `failure_reason` is the 0° one. Still low-impact in the
app (`TemporaryDirectory`), still a real trap for `batch_detect.py`.

Second-order, noticed in audit 2: on a *successful* rotated attempt the
returned dict's `"image"` key points at `_rotation_attempt.jpg`, which is
unlinked immediately afterwards.

---

## Security review (audit 1) — SUPERSEDED

The 2026-08-27 verdict of "no HIGH/MEDIUM findings" was accurate for the
code as it stood. It no longer is: `/api/harvest` did not exist in its
current form, there was no public deployment, and the reviewed surface
took no client-controlled strings into file paths. See **N1** and **N2**.

What audit 1 checked and audit 2 re-confirmed as still clean: API-key
sourcing (`GEMINI_API_KEY` via env only, never in a response body), the CORS
regex (localhost + private LAN ranges, no `allow_credentials`), and
Tesseract config strings (built from hardcoded constants, never user input).

## Design (`product-ui-design`) — ✅ fixed (2026-08-29)

Unchanged from audit 1, and re-verified: `index.css` is a real token system
with two-layer tinted shadows and the petrol-teal accent, `scan-tells.py`
passes clean. See CLAUDE.md's "Frontend design system".

---

# Part B — new findings (audit 2, 2026-08-31)

## HIGH

### N1. Path traversal in `/api/harvest`: a crafted `serial` writes files outside the harvest root

**Status: FIXED 2026-08-31 (pair pass).** Two layers. `harvest.py` gained `_sanitize_value`, applied inside `add()` — the one place every field funnels through, so no field added later can forget it, which is exactly how `value` was missed when `source` was guarded. And `LocalStore.put` now asserts `dest.resolve()` is under the root, because *no crop is written outside the root* is the property that matters and it should not depend on every caller escaping correctly. The original exploit was re-run and no longer escapes. The value rule is a **shape**, not an alphabet: a first attempt at `^[0-9.?]{1,8}$` let `".."` through (`.` has to be legal for a half mark) — inert, since `_key` renders it as a filename, but a nonsense label in the corpus. Caught by a parametrised test, not by inspection.

**Files:** [harvest.py:63-86](backend/app/harvest.py#L63-L86) (`_key`), [harvest.py:166-168](backend/app/harvest.py#L166-L168), [stores.py:58-66](backend/app/stores.py#L58-L66) (`LocalStore.put`)

`_key` interpolates the **confirmed field value** straight into the storage
key:

```python
return f"{source}/{field}/{tag}/{value}_{digest}.png"
```

`source` is sanitized by `_sanitize_source` — whose docstring says exactly
why: *"`/api/harvest` is a public endpoint and this arrives in a form field
— a `../..` here would otherwise escape the harvest root."* That reasoning
applies verbatim to `value`, which is **not** sanitized. `HarvestFields.serial`
is an unconstrained `str | None` straight off the wire, and `LocalStore.put`
does `dest = self.root / key` then `mkdir(parents=True)` + `copyfile`.

Verified by execution (2026-08-31):

```
harvest(..., confirmed_serial="../../../../escaped/PWNED", store=LocalStore(root))
→ escaped/PWNED_73bf48fb3c46eb87f38779f251eb6cfc.png     # written OUTSIDE root
→ harvested/                                              # empty
```

The written bytes are a cell crop of the caller's own uploaded image, so the
content is effectively attacker-chosen too.

The near-miss that makes this worth calling out: `test_harvest.py` contains
`test_a_hostile_source_cannot_escape_the_harvest_root` — the exact threat
was anticipated, tested, and fixed for one field, and the adjacent field on
the same request was missed. The passing test reads as coverage of the
class of bug when it covers one instance of it.

Blast radius by backend:
- **`local` (the laptop default, and the Docker default):** arbitrary file
  write anywhere the process can write. HIGH.
- **`s3` (the deployed config):** no traversal — S3 keys are literal — but
  arbitrary key prefixes inside the bucket, which corrupts the
  `<source>/<field>/<tag>/` layout `fetch-crops.sh` and the held-out-writer
  evaluation both depend on. MEDIUM.

**Fix direction:** sanitize `value` the same way `source` already is, inside
`_key` so no future field can forget it — and additionally assert in
`LocalStore.put` that `dest.resolve()` is under `self.root.resolve()`, since
that is the invariant that actually matters and it should not depend on
every caller getting its own escaping right.

### N2. Unbounded `max` in `QuizConfig` → memory exhaustion on the public endpoint

**Status: FIXED 2026-08-31 (pair pass).** `QuestionConfig.max` is `Field(gt=0, le=100)`, `idDigits` `ge=1, le=15`, `questions` `min_length=1, max_length=30`, `quizName` `max_length=200`. **The numbers are pinned across languages**: `tests/test_models.py` reads `frontend/src/validateConfig.ts`, parses its `export const` values and asserts they equal the Python ones — verified to fail when only one side is changed. That is the actual fix for the drift risk N19 created by adding a second copy.

**Files:** [models.py:26-36](backend/app/models.py#L26-L36), [marks.py:46-49](backend/app/marks.py#L46-L49) (`legal_values`)

`QuestionConfig.max` is a bare `float` with no bound, and `legal_values`
materializes a set with `2 * max + 1` elements:

```python
def legal_values(max_mark: float) -> set[float]:
    steps = round(max_mark * 2)
    return {i / 2 for i in range(steps + 1)}
```

Verified by execution (2026-08-31): the model accepts
`{"idDigits": 100000, "questions": [{"q": 1, "max": 1e9}]}` without
complaint; `legal_values(500_000)` already allocates ~32 MB in 0.22 s, and
scales linearly — `max=1e9` is 2 billion elements, tens of GB.

Reachability: detection runs first, so this needs a photo whose column count
matches the declared question count — but that is a five-column grid photo,
and the app is publicly deployed with the template's own layout documented.
`CNNRecognizer.read_marks` then calls `legal_values(max_mark)` per question
plus `legal_values(sum(...))` for the total. The Lambda has 2048 MB; it
OOM-kills. No auth stands in front of this, and the rate limiter keys on the
attacker-controlled `X-Forwarded-For`.

A smaller sibling on the same model: `idDigits` is unbounded too (drives a
loop of `Path.exists()` calls), and the `config` form field itself has no
size cap — `_reject_oversized` measures only `image_bytes`, so a
chunked-encoding request with no `Content-Length` bypasses the middleware
check and can carry an arbitrarily large `config` string into memory.

**Fix direction:** bound the model — `idDigits: int = Field(ge=1, le=15)`,
`max: float = Field(gt=0, le=100)`, `questions: list[...] = Field(min_length=1, max_length=30)`.
These are quiz-grid facts, not arbitrary limits; the template physically
cannot hold more.

---

## MEDIUM

### N26. Nothing stops a real session's output from being committed

**Status: PARTLY FIXED 2026-08-31.** The `.gitignore` half is done (see
N27). Still open: the convention for whether a genuinely-real photo batch
may ever live in the repo — now written into CLAUDE.md's "Things to avoid",
so the question is settled before the data exists.

**Files:** [.gitignore](.gitignore), [Results.tsx:77-87](frontend/src/Results.tsx#L77-L87), [generate_collection_sheet.py](backend/generate_collection_sheet.py)

**Scope note (corrected 2026-08-31, per the repo owner):** the committed
testset — `testset/images/real_class_*.jpeg`, `phone_*.jpg`,
`real_class_info.json`, `labels.json` — carries **fabricated** IDs, serials
and marks. They are real photographs of real handwriting, which is what
makes them useful for detection and CNN accuracy work, but the identifying
values in them are made up. There is no disclosure, nothing to purge from
history, and nothing to check on GitHub. An earlier draft of this file
recorded that as a HIGH finding; it was wrong and has been removed.

What survives is forward-looking, and it is a real gap: **the pilot has not
run yet, and when it does, its outputs will contain genuine student data
that nothing currently keeps out of git.**

Three artifacts, in descending order of risk:

1. **The exported workbook.** `handleExport` downloads
   `${quizName}.xlsx` — every student's ID, serial and marks for a whole
   class, in one file. The browser puts it wherever downloads go, and if
   that is ever inside this tree (or it gets moved here to check against the
   attendance sheet, which is exactly what the Results screen tells the
   instructor to do), **nothing ignores it.** There is no `*.xlsx` pattern
   anywhere. This is the single most concentrated piece of real student data
   the app will ever produce.
2. **Filled-in collection sheets.** `generate_collection_sheet.py` writes to
   the repo root by default (`--out ../collection_sheet.docx`). The blank
   one is harmless; the photographed, filled-in ones are handwriting samples
   from named people, and neither the `.docx` nor any scan of it is ignored.
3. **Real photographs from an actual class.** The current batch is fine, but
   the next batch may not be, and the naming convention (`real_class_*`)
   gives no signal either way — a future `real_class_19.jpeg` with genuine
   values would be committed exactly as easily as the fabricated ones were.

The rest of the pipeline already takes this seriously —
`backend/training_data/harvested/` is ignored with the comment *"real
student/instructor handwriting — neither belongs in git"*, and
`comparison_log/` alongside it. The gap is that both of those are files
*the backend* writes, and all three above are files a *person* ends up
holding.

**Fix direction:** add `*.xlsx`, `*.docx` (with a `!marks-grid-template.docx`
negation, since that one is a real deliverable) and `collection_sheet*` to
`.gitignore` before the pilot runs — see **N27**, which is the same change.
Separately, decide the convention now for whether a genuinely-real photo
batch is ever allowed in the repo, and write it into CLAUDE.md next to the
existing harvested-crops rule, so the question is settled before the data
exists rather than after.

### N3. A single hung upload disables the capture button for the rest of the session

**Status: FIXED 2026-08-31.** Both `/api/scan` and `/api/harvest` go through `postWithTimeout`, a 60 s `AbortController` (not `AbortSignal.timeout`, which jsdom and older browsers lack). A hung request now becomes an `'error'` entry with a readable message, which drops `inFlightCount` to 0 and re-enables capture. Pinned by a `scanQueue.test.ts` case.

**Files:** [Scan.tsx:170](frontend/src/Scan.tsx#L170), [Scan.tsx:229-234](frontend/src/Scan.tsx#L229-L234), [scanQueue.ts:33-35](frontend/src/scanQueue.ts#L33-L35), [api.ts:51-54](frontend/src/api.ts#L51-L54)

The 2026-08-30 capture-button change made `disabled={!!cameraError || capturing}`
with `capturing = inFlightCount(entries) > 0`, and `inFlightCount` counts
entries whose status is still `'pending'`. An entry leaves `'pending'` only
when its `fetch` settles.

`scanImage` has no `AbortSignal` and no timeout. A request that never
settles — a dropped wifi association mid-upload is the common one, and the
phone-on-LAN setup makes it likely — leaves one entry `'pending'` forever,
which means `capturing` stays `true` forever, which means **the capture
button is disabled for the rest of the session with no way to recover but a
page reload.**

Before the spinner change this was survivable (captures ran in parallel;
a stuck one was just a stuck row). CLAUDE.md records the throughput
trade-off that change made but not this one. It is the sharpest current
violation of "a bad photo must never block the session," because it blocks
*every* subsequent photo, and it compounds finding 6 (the stuck entry also
has no dismiss action).

**Fix direction:** `AbortSignal.timeout(60_000)` on both fetches in
`api.ts`, so a wedged request becomes an `'error'` entry — and give
`'error'` entries a dismiss action (finding 6) so the queue can drain.

### N4. The ID path has no blank-cell guard; the marks path does

**Status: FIXED 2026-08-31 (hot-path pass).** `cnn/preprocess.py` gained `has_ink()`, called by `CNNRecognizer.read_id` before any classification; a blank cell now yields `?` plus a flag, exactly like a missing crop.

**The bug was demonstrated, not just reasoned about.** Running the real blank grid (`empty_file.jpeg`) through `read_id` with the gate bypassed returns `??????4` — a fabricated `4` from pure paper noise, clearing *both* the 0.75 confidence floor and the 0.6 margin floor. With the gate: `???????`.

Calibrated over every ID cell in `testset/labels.json` that detection reads — FILLED n=168 (min 0.00163), BLANK n=7 (max 0.00041) — and the floor put at 0.0015, misclassifying nothing either way. Two design points worth keeping: it measures the **largest connected component**, not total ink, because a total-ink measure separated the real data perfectly and *still* let a speck through (a test caught that, not inspection); and `MIN_GLYPH_AREA_FRAC` is deliberately its own constant despite equalling `segment.py`'s `NOISE_AREA_FRAC`, so tuning segmentation cannot silently move the ID's blank gate — the same reasoning `detection.py` already records for `LABEL_COLUMN_NOISE_AREA_FRAC`.

**`cnn/accuracy.py` was updated to run the same gate**, since a harness that evaluates a different code path than production is how a measurement stops meaning what its number says. All numbers unchanged: 91.8% per-digit, 55.2% whole-ID, 1 confidently wrong.

**Files:** [local.py:65-91](backend/app/recognizers/local.py#L65-L91) (`read_id`), [preprocess.py](backend/cnn/preprocess.py) (`_to_canvas`), versus [segment.py:151-152](backend/cnn/segment.py#L151-L152)

`segment_cell` guards blanks explicitly and returns `[]`, with a comment
citing plan.md §16: *"A classifier always outputs something; feed it a blank
cell and it returns a confident wrong digit."* `_decode_serial_cell` and
`_decode_value_cell` both check that result and return `None`.

`read_id` has no equivalent. A blank or near-blank ID cell goes straight
into `preprocess_for_cnn` → `_to_canvas`, where an Otsu threshold on
near-uniform paper produces an arbitrary binarization (Otsu always splits,
even a unimodal histogram), and the resulting canvas is classified. The only
thing standing between that and a fabricated digit is
`CONFIDENCE_FLOOR`/`MARGIN_FLOOR` — floors calibrated in
`cnn/accuracy.py` against **real handwritten digits**, never against blank
input, and deliberately loosened to 0.75/0.6 on 2026-08-30.

`_to_canvas` also returns an all-zero 28×28 canvas when it finds no ink at
all, which is then fed to the model rather than short-circuited.

This matters specifically because the ID is the field with no arithmetic
check behind it — `id_ocr.py`'s own docstring makes that point — so a
fabricated ID digit has nothing downstream to catch it.

**Fix direction:** apply `segment_cell`'s own ink-fraction floor to the ID
cell before classification, and return `?` + flag for a blank. Also return
`None` from `_to_canvas` rather than an all-zero canvas, so callers cannot
classify emptiness.

### N5. A student ID containing `?` saves as a confirmed record and exports to Excel

**Status: FIXED 2026-08-31.** `isCompleteId(studentId, idDigits)` in `validateMarks.ts`; Review blocks Confirm on a partial ID with a message naming the required length, while still allowing a **cleared** ID (an absent ID is a legitimate unverified save — plan.md §10 — a partial one is not). `unverifiedReason` takes an optional `idDigits` and reports `'ID incomplete'`, so older records already carrying a `?` are surfaced in the Results count rather than passing as verified.

**Files:** [Review.tsx:39](frontend/src/Review.tsx#L39), [Review.tsx:119-149](frontend/src/Review.tsx#L119-L149), [Results.tsx:63-75](frontend/src/Results.tsx#L63-L75)

Both recognizers return `?` for an unreadable ID position, by design and by
contract ("an unreadable position becomes `?`, never a silently-dropped
digit"). The review screen pre-fills that string into the Student ID input
and flags the field visually — but nothing blocks Confirm on it.

`handleConfirm` checks only that at least one identity field is non-empty.
So `"12?4567"` is saved as `confirmed: true`, `unverifiedReason` returns
`null` (both fields present, so no badge), and it lands in the exported
Excel as a literal `12?4567`. Nothing downstream — sum check, cross-check,
the unverified count — treats it as incomplete.

More broadly there is no structural validation of `studentId` anywhere: not
length against `config.idDigits`, not digits-only, on either the Review or
the Results screen.

**Fix direction:** treat an ID that is not exactly `idDigits` digits as
blocking on Confirm (with the usual "enter manually" escape), and count it
in `unverifiedReason` if it does get saved.

### N6. The Results screen's inline Total edit has no legal-value check

**Status: FIXED 2026-08-31.** Same `parseMarkField` helper as #4 — one rule, two screens, which is what stopped them drifting apart again. `commit()` refuses and explains rather than persisting `NaN`.

**File:** [Results.tsx:201](frontend/src/Results.tsx#L201), [Results.tsx:218-234](frontend/src/Results.tsx#L218-L234) (`commit`)

Same class as finding 4, second location. `commit()` checks `hasMarkErrors`
(questions only) and the both-identity-fields-empty case, then writes
`total = Number(totalStr)` unvalidated. Typing anything non-numeric into the
Total cell and tabbing away persists `NaN` onto an existing record — and
this screen is the last one before export, where a bad value has nothing
after it to catch it.

**Fix direction:** the same finite + legal-value check as the question
cells, sharing one helper with `Review.tsx`.

### N7. The Excel download can be aborted on the target device

**Status: FIXED 2026-08-31.** The anchor is appended to the document before `click()` and removed with the object URL revoked on a 30 s timer instead of synchronously. Filename is sanitized through `exportFilename()`, so a quiz named `CSE211L/Q1` no longer produces a path-bearing download name. **Still needs verification on a real iOS device** — jsdom cannot test this, which is exactly why it was missed.

**File:** [Results.tsx:77-87](frontend/src/Results.tsx#L77-L87) (`handleExport`)

```ts
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url; a.download = `${config.quizName || 'quiz'}.xlsx`;
a.click();
URL.revokeObjectURL(url);
```

Two known problems, both specific to the device this app is used on:

1. `revokeObjectURL` fires synchronously in the same tick as `click()`. The
   download itself is asynchronous; revoking the URL before the browser has
   read from it is a documented way to get a silently-failed download,
   particularly on iOS Safari. The fix is a `setTimeout(..., 0)` or a
   `requestAnimationFrame`.
2. The anchor is never appended to the DOM. `click()` on a detached anchor
   is a no-op in some browsers, and iOS Safari handles `download` on blob
   URLs inconsistently regardless.

This is the one operation the whole application exists to perform, on the
one screen reached once per class, at the moment the instructor most needs
it to work — and it is the piece least covered by tests (jsdom's "Not
implemented: navigation to another Document" warning in the current vitest
run is this code path).

Also minor, same function: `quizName` is used unescaped as a filename, so a
quiz named `CSE211L/Q1` produces an invalid or path-bearing download name.

**Fix direction:** append the anchor, click, remove it, and revoke on a
timeout. Sanitize the filename. Verify by hand on the actual phone — this
is not testable in jsdom.

### N8. Harvested crops have no retention policy, while the logs do

**Status: FIXED 2026-08-31 (pair pass).** `deploy.sh` applies an S3 lifecycle rule expiring the crops bucket at `CROPS_RETENTION_DAYS` (default 365), re-applied every run rather than only at creation. **And the frontend half**, which is what makes it honest: `Setup.tsx`'s disclosure now states the period in both the collapsible section and the always-visible line, with a comment tying it to `CROPS_RETENTION_DAYS` so the two move together — the same failure mode 11.5 already caught once.

**File:** [deploy.sh:66-74](deploy.sh#L66-L74), [deploy.sh:141-150](deploy.sh#L141-L150)

`deploy.sh` sets a 30-day retention on the CloudWatch log group with an
explicit comment — *"New log groups default to Never expire, which is a slow
privacy leak as much as a cost one"* — and that reasoning is correct.

The crops bucket, which holds the actual student handwriting this project
takes considerable care to keep unlinkable, gets `put-public-access-block`
and nothing else. No lifecycle rule, no expiration, no versioning-noncurrent
cleanup. The data with real privacy weight has weaker retention than the
data deliberately scrubbed of it.

That is an inconsistency rather than a vulnerability, but it is the kind
this project has otherwise been rigorous about, and it grows monotonically
for as long as the demo is up.

**Fix direction:** add an S3 lifecycle rule with an expiration matched to
how long the crops are actually useful for fine-tuning, and state that
duration in `Setup.tsx`'s disclosure so the claim there stays complete.

### N9. `RECOGNIZER=both` writes full student IDs to disk, in scan order

**Status: FIXED 2026-08-31 (dormant pass).** The ID is logged as a **difference, not a value**: `differing_positions`, `differing_count` and the two lengths. That keeps everything a comparison run actually needs — whether they disagreed, where, how often, whether it clusters — without the digits. Serial and marks still log their values in full, deliberately: they identify nobody without the instructor's attendance sheet and have already gone to Gemini on this path, which is the line plan.md §12 draws. The write is also wrapped in `try/except OSError`, since `COMPARISON_LOG_DIR` is repo-relative and would otherwise fail every scan on a read-only filesystem. The old test was named `test_disagreeing_id_logs_both_values` — it pinned the defect — and is replaced by one asserting neither ID appears anywhere in the raw log line.

**File:** [both.py:40-52](backend/app/recognizers/both.py#L40-L52) (`_log_disagreement`), [both.py:70-75](backend/app/recognizers/both.py#L70-L75)

```python
if cnn_result.student_id != remote_result.student_id:
    _log_disagreement("student_id", cnn_result.student_id, remote_result.student_id)
```

This appends the complete recognized student ID, both recognizers' versions,
with a UTC timestamp, to `comparison_log/comparisons.jsonl` — one line per
scan, in scan order.

Every other part of this codebase goes to real lengths to prevent exactly
this: `harvest.py` shuffles write order and hashes crop content,
`stores.py` flattens mtimes, `observability.py` denylists `student_id` as a
key *and* regex-redacts any 4+ digit run, and `test_observability.py`
asserts a real scan's logs contain no student ID. `both.py` writes the ID
verbatim, and there is no test asserting otherwise.

It is gitignored and only produced during a deliberate comparison run — but
the comparison run is a step 3r.6 deliverable that is still outstanding and
is meant to happen during a *real class*, which is the moment the file is
most sensitive. Two adjacent notes:

- `_log_disagreement` writes to a repo-relative path, so `RECOGNIZER=both`
  on the deployed Lambda would raise `OSError: Read-only file system` inside
  `read_id` and fail every scan. Not currently reachable (the deploy sets
  `cnn`) but it is a one-env-var mistake away.
- Its docstring calls this log "the one deliberate, permanent exception" to
  statelessness "the same way `debug_uploads/` was" — `debug_uploads/` was
  deleted in step 11.0.1 precisely because it turned out to be a privacy
  defect, which makes that a poor precedent to invoke.

**Fix direction:** log a per-position agreement mask rather than the values
(`"cnn": "12?4567" → "positions_differing": [2, 5]`), which is what actually
answers "where do the recognizers disagree" without recording anybody's ID.
If the raw values are genuinely needed, route them through
`observability._scrub` and say so.

---

## LOW

### N10. `deploy.sh`'s CloudFront comment block contradicts what it deploys

**Status: FIXED 2026-08-31.** `deploy.sh`'s CloudFront header rewritten to
describe API Gateway and to state plainly that the backend is *not* private
(with the OAC-vs-secret-header note for if that ever needs closing off); the
stale `ORIGIN_REQ_ALL_EXCEPT_HOST` rationale corrected (Host exclusion still
matters, but because API Gateway routes *by* Host, not because of Function
URL SigV4); usage line and `local-stack.sh` updated. `aws/README.md` gained
an API Gateway row. The underlying posture — a directly-reachable API URL —
is accepted, now in writing.

**File:** [deploy.sh:254-267](deploy.sh#L254-L267) versus [deploy.sh:346-352](deploy.sh#L346-L352)

The section header still describes the pre-pivot design:

> `/api/*` -> the Lambda **Function URL** … It is also what makes the Lambda
> URL non-public: the URL stays on AWS_IAM and CloudFront signs each request
> with Origin Access Control, **so nothing can call it directly.**

Ninety lines later the code says the opposite, correctly: *"API Gateway is
publicly invokable, so the API origin takes no OAC and no request signing."*

The deployed reality is the second one: `https://<api-id>.execute-api.us-east-1.amazonaws.com/api/scan`
is directly reachable, unauthenticated and bypassing CloudFront entirely.
That is an acceptable posture for this demo — CloudFront adds no auth here
anyway — but a reader who trusts the first comment will believe there is a
control in place that is not.

Same drift in [aws/README.md](aws/README.md): the grant table row reads
"Lambda actions | create/update the function and **its Function URL**" and
there is no API Gateway row at all, though the policy has one.

**Fix direction:** rewrite the comment block to describe API Gateway, and
either accept the direct API URL explicitly in writing or add a
CloudFront-injected shared-secret header the origin checks.

### N11. `preflight.sh` does not probe API Gateway, and its read-only check does not use the deployed harvest config

**File:** [preflight.sh:84-90](preflight.sh#L84-L90), [preflight.sh:151-167](preflight.sh#L151-L167)

Two gaps in the script whose entire purpose is "anything that would fail
halfway through `./deploy.sh` fails here instead":

1. The permission probes cover ecr, lambda, s3, iam and cloudfront — but not
   `apigatewayv2`, which `deploy_backend` has called since the pivot. A
   fresh deploy user whose policy is missing that grant passes preflight
   with zero blockers and fails mid-deploy, after the ECR repo, image,
   bucket, role and function already exist. This is the same class of
   problem as the `iam:ListRoles` probe bug CLAUDE.md records, in the
   opposite direction: that one over-probed, this one under-probes.
2. The read-only-filesystem check runs the container with
   `HARVEST_ENABLED=false`. Production runs `HARVEST_BACKEND=s3` with
   harvesting **on**. So the check that exists to reproduce Lambda's
   filesystem never exercises the one code path that writes anything —
   `/api/harvest` is not called at all, under any configuration.

**Fix direction:** add `probe "apigateway" blocking aws apigatewayv2 get-apis --region "$REGION"`,
and point the read-only container at `local-stack.sh`'s MinIO with
`HARVEST_BACKEND=s3` so a real harvest round-trips under `--read-only`.

### N12. The deploy policy carries grants for two abandoned approaches, and one grant is account-wide

**Status: DOCUMENTED, not fixed.** `aws/README.md` now names the dead
grants (`lambda:*FunctionUrlConfig`, the CloudFront Functions statement) and
adds API Gateway to a renamed "three grants that are wider than they look"
section with the `/apis/*` scope spelled out. **The grants are still in
`deploy-policy.json`** — removing them changes a live IAM policy and should
be done deliberately, not as part of a docs pass.

**File:** [aws/deploy-policy.json](aws/deploy-policy.json)

`aws/README.md` states the policy is "derived from the API calls the script
makes, not from a guess." Three statements no longer match that:

- `lambda:CreateFunctionUrlConfig` / `GetFunctionUrlConfig` /
  `UpdateFunctionUrlConfig` — `deploy.sh` makes no Function URL call.
- `CloudFrontFunctionForSigningApiPostBodies` (`cloudfront:CreateFunction`,
  `PublishFunction`, …) — no CloudFront Function is created anywhere; this
  is left over from the abandoned request-signing approach.
- `ApiGatewayForThisProject` is scoped to `arn:aws:apigateway:*::/apis` and
  `/apis/*`, which is **every API Gateway API in the account** —
  `apigateway:PATCH`/`PUT` on `/apis/*` can modify or re-target any other
  API the account owns. Like CloudFront's create-time wildcard this may be
  unavoidable, but unlike CloudFront it is not called out in the README's
  own "The two grants that are wider than they look" section.

**Fix direction:** delete the two dead statement groups, and add the API
Gateway scope to the README's wide-grants section with the reason.

### N13. `./deploy.sh all` can never set `ALLOWED_ORIGINS`

**Status: FIXED 2026-08-31 (pair pass).** `all` now runs backend → cdn → **`apply_allowed_origins`** → frontend, setting the var once the CloudFront domain exists. The env list itself moved into a single `lambda_env()` function, because `update-function-configuration` **replaces** the environment rather than merging — two hand-kept copies of that list would have meant the second call silently dropping whatever the first knew about. That is a drift this fix would otherwise have introduced.

**File:** [deploy.sh:96-99](deploy.sh#L96-L99), [deploy.sh:410-415](deploy.sh#L410-L415)

`ALLOWED_ORIGINS` is appended to the Lambda's environment only
`if [ -n "${SITE_URL:-}" ]`, and `SITE_URL` is only ever read from the
caller's environment — nothing in the script sets it. In `all` mode
`deploy_backend` runs *before* `deploy_cdn`, so the CloudFront domain is not
known yet, and `deploy_backend` never runs again.

The deployed function therefore always keeps `DEFAULT_ALLOWED_ORIGIN_REGEX`
(localhost + private LAN), which step 11.1.1 built `ALLOWED_ORIGINS`
specifically to replace. It is harmless *today* only because the frontend is
same-origin behind CloudFront, so no CORS check ever runs — meaning the
config seam is untested in production and would surprise anyone who later
splits the origins.

**Fix direction:** have `deploy_cdn` export the domain and re-apply
`update-function-configuration`, or reorder `all` to cdn → backend → frontend.

### N14. `/api/harvest` is only best-effort on the client side

**Status: FIXED 2026-08-31 (pair pass).** The harvest body is wrapped in try/except returning `{"harvested": False}` and logging a `harvest_failed` event with the exception **type and truncated message only** — never its repr, which can carry a key path and therefore a confirmed value. A detection failure now logs its reason too. "Best-effort" holds on both sides of the wire; a misconfigured bucket is visible in CloudWatch instead of invisible everywhere.

**File:** [main.py:273-336](backend/app/main.py#L273-L336)

The endpoint's docstring says "Best-effort — a detection failure here just
means nothing gets harvested for this scan, not a failed save." That holds
for detection, which is explicitly checked. It does not hold for anything
else: `stores.build_store()` raises `ValueError` on a missing
`HARVEST_BUCKET`, `S3Store.put` raises on a throttle/permission/network
error, and `harvest()` raises on a malformed crop — all unguarded, all
becoming a 500.

Nothing breaks for the user, because `harvestScan` swallows everything
client-side. But that means an S3 misconfiguration in production is
completely silent: crops stop being collected, the frontend never notices,
and the only signal is the absence of a `harvest` log line.

**Fix direction:** wrap the body in try/except, return
`{"harvested": False}`, and `obs.log_event("harvest_failed", reason=...)` so
the failure is visible in CloudWatch instead of invisible everywhere.

### N15. The production image installs the test dependencies

**File:** [requirements.txt](backend/requirements.txt), [Dockerfile](backend/Dockerfile)

`pytest==9.1.1` and `httpx==0.28.1` are in `requirements.txt`, which the
Dockerfile installs wholesale. `.dockerignore` correctly excludes `tests/`,
so the image ships a test runner with nothing to run. Contrary to the split
the project otherwise maintains carefully (`requirements-cnn.txt` for
training, `requirements-deploy.txt` for the container).

**Fix direction:** a `requirements-dev.txt` for pytest/httpx, matching the
existing convention.

### N16. The production recognizer imports a dev accuracy harness for two constants

**Status: FIXED 2026-08-31 (cnn-path pass).** New `cnn/thresholds.py` holds the calibrated floors and imports nothing; `accuracy.py` and `local.py` both read from it. The serial floors moved out of `local.py` at the same time, so every calibrated decode floor now lives in one place with its own calibration record. Pinned by a test that blocks `cnn.accuracy` from the import path and asserts `local.py` still imports — verified it also no longer drags in `app.detection`.

**File:** [local.py:23-24](backend/app/recognizers/local.py#L23-L24)

```python
from cnn.accuracy import CONFIDENCE_FLOOR as ID_CONFIDENCE_FLOOR
from cnn.accuracy import MARGIN_FLOOR as ID_MARGIN_FLOOR
```

`cnn/accuracy.py` is a CLI tuning harness — it imports `argparse`,
`tempfile`, `app.detection`, and computes a `TESTSET` path pointing at a
directory the container does not contain. It is pulled into the default
recognizer's import graph at Lambda cold-start time purely to read two
floats. Its own docstring says "Standalone: … No `app/recognizers/` import
here on purpose", and the dependency now runs the other way.

Any import-time work added to that harness later — loading `labels.json`,
argument parsing at module scope — breaks production startup with no
obvious connection to the change.

**Fix direction:** move `CONFIDENCE_FLOOR`/`MARGIN_FLOOR` (with their
calibration comment, which is the valuable part) into a small
`cnn/thresholds.py` that both `accuracy.py` and `local.py` import.

### N17. Re-harvesting a crop under a different label leaves both labels in the corpus

**Status: FIXED 2026-08-31 (cnn-path pass).** Detected by `fetch-crops.sh`, which now reports any `(field, digest)` carrying more than one label and names them. **Deliberately not fixed at write time**: `Store` is one method by design (no listing or deleting — widening it would be a real design change for a latent issue), and the label has to stay in the filename, which is what keeps the corpus self-labelling with no annotation file to drift. Detection belongs where crops are assembled for training, alongside the balance warnings already there. Checked against the real corpus first — 229 crops, 229 distinct `(field, digest)`, **zero conflicts today** — so this is a guard before fine-tuning, not a cleanup.

**File:** [harvest.py:63-86](backend/app/harvest.py#L63-L86) (`_key`)

The content hash makes re-harvesting idempotent, which is the property the
first corpus had to be thrown away for lacking. But the hash is the
*suffix*; `field`, `tag` and `value` are all path segments ahead of it. So
the same crop bytes harvested twice with different outcomes produce two
different keys:

```
src/serial/confirmed/5_<digest>.png
src/serial/corrected/7_<digest>.png
```

Both survive. The training set then contains one image with two
contradictory labels — the realistic route being a scan confirmed too
quickly, then re-photographed and corrected, which is a normal thing to do.

`fetch-crops.sh`'s summary would not surface it (it counts per field/tag
independently), and it would show up only as unexplained fine-tuning noise.

**Fix direction:** either put the digest first in the key so a re-harvest
overwrites regardless of label, or have `fetch-crops.sh` detect and report
digests appearing under more than one label.

### N18. `build_composite` crashes on an unreadable crop file

**Status: FIXED 2026-08-31 (hot-path pass).** New `app/cells.py` with one `read_cell()`, used at all five sites across `local.py` (×3), `marks_ocr.py` and `marks.py`. `path.exists()` was never the right check — these files are written moments earlier by the same request, so "missing" was already handled and "present but truncated, empty, or not a PNG" was not. `build_composite` now returns `(None, [])` on an undecodable crop, which `recognize` already maps to `model_error`.

**File:** [marks.py:87-95](backend/app/marks.py#L87-L95)

```python
images = [cv2.imread(str(path)) for _, path in sources]
...
h, w = img.shape[:2]
```

`cv2.imread` returns `None` for a file that exists but is truncated or
unreadable — which is possible here, since these are files another part of
the pipeline just wrote. `None.shape` is an `AttributeError`, uncaught, so
it becomes a 500 rather than a clean `model_error`.

**Correction (2026-08-31): this is not remote-path-only, as first recorded.**
Re-checked while sorting the open findings by recognizer path, the same
unchecked pattern appears **three times on the default `cnn` path**:

- [local.py:79](backend/app/recognizers/local.py#L79) — `read_id`'s per-digit crop
- [local.py:139](backend/app/recognizers/local.py#L139) — `_decode_serial_cell`
- [local.py:150](backend/app/recognizers/local.py#L150) — `_decode_value_cell`

All three check `path.exists()` first and none checks the read result, so a
truncated crop reaches `preprocess_for_cnn`/`segment_cell` as `None` and
raises on `.shape`. Also unchecked in
[marks_ocr.py:37-38](backend/app/marks_ocr.py#L37-L38) (`remote`).

**Fix direction:** one guarded helper — read, return `None` on a failed
read, and let each caller treat that the same way it already treats a
missing file (`?` plus a flag, never a guess).

### N19. `validateConfig` has no upper bounds

**Status: FIXED 2026-08-31.** `MAX_ID_DIGITS = 15`, `MAX_QUESTIONS = 30`, `MAX_MARK_PER_QUESTION = 100`, each with its own message, plus `Number.isFinite` on the maxes. **This does not fix N2** — it is the client half only, and the Pydantic model still accepts anything from a request that never came from this form.

**File:** [validateConfig.ts:25-41](frontend/src/validateConfig.ts#L25-L41)

`idDigits` and `questionCount` are checked as positive integers with no
ceiling, and `questionMaxes` entries only as positive numbers. This is the
client half of **N2**, and the enabling condition for finding **1**'s hang.

**Fix direction:** bound both, matching whatever bounds the Pydantic models
gain — the two definitions of "a valid quiz" should not be able to disagree.

### N20. Stale comments (nits, no behaviour change)

**Status: FIXED 2026-08-31.** All three corrected, each stating what it
used to say and why that was wrong rather than being silently overwritten.

- [.gitignore](.gitignore): the `debug_uploads/` block still reads
  "TEMPORARY step 6 debugging only … Remove this **and the save code in
  app/main.py** once step 6 is confirmed working." That save code was
  deleted in step 11.0.1 and the directory no longer exists.
- [requirements.txt](backend/requirements.txt): `scipy` is annotated
  "cnn/segment.py's connected-component labelling". `segment.py` uses
  `cv2.connectedComponentsWithStats`; the real scipy consumer is
  `cnn/preprocess.py`'s `ndimage.center_of_mass`, which is load-bearing for
  MNIST-matched centering — worth naming correctly, since the comment is the
  only record of why the dependency exists.
- [both.py:43](backend/app/recognizers/both.py#L43): calls
  `comparison_log/` a deliberate exception "the same way `debug_uploads/`
  was" — `debug_uploads/` was removed as a defect, not retired as a success.

### N21. `validate_payload` never validates the serial it accepts

**Status: FIXED 2026-08-31 (pair pass).** Both halves, deliberately together. `marks.validate_serial` blanks-and-flags anything that is not 1–4 digits (leading zeros preserved — `"07"` is what is on the paper), and `validateMarks.isValidSerial` applies the identical rule to the instructor's typing, blocking Confirm. This was the one identity field nothing checked on either side.

**File:** [marks.py:153-161](backend/app/marks.py#L153-L161)

Every mark goes through `legal_values`; the serial goes through nothing. It
is flagged only if it is `None` or whitespace — so `"abc"`, `"12.5"`, or a
2 KB string all pass straight into `MarksResult.serial`, into the review
screen's pre-filled input, and (if confirmed unchanged) into IndexedDB, the
Excel export, and `/api/harvest`'s key path. The CNN path cannot produce a
non-digit serial by construction, but Gemini can, and `marks_ocr.py`'s
whitelist pass is the only place any digit constraint is applied at all.

This is the upstream half of **N1** and a sibling of **N5**: nothing in this
project validates an identity string's *shape* at any layer.

**Fix direction:** reject a serial that is not 1–3 digits in
`validate_payload`, flagging rather than guessing, same as every other field.

### N22. The deploy smoke test hardcodes a testset photo it does not check for

**File:** [deploy.sh:196-202](deploy.sh#L196-L202), [preflight.sh:156](preflight.sh#L156)

Both scripts hardcode `testset/images/filled_file.jpeg`. `deploy.sh` guards
it with `if [ -f "$photo" ]` and silently skips the smoke test when absent —
so a deploy whose end-to-end check never ran looks identical to one that
passed. `preflight.sh` does not guard it at all and would report the
read-only-filesystem check as a failure if the file moved.

The values in that photo are fabricated (see **N26**), so there is no
privacy dimension here — but the testset is explicitly a working directory
that gets reorganised (three synthetic images were copied in from
`synthetic_scripts/` during step 0), and a silent skip is the wrong
behaviour for the one check that proves the deployed container actually
serves a scan.

**Fix direction:** fail loudly rather than skipping, and point both at a
`synthetic_scripts/` image so the check does not depend on a photo batch
that may be curated away.

### N23. `deploy.sh` writes its distribution config to a predictable `/tmp` path

**File:** [deploy.sh:355](deploy.sh#L355), [deploy.sh:395](deploy.sh#L395)

```bash
cat > /tmp/$PROJECT-dist.json <<JSON
...
aws cloudfront create-distribution --distribution-config "file:///tmp/$PROJECT-dist.json"
```

A fixed, world-guessable path written and then read back. On a shared or
multi-user machine that is a symlink/TOCTOU target — another user can
pre-create `/tmp/marks-scanner-dist.json` as a symlink and either capture
the write or substitute the distribution config that gets created.

Low, because this is a solo project on a single laptop. Recorded because it
is a one-line fix and the script otherwise handles its inputs carefully.

**Fix direction:** `mktemp` and clean up on exit.

### N24. `decode_value` checks that a decimal point exists, not where it is

**Status: FIXED 2026-08-31 (cnn-path pass).** `_digits_of` returns the decimal's glyph index instead of a bool, and `decode_value` compares it to `has_decimal_at`. Verified against a real `segment_cell` run that `[digit, decimal, digit]` yields index 1 and `_digits_of(4.5)` expects 1 — they agree. **This exposed a wrong existing test**: `test_decoder_returns_the_legal_value_its_glyphs_encode` passed `has_decimal_at=0` for `4.5`, an input the real pipeline never produces, which only passed because the index was discarded. Corrected to 1 with the reasoning recorded. Marks accuracy unchanged at 98.1%.

**File:** [decode.py:68-101](backend/cnn/decode.py#L68-L101)

```python
if expects_decimal != (has_decimal_at is not None):
    continue
```

The candidate filter compares decimal *presence* only; `has_decimal_at` is
an index and its value is discarded. For the legal sets this project
actually uses (`x` and `x.5`) the decimal is always in the same position, so
this cannot currently mis-decode — the constraint is redundant rather than
wrong. It becomes a real gap the moment a legal set contains two values with
the same digits and a differently-placed point (any quarter-mark or
two-decimal scheme).

**Fix direction:** compare the index against the candidate's own decimal
position, so the check means what its variable name says.

### N25. `ResultsRow` writes to IndexedDB on every blur, changed or not

**Status: FIXED 2026-08-31.** `commit()` compares field by field via `isUnchanged()` and returns early. Field-by-field rather than `JSON.stringify`, since `questions` is rebuilt fresh each render and key order is not guaranteed.

**File:** [Results.tsx:218-234](frontend/src/Results.tsx#L218-L234), [Results.tsx:239-261](frontend/src/Results.tsx#L239-L261)

`onBlur={commit}` is on all six-plus inputs per row, and `commit()`
unconditionally calls `onUpdate` → `saveRecord` → `db.put` plus a full
`setRecords` map. Tabbing across a row to read it rewrites the record once
per field and re-renders the whole table each time.

Harmless at 30 records. Worth noting only because it also means a record's
`capturedAt` row is rewritten by a pure read-through, and because a future
"last modified" field would be silently wrong.

**Fix direction:** compare against the current record and return early if
nothing changed.

### N29. The backend's 413 and 429 responses never reach the instructor

**Status: FIXED 2026-08-31 (pair pass).** `api.ts`'s `describeFailure` reads `detail` from the body and, for 429, appends the `Retry-After` seconds — so the queue row says "Too many requests. Please slow down. Try again in 9s." instead of "HTTP 429". Falls back to the status when the body is not JSON.

**Files:** [api.ts:86-88](frontend/src/api.ts#L86-L88), [main.py:108-126](backend/app/main.py#L108-L126), [main.py:163-168](backend/app/main.py#L163-L168)

Step 11.4 built a careful error contract on the backend. Both endpoints can
answer:

- **413** `{"detail": "Image too large."}` — from the Content-Length guard
  and again from the post-read check
- **429** `{"detail": "Too many requests. Please slow down."}` **plus a
  `Retry-After` header**, computed to the second by the sliding-window
  limiter

The frontend collapses all of it:

```ts
if (!response.ok) {
  throw new Error(`Scan request failed: HTTP ${response.status}`);
}
```

Nothing in `frontend/src/` reads `detail` or `Retry-After` — verified by
grep. So the instructor's queue row says **"Failed: Scan request failed:
HTTP 413"**, and they have no way to know the photo was too big rather than
unreadable, or that waiting nine seconds would fix it.

This is the backend half of a user-facing behaviour shipped without its
frontend half. It is worth calling out separately from the audit's other
findings because nothing is *broken* — every component does what it was
built to do — and that is exactly why it would never surface as a bug
report. It only shows up when someone asks what the other side of the
contract does with these responses.

Sharper once hosted: the rate limit exists precisely because the URL is
public, so 429 is the response most likely to be seen by someone who is not
the author, and it is the one whose remedy (wait, then retry) is most
actionable if only it were stated.

**Fix direction:** parse `detail` out of the JSON body when present and use
it as the error message; special-case 429 to include the `Retry-After`
seconds. Frontend-only — the backend contract is already right.

### N27. Ignore-file hygiene: small gaps (the rest is clean)

**Status: FIXED 2026-08-31.** Root `.gitignore` gained `.vscode/`,
`.idea/`, `.DS_Store`, `.pytest_cache/`, `*.xlsx` and
`collection_sheet*.docx`, with a `!marks-grid-template.docx` negation.
Verified: a `CSE211L Quiz 1.xlsx` and a `collection_sheet.docx` are both
ignored, the template is still tracked and not ignored, and nothing
previously tracked became newly ignored.

Checked 2026-08-31 across `.gitignore`, `frontend/.gitignore`,
`backend/.dockerignore`. **The substantive protections all hold** —
`backend/.env`, `backend/certs/`, `backend/training_data/` (8.7 MB of
crops), `comparison_log/`, `aws/deploy-policy.generated.json`, `venv/`,
`node_modules/`, `cnn/data/` (2.2 GB) and `testset/debug/` are all correctly
ignored and none is tracked. The Docker build context is 2.0 MB / 40 files
with `.env`, `certs/`, `training_data/` and `comparison_log/` all excluded,
and `digit_cnn.onnx` (1.8 MB) is correctly tracked so the image needs no
download at boot. All 20 currently-untracked files are legitimate sources
awaiting a commit — no junk, no secrets.

Remaining gaps, all minor:

- **The root `.gitignore` has no editor/OS patterns.** `.vscode/`, `.idea/`
  and `.DS_Store` appear only in `frontend/.gitignore`, so they are ignored
  under `frontend/` and nowhere else. None exists right now, but this
  project is being worked on in VS Code, so a root `.vscode/` is one
  settings change away from being committed.
- **`.pytest_cache/` is not in any project ignore file.** It is currently
  ignored only by `backend/.pytest_cache/.gitignore`, a file *pytest
  generates for itself*. That works, but it means the protection is a side
  effect of the tool rather than a project decision, and it disappears if
  the directory is ever cleaned and recreated by something that does not
  write that file.
- **No `*.xlsx` or `*.docx` pattern.** The app's whole output is a
  downloaded workbook, and `generate_collection_sheet.py` writes to the repo
  root by default (`../collection_sheet.docx`). Neither is ignored, and both
  are exactly the kind of file that gets produced during a session, sits in
  the working tree, and is swept up by `git add -A`. This is the concrete
  half of **N26** — see there for why it is worth doing before the pilot
  rather than after. Note `marks-grid-template.docx` is a tracked
  deliverable, so a `*.docx` rule needs a `!marks-grid-template.docx`
  negation after it.
- `frontend/.gitignore` does not cover `.env`/`.env.local`; the root file's
  `.env` and `.env.local` entries do cover it, so this is fine as-is, just
  worth knowing it depends on the root file.

**Fix direction:** add `.vscode/`, `.idea/`, `.DS_Store`, `.pytest_cache/`,
`*.xlsx` and `collection_sheet.docx` to the root `.gitignore`.

### N28. Both `.env.example` files document values the code does not use

**Status: FIXED 2026-08-31.** `backend/.env.example` now says 4 MB with
the base64-inflation reasoning; `frontend/.env.example` now documents
`VITE_API_BASE=""` (same origin) and why the empty string is a real value.
`learn.md` carried the same 5 MB error and was corrected too.

**Files:** [backend/.env.example](backend/.env.example), [frontend/.env.example](frontend/.env.example)

Neither contains a real secret — both are clean placeholder files, which is
the important part. But both document a configuration that is no longer
true:

- `backend/.env.example` says *"the 5 MB default"* and shows
  `MAX_UPLOAD_BYTES=5242880`. [config.py:106](backend/app/config.py#L106)
  sets `4 * 1024 * 1024`, with a long comment explaining precisely why it is
  4 MB and not 5 (base64 inflation against Lambda's 6 MB payload ceiling).
  The example file recommends the exact value the code's own comment argues
  against.
- `frontend/.env.example` describes the backend as *"a Lambda Function
  URL"* and gives
  `VITE_API_BASE=https://xxxx.lambda-url.us-east-1.on.aws` as the hosted
  setting. The deployed build uses `VITE_API_BASE=""` (same origin, via
  CloudFront routing `/api/*`), which `deploy.sh` sets and `api.ts`'s
  `apiBase()` documents carefully as a real value distinct from unset.
  Anyone following this file would build a frontend pointing at a host that
  does not exist.

Same doc-drift family as **N10** and **N20**, listed separately because
`.env.example` is the file a new contributor copies verbatim.

---

## What this audit did NOT cover

Stated so the absence of findings in these areas is not read as a clean
bill of health.

**Files read in full:** all of `backend/app/` (12 modules), `backend/cnn/`'s
`decode.py`, `segment.py`, `preprocess.py`, `id_infer.py`, all of
`frontend/src/`'s non-test sources (13 files), `Dockerfile`,
`.dockerignore`, `requirements*.txt`, `.gitignore`, `deploy.sh`,
`preflight.sh`, `fetch-crops.sh`, `dev.sh`, `aws/deploy-policy.json`,
`aws/README.md`.

**Not read at all:**

- `local-stack.sh` — first 50 lines only (the header and config block).
  It runs the deployed shape locally against MinIO and is the one place
  `HARVEST_BACKEND=s3` is exercised end to end, so it is a meaningful gap.
- `aws/MONITORING.md`.
- The standalone harnesses and one-offs: `detect.py`, `batch_detect.py`,
  `id_ocr_accuracy.py`, `harvest_real_photos.py`,
  `generate_collection_sheet.py`, `gen_dev_cert.py`, and `cnn/`'s
  `accuracy.py` (beyond its import block and threshold comments),
  `marks_accuracy.py`, `train.py`, `model.py`, `inspect_preprocess.py`.
  These do not run in production, but `harvest_real_photos.py` writes into
  the real corpus and `accuracy.py`/`marks_accuracy.py` produce the numbers
  the CNN-default decision rests on — a bug in either would mean the
  measurements in CLAUDE.md are wrong, which is a different and arguably
  more important kind of defect than the ones listed above.
- `frontend/vite.config.ts`, `index.css`, `main.tsx`, `setupTests.ts`.
- **The test suites themselves.** I ran both and listed every test name, but
  audited test *content* only where a finding required it (`test_harvest.py`
  for N1, `test_observability.py` for N9). Tests were not reviewed for
  whether they assert the right thing — and N1 is a direct example of a
  passing test that reads as broader coverage than it has, so this gap
  matters more than usual here.
- **The specs.** `plan.md`, `step.md`, `learn.md`, `README.md` and
  `stack-reference.md` (~500 KB combined) were not checked for drift against
  the code. Only CLAUDE.md's claims were spot-verified, and three of those
  turned out stale (N10, N20).

**Also not done:** no dynamic testing against the live deployment. N1 and N2
were reproduced locally; neither was fired at
`https://d2n2meq17rr1oi.cloudfront.net`, since that is the user's own
production infrastructure and probing it is their call, not mine.

---

## Suggested order of work

Nothing here is required for the laptop pilot to keep working, but four
items gate anything else:

0. **N26 + N27's `.gitignore` lines — before the pilot runs, not after.**
   A one-line-per-pattern change, and the only item on this list whose cost
   goes up sharply if it is done late: once a real class's exported workbook
   has been committed, the fix stops being a `.gitignore` edit and becomes a
   history rewrite. Cheap now, expensive later, and the trigger is a date
   rather than a decision.
1. **N1** and **N2** — the endpoint is publicly deployed *now*, and both are
   verified-reproducible. N1 is a small, well-understood patch plus a test
   that covers the field class rather than one field.
2. **1**, **N3**, **6** — the three that can end a live grading session:
   a crash on the first screen, a permanently-disabled capture button, and
   a queue entry with no way out.
3. **4** / **N6** / **N5** and **N7** — everything between a confirmed value
   and the exported file. These are the ones that produce a *wrong mark in
   a real gradebook*, which is the failure this project's invariants exist
   to prevent.

Everything else is genuine but survivable.
