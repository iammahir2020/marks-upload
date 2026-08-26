# Script Mark Scanner — Project Plan

Build spec for Claude Code. Architecture, data models, screens, and API
contracts are concrete enough to start implementing directly.

Library-level detail — exact calls, parameter starting values, and the SDK
behaviours these decisions lean on — lives in `stack-reference.md` beside this
file. This document stays at the level of what to build and why.

## 1. Goal

A faculty member grading a quiz photographs the marks grid at the top of
each student's script. The app extracts the handwritten student ID, serial
number, and marks per question, lets the faculty confirm or correct them
on the spot, and exports every record as one Excel file.

Primary user: a single instructor running one quiz session for one class
(pilot: CSE211L). No file uploads, no auth, no server-side database.

## 2. Identity fields — why both

The sheet carries **student ID and serial**. Serial is fixed per course
from the attendance sheet, but in practice many students don't write it
and many don't remember it, so serial alone is unreliable. ID is what
students actually know.

Capturing both is also the app's strongest correctness guard. With two
independent identifiers, a misread in either becomes visible: if two
scripts resolve to the same serial but different IDs, one was read wrong.
That conflict check replaces what a class roster would have provided,
without requiring any upload.

Either field alone identifies the record. A script with only one filled in
still works — the app loses the cross-check for that row and flags it
unverified.

## 3. The template — a table you paste into your question paper

There is **no template generator**. The grid is an ordinary table the
instructor keeps in Google Docs or Word and pastes at the top of each
question paper. Nothing extra to print, staple, or distribute.

`marks-grid-template.docx` (shipped alongside this plan) is the reference
layout. Open it in Google Docs, copy the three tables, paste into the
question paper.

### Structure

Three separate tables, stacked:

```
┌────────┬───┬───┬───┬───┬───┬───┬───┐
│   ID   │   │   │   │   │   │   │   │      7 digit boxes
└────────┴───┴───┴───┴───┴───┴───┴───┘

┌────────┬──────────┐
│ Serial │          │                       one cell, "2" or "02"
└────────┴──────────┘

┌────────┬────────┬────────┬────────┬────────┬───────────┐
│ Q1 (5) │ Q2 (5) │ Q3 (5) │ Q4 (5) │ Q5 (5) │ Total (25)│  header
├────────┼────────┼────────┼────────┼────────┼───────────┤
│        │        │        │        │        │           │  answer
└────────┴────────┴────────┴────────┴────────┴───────────┘
```

One cell per question, plus one for Total. The instructor writes the mark
the way they'd write it anywhere else — `4` for a whole mark, `4.5` for a
half. No separate half-mark column, no ticking, no convention to remember.

The ID keeps one box per digit because a 7-digit number is where isolated
boxes genuinely help recognition, and the local OCR pass reads one digit
at a time. Serial is a single free cell — students write `2` or `02`
inconsistently and both are fine; the app strips leading zeros when
comparing.

### Rules that keep detection reliable

These aren't cosmetic — the detector depends on them:

- **All borders visible.** The table's own lines are the reference frame.
  Borderless tables cannot be detected at all.
- **No merged cells.** Merging breaks the assumption that row `n` has the
  same column boundaries as row 0.
- **No cell shading.** Fill colour interferes with binarization.
- **Answer row noticeably taller than the header row.** Gives handwriting
  room and makes the two rows easy to tell apart.
- **Nothing but the mark in a mark cell.** No ticks, slashes, or comments
  — the value is parsed against a fixed set (section 5) and anything else
  reads as a failure.
- **Frame the photo tightly on the three tables**, not the whole page. The
  marks table must be the largest rectangle in the shot.

Changing the question count or max marks means editing the table in Docs
and updating the matching numbers at Setup. Keep the two in sync — the app
uses the Setup config to interpret what it sees.

## 4. Architecture overview

```
┌──────────────────────┐        ┌────────────────────────────────┐        ┌──────────┐
│   Frontend (PWA)      │ POST   │   Backend (FastAPI)             │  API   │  Gemini  │
│  React + TypeScript   │ ─────► │  OpenCV: detect table, split    │ ─────► │ (vision) │
│  IndexedDB (session)  │ ◄───── │  into cells                     │ ◄───── │          │
└──────────────────────┘  JSON  │  Local OCR: student ID          │  JSON  └──────────┘
                                 │  Gemini: serial + mark digits   │
                                 └────────────────────────────────┘
```

