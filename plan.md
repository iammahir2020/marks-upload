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

**The diagram above describes `RECOGNIZER=remote`.** Since step 3r.6e the
default is `RECOGNIZER=cnn`, where the whole right-hand column disappears:
a local CNN reads the ID, serial and marks, and no request leaves the
laptop. Section 16 covers that path in full; the OpenCV detection stage,
the API contract, and every validation rule below are identical either way,
which is the point of putting both behind one `Recognizer` protocol.

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
| Hosting | None for the pilot — both halves run on the instructor's laptop. A free-tier hosted demo on AWS (Lambda behind API Gateway; S3 + CloudFront) is `step.md` step 11, see section 13 | No account, no deploy step, no cold start. See "Running locally" in section 9. The laptop path stays supported; hosting is additive, and sized to AWS's always-free tiers rather than to credits. **Shipped 2026-08-31** — API Gateway, not the Function URL this plan originally specified; see section 13 for why. |

This table is the baseline (Gemini + Tesseract) stack and stays accurate for
the `RemoteRecognizer` path. Section 16 adds a second local path (a small
CNN via ONNX Runtime) behind the same interface — additive, and a
replacement for nothing in this table.

**As of step 3r.6e (2026-08-30) that second path is the default**, so for a
default run the two recognition rows above are replaced by:

| Layer | Choice | Why |
|---|---|---|
| ID + serial + mark recognition | Local digit CNN, ONNX Runtime | 91.8% per-digit on the ID vs Tesseract's 58.9%; no key, no quota, no network, nothing leaves the laptop. Section 16 has the full numbers and caveats. |

`onnxruntime` and `scipy` therefore sit in `requirements.txt`, not in the
optional `requirements-cnn.txt` — the app cannot start without them.
`torch` stays training-only. Everything else in the table is unchanged, and
`RECOGNIZER=remote` still selects exactly the stack listed above it.

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

**Steps 5–8 above describe `RECOGNIZER=remote`.** On the default `cnn`
path they collapse into a single local inference pass that reads the ID,
serial and marks together — no composite image, no API call, no retry
policy. Steps 1–4 (decode, detect, deskew, split) and step 9 (assemble
`ScanResult`) are identical on both paths, as are the early exits: no
recognizer of any kind runs after `table_not_found` or
`column_count_mismatch`. The legal-value rejection in step 8 also applies
to both — the CNN's decoder is constrained to legal values by
construction, but the check is not conditional on that.

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

**That prediction held, with two caveats found when it was actually
specced** (`step.md` step 11). The origins are indeed the main change — the
CORS regex here matches only localhost and private LAN ranges, and a public
frontend is rejected by it — while the key's location stops mattering at
all, since the default recognizer makes no API call. The caveats are both
about statelessness being *less* true than this paragraph assumes:

- ~~The `debug_uploads/` capture added during step 6 phone debugging writes
  every upload to disk.~~ **Resolved (step 11.0.1, 2026-08-30):** the block
  is gone from `main.py` and the directory — 605 real scripts, 99 MB — is
  deleted. Verified adversarially rather than assumed: a real scan through
  the endpoint now writes nothing at all under `backend/`.
- Section 16's harvester deliberately persists labelled cell crops. That is
  wanted, but it means the deployed backend needs durable storage — and no
  mainstream free tier provides a persistent disk, so those crops have to
  go to object storage rather than the container filesystem.

On the chosen target (AWS Lambda, section 13) both of these stop being
judgement calls: the filesystem is read-only outside `/tmp`, so either
write path fails outright on the first scan. The stateless property this
section claims has to become literally true before the app will run at
all — which is a better forcing function than any amount of documentation.

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

**The default recognizer strengthens this considerably** (section 16, step
3r.6e). On `RECOGNIZER=cnn` there is no outbound API call at all: no
serial, no marks, no composite image leaves the laptop, so the free-tier
training concern above simply doesn't arise. The precision above still
holds exactly as written, though — the photo does travel from the phone to
the laptop, so the accurate claim is "**no third party ever sees a
script**", not "the ID never leaves the device". The remaining paragraph
above stays relevant because `RECOGNIZER=remote` is still supported, and
because the browser-side-cropping upgrade is what the stronger claim needs
regardless of recognizer.

**Hosting weakens this, and the wording has to follow** (`step.md` step
11). On the laptop, "the backend sees the ID but it is your own machine" is
a genuine answer. On a hosted demo it is someone else's machine, handling
other faculty's students' scripts. What step 11 commits to instead:

