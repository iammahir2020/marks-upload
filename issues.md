# Issues

Findings from a full-repo audit (2026-08-27): `code-review` (backend +
frontend, targeted directly at `backend/` and `frontend/` since the
default diff-based mode misses everything untracked in this not-yet-fully
committed repo), `security-review`, and a pass against `fastapi-templates`,
`frontend-patterns`, and `product-ui-design` for pattern-specific gaps.
The top findings were spot-verified directly against the code before being
recorded here — not just taken on the reviewing tool's word.

Nothing here has been fixed yet. This is the record of what was found;
check items off (or note why not) as they're addressed.

---

## High priority — real bugs

### 1. `Setup.tsx` crashes on non-integer input

**File:** `frontend/src/Setup.tsx:42` (`handleQuestionCountChange`)

Typing `5.5` (or anything non-integer) into "Number of questions" runs
`copy.length = Math.max(next, 0)` with `next = Number(e.target.value) =
5.5`. Setting `array.length` to a non-integer throws
`RangeError: Invalid array length` per the JS spec — the Setup screen
crashes before `validateConfig` ever runs, on the very first screen of the
app. A non-numeric string (`Number("abc") = NaN`) crashes the same way.

**Fix direction:** guard `handleQuestionCountChange` against non-integer
input before mutating array length — e.g. `Number.isInteger(next)` check,
or `Math.trunc`/reject and leave the previous count in place.

### 2. Duplicate cross-check misses leading-zero duplicates

**Files:** `frontend/src/Review.tsx` (`handleConfirm`), `frontend/src/db.ts`
(`findRecordsBySerial`)

`handleConfirm` calls `findRecordsBySerial(candidate.serial)` with the
*raw, un-normalized* typed serial. `db.ts`'s `findRecordsBySerial` does an
exact-match `getAllFromIndex` lookup — no leading-zero stripping happens
before this DB query runs. `validateMarks.ts`'s `crossCheck` *does*
correctly normalize serials via `normalizeSerial`, but only compares
against whatever `findRecordsBySerial` already retrieved.

A record saved with serial `"007"` and a later rescan typed as `"7"` never
even get compared — `findRecordsBySerial("7")` returns nothing, so the
duplicate is silently saved as a second record. Directly undermines
CLAUDE.md's stated invariant: "Serial comparison strips leading zeros. `2`,
`02`, `002` are the same serial."

**Fix direction:** normalize the serial before it's used as a lookup key
(either store records with normalized serials, or query with the
normalized value / use a range query), so the exact-match index lookup and
the cross-check's own normalization agree.

### 3. ID-OCR fallback never accepts a digit read correctly by the fallback pass

**File:** `backend/app/id_ocr.py:116-125` (`read_digit`)

The unconstrained fallback pass only accepts a result if `fallback_text in
DIGIT_LOOKALIKES` — but `DIGIT_LOOKALIKES`'s keys are all *letters*
(`"o"`, `"D"`, `"l"`, etc.), never digit characters. So when the fallback
pass reads a crop correctly *as the actual digit* (e.g. a legible `"7"`
that scored below `CONFIDENCE_FLOOR` on the whitelist pass, then gets read
correctly and confidently — well above `FALLBACK_CONFIDENCE_FLOOR` — by
the unconstrained pass), the check `fallback_text in DIGIT_LOOKALIKES` is
`False`, and the function falls through to `return None, ...`, discarding
a confidently-correct read as `?`.