Four decisions worth stating explicitly:

**The Gemini key lives only on the backend.** A browser PWA can't hide an
API key. The backend exists to proxy that call as much as to run OpenCV.

**The student ID never reaches Gemini.** See section 12 — the ID is what
makes an image personally identifying, and Gemini's free tier may use
inputs for training. The backend crops the ID row and reads it with a
local OCR pass. Serial and marks still go to the API; on their own they
identify nobody outside the instructor's attendance sheet.

**Marks are read as a constrained enumeration, not free text.** A question
out of 5 has exactly 11 legal values (0, 0.5, 1, … 5). The Gemini prompt
states that set explicitly and the backend rejects anything outside it.
This is what makes reading a handwritten "4.5" reliable — an ambiguous
mark that could be 4.5 or 45 resolves immediately because 45 isn't a legal
value.

**Mark and serial cells are cropped individually, then tiled into one
composite image for a single Gemini call.** The model sees isolated
digits, not a layout it must parse, at ~1 request per student. A
30-student class costs ~30 requests.

## 5. Grid detection — proportional, not fixed-coordinate

Because the grid is pasted into a question paper, it can sit anywhere on
the page at any size. Detection is therefore relative to the table itself,
not to page coordinates:

1. **Binarize and find lines.** Adaptive threshold, then morphological
   open with a long horizontal kernel and a long vertical kernel to
   isolate the table's rules. Kernel length is a fraction of the image's
   width and height, never a pixel constant — that is what makes this step
   survive a grid photographed close up and one photographed small in the
   frame, and it is the first parameter to tune.
2. **Find table rectangles.** Contour detection on the combined line mask;
   keep rectangles above a minimum area. Expect three (ID, serial, marks).
   Classify them by aspect ratio and row count — the marks table is the
   only one with two rows.
3. **Deskew each table.** Four corners of the detected rectangle give a
   perspective transform. This replaces the corner markers entirely — the
   table's own borders are better fiducials than printed squares, because
   they can't be cropped out of frame accidentally.
4. **Recover cell boundaries** from the intersections of the detected
   horizontal and vertical lines within each table. Do not assume even
   spacing — read the actual line positions, since Docs column widths
   won't be exactly uniform.
5. **Map columns to fields** using the Setup config: the marks table has
   `questionCount + 1` columns, in order — one per question, then Total.
   The ID table has `idDigits + 1` (label plus digit boxes); the serial
   table has 2.
6. **Extract from the answer row** (row index 1) of the marks table, and
   the single row of the ID and serial tables.

### The Setup config is the detector's ground truth

Question count is entered before scanning starts, so the detector always
knows what it should be looking at. Two questions or ten, the code path is
identical and Total is always the last column. That expected shape does
three jobs at once:

- **Identifies the marks table** among the three detected rectangles — it
  is the one with `questionCount + 1` columns and two rows.
- **Confirms the photo caught the whole table.** A frame that clipped the
  last column produces the wrong count, which is caught rather than
  silently read as a shorter quiz.
- **Catches config drift.** If the pasted table doesn't match what was
  entered at Setup, that surfaces immediately instead of writing marks
  into the wrong question columns.

All three surface as `column_count_mismatch`. That is the correct
response to each — every one means "don't trust this scan," and the fix
is the same: check the framing, or check the config.

Per-question max does the same job one level down. Each question's legal
value set is derived from its own max, so a 10-mark question accepts up to
10 while a 5-mark one rejects anything above 5. A quiz with uneven
weighting is handled with no extra machinery.

Never guess when the shape disagrees with the config — return a failure
and let the instructor look at it.

## 6. Detection is the make-or-break component

Build this first, build it standalone, and do not move on until it works
on bad photos as well as good ones.

### Why it carries more weight than anything else

Every other component has a fallback. Bad digit recognition gets corrected
on the review screen. A failed Gemini call gets retried. A wrong total
gets caught by the sum check. Detection has none — if the table isn't
found, or cells are split wrong, nothing downstream recovers it and the
photo is simply unusable.

It is also the only part whose correct values cannot be reasoned out in
advance. Adaptive threshold parameters, morphological kernel lengths,
minimum contour area — these are tuned against real photographs taken in
the conditions the app will actually run in: your phone, your classroom
lighting, the paper the department buys. No amount of care in the spec
substitutes for running it on real images.