- **No whole script is stored anywhere.** The photo is processed in memory
  and discarded. This required deleting the `debug_uploads/` capture first
  (section 9), which made the claim false — **done in step 11.0.1
  (2026-08-30)**, so the claim is now true on the laptop as well.
- **What persists is individual labelled cell crops** — one digit each,
  with no name, no ID, and no shared key linking one student's crops
  together. Step 11.0.2 closed the one remaining link: the crops were
  written in loop order, so file mtimes reconstructed an ID that the
  per-crop UUIDs were meant to scatter. **Done 2026-08-30** — every crop
  now gets a constant mtime, and the ~700 crops already collected before
  the fix were backfilled to match, since those are exactly the corpus
  11.2 uploads to S3. The leak was confirmed real before fixing, not
  assumed: 2 of the 18 real class IDs were recoverable verbatim from the
  mtime-ordered digit stream, and neither is afterwards.
- **Faculty are told this in the interface**, not in a document. Their
  students' handwriting becomes training data; that is a disclosure
  obligation, not a footnote.

The honest summary for a hosted demo is "no third party AI service sees a
script, nothing is stored, and loose unlabelled digits are kept to improve
recognition" — not "your data never leaves your device".

## 13. MVP scope

In scope: setup, proportional grid detection, scan loop with queued
uploads, local ID recognition, review/edit with sum-check and identity
cross-checks, failure handling, Excel export.

**Scope extension (2026-08-30): a free-tier hosted demo.** Hosting was out
of scope below, and the reasoning for that — one instructor, one laptop, no
account to keep alive — was right for the pilot. The goal changed: other
faculty trying it on their own phones, on their own networks. That is
`step.md` step 11, and it does not alter the laptop workflow, which remains
the supported path. Two things make it affordable that weren't true when
this section was written: section 16's CNN is now the default, so there is
no API key to share and no shared quota for faculty to exhaust between
them; and the app idles at 124 MB, which fits a free tier. One constraint
shapes the whole step — **no mainstream free tier offers a persistent
disk**, so harvested crops (section 16) must go to object storage rather
than the app host, or they are lost on every redeploy.

**Target: AWS** (decided 2026-08-30). The design deliberately sits inside
AWS's *always-free* tiers — Lambda for the backend (1M requests + 400,000
GB-s/month, permanent), S3 + CloudFront for the frontend (1 TB
egress/month, permanent), S3 for the crops — rather than spending the
available credits, so the demo survives their expiry. Measured against this
workload that is roughly 100,000 free scans a month against a realistic
load of a few hundred. Lambda sharpens the disk constraint above rather
than softening it: its filesystem is read-only outside `/tmp`, so the two
write paths named in section 9 raise `OSError` there instead of quietly
losing data.

**Deployed 2026-08-31, with one deviation from what this section
originally specified.** The plan said "Lambda behind a Function URL",
chosen over API Gateway on cost and its 29-second timeout. That could not
be made to work on this account, which refuses Function URL invocation by
any non-IAM principal: `AuthType NONE` with a correct public resource
policy returned 403, CloudFront's service principal with a correct OAC
grant (verified principal, action, `FunctionUrlAuthType` and a matching
`SourceArn`) also returned 403, and only a directly IAM-signed request
succeeded. **API Gateway fronts the Lambda instead.** The costs the plan
worried about turned out not to bind — ~$0 at a few hundred requests a
month — but the 29–30s timeout is a real constraint against a measured
~9s cold start, which is why `deploy.sh` wires in a warm-up rather than
leaving it as advice. The live URL is <https://d2n2meq17rr1oi.cloudfront.net>;
CloudFront serves the S3 frontend and routes `/api/*` to API Gateway, one
origin, so there is no CORS anywhere.

Deferred:
- Client-side detection and cropping (OpenCV.js), so raw photos never
  leave the device. Worth doing before other faculty use a hosted
  instance. **Still deferred as step 11 proceeds without it** — the
  accepted position is that a hosted demo handles photos in memory and
  stores none, which is weaker than "never leaves the device" and must be
  stated to users rather than glossed (section 12).
- Roster import for range validation and coverage checking. Skipped
  deliberately to avoid file-upload complexity.