This bug was introduced this session while building the look-alike
fallback (learn.md step 2's "0"→"D", "1"→"l" fix) — the fallback was only
ever tested against the letter-lookalike cases it was designed for, not
against a case where the fallback pass reads the digit itself correctly.

**Fix direction:** also accept `fallback_text` directly when it's already
a digit character (e.g. `fallback_text in WHITELIST`), in addition to the
`DIGIT_LOOKALIKES` mapping — same confidence floor either way.

### 4. Review screen's Total field has no legal-value check

**File:** `frontend/src/Review.tsx` (`hasMarkErrors`, ~line 71)

`hasMarkErrors` only iterates `config.questions` — the Total field is
never validated the way per-question marks are. Typing `"abc"` into Total
doesn't block "Confirm & next"; `total = Number("abc")` is `NaN`, and
`commitSave` writes `StudentRecord.total = NaN` to IndexedDB as a
`confirmed: true` record. Violates CLAUDE.md's "Flag, never guess" /
"Never store a wrong number."

**Fix direction:** extend the legal-value check (or at minimum a
finite-number check) to the Total field, same as each question's mark.

### 5. Conflict Overwrite/Save-anyway can target a stale record

**File:** `frontend/src/Review.tsx` (`handleConfirm`, the conflict panel
buttons, ~line 239)

If the instructor edits a field *after* a conflict banner appears (e.g.
realizing the serial was misread and correcting it so it no longer
actually conflicts), the Overwrite/Save-anyway buttons still use the
`pendingConflict` captured *before* the edit — and Confirm is disabled
while `pendingConflict` is set, so there's no way to re-run `crossCheck`
against the corrected values before committing. Clicking "Overwrite
earlier record" can overwrite the wrong record's real data with values
that were never actually re-checked against it.

**Fix direction:** re-run `crossCheck` against current field values at the
moment Overwrite/Save-anyway is clicked (not reuse the panel's original
snapshot), or clear `pendingConflict` on any field edit so Confirm has to
be pressed again to get a fresh check.

### 6. Network-level scan failures are a dead end

**File:** `frontend/src/Scan.tsx` (queue entry list, ~line 215)

A capture that fails at the transport layer (`scanQueue`'s `'error'`
status — dead backend, dropped wifi mid-upload) renders only static
`"Failed: <message>"` text. The Review/Retake button block only renders
for `status === 'done'` entries — an `'error'` entry has no Retake, no
Review, no recovery action anywhere in the UI. Only backend-reported
`status: "failed"` `ScanResult`s get routed to the Review screen's
Retake/Enter-manually path; client-side/network failures don't. Undercuts
CLAUDE.md's "A failed scan is never a dead end... a bad photo must never
block the session."

**Fix direction:** give `'error'` entries a visible retry/discard action —
at minimum, let the instructor dismiss the entry and capture again without
it silently sitting there unresolved.

### 7. `POST /api/scan` blocks the event loop

**File:** `backend/app/main.py:51` (`async def scan`)

Detection (OpenCV), local OCR (Tesseract), and the Gemini SDK call all run
synchronously inside the `async def` handler with no thread-pool offload —
the only `await` in the function is `await image.read()`. Confirmed
against `fastapi-templates`' async-pattern guidance: a genuinely
CPU/IO-bound synchronous call inside an async route handler runs on the
single event-loop thread and blocks everything else.

This silently defeats the frontend's own design: `scanQueue.ts` is built
specifically so "the camera never blocks: multiple captures can be pending
at once" (its own test name), issuing several `/api/scan` requests in
flight — but since the server serializes on the blocking handler, request
B can't even start until request A's full multi-second
detection+OCR+Gemini round trip finishes.

**Fix direction:** offload the synchronous pipeline via
`starlette.concurrency.run_in_threadpool` (or make the route a plain `def`
so FastAPI runs it in its default thread pool automatically).

---

## Medium priority

### 8. Malformed config JSON causes an unhandled 500

**File:** `backend/app/main.py:57`

`QuizConfig.model_validate_json(config)` is unguarded. Verified against
the installed `fastapi==0.141.1`: only `HTTPException`,
`RequestValidationError`, and `WebSocketRequestValidationError` get
default exception handlers — a raw `pydantic.ValidationError` raised
inside the route body isn't one of them, so a malformed `config` field
(stale frontend build, hand-crafted request) surfaces as a generic 500
instead of a clean 4xx.

**Fix direction:** wrap the parse in try/except and raise `HTTPException`
with a clear 400 on failure.

### 9. A missing mark crop can desync the composite from the prompt

**File:** `backend/app/marks.py` (`build_composite`, ~line 73)

If a mark-cell crop is ever missing (e.g. a zero-width crop from a
boundary-computation edge case that doesn't trip `column_count_mismatch`),
`build_composite` silently skips writing that tile (`if crop.size == 0:
continue`) while `build_prompt` still unconditionally describes all N
questions to Gemini. Gemini can then return a legal-looking value for a
tile it was never actually shown, and `validate_payload` accepts it — it
only range-checks against the legal set, it can't detect that the tile
never existed in the composite. Unlike the ID-exclusion guarantee (which
has an explicit `assert`), nothing catches this desync.

**Fix direction:** assert (or otherwise fail loudly) if the number of
tiles actually built doesn't match `question_maxes`' length, rather than
silently proceeding with a mismatched composite/prompt pair.

### 10. No backend check that questions are in `q`-order

**File:** `backend/app/main.py` (~line 80)

`question_maxes`/column mapping is derived from `quiz.questions`' *array
order*, not its `q` field, with nothing on the backend checking the two
agree. Currently only prevented by `validateConfig.ts` always building
`{q: i+1, max}` in order on the frontend — an unenforced convention, not a
backend guarantee. Out-of-order `q` values would silently mislabel marks
to the wrong question with no flag raised (each value still passes its
own legal-value check, just against the wrong question's legal set).

**Fix direction:** assert `quiz.questions` is sorted by `q` (or sort by
`q` explicitly) before deriving `question_maxes`.

### 11. Preview blob URLs leak for the whole session

**File:** `frontend/src/Scan.tsx:51` (the `previews` cleanup effect)

```ts
useEffect(() => {
  return () => Object.values(previews).forEach((p) => URL.revokeObjectURL(p.url));
}, []);
```

Empty dependency array means this closure captures `previews` as it was
at mount (`{}`) and never sees later captures. No other
`revokeObjectURL` call exists in the file, so every captured photo's blob
URL accumulates for the entire session with no revocation path at all.

**Fix direction:** revoke a preview's URL when it's superseded/no longer
needed (e.g. on unmount of that specific entry, or via a ref that always
holds the latest `previews` map), not via a mount-only empty-deps effect.

### 12. Portrait-rotation direction is hardcoded from one device

**File:** `frontend/src/Scan.tsx:110` (`capture`)

`ctx.rotate(-Math.PI / 2)` — the comment itself says this "matches this
device's actual capture orientation." A different phone/browser whose
camera sensor rotates the other way (a real, documented cross-device
`getUserMedia` inconsistency) gets captures rotated the wrong direction,
with no per-device detection or EXIF check to catch it. The backend's
4-way orientation retry (`detect_any_orientation`) is the safety net for
this today, per learn.md step 6 — worth confirming that net still catches
a wrong-direction rotation, not just a missing one.

**Fix direction:** no immediate fix required if the backend's 4-way retry
already covers this case (verify it does); otherwise, detect rotation
direction rather than hardcoding it, or fall back to trying both
directions.

---

## Low priority

### 13. `genai.Client()` re-created every request

**File:** `backend/app/marks.py:208` (`recognize`)

A new SDK client is instantiated on every `/api/scan` request instead of
being created once and reused. Wasted setup cost on the already-slowest
part of the pipeline, across potentially dozens of requests per class
session.

### 14. `QuizConfig.totalMax` accepted but never checked

**File:** `backend/app/models.py:35`

`totalMax` is required in every request payload but never read anywhere
in the backend — `marks.py` always independently recomputes
`sum(question_maxes)` for both the Gemini prompt and `validate_payload`'s
total check. If a future frontend change (or a hand-crafted request) ever
sends a `totalMax` that disagrees with the real sum, nothing notices.

### 15. Failed-rotation debug artifacts reflect the wrong orientation

**File:** `backend/app/detection.py:365` (`detect_any_orientation`)

All four rotation attempts reuse the same `out_dir`, so if all four fail,
the on-disk `overlay.jpg`/`result.json` reflect whichever rotation was
tried last (270°), not the original 0° the function actually returns as
`failure_reason`. Currently low-impact: `main.py`'s `TemporaryDirectory`
is deleted immediately after each request, so nothing today reads
`out_dir` post-failure — would only matter if this function is ever
called from a context that keeps `out_dir` around for debugging.

---

## Security review — clean

No HIGH/MEDIUM findings cleared the confidence bar. Checked: API-key
sourcing (`GEMINI_API_KEY` via env only, `genai.Client()`, never reaches
the frontend or a response body), CORS config (`allow_origin_regex`
matches localhost + private LAN ranges only, no `allow_credentials`, no
auth/session/cookie surface to attack via CORS), and injection surfaces
(Tesseract config strings built entirely from hardcoded constants —
`OEM`/`PSM`/`WHITELIST` — never user input; no path traversal, since every
file write uses a fixed filename or a server-generated timestamp, never
client-controlled data).

No-auth and local-only CORS are deliberate, documented design choices for
a single-instructor local pilot (plan.md §9, §13) — not vulnerabilities
introduced by recent changes.

---

## Design (`product-ui-design`) — ✅ fixed (2026-08-29)

Mechanical scan (`scan-tells.py`) found 2 tells in
`frontend/src/index.css`:

- A pure-black, single-layer `box-shadow` (`--shadow`, lines 11 & 44) —
  should be tinted toward the background hue, two layers.
- A purple/violet `--accent` (`#aa3bff` light / `#c084fc` dark) — in the
  same family the skill flags as a default "AI accent" to avoid.

Both were leftover Vite-scaffold CSS custom properties, never referenced
by any component (Setup.tsx/Scan.tsx/Review.tsx all used ad-hoc inline
styles instead) — not an active visual defect at the time, but flagged as
worth fixing before any real UI polish pass began, exactly so nobody
inherited the purple accent later by assuming it was intentional.

That polish pass happened (2026-08-29, via the `product-ui-design`
skill): `index.css` was replaced entirely with a real token system
(`--background`/`--foreground`/`--primary`/etc., two-layer tinted
shadows, a deliberate petrol-teal accent), and every screen
(Setup/Scan/Review/Results) was rebuilt on it. `scan-tells.py` now passes
clean. See CLAUDE.md's "Frontend design system" section and learn.md for
the walkthrough. The other findings in this file (bugs, medium/low
priority) are unrelated to that pass and remain unaddressed.