The `column_count_mismatch` check earns special attention here. It is the
difference between failing loudly and silently writing Q4's mark into the
Q3 column. Treat it as core logic, not error handling to bolt on later.

### Build it as a standalone harness first

Do not wrap detection in FastAPI until it works. An HTTP round trip per
iteration slows the tuning loop for no benefit. Write a plain script:

```
detect.py <image-path> --questions 5 --id-digits 7 --out debug/
```

It should produce, per input image:

- `overlay.jpg` — the source photo with detected table rectangles and
  every recovered cell boundary drawn on it. This is the artifact you
  actually look at; a wrong split is obvious in the overlay and invisible
  in a JSON dump.
- `cells/` — every cell crop written out individually, named by position
  (`marks_r1_c3.png`, `id_d5.png`). Eyeball these — they are exactly what
  gets sent to recognition, so if a digit is clipped here it will be
  misread later.
- `result.json` — detected table count, column and row counts per table,
  and whether the shape matched the expected config.

Run it across the whole test set in one command and check the overlays
side by side. That loop should take seconds, and you should expect to run
it dozens of times.

### Build a deliberately awkward test set

Collect 15–20 photographs before writing the detector, and make most of
them imperfect on purpose:

- Straight-on, well-lit (the easy baseline)
- Shot at an angle, maybe 20–30° off perpendicular
- Shadow falling across part of the grid
- Slightly crumpled or curled paper
- Grid low on the page with question text above it
- Fluorescent classroom light, and separately, daylight near a window
- Slightly out of focus
- Framed tight enough that one column is nearly cut off
- A photo where the grid is a small part of the frame

The point of the awkward ones is to find the failure in a harness on a
quiet evening rather than on script nineteen of thirty with a class
waiting. Keep the set in the repo — every threshold change gets re-run
against all of it, so a fix for angled shots can't quietly break the
well-lit case.

### Definition of done

Detection is finished when every image in the test set either produces
correct cell crops, or fails with an accurate reason. A wrong split that
reports success is a defect; a genuinely unusable photo that returns
`table_not_found` is correct behavior.

## 7. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + TypeScript, Vite, PWA (camera via `getUserMedia`) | Matches existing React strength; client-only, no SSR needed. |
| Session state | IndexedDB via `idb` | Survives crash/refresh mid-scan. |
| Excel export | ExcelJS (MIT), client-side | No backend round trip for the final step. See section 15 for why not SheetJS. |
| Backend | Python, FastAPI | Natural home for OpenCV and the Gemini SDK. |
| Image processing | `opencv-python` | Line detection, table finding, deskew, cell splitting. |
| Local ID OCR | `pytesseract` per box, digit whitelist (`--psm 10`) | Isolated boxed digits are the easiest OCR case; keeps ID off the network. Swap for a small trained classifier if accuracy disappoints. |
| Serial + mark recognition | Gemini API via `google-genai`, free tier | Structured JSON, one call per script. Note `google-generativeai` is the retired SDK — `google-genai` (`from google import genai`) is the current one. |
| Template | A `.docx` table, maintained by hand | No generator to build or keep in sync. |
| Database | None | Session lives in IndexedDB until export. |
| Hosting | None — both halves run on the instructor's laptop for the pilot | No account, no deploy step, no cold start. See "Running locally" in section 9. |

## 8. Data models

```typescript
interface QuizConfig {
  quizName: string;
  idDigits: number;              // 7 for IUB
  questions: { q: number; max: number }[];
  totalMax: number;
}

interface StudentRecord {
  id: string;                    // client-generated uuid
  studentId: string | null;      // handwritten, read locally
  serial: string | null;         // normalized: leading zeros stripped
  questions: { q: number; value: number | null }[];  // 0, 0.5, 1, … max
  total: number | null;
  confirmed: boolean;
  capturedAt: string;
}
// sumCheck is NOT stored — derive it on render so an edit can never
// leave a stale pass/fail flag behind.
// At least one of studentId / serial must be non-null to save a record.
```

```python
class QuestionMark(BaseModel):
    q: int
    value: float | None   # one of 0, 0.5, 1, … max; None if unreadable

class ScanResult(BaseModel):
    status: Literal["ok", "failed"]
    failure_reason: str | None = None
    # "table_not_found" | "column_count_mismatch" | "blurry"
    # | "rate_limited" | "model_error"
    student_id: str | None = None
    serial: str | None = None
    questions: list[QuestionMark] = []
    total: QuestionMark | None = None
    low_confidence_fields: list[str] = []
```