- Local digit classifier for marks too (TFLite/ONNX) — only if Gemini
  accuracy or quota becomes a real constraint. **Update:** both conditions
  were hit for real during steps 2–3 (Tesseract measured at 58.9%
  per-digit on real photos; a genuine `rate_limited` response during live
  phone testing) — see section 16, which picks this item back up as an
  additive, optional path rather than a required rewrite.
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

Section 16 adds an optional parallel track (`step.md` steps 2r.0, 2r, 3r,
3r.6) that slots in after step 3 is done — it extracts the existing
recognition code behind a shared interface, then adds a local CNN behind
that same interface as a second, selectable implementation. It does not
renumber or replace steps 4–10 above; those proceed the same regardless of
whether the CNN track is picked up.

`step.md` step 11 (free-tier demo deployment) sits after step 10 and is
likewise additive — see the scope note in section 13. Its first substep
(11.0) is not deployment work at all: removing the temporary
`debug_uploads/` capture, which stored whole scripts and contradicted the
stateless-backend property section 9 commits to, and closing an ordering
leak in the harvester that let file mtimes reconstruct a student ID the
per-crop UUIDs were meant to prevent. Both were defects independent of
hosting, worth doing whether or not step 11 proceeded — **and both are now
done (2026-08-30)**, shipped on their own as phase A ahead of any
deployment work.

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
  what would remove it. Section 16 is that classifier, built additively
  once the deferral's own trigger condition (real accuracy or quota
  pressure) actually happened.
- The local CNN path (section 16) is added *beside* the Gemini+Tesseract
  path, not in place of it, behind a shared `Recognizer` interface,
  selectable via an environment variable. Both paths stay in the repo
  indefinitely — the existing path is the only independent check available
  on the local model's output, and reverting to it costs nothing.

## 16. Local CNN recognizer (optional, alongside Gemini)

Adds a local CNN recognition path **beside** the existing Gemini +
Tesseract path, behind a common interface, with the CNN eventually the
default once it earns that. Nothing already built gets deleted. Detection
(section 5/6) is untouched — it works, and none of this affects it.

Originally drafted as a standalone note (`Cnn migration.md`) after steps 2
and 3 were both in progress and step 7 was done; folded in here once that
draft was reviewed. Section 13's MVP scope already deferred a local mark
classifier "only if Gemini accuracy or quota becomes a real constraint" —
this section exists because that trigger condition was hit for real, not
speculatively:

- **Cost and quota.** The Gemini free tier rate-limited during actual live
  phone testing (`step.md` step 3's Progress note) — not a hypothetical,
  a real `rate_limited` response mid-session. A local model has no ceiling
  and no bill.
- **Tesseract is measurably the wrong tool for this, not just imperfect.**
  58.9% per-digit accuracy, 0-of-8 whole-ID exact match, after two real
  rounds of tuning (`step.md` step 2's Progress note). The diagnosis
  matters more than the number: Tesseract's LSTM engine read a handwritten
  `0` as the letter `D` at 86% confidence and a `1` as `l` at 90% — it is a
  text engine, and letters are always in its output space. A 10-class
  digit classifier cannot make that specific error at all.
- **Latency.** Tesseract runs roughly 50–100ms per digit — around 700ms
  for one 7-digit ID. A small CNN reads all seven in one batched forward
  pass, under 5ms on CPU.

When the CNN path is selected: section 12's privacy argument becomes
trivially true (nothing leaves the machine at all, not even the serial and
marks), `rate_limited` is unreachable, and `marks_ocr.py`'s degraded
rate-limit fallback (added after the live `rate_limited` hit — see
`step.md` step 3) has nothing to fall back *from*. These properties are
per-path, not global: the Gemini path keeps its existing behavior and its
existing caveats whenever it's the one selected.

### Architecture: one model, ten classes, used three ways

```
                          ┌──────────────────┐
   ID cells (7)  ────────►│                  │──►  7 digits, batched
                          │   digit CNN      │
   Serial cell   ──seg──► │   10 classes     │──►  glyph probabilities
                          │   ~150KB ONNX    │        │
   Mark cells    ──seg──► │                  │──►     │
                          └──────────────────┘        ▼
                                                constrained decode
                                                against legal values
```

**ID** needs no segmentation — the template already gives one digit per
box (section 3), which is exactly why those boxes exist. Seven crops go
through as one batch.

**Serial and marks** hold multiple glyphs in one cell, so they need
segmentation first (below), then constrained decoding to assemble a legal
value.

**The decimal point is not a CNN class.** There is no training data for a
handwritten decimal point and no need for any — it is a connected
component with tiny area sitting low in the glyph band, pure geometry, no
model. Keeping the model at ten classes means a standard digit dataset
(EMNIST) works as-is with no relabelling.

### Two paths behind one interface

Neither path is special-cased in `main.py`. Both implement the same
protocol and the pipeline calls whichever is selected:

```python
# app/recognizers/base.py
from typing import Protocol

class Recognizer(Protocol):
    name: str

    def read_id(self, id_crops: list[np.ndarray]) -> IdResult:
        """Seven single-digit crops → digits + confidence per position."""

    def read_marks(
        self, serial_crop: np.ndarray,
        mark_crops: list[np.ndarray],
        total_crop: np.ndarray,
        config: QuizConfig,
    ) -> MarksResult:
        """Cell crops → serial, per-question values, total."""
```

Two implementations:

- `recognizers/remote.py` — `RemoteRecognizer`, wrapping the existing
  `id_ocr.py` (Tesseract) and `marks.py` (Gemini), including `marks_ocr.py`
  as its internal rate-limit fallback. **Moved, not rewritten** — the
  logic inside is already tested and tuned; this is an import-path change
  plus a thin adapter.
- `recognizers/local.py` — `CNNRecognizer`, the segmentation + constrained
  decoding below.

Selection by environment variable:

```python
RECOGNIZER = os.getenv("RECOGNIZER", "cnn")   # "cnn" | "remote" | "both"
```

The default was `"remote"` as originally written here — this section added
the option without flipping the default on arrival, deliberately. **It was
flipped to `"cnn"` on 2026-08-30** (step 3r.6e) once the 18-photo
real-class batch gave real numbers to decide on: 91.8% per-digit / 55.2%
whole-ID against Tesseract's 58.9% / 0.0%, and 98.1% per-question on marks
(half marks 100%).

The accuracy gap on the ID is the headline, but not the whole argument.
The CNN path costs nothing per scan, has no quota to exhaust in the middle
of a class, needs no network, and keeps every photo on the instructor's own
laptop — which is the privacy property section 12 otherwise has to
qualify. A rate-limited Gemini mid-session is a real failure mode this
removes outright.

Two honest caveats, accepted rather than overlooked:

- **Serial is the CNN's weakest field at 63.2%**, and there is no Gemini
  baseline on the same batch to compare it against, because the full
  comparison run below never happened. This is survivable because a
  low-confidence serial is flagged blank rather than guessed, identity
  holds on the student ID alone (section 10's "at least one non-null"
  rule), and the instructor confirms every scan anyway — but it is the
  first thing to fix, and the likeliest culprit is segmentation of the
  two-digit serial cell rather than the classifier.
- **Both accuracy harnesses report one confidently-wrong case**, against
  the bar stated below that it must stay zero. One genuinely ambiguous
  cursive digit, not a systematic error — but the bar is the bar, and it
  is not currently met.

`RECOGNIZER=remote` remains fully supported as the fallback. `main.py`
resolves the choice once at startup and holds the instance. The
pipeline's existing early exits are unchanged: no recognizer is called
after `table_not_found` or `column_count_mismatch`, whichever is selected
(section 9 step 2, unchanged).

**Comparison mode.** `RECOGNIZER=both` runs both paths and returns the
CNN's result, while logging every field where they disagree:

```json
{
  "image": "phone_003.jpeg",
  "field": "q3",
  "cnn": {"value": 4.5, "confidence": 0.71},
  "remote": {"value": 4.0, "confidence": null},
  "confirmed": 4.5
}
```

This is worth more than it looks: the labelled set is thin (`testset/
labels.json` — see step 0/2's own repeated caveat about sample size), so
accuracy numbers alone are noisy, but disagreements are self-selecting
hard cases, and the instructor's confirmation on the review screen (step
7, unchanged) resolves each one into a labelled sample. Running `both` for
a full quiz gives a targeted error analysis and a batch of training labels
from the same session. Don't run `both` in normal use — it costs Gemini
quota for no benefit once the CNN is ahead.

`rate_limited` stays in the failure-reason enum (section 8) — unreachable
under the CNN path, still reachable under the remote one, and removing it
would break the path this section deliberately keeps.

### Segmentation (serial and mark cells only)

Per cell, after the 12% inset already established in `id_ocr.py` (step 2):

1. Otsu binarize.
2. `cv2.connectedComponentsWithStats`.
3. Drop components below a noise-area floor (a fraction of cell area).
4. **Merge horizontally-overlapping components.** A `4` or `5` written with
   a disconnected stroke produces two components that are really one
   glyph. If two components' x-ranges overlap by more than ~50% of the
   narrower one, merge them — the single most common segmentation failure,
   and cheap to fix.
5. Sort remaining components left to right by centroid x.
6. **Classify each as digit or decimal point:** a component whose height
   is below ~35% of the median component height *and* whose centroid sits
   in the lower third of the glyph band is a decimal point; everything
   else is a digit.

Blank detection happens before any of this — count ink pixels after
binarizing and return empty below a threshold. A classifier always outputs
*something*; feed it a blank cell and it returns a confident wrong digit.
This is already the right behavior in `id_ocr.py`; the CNN path keeps it.

### Constrained decoding

This is what makes local recognition beat the Gemini path rather than
merely match it — and it's where the constrained-value-set design from
section 5/9 (the legal-value enumeration Gemini's prompt already relies
on) pays off again on a different recognizer.

Don't parse the CNN's output into a string and validate afterward. Score
every legal value directly against the per-glyph probabilities:

```python
def decode_cell(glyph_probs, has_decimal_at, legal_values):
    """
    glyph_probs: list of (10,) probability vectors, left to right
    has_decimal_at: index where a decimal point was found, or None
    legal_values: e.g. [0, 0.5, 1, 1.5, ... 5] for a 5-mark question
    Returns (value, confidence) or (None, confidence) to flag.
    """
    best, best_score = None, 0.0
    for value in legal_values:
        digits = [int(c) for c in f"{value}".replace(".", "")]
        expects_decimal = "." in f"{value}"

        if len(digits) != len(glyph_probs):
            continue
        if expects_decimal != (has_decimal_at is not None):
            continue

        score = 1.0
        for d, probs in zip(digits, glyph_probs):
            score *= probs[d]

        if score > best_score:
            best, best_score = value, score

    if best_score < DECODE_FLOOR:
        return None, best_score
    return best, best_score
```

For a 5-mark question that's eleven candidates — trivial to enumerate.
`45` can never be returned, because it isn't a candidate. A smudged `4.5`
that a free-form parser would read as `45` resolves correctly by
construction, not by validation after the fact — the same principle
section 9 step 8 already applies to Gemini's output, pushed one layer
earlier.

Same mechanism for serial (legal set: every integer the class could
plausibly use — `2` and `02` both decode to 2, mirroring the leading-zero
stripping already in `StudentRecord.serial`) and for total (legal set:
multiples of 0.5 in `0..totalMax`).

`DECODE_FLOOR` starts around 0.3 and gets calibrated on real data — treat
it exactly as provisionally as `id_ocr.py`'s own `CONFIDENCE_FLOOR` is
already annotated in code.

### Confidence, and when to flag

Two signals, both needed: **max probability** (the top class's score) and
**margin** (top-1 minus top-2 — a `4` at 0.51 with `9` at 0.47 close
behind is worse than a `4` at 0.70 with nothing close, even though the max
is lower in the second case). Below either threshold, add the field to
`low_confidence_fields` and leave it blank — the existing review screen
(step 7) already renders these with an amber border, so no frontend change
is needed for this path at all.

The bias here is the one already established and validated in step 2's
own notes: **0 confidently wrong matters more than raw accuracy**, because
a flagged blank costs the instructor one second and a confident wrong
digit costs a student their marks.

### Model and training

Deliberately small — this is MNIST-class difficulty, and a large model
buys nothing but latency:

```
Conv(1→32, 3x3) → BN → ReLU → Conv(32→32, 3x3) → BN → ReLU → MaxPool → Dropout(0.25)
Conv(32→64, 3x3) → BN → ReLU → Conv(64→64, 3x3) → BN → ReLU → MaxPool → Dropout(0.25)
Flatten → Linear(→128) → BN → ReLU → Dropout(0.5) → Linear(→10)
```

~150KB as ONNX, sub-millisecond per batch on CPU.

**Data: EMNIST Digits, not MNIST** — 240k training samples versus MNIST's
60k, and considerably more writer variety. Same 28×28 format, so
preprocessing is identical. EMNIST ships transposed relative to MNIST;
images need `.transpose(1, 2)` or the model trains on rotated digits —
this bites everyone once.

**Preprocessing must match MNIST's normalization exactly** — worth more
than any architecture change, and getting it wrong is the most common
reason a model scoring 99% on test data performs badly on real crops. Per
digit crop: inset 12% (already in `id_ocr.py` — the same fix that stopped
the cell border reading as extra ink), Otsu binarize (white ink on black),
crop tight to the ink bounding box, scale so the longest side is 20px
preserving aspect ratio, then paste onto a 28×28 black canvas **centered
by centre of mass, not by bounding-box centre** — that last detail is
exactly how MNIST itself was built, and centering by bounding box instead
looks correct while costing several points of accuracy, because the
training distribution the model learned is centre-of-mass centered.

**Augmentation:** rotation ±10°, translation ±2px, scale 0.9–1.1, slight
elastic distortion — real photographed digits have residual skew that
deskewing doesn't fully remove.

**Test-time augmentation:** since inference is ~1ms, run each crop at 3–5
small perturbations and average the probability vectors. Almost nobody
does this because it's normally too expensive; at this scale it's free and
measurably helps borderline cases. Apply it to the ID especially, which
has no arithmetic guard the way marks do (section 10's sum check).

### Collecting real handwriting samples

EMNIST is American handwriting from the 1990s. Local handwriting
conventions differ in exactly the places that matter — a crossed `7`, a
closed `4`, a `1` with or without a base serif. A cold EMNIST model
systematically misreads whichever conventions the actual writers use, and
no amount of augmentation fixes a style mismatch. Hand-collected samples
fix it — but *whose* hand matters, and the answer differs by field:

- **Marks are written by one person, every time, forever** — the
  instructor grading the quiz. Training on that one person's handwriting
  for the marks field isn't overfitting, it's targeting the exact
  distribution production will see. A few hundred of their own samples is
  close to ideal here.
- **IDs and serials are written by students** — many writers, changing
  every semester, most never seen in advance. The instructor's own samples
  are nearly useless for this field. What helps is writer *variety*:
  fifteen different hands beats three thousand samples of one.

Collect both, tagged by writer so they can be weighted differently during
fine-tuning — heavily toward the instructor's hand for marks, evenly
across writers for the ID.

**The collection sheet** reuses the existing detector rather than needing
new infrastructure: a `.docx` variant of the marks-grid template (section
3), one row per digit 0–9, ~20 empty cells across. The labels come from
row position, so there is no manual annotation at all. ~200 samples per
sheet; six or seven sheets gets ~150 per digit, enough to fine-tune well —
an evening's work, not a project. Same pen and paper as real quizzes,
written at normal speed (not carefully formed), including genuinely messy
variants — the point is covering the cases that fail, not the ones that
already work.

**Harvesting labels from real use.** The review screen (step 7) is already
a labelling machine: every digit the instructor confirms or corrects is a
labelled crop of exactly the handwriting that matters, including student
handwriting that could never be collected in advance. On Confirm, POST the
cell crops alongside the confirmed values to `training_data/harvested/`,
tagging corrections separately from confirmations — corrections are the
model's actual failures and worth oversampling; confirmations mostly
re-teach what it already knows. Build this collection path as part of the
CNN work even though nothing consumes it immediately; retrofitting later
means discarding every label from the pilot, which is the period these
labels matter most. One 30-student class yields roughly 210 labelled ID
digits — three or four quizzes is enough to fine-tune meaningfully.

**A hosted demo turns this into the fastest path to 3r.6b.** Collecting
from four writers has been the blocker; a handful of faculty each running a
class produces far more diverse handwriting than any collection sheet
would, as an ordinary by-product of use. Two constraints come with it
(`step.md` step 11): the crops must be written to object storage — S3 on
the chosen AWS target — rather than the app's own disk, since a Lambda
filesystem is read-only outside `/tmp` and no free tier keeps a filesystem
across redeploys anyway. The volume is trivial, roughly 50 KB per student,
so 10 GB holds on the order of 200,000. And the people using it have to be
told plainly that their students' handwriting is being kept (section 12).

**Multi-writer collection needs a source tag, which the harvester does not
currently write.** `harvest.py` names crops `<value>_<uuid>.png` with no
writer or session information — adequate for one instructor, and actively
disabling for several, because the held-out-writer evaluation this section
requires below becomes impossible once everyone's crops pool anonymously
into one bucket. It also cannot be reconstructed later, so it has to be in
place *before* faculty start filling it. The layout becomes
`harvested/<source-id>/<field>/{confirmed,corrected}/<value>_<uuid>.png`,
with the id **per-faculty**: coarse enough that a prefix holds a whole
class mixed together and identifies no student, fine enough to hold out one
writer entirely. It must be random and client-generated — a per-scan id
would regroup one student's digits and undo the unlinkability described in
section 12.

**Fine-tuning:** freeze the conv layers, retrain the classifier head at a
low learning rate (~1e-4), hold out a real, unseen-writer photo set to
measure against. Two separate fine-tuned heads on the same base model —
one weighted toward the instructor's hand for marks, one weighted across
writers for the ID.

### Serving

Train in PyTorch, export to ONNX, serve with `onnxruntime`:

```bash
pip install onnxruntime numpy opencv-python   # runtime
pip install torch torchvision                 # training only, not in requirements.txt
```

`onnxruntime` is ~15MB against PyTorch's ~800MB, and the backend only ever
does inference — keep `torch` in a separate `requirements-train.txt` so
the deployed backend doesn't carry it. Load the session once at module
import, not per request (same statelessness rule as section 9, applied to
model loading rather than request data).

### Open risks

**Segmentation is the new fragile part** — it's doing work Gemini did
invisibly. Touching digits and disconnected strokes are the two failure
modes; the overlap-merge rule addresses the second, the constrained
decoder absorbs some of the first. Watch it specifically in the accuracy
harness, not just in aggregate numbers.

**Cold-start accuracy on real handwriting is unknown.** EMNIST gives a
strong prior, not a guarantee. The honest expectation is a large
improvement over 58.9% per-digit but whole-ID exact match still poor until
fine-tuning — plan around the review screen catching it, which it already
does, and keep `RECOGNIZER=remote` available as the fallback while that's
still true.

**This prediction held almost exactly** (measured 2026-08-30): 91.8%
per-digit, a large improvement as expected, with whole-ID exact match at
55.2% — still poor, still pending fine-tuning, exactly as anticipated.
The review screen catching it is what makes the default flip defensible;
`RECOGNIZER=remote` stays available.

**Self-collected samples can narrow the model rather than widen it.** If
every sheet is the instructor's own handwriting, fine-tuning makes the ID
model worse on students, not better. Per-writer tagging exists so this is
measurable rather than a surprise: hold out an unseen writer entirely and
measure against them, not against a random split of samples collected
together.

**The per-writer tagging this risk depends on was never actually built** —
found 2026-08-30 while planning the hosted demo. `harvest.py` writes
`<value>_<uuid>.png`, so the mitigation described above cannot currently be
carried out on harvested data at all. `step.md` step 11.2.4 adds it. Two
things follow. First, everything harvested up to that point is untagged and
can only be treated as one undifferentiated pool. Second, this is the
clearest instance in the project of a stated mitigation quietly not
existing in code: the risk was correctly identified here, and the paragraph
reads as though something guards against it.

**Class imbalance in harvested data is not hypothetical.** Measured across
the 727 crops collected by 2026-08-30: ID digits range from 20 (`4`) to 80
(`2`), a 4× spread, and marks are far worse — whole numbers appear 33–58
times each while **half marks appear only ~8 times each**, roughly 6×
under-represented despite being the harder case the constrained decoder
exists for. Fine-tuning without weighted sampling would bias the model
toward what it already reads most easily.

**The confirmed/corrected split can be polluted by how data is loaded.**
`harvest_real_photos.py` posts `original == confirmed`, so its whole batch
lands in `confirmed/` regardless of what the model would have read. Those
crops remain valid *labelled data*, but `corrected/` is not a complete
record of model failures, and oversampling it does not mean what this
section assumes unless the loader preserved a true original.

**A stray pen dot could read as a decimal point.** The sum check (section
10) catches it — a `4` read as `4.5` throws the total off by exactly
enough to be visible. This is precisely the failure the sum check was
designed for, now protecting a second recognizer instead of one.

### Migration steps

The concrete build order (Recognizer extraction → train the CNN →
segmentation/decoding → real-sample collection and comparison run) is
`step.md` steps 2r.0, 2r, 3r, and 3r.6 — slotted in after step 3, before
step 4, without renumbering anything already built.