## 9. Backend

### `POST /api/scan`

Input: one `multipart/form-data` request carrying the image and the
`QuizConfig` as a JSON string in a form field. HTTP encodes a body as either
multipart or JSON, not both, so the config cannot ride along as a JSON body
next to the file — it has to be a form field the handler parses.

1. Decode image.
2. Run grid detection (section 5). On no table found → `status: "failed"`,
   `failure_reason: "table_not_found"`. On column count disagreeing with
   the config → `"column_count_mismatch"`. Never call Gemini in either
   case.
3. Deskew each detected table.
4. Split into cells from the recovered line intersections.
5. Read the ID cells locally, one crop per digit, digit whitelist only.
   Add `"student_id"` to `low_confidence_fields` if any box is empty or
   ambiguous.
6. Tile the serial and mark cell crops — **excluding the ID crops** — into
   one composite image, labeled by position.
7. One Gemini call, with a response schema attached so the reply is
   constrained to the expected structure. The prompt carries the legal
   value set per question (0, 0.5, … max) and the instruction to return one
   value from that set per cell, plus the serial as written — and nothing
   about the shape of the output, which the schema already fixes. Restating
   the format in the prompt on top of the schema makes results worse, not
   better.
8. Reject any returned value outside the legal set for its question; add
   that field to `low_confidence_fields` and leave it blank for the
   instructor rather than storing a wrong number. The schema in step 7 does
   not make this redundant — it constrains the shape of the response, not
   the range of a number inside it, so a 7 can still come back for a
   5-mark question. This is the check that catches it.
9. Assemble and return `ScanResult`.

Backend is stateless. No auth, no storage, nothing written to disk.

### Running locally

For the pilot the backend runs on the instructor's own laptop. Nothing is
deployed, so there is no hosting account to keep alive and no cold start to
sit through at the beginning of a class — and the Gemini key lives in a local
env file rather than a platform secrets store. The laptop needs internet for
the Gemini call; the phone only needs to reach the laptop.

Two consequences follow from the phone being the camera and the laptop being
the server, and both are the kind of thing that is much better discovered now
than in a classroom:

- **They are separate origins**, so the backend needs CORS configured for
  wherever the frontend is served. `localhost` and the laptop's LAN address
  are different origins; allow both, since you will develop against one and
  scan against the other.
- **The frontend must be served over HTTPS.** `getUserMedia` only works in a
  secure context. `localhost` counts as one; `http://192.168.x.x` does not,
  so a phone loading the app over plain HTTP cannot open the camera at all.
  It fails at the camera rather than at page load, which makes it look like a
  device or permissions problem instead of a transport one. Serve the dev
  server with a locally-trusted certificate — mkcert, or Vite's basic-ssl
  plugin — and trust it once on the phone.

Moving to a hosted instance later changes the origins and the key's location.
It changes nothing else, which is the point of keeping the backend stateless.

### Rate limiting and retries

The Gemini Flash free tier allows on the order of ten requests a minute —
the exact ceiling is per-model, so confirm it against whichever model you
pin rather than taking the figure from here. Whatever it is, an instructor
scanning briskly will exceed it. Requirements:

- Frontend queues uploads rather than blocking the camera on each call —
  capture the next script while the previous is in flight.
- Backend retries 429s with exponential backoff. The SDK already does this
  by default — configure its retry options rather than writing the loop by
  hand.
- If retries exhaust, return `status: "failed"`, `failure_reason:
  "rate_limited"`. The session must never die partway through a class.
- A blocked or empty response is a 200, not an error, so nothing retries it
  and nothing raises. Check the block and finish reasons on every response
  and map them to `"model_error"`. Skipping this turns a blocked reply into
  an unhandled `None` at parse time — a crash rather than a review screen
  the instructor can correct.

## 10. Validation and failure handling

**Sum check** (frontend, on render): the question values must sum to the
written total. Mismatch highlights the row. This is the main safety net
against a silent misread, and it now covers half marks too — a `4` read as
`4.5` throws the total off by exactly the amount that makes it visible.

**Legal value check**: any question value must be a multiple of 0.5 within
`0..max`. Enforced on the backend against the model's output and again in
the frontend on manual edit, so a typo during correction can't slip
through either.

**Identity cross-check.** On save, compare against every record already in
the session:

| Situation | Meaning | Action |
|---|---|---|
| Same serial, same ID | Same script scanned twice | Block, offer to overwrite the earlier record |
| Same serial, different ID | One serial was misread | Warn, show both records side by side |
| Same ID, different serial | One serial was misread | Warn, show both records side by side |
| Both fields empty | Unusable record | Block save until one is entered |
| Only one field filled | Valid but unverified | Allow, mark the row unverified in results |

Index the session store by serial and by student ID so this is a lookup on
save rather than a walk over every record. Those indexes must permit
duplicates: a repeated serial is precisely what the check exists to surface,
and a uniqueness constraint would throw on write instead — losing the two
records the instructor needs to see side by side.

**Identity fields are shown first and largest** on the review screen,
above the marks. The instructor is holding the script anyway — confirming
ID and serial takes a second and is the highest-value check in the
workflow. Never render them as ordinary small fields.

The app has no class list, so it cannot tell that a serial is out of range
or that a student was skipped. Both surface when the instructor lines the
export up against their attendance sheet. Say this plainly in the UI at
Finish so it's an expectation, not a surprise.

**Scan failure**: any `status: "failed"` result lands the instructor on
the review screen with empty fields and the reason shown, plus Retake and
Enter manually. A bad photo never blocks the session.

## 11. Frontend screens

### Setup (`/setup`)
```
Quiz name        [________________]
Student ID digits    [ 7 ]
Number of questions  [ 5 ]
  Q1 max [5]   Q2 max [5]   Q3 max [5]   Q4 max [5]   Q5 max [5]

  ⓘ These must match the table pasted in your question paper.

[ Start scanning → ]
```

### Scan (`/scan`)
```
Scanned 7
┌─────────────────────────┐
│      camera preview      │
│   (frame on the grid)    │
└─────────────────────────┘
        [ Capture ]
   (2 uploads in progress…)
```

### Review (`/scan/review`)
```
   ID  [ 1 9 1 2 3 4 5 ]        SERIAL  [ 0 ] [ 7 ]
   ──────────────────────────────────────────────  (large, top of screen)

┌───────────────┐   Q1 [ 4  ]   Q2 [ 3.5 ]   Q3 [ 5  ]
│ deskewed grid  │   Q4 [ 5  ]   Q5 [ 2.5 ]
│ image preview  │   Total [ 20 ]
└───────────────┘

  Sum check: 19.0 vs printed 19.0  ✓ / ✗ (red if mismatch)
  ⚠ shown here if: duplicate / ID-serial conflict / missing identity / scan failed

[ Retake ]                          [ Confirm & next → ]
```

### Results (`/results`)
```
Serial | Student ID | Q1 | Q2 | Q3 | Q4 | Q5 | Total | Check
  01   | 1912301    | 4  | 5  | 3  | 5  | 4  | 21    |  ✓
  02   | 1912345    | 3  | 4  | 5  | 3  | 5  | 20    |  ✓
  —    | 1912377    | 5  | 5  | 4  | 4  | 5  | 23    |  ⚠ no serial
  ...  (inline-editable, sorted by serial then ID)

30 records · 1 unverified. Check against your attendance sheet for gaps.

[ Download Excel ]
```

## 12. Privacy note

The student ID is what makes a captured image personally identifying — an
ID paired with marks is exactly the combination worth keeping away from a
service whose free tier may train on its inputs. Google's own pricing terms
state this plainly: free-tier usage may be used to improve their products,
while paid-tier data is not. Hence step 6 of the scan
pipeline: the ID is cropped and read by a local OCR pass on the backend,
and ID crops are excluded from the composite sent to Gemini. What Gemini
receives is a serial number and some marks, which identify nobody without
the instructor's own attendance sheet.

Be precise about what this does and doesn't guarantee. The full photo is
uploaded to the backend, so the backend does see the ID — that is your own
code and it writes nothing to disk, which is the point. This is *not* a
claim that the ID never leaves the device. Making that true would mean
moving detection and cropping into the browser with OpenCV.js and
uploading only pre-cropped mark cells — worth doing if this ever runs as a
hosted service for other faculty, unnecessary for a self-hosted pilot.

## 13. MVP scope

In scope: setup, proportional grid detection, scan loop with queued
uploads, local ID recognition, review/edit with sum-check and identity
cross-checks, failure handling, Excel export.

Deferred:
- Client-side detection and cropping (OpenCV.js), so raw photos never
  leave the device. Worth doing before other faculty use a hosted
  instance.
- Roster import for range validation and coverage checking. Skipped
  deliberately to avoid file-upload complexity.
- Local digit classifier for marks too (TFLite/ONNX) — only if Gemini
  accuracy or quota becomes a real constraint.
- Server-side database and multi-quiz history.
- Multi-user auth.

## 14. Build order

0. **Collect the test-image set** (section 6). Do this before writing any
   code — the detector is tuned against these, not against an idea of
   what a photo looks like.
1. **Standalone detection harness** (section 6): `detect.py` producing
   overlays, cell crops, and a shape report. Iterate until it passes the
   definition-of-done bar on the whole set. Expect this to take longer
   than any other single step, and expect that to be time well spent.
2. Local ID OCR pass, still standalone, run over the cell crops from
   step 1. Test in isolation — the ID has no arithmetic guard and no
   second opinion.
3. Gemini call for serial and marks (tiled composite, constrained value
   set, structured JSON), still standalone.
4. **Only now wrap steps 1–3 in FastAPI** as `POST /api/scan`. By this
   point the hard part is already proven and the endpoint is a thin
   wrapper over working code.
5. Frontend setup screen: config → IndexedDB.
6. Camera capture + upload queue + raw result rendering.
7. Review screen: editable fields, sum-check, identity cross-checks,
   failure states.
8. Scan loop wiring (Next → save → reopen camera).
9. Results table + Excel export.

The ordering is deliberate: everything before step 4 runs as a script
against a folder of images, which is a far faster loop than anything
involving a camera, an upload, and a browser. Do not build the app
scaffolding first and discover the detector's limits through it.

## 15. Resolved decisions

- Marks are written as plain numbers (`4`, `4.5`) in one cell per
  question. The earlier separate half-mark tick column was dropped as
  unfriendly to the person doing the grading; constraining the model to
  the legal value set recovers the accuracy it was there to provide.
- Student IDs are 7 digits, one box each — fixed length, so per-digit
  boxes are unambiguous and help recognition.
- Serial is a single free cell, deliberately not per-digit boxes. Serial
  length varies and students write `2` or `02` interchangeably; in a
  two-box field a lone `2` is ambiguous between serial 2 and serial 20
  with a blank box. One cell takes either form and the app strips leading
  zeros when comparing.
- Detection is built and tuned standalone against a fixed set of
  deliberately imperfect photographs before any API or UI exists. It is
  the only component with no manual fallback, so it sets the ceiling on
  how well the whole thing works.
- No template generator. The grid is a Docs/Word table pasted into the
  question paper — nothing extra to print or staple, and one fewer
  component to build and keep in sync with the detector.
- Detection is proportional to the detected table rather than fixed page
  coordinates, since the pasted grid can sit anywhere at any size. The
  table's own borders replace the corner markers.
- Both student ID and serial are captured. Students frequently don't write
  or don't know their serial, so ID is the reliable field in practice.
  Having both also gives the cross-check that replaces roster validation.
- Pre-printing serials on sheets was considered and rejected —
  distributing the right numbered sheet to each student costs more time
  than it saves.
- No file uploads. Config in at the start, file out at the end.
- The student ID is read locally and excluded from anything sent to
  Gemini.
- Excel export uses ExcelJS rather than SheetJS. SheetJS Community Edition
  is the more actively developed of the two, but its npm package has been
  frozen since 2022 with two unpatched advisories against it, and current
  builds ship only from the vendor's own CDN. ExcelJS is MIT, installs from
  npm normally, and is more than enough to write a plain grid of numbers —
  though its own last stable release was October 2023, so neither option is
  under active npm maintenance. Worth revisiting only if the export ever
  needs styling or streaming.
- The backend runs on the instructor's laptop for the pilot rather than on a
  hosting free tier. Railway no longer offers one, and Render's spins a
  service down after fifteen minutes idle with a cold start of up to a
  minute — which lands on the first script of every class. Running locally
  removes the wait, the account, and the deploy step at once.
- Everything in the stack is open source except the Gemini API, which is a
  proprietary hosted service with a free tier. That is the project's one
  external dependency, and section 13's deferred local mark classifier is
  what would remove it.
