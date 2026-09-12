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
(pilot: CSE211L). No auth, no server-side database. **No file uploads**
described the MVP pilot; section 17 (2026-09-07) adds one, optional, kind —
the instructor's own class-list workbook — on the instructor's own request,
detailed there rather than here.

## 2. Identity fields — why both

The sheet carries **student ID and serial**. Serial is fixed per course
from the attendance sheet, but in practice many students don't write it
and many don't remember it, so serial alone is unreliable. ID is what
students actually know.

Capturing both is also the app's strongest correctness guard. With two
independent identifiers, a misread in either becomes visible: if two
scripts resolve to the same serial but different IDs, one was read wrong.
That conflict check is what replaced a class roster for the pilot, without
requiring any upload.

**Update (section 17, 2026-09-07):** an upload is no longer categorically
ruled out. Section 17 adds an *optional* roster upload — the instructor's
own semester marksheet, read for its `STUDENT ID`/`STUDENT NAME` columns —
which the cross-check above still runs alongside, unweakened. The
duplicate-serial/duplicate-ID check here is still the app's only defense
when no roster is supplied; the roster is an additional, opt-in signal on
top of it, not a replacement.

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

> **§18 wraps these rather than replacing them — built 2026-09-10**
> (step.md step 13, Phases A/B). `QuizConfig`'s fields survive unchanged
> as the shape `assessmentConfig()` derives from an `Assessment` plus its
> `Section` (idDigits is read from the Section, not duplicated onto the
> Assessment — see §18), and `StudentRecord` gained the one field this
> note said it would, `assessmentId`. The API contract in §9 is untouched
> — the models below are still exactly what crosses the wire; this step
> never touched the backend at all.

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

> **§18 adds two screens ahead of these — built 2026-09-10 (step.md step
> 13, Phases A and B)**: a **Library** (`Library.tsx`) — semester → course
> → section → assessment — which is now the app's entry point, and a
> **Section** screen (`SectionForm.tsx`) owning the class list and the
> ID-digit count. Setup split in two as specced: the durable half moved
> to Section, and what remains below as "Setup" is now `AssessmentForm
> .tsx` — the quiz's own question config, with ID digits removed (it asks
> the Section instead). `Setup.tsx` itself no longer exists as a file.
> The three screens below (Scan, Review, Results) kept their behaviour
> exactly as this note originally said they would; `config === null` is
> no longer the router — `App.tsx` has a real screen enum instead.

### Setup (`/setup`) — historical mockup, now `AssessmentForm.tsx`

The shape below predates step 13 and shows the form as it looked when it
asked for everything in one screen. `AssessmentForm.tsx` today omits
"Student ID digits" (inherited from the Section) and nothing else in this
mockup changed.
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
  deliberately to avoid file-upload complexity. **Picked up 2026-09-07**:
  see section 17. What changed the calculus is that the roster already
  exists, in a file the instructor keeps all semester — so the complexity
  being avoided turned out to be a file picker, not a roster management
  system. Specced in step.md step 12; **all four phases built 2026-09-07**, plus six fixes from real phone use.
- Local digit classifier for marks too (TFLite/ONNX) — only if Gemini
  accuracy or quota becomes a real constraint. **Update:** both conditions
  were hit for real during steps 2–3 (Tesseract measured at 58.9%
  per-digit on real photos; a genuine `rate_limited` response during live
  phone testing) — see section 16, which picks this item back up as an
  additive, optional path rather than a required rewrite.
- A **server-side** database. (Multi-quiz history is no longer part of
  this bullet — it was written as one item with the server, which
  conflated a backend with *remembering more than one quiz*. Holding a
  semester locally needs neither a server nor an account: see §18, picked
  up 2026-09-09 as step.md step 13, specced and not yet built.)
- Multi-user auth.
- **A deliberate override for a mark above a question's printed max.**
  Raised 2026-09-09 as a real want, not yet specced or built. Today a mark
  outside `[0, max]` is unrepresentable **by design** (§4, §10, and
  CLAUDE.md's "never store a wrong number") — `decode_value` never even
  scores it as a candidate, and `isLegalValue` blocks Confirm client-side
  and `legal_values` rejects it server-side, so there is no way to type
  `6` on a 5-mark question and save it, however many times the instructor
  tries. That is correct for the case this was built for: a misread ink
  glyph or a printed-max/actual-answer mismatch, where the honest move is
  to flag and let the instructor check the paper (N31/N33, fixed
  2026-09-09, exist specifically to make that flag informative instead of
  a silent blank).

  What it can't yet do is the case where the instructor **means** it — a
  genuine bonus mark, a partial-credit scheme that legitimately exceeds
  the printed max on one script. Today the only route is outside the app
  entirely: let the field flag blank as designed, export, and hand-edit
  the cell in the exported `.xlsx` (the plain download is unprotected, so
  this works, but it's invisible to the app and to `sumCheck`/the
  identity cross-check from that point on).

  Two directions worth weighing when this is picked up, not yet decided
  between:
  - **A per-question tolerance** (e.g. "allow up to N above max"), set at
    Setup/Assessment config time, so it's a property of the quiz rather
    than a per-scan decision — cheap, but widens what's legal for every
    student on that question, not just the one who earned it.
  - **An explicit per-field override action** on the review screen — a
    second, harder confirmation distinct from the normal Confirm tap
    (plan §11's "don't add a tap to the confirm→next loop" would need a
    deliberate, named exception here, not a silent loosening), logged and
    harvested differently from a normal confirmation so it never trains
    the model to treat an above-max value as a legal read. This keeps
    every other question's ceiling untouched but is more machinery.

  Either direction has to answer the same question `totalMax`/`sumCheck`
  already assume settled: what does the sum check compare against once
  one question can legitimately exceed its own printed max — the original
  `totalMax`, or a total that now accounts for the override. Not decided.

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
- No file uploads for the pilot MVP: config in at the start, file out at
  the end. **Revisited 2026-09-07 (section 17)**: an optional roster
  upload was added at the instructor's own request, once it became clear
  the "roster" already exists as a workbook they keep all semester rather
  than something the app would need to help them build. The upload is a
  class list only — no marks, no config — and is optional; the plain
  config-in/file-out flow is unchanged for anyone who doesn't use it.
- The student ID is read locally and excluded from anything sent to
  Gemini.
- Excel export uses ExcelJS rather than SheetJS. SheetJS Community Edition
  is the more actively developed of the two, but its npm package has been
  frozen since 2022 with two unpatched advisories against it, and current
  builds ship only from the vendor's own CDN. ExcelJS is MIT, installs from
  npm normally, and is more than enough to write a plain grid of numbers —
  though its own last stable release was October 2023, so neither option is
  under active npm maintenance. Worth revisiting only if the export ever
  needs styling or streaming. **Section 17 needed more than "a plain grid
  of numbers"** — loading an arbitrary existing workbook, appending a sheet,
  and writing it back without disturbing anything else in it — and was
  verified capable of exactly that before being relied on: formulas, fonts,
  column widths, hidden sheets, defined names, autofilters, frozen panes,
  data validation, conditional formatting and images all survive a real
  round trip. Charts and pivot tables are the one confirmed gap.
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


## 17. Class-list workbook round trip (optional roster upload)

Adds an optional roster upload — the instructor's own semester marksheet
— read at Setup, matched against during scanning, and written back into
with each exam's results. Nothing about the existing config-in/file-out
path changes for an instructor who doesn't use it; this sits beside it as
a second mode, chosen at Setup, the same relationship section 16's CNN
path has to Gemini+Tesseract.

Specced 2026-09-07 from a feature note the user brought into the repo
(`File Upload.md`, written in a separate claude.ai conversation) plus a
real semester marksheet, `Course CSE211L  Section 1 Marksheet.xlsx`
(gitignored, never committed — see step.md step 12's own note on this).
The note is the source document, not the spec: several of its choices are
deviated from below, each with the reasoning that changed it. The concrete
build order is step.md step 12, four independently-shippable phases;
specced, not yet built.

### Why now, having been deferred at section 13

Section 13 skipped roster import "deliberately to avoid file-upload
complexity." That reasoning assumed the app would need to help build or
maintain a roster. It doesn't: the instructor already keeps one, as a
workbook, all semester, and already writes each exam's totals into it by
hand. The complexity being avoided was a roster *management* system; what
this section adds is a file picker and a sheet writer, which is a smaller
thing than section 13 was declining.

### What this changes and what it doesn't

Still true, unweakened: the ID/serial cross-check from section 2 is the
app's only defense when no roster is supplied, and remains exactly as it
was. Still true: the student ID never reaches Gemini or any third party,
on any recognizer path (section 12). Still true: no server-side database,
no accounts, no multi-quiz history.

New: a roster, optionally, provides a third check — is this ID one of my
students at all — which the duplicate-serial/duplicate-ID check alone
cannot provide, since it only catches misreads *within* one session's
scans, never a read that happens to be a plausible ID nobody in the class
actually has.

### The file format contract

Deliberately loose on structure and strict on identification, because the
one thing known in advance is that every instructor's workbook looks
different (their own column order, extra sheets, accumulated quiz columns)
and the one thing that can't vary is which sheet is the class list.

**Roster sheet — identified by content, never by name or position.**
A sheet qualifies if some row within its first ~20 rows contains, among
its header cells, both `STUDENT ID` and `STUDENT NAME` — matched on a
canonicalised key (uppercased, non-alphanumerics stripped), so `Student
ID`, `STUDENT  ID`, `student_id` and `StudentID` all match. Position is
consulted only as a *preference* among otherwise-valid candidates — see
"Identifying the class-list sheet" below — never as the sole test, because
a valid-shaped sheet can end up first by accident (a dragged tab) or by
design (a scanner-written exam sheet with names in it, per the decision
below) without being the class list.

**Exam sheet — one per exam, named after the exam.** Columns: `SL`,
`STUDENT ID`, `STUDENT NAME`, `Q1..Qn`, `Total`, `Serial`. Question and
total headers carry the max mark alongside them — `Q1 (5)`, `Total (20)`
— added 2026-09-07 from live phone use, so the max is visible without
opening Setup. That annotation had to be checked against the exclusion
rule two paragraphs below before it shipped: canonicalizing `"Total (20)"`
produces `"TOTAL20"`, not `"TOTAL"`, so the exam-signature check had to be
loosened from an exact match to tolerate trailing digits — otherwise a
workbook this app wrote would stop being recognized as exam-shaped on its
own next re-upload. One row per roster student, in roster order; a
student with no matching scan gets blank mark cells, never `0` (section
10's flag-never-guess rule, carried over unchanged). A scanned script
matching no roster student is appended below the roster block rather than
dropped. Existing exam sheets already in the workbook are never modified
when a new one is written.

**Sheet-name sanitisation — to the library's actual enforced rule set,
not a guessed one.** ExcelJS itself throws on `* ? : \ / [ ]`, on a
leading or trailing `'`, on an empty name, and on a duplicate compared
**case-insensitively** — verified directly rather than assumed, and it is
stricter than `File Upload.md`'s own sanitiser, which misses the
apostrophe rule and compares case-sensitively. Truncation past 31
characters is a warning, not a throw. Sanitise before calling
`addWorksheet`, and show the instructor the final name when it differs
from what they typed.

### Identifying the class-list sheet: exclude, then prefer, then confirm

Three layers, not one, because no single rule survives every real case —
and the order between the first two is load-bearing, not incidental. An
earlier draft of this section put position first ("prefer the first
visible sheet if it independently passes the header test") and the
exam-sheet exclusion second, treating them as independent signals. That
order was checked directly and found unsafe: since exam sheets carry
`STUDENT NAME` (see below), an exam sheet is itself a valid roster shape,
so a dragged tab would independently pass the header test and win *before*
the exclusion ever ran — reproducing, by construction, the exact silent
misdetection this design exists to prevent. The exclusion must therefore
run first, unconditionally, and position is only ever a tiebreaker among
whatever survives it — never a way to bypass it.

1. **Exclude anything shaped like an exam sheet.** Among sheets that pass
   the header test (`STUDENT ID` + `STUDENT NAME`), drop any that also
   carries the full exam-sheet signature — `Total` **and** at least one
   `Q<n>` column **and** `Serial`, together. An exam sheet this app writes
   always carries all three; a class list that has accumulated its own
   summary columns over a semester (`SL | STUDENT ID | STUDENT NAME | Q1 |
   Q2 | Mid | Total`, the instructor's actual stated workflow) does not
   have `Serial` and so survives this filter. This step runs first and
   unconditionally — nothing below ever overrides it.
2. **Among the survivors, prefer the instructor's own convention** — the
   first visible sheet in the workbook, if it is one of them. This is
   where "always keep the class list first" pays off: with exactly one
   survivor it is redundant (that survivor is the answer regardless of
   position), but with more than one — two roster-shaped sheets, e.g. two
   sections in one workbook — position breaks the tie instead of forcing a
   guess. Verified directly that this is implementable rather than
   aspirational: rewriting a workbook's `<sheets>` order inside its own XML
   and reloading through ExcelJS reports the new order faithfully, and
   each sheet's hidden/visible state is exposed. With zero survivors, or
   more than one and none of them first, the pick is provisional and 3 is
   what actually makes it safe rather than a guess dressed as an answer.
3. **Always confirm.** Whichever candidate steps 1–2 land on is shown —
   "Class list: `data` — 16 students · Change" — with every other
   candidate one tap away. This is the layer that actually guarantees
   correctness; 1 and 2 only reduce how often it has to be exercised.

**Why not fewer layers.** Exclusion alone leaves genuine ties unresolved
(two roster-shaped sheets) with no principled way to pick one. Confirm
alone would work but makes every single upload a manual pick rather than
a formality in the ordinary case. All three together mean the ordinary
case takes one glance and the adversarial cases — a dragged tab, an
accumulated summary column, two candidate sheets — are still caught rather
than silently resolved to the wrong answer.

**Deliberately no marker written into the workbook** to remember the
answer between uploads. Four candidate mechanisms — a defined name, a
hidden sheet, a print-footer string, and workbook properties — were each
verified to survive both an ExcelJS round trip and a real LibreOffice
re-save, so a persistent, invisible bookmark was genuinely available and
was declined anyway, at the instructor's own request: nothing about this
feature should leave bookkeeping in a file that isn't the app's to keep.
The cost is one confirmation per upload; layer 1 keeps that confirmation
a formality in the ordinary case.

### Two decisions that reverse `File Upload.md`'s own reasoning

**Exam sheets carry `STUDENT NAME`.** The note bans names from exam sheets
specifically so the sheet's *absence* of a name column can distinguish it
from the roster. That reasoning is superseded by the three-layer rule
above, which doesn't need it — and dropping it would have thrown away the
one thing that makes a misread ID visible at a glance against the name on
the script the instructor is holding.

**The exam sheet carries the full per-question breakdown, not the note's
single `Marks` column.** A single total discards exactly the information
this app's whole pipeline exists to extract accurately. `SL`, `STUDENT
ID`, `STUDENT NAME` are read straight through from the roster and written
back verbatim — never renormalised — so the file keeps whatever formatting
convention the instructor already has (e.g. IDs stored as text, preserving
leading zeros the app itself would otherwise have to reconstruct).

### Matching during scanning

Matching is on student ID only. `SL` is read through and carried onto the
exam sheet but does not participate in any check — it was considered as a
second matching key (given section 2's own framing of serial as "fixed per
course from the attendance sheet"), and rejected for this pass on the
grounds that whether a given roster's `SL` actually corresponds to what
students write in the physical serial box cannot be assumed workbook to
workbook.

An ID read from a script that matches no roster student is flagged during
review. When exactly one roster ID is a single edit (one digit) away from
the read value, or is the unique completion of a partially-read ID (the
`?`-marked positions both recognizer paths already produce per section
10), the instructor is shown that candidate as a suggestion. It is never
applied automatically — accepting it costs one tap, the same as any other
correction, honoring the flag-never-guess rule exactly as written for
recognition confidence. This is not a minor convenience: whole-ID exact
match on the CNN path was measured at 55.2% on the real-class batch
(section 16), so a class list turns a large share of what would otherwise
be silent misreads into a one-tap fix at the moment the instructor is
still holding the script.

### Duplicates are stricter here than the plain path

Two confirmed scans matching the same roster student **block the
round-trip export**, naming both conflicting records. This is a stricter
rule than the plain-download path's duplicate handling, deliberately: the
Results table is already editable, so resolving the conflict there before
export is neither slow nor a dead end, and writing one student's marks
into another's row in the instructor's own semester-tracking file is a
strictly worse failure than the same mistake landing in a standalone
`.xlsx`, since it can silently follow that student across the rest of the
term. The plain download remains available, unblocked, as an escape
hatch if the conflict can't be resolved before class ends.

### The opt-in totals column

A checkbox at export, off by default: also add or update one column in
the class-list sheet, headed with the exam's own sanitised name plus its
max mark — `Quiz 1 (20)`, matching the annotated headers everywhere else —
holding each student's total. Re-exporting the same exam updates that
column in place rather than duplicating it, matched on the exact header
text including the max: if the max has genuinely changed since the last
export of a same-named quiz, that reads as a different column rather than
silently overwriting one that used to display a different total, the same
"a difference is a new thing" rule the sheet-name collision check already
follows. A scanned script matching no roster student is never appended to
the class list as a new row — only the exam sheet gets that row; the
class list is reported as "N scripts matched no one on this list," never
silently extended.

This is the one operation in this whole section that writes into a sheet
the instructor authored rather than one the app created, which is why it
defaults off and why every other write (a new exam sheet) is unconditional
by comparison — the two are not the same kind of write and are not
governed by the same default.

### What was verified before any of this was specced

Against the real workbook, on ExcelJS 4.4.0 (already a dependency — no new
one is added by this section):

- **The real file's actual shape**: one sheet `data`; header on row 1
  exactly `SL` / `STUDENT ID` / `STUDENT NAME`; 16 students; IDs stored as
  **text**, all 7 digits; no merged cells, formulas, or styling;
  LibreOffice-authored. Not relied on as a universal shape — 12.2's header
  scan and ID normalisation exist precisely because another workbook,
  or the same one re-saved from Excel, need not match it.
- **A full round trip preserves far more than the minimum needed here**:
  load → append a sheet → write → reload keeps every other sheet intact,
  formulas as formulas, fonts, column widths, hidden sheets, pre-existing
  defined names, autofilters, frozen panes, data validation, conditional
  formatting, and images. Verified individually against both a synthetic
  workbook constructed to carry all of them and the real file.
- **Charts and pivot tables are the one confirmed gap** — ExcelJS has no
  support for either, so a workbook containing one comes back without it.
  This is a documented library limitation, not something exercised here
  (no chart-bearing file was available to test against), and is stated to
  the instructor in the export UI rather than discovered later.
- **A blank mark round-trips as a genuinely empty cell**, not as `0` —
  section 9/10's worst-possible-failure rule extends to this export path
  unchanged.
- **The sheet-name rule set and the duplicate-name check** are as
  described above, both confirmed by triggering ExcelJS's own thrown
  errors rather than inferred from documentation.

### Open risks, named rather than assumed away

**Mobile file-picker and save-back UX is unverified.** Selecting an
`.xlsx` from a phone's file picker or cloud storage, and saving the
updated copy back afterward, is plausible on both iOS and Android but has
not been tried on a real device — the same category of thing CLAUDE.md
already requires hand-verification for (camera, PWA install, export
download), and step.md step 12's Done-when bar requires it explicitly.

**A workbook holding student names is new privacy surface for this app.**
Names are held in IndexedDB for the session (a new store, cleared by
`resetAll()`), shown in Review and Results, and never sent to the backend
— `/api/harvest` and `/api/scan` continue to receive only what they
always did. Setup's privacy disclosure needs the same care section 11.5
already had to apply once, correcting an earlier claim that overstated
what stayed local — see step.md's own account of that mistake, and don't
repeat its shape here.

**The class-list identification rule is a heuristic with a confirm step,
not a proof.** Layer 3 is what makes it safe; if a future change ever
removed the confirm step to save a tap, the two adversarial cases already
demonstrated (a dragged exam-sheet tab; a roster that has accumulated
exam-shaped columns) would go back to being silent failures rather than
one-tap corrections.

## 18. Multi-course, multi-section persistence

Turns the app from a one-sitting tool into one that holds a semester.
Today there is exactly one quiz session at a time; a faculty member
teaches several sections at once, and the second one destroys the first.

Specced 2026-09-09 from a design discussion, grounded in the user's real
semester rather than a hypothetical one: **one section of CSE100, one of
CSE200, and two of CSE203**. Four decisions in it came from the user
directly and are marked as such below — they narrowed the design more
than any reasoning here did. The concrete build order is step.md step 13,
four independently-shippable phases. **All four phases are done
(2026-09-10)** — the schema, the library screen, the roster/workbook
moved onto the Section (including the staleness-made-visible provenance
line and the re-cache this section specs below), every "not grading into
the wrong section" protection (assessment-scoped duplicate detection —
13.15, a shared serial across two courses no longer raises a conflict,
verified against the case that must still fire within one course, not
just the case that must not fire across two — a resume confirmation for
an assessment last touched before today, 13.14, and an identity-carrying
filename, 13.16), and the semester boundary itself: a purge offered
exactly when this section says it should be — creating a section under a
genuinely new semester label, never a timer, never automatic — blocked
outright while any assessment in that semester has never been exported
(13.19), and comparing semester labels by exact string rather than
normalizing them, so the label-drift risk named below is surfaced as two
separate purge candidates instead of silently merged inside the one
feature that deletes data. See step.md's step 13 for the full account,
including two deliberate deviations from the letter of this spec (the
"plain vs. workbook" mode toggle is gone — a section either has a roster
attached or it doesn't, since the choice stopped being a per-quiz
decision — and `Setup.tsx` is deleted outright rather than kept alongside
the new screens).

### Why the single-session model breaks

Three facts in the code, none of them accidental — they were correct for
the pilot this app was scoped to:

- `db.ts`'s `config` store holds a **single value**, keyed and
  overwritten. Starting a second quiz overwrites the first's config.
- `StudentRecord` has no quiz or section field, and `records` is one flat
  store. `getAllRecords()` cannot tell CSE100's marks from CSE203's.
- `resetAll()` is the only transition between sessions, and it deletes
  the records, the config and the roster together.

For the real semester above, one round of quizzes across four sections
means **eight config entries and eight class-list uploads**, eight
"Reset everything" confirmations, and no way to look at last week's quiz
at all. The second CSE203 section cannot be graded until the first one's
data has been destroyed — before the instructor has opened the exported
file to check it.

### What varies with what

Worth separating, because these do not vary together, and the single
`config` store implicitly assumes they do:

| Thing | Varies per | Lifetime |
|---|---|---|
| Class list / roster | **section** | the whole semester |
| `idDigits` | institution | effectively forever |
| Question config (Q1..Qn and maxes) | **assessment** | one quiz |
| Records | **section × assessment** | one sitting |

That table is the argument against a flat "session = course + section +
quiz" store, which is the obvious first design. The roster is the
expensive thing to re-enter and it belongs to the *section*; the question
config is cheap and belongs to the *quiz*. §17's "fresh upload per quiz"
rule was right when there was one quiz and becomes wrong here — it is what
produces the eight uploads.

### The model: two entities, not four

```
Section {
  id, courseCode: "CSE203", label: "2", semester: "Fall 2026",
  idDigits: 7,
  roster?: ParsedRoster,                                  // IDs, names, rows
  workbook?: { fileName, bytes, provenance, capturedAt },  // one file — see below
}

Assessment {
  id, sectionId, name: "Quiz 1",
  questions: QuestionConfig[], totalMax,
  createdAt, exportedAt: string | null,      // load-bearing — see the purge guard
}

StudentRecord { ...unchanged, + assessmentId }
```

**Course is deliberately not an entity.** It is `section.courseCode`,
grouped in the UI. That yields the "CSE203 ▸ Section 1, Section 2" tree
for free and avoids a store that, for a single instructor with no
server, buys nothing but a join. If course-level facts ever appear — a
grading scheme, a credit weight — that is when a Course store earns
itself, and adding it later costs one migration.

`QuizConfig` survives unchanged as the shape inside `Assessment`, so
`validateConfig.ts`, `/api/scan`'s contract and the whole scan pipeline
are untouched by this section.

### Four decisions taken from the user, not inferred

1. **One workbook file per section.** `CSE203-1.xlsx` and
   `CSE203-2.xlsx` are separate files, so a `Section` owns exactly one.
   This is the assumption everything in §17 already fits: multiple
   quizzes land as sibling sheets in that one file, and
   `findSheetCollision`'s refusal to ever mark the class-list sheet
   overwritable keeps the roster tab safe across a whole semester of
   exports. No export code changes; the file is simply picked once per
   section instead of once per quiz.

2. **No shared quiz template across sections.** The two CSE203 sections
   are configured independently, from scratch, each time. A "duplicate
   from" affordance was considered and deliberately **not** specced: the
   user's own workflow treats the sections as independent, and a shared
   template is the kind of convenience that silently edits one section's
   marks scheme when you meant to edit the other's. The seam stays open —
   duplicating an `Assessment`'s `questions` is additive and needs no
   schema change — but it is not part of this section.

3. **Records are kept until the end of the semester**, then purged on a
   prompt. Not deleted at export (no recovery if the export was wrong,
   and a regrade query three weeks later is a real event), and not kept
   forever (student marks accumulating on a phone indefinitely is a
   privacy cost with no matching benefit).

4. **The plain download stays exactly as it is.** It is the verification
   path — the instructor downloads, opens it, checks it against their own
   record, files it in Google Drive. Everything in this section is
   additive to it, the same relationship §17's workbook export already
   has.

### The staleness problem this creates, and the rule for it

This is the failure mode most worth designing against, and it is *created*
by the feature rather than exposed by it. It also means this section
**reverses a decision step 12 made deliberately and for exactly this
reason**: 12.1 requires a fresh upload per quiz, "so the file written into
is the one the instructor actually has on disk, not a stale in-app copy
that would silently discard whatever they edited in Excel between
quizzes." That reasoning was correct and does not stop being correct here
— what changes is the price. At one quiz it costs one upload; at four
sections × six quizzes it costs twenty-four, which is the friction this
whole section exists to remove. So the rule is replaced rather than
dropped, by making staleness *visible* instead of impossible.

§17 persists the roster upload including `workbookBytes`. Attach that to a
section for a semester and:

1. September — upload `CSE203-1.xlsx`, grade Quiz 1, export, file in Drive.
2. October — in Drive, add a late-registering student and fix two names.
3. November — Quiz 2 exports from the app's **September copy**. The new
   student is absent and the name corrections are reverted, in a file that
   then replaces the Drive one.

Silent, and it destroys work done outside the app. One-file-per-section
makes the divergence window a whole semester, so this gets worse with the
feature, not better. The rule, split by what each artifact is *for*:

- **The parsed roster is persisted** — IDs, names, row numbers. It drives
  live matching, the "Scanned 7 of 16" header and the name beside the ID
  field. Stale here costs a wrong display name: visible, and harmless.
- **The stored bytes are never presented as authoritative.** Every
  workbook export states its provenance ("the copy this app produced on
  12 Sep, for Quiz 1") and offers **Re-pick** as a first-class action, not
  a buried one.
- **After a successful export, the bytes just written become the section's
  cached copy**, stamped. An instructor who always uploads that download
  back to Drive keeps the chain aligned and rarely needs to re-pick; one
  who edits in Drive, or skips an upload, sees a provenance line that no
  longer matches what they remember doing.

**The Drive API is deliberately not the answer here.** OAuth, a verified
app and a Drive scope would trade away the "no auth, nothing server-side"
property that makes this app deployable at all — to save one file-picker
tap. The File System Access API is a lighter alternative but is not
available on the mobile browsers this workflow actually runs on. A
download plus a manual upload is the right primitive for a phone.
(Revisited 2026-09-12 as a live-write-to-a-specific-Sheet question, not a
file-picker one — still not built; see §20.)

### Duplicate detection must be scoped, in the same change

`findRecordsBySerial` and `findRecordsByStudentId` query a global index.
That is correct today, when every record belongs to one quiz, and becomes
wrong the moment records persist across sections: a CSE100 student and a
CSE203 student sharing serial `7` is normal and expected, not a conflict.

This is not cosmetic. The identity cross-check is described in §2 and §10
as the highest-value check in the workflow, and a warning that is usually
wrong is one the instructor learns to dismiss without reading — including
on the occasion it is right. Scoping to `assessmentId` ships **with** the
schema change, not after it.

### The purge, and the guard it needs

- Sections carry a semester label; the library groups by it.
- Creating a section under a **new** label offers to purge the previous
  one. The app never purges on its own, and never on a timer.
- The dialog lists exactly what would go, per section, with counts.
- **Any assessment with `exportedAt === null` blocks the purge** and is
  named individually — cancel only, matching the duplicate-blocking
  pattern already in `Results.tsx`. An unexported assessment is
  unrecovered work, and deleting it silently is the one outcome this
  feature must never produce. This is what makes `exportedAt` a real
  field rather than a display detail.
- A purge deletes the section wholesale — records, assessments, roster,
  workbook bytes. Keeping a section shell into the next semester is worse
  than useless: the students are different.

### What does not change

**The backend needs no changes at all.** `POST /api/scan` takes the quiz
config per request and stores nothing (§9, and the statelessness
invariant), so sections, semesters and multi-quiz history are entirely a
frontend concern — no API change, no migration, no redeploy required by
this section.

Unchanged on the frontend: detection, both recognizers, harvesting,
`validateMarks.ts`, `examSheet.ts`, `workbookExport.ts`, `rosterMatch.ts`,
`scanQueue.ts`, and the capture → review → confirm loop itself. That loop
is the part that runs thirty times a class and is already tuned; §11's
"don't add a tap" rule applies to it unchanged. Everything this section
adds sits *before* it (which section am I in) and *after* it (which file
does this export into).

### Open risks, named rather than assumed away

**Scanning into the wrong section is the new worst failure.** Grading
CSE203-1 in the morning and CSE203-2 after lunch is the user's actual
workflow, and thirty scripts saved against the wrong section is worse
than any single misread — it is silent, and it looks exactly like
success. **Built (2026-09-10)**: a persistent context header on Scan,
Review and Results; a confirmation when resuming an assessment last
touched before today; and duplicate detection scoped to the assessment,
so a genuine cross-course collision doesn't get lost in the noise of
false ones. None of this is a proof, only mitigation — this is still the
risk that most deserves real-session verification, now that there's a
real build to verify.

**Holding marks for a semester is new privacy surface.** Student IDs and
marks currently live on the device for one sitting. After this they live
there for months. Setup's disclosure must say so — this is the same
"true but incomplete" shape step 11.5 already had to correct once, and
`Setup.test.tsx` pins that line deliberately so it moves with the
behaviour rather than after it.

**Semester labels are now a picker, not free text (decided 2026-09-10,
step.md 13.20).** Three terms — Spring, Summer, Autumn, matching the
pilot institution's own trimester calendar, deliberately no Winter — plus
a plain year input, combined by `sections.ts`'s `formatSemesterLabel`
into the exact string stored on `Section.semester` and shown everywhere
else in this section. This closes the drift risk for new data outright:
the picker can only ever produce a canonical `"Season YYYY"` string, so
`Fall 2026` / `fall 2026` / `F26` cannot arise from anything created
through it. The purge's exact-string comparison (step.md 13.18,
unchanged) still matters for **legacy** sections whose `semester` predates
the picker — `parseSemesterLabel` returns `null` for those, and editing
one falls back to today's own current season/year (`currentSemesterSeason`)
rather than crashing or guessing at the original intent; nothing is
overwritten until the instructor taps Save. The underlying "how the
LIBRARY groups and orders semesters day to day" question (insertion order,
not "current semester first") is unaffected by this decision and remains
as `groupSections`'s own comment describes it.

**Storage growth is bounded but real.** One workbook's bytes per section,
plus a semester of records. Four sections of a few hundred KB each is
nothing against IndexedDB's quota, but the app has never held more than
one file at a time and has no eviction story; the purge flow is the only
thing standing between a semester and an unbounded store.

**The migration has to fold an in-flight session, not drop it.** Someone
may be mid-quiz when the new bundle loads. The v4 → v5 upgrade must turn
the existing `config` + `records` + `rosterUpload` into one Section plus
one Assessment. `meta` (and `getSourceId()`) stays untouched, per its own
rule in §16's collection design.

**Where the app opens is decided: the library (confirmed 2026-09-10).**
`App.tsx`'s default `Screen` state and its final fallback render both
resolve to `Library` — see every section at a glance, one tap to
anything. The alternative considered — jumping straight into the last
active assessment, zero taps back into a class you are mid-way through —
was rejected in favour of always showing the tree; nothing about that
needs a real session to judge further. If jump-to-last-assessment is ever
revisited, `lastActivityAt` (13.14) already has what it would need to
pick "last active," so no new derivation is required — only the routing
decision itself.

## 19. Landing page — the story before the tool

Everything before this section is about the instructor who already knows
what this is. This section is about everyone else: a colleague sent the
link, a faculty member deciding whether it's worth a class, the user
themselves explaining it to someone. Today the link opens straight into
`Library.tsx`'s "Your sections" — a screen that assumes you already know
why you'd want a section.

Specced 2026-09-10. Concrete build order is step.md step 14. Like steps
11, 12 and 13, this is a deliberate extension beyond §13's MVP scope, and
like all of them it leaves the existing path intact: the capture → review
→ confirm loop is untouched, the backend is untouched, and a returning
instructor's first tap is still the same first tap.

### Six decisions taken from the user, not inferred

1. **"Open the app" stays pinned at the top**, visible at every scroll
   position. Nobody reading this page should ever have to scroll to leave
   it.
2. **Dark theme**, unconditionally — not `prefers-color-scheme`-aware the
   way the app itself is.
3. **An animated scan** as the hero visual, rather than screenshots.
4. **Raycast's design system as the structural reference** (see "What is
   borrowed, and what is deliberately not" below).
5. **Lightweight, static-first, works on 3G and a flaky connection.**
6. **Mobile-first, then responsive upward** — the phone is the primary
   target, not the narrow case handled last. See "Mobile-first, and what
   it actually changes" below, which amends several of the decisions
   above rather than sitting alongside them.

### Why this is NOT server-rendered, despite the request for it

The request was "preferably built server side so it works on flaky
internet." The goal is right and the mechanism is wrong, so the goal is
kept and the mechanism is replaced — the same shape as §18's own
reversal of 12.1.

The frontend is static files on S3 behind CloudFront; the backend is
Python on Lambda behind API Gateway serving only `/api/*`. Rendering this
page server-side means either bolting a Node runtime onto a Python stack
or teaching FastAPI to serve HTML, and **either one puts a Lambda — with
a possible cold start — into the critical path of the very first paint.**
On a flaky connection that is the worst available place to put it. It
would also break two invariants recorded on purpose: the backend being
stateless and recognition-only (§9), and the single-origin static
frontend (step 11's deployed shape).

Static HTML from a CloudFront edge beats it on both metrics — no compute,
cached near the reader — and the service worker (`vite-plugin-pwa`,
`registerType: 'autoUpdate'`) already precaches the document, so a repeat
visit needs **zero** network. Nothing server-side can beat zero.

So: **pre-rendered at build time, not rendered per request.**

### The architecture: prerendered markup, zero runtime JS

The landing page ships as HTML inside `dist/index.html`, generated at
build time by rendering a React component with `renderToStaticMarkup`.
`react-dom` is already a dependency, so this costs **no new package**.

Three properties fall out of that, and the third is the interesting one:

- **First paint needs one round trip.** The markup and its critical CSS
  are in the document. Today `#root` is empty until 244KB of JS has
  downloaded and parsed; on 3G that is seconds of blank screen. This
  section makes the app faster on a cold visit than it is now.
- **A returning instructor never sees it.** A synchronous `localStorage`
  read in a small inline script sets a class on `<html>` before first
  paint. Deliberately **not** the IndexedDB `meta` store that holds
  `getSourceId()`: IndexedDB is async, so it would paint the landing page
  and then yank it away. This is the one place in the app where
  `localStorage`'s synchronousness is the whole point.
- **The landing page ships no runtime JavaScript at all.** Its markup
  lives *outside* `#root`, so React never owns it, never hydrates it, and
  never re-renders it. Visibility is a class on `<html>`; the CTA is
  handled by ~15 lines of inline script that set the flag and flip the
  class. The React component exists only as a build-time input. A page
  that is bytes of HTML and nothing else is the lightest thing that can
  possibly work, and it keeps working if the main bundle never arrives.

### What is borrowed from Raycast, and what is deliberately not

Borrowed — all structural:

- **Depth from a surface ladder plus hairline 1px borders, no drop
  shadows.** The dark theme is already most of a ladder (`#0f0f0d` →
  `#181815` → `#201f1b`); this adds a deeper canvas step beneath it.
- **Section rhythm**, authored from the phone up: **48px base, 64px at
  tablet, 96px at desktop**, added by `min-width` queries rather than
  taken away by `max-width` ones. The app has no such rhythm — its
  spacing is phone-app tight (8/10/12px), correct for a grading screen
  and far too tight for a page that argues something.
- **A display type ramp** existing only on this page — but **fluid, and
  rooted at the phone size rather than the desktop one**. A 64px headline
  on a 390px-wide screen is about six characters per line, which is not a
  headline. The ramp starts around 32–36px on a phone and reaches 64px on
  a wide screen, expressed with `clamp()` so it scales continuously
  instead of jumping at breakpoints — which also costs fewer bytes than
  the equivalent media queries.
- **Monochrome base, one accent, spent sparingly**, and **the product as
  the hero** rather than decoration around it.

Not borrowed, each for a reason:

- **Their palette.** Raycast's black is cool (`#07080a` is blue-leaning,
  `#f4f4f6` a cool white). This app is deliberately warm — `#0f0f0d` is
  olive-black under a petrol teal. Mixing temperatures reads as two
  products stitched together, and the seam would land exactly at the tap
  that leaves the page. The ladder is built from this app's own values.
- **The white primary CTA.** Raycast's primary is always a white pill.
  Here the primary CTA is the teal, because "Open the app" is a handoff
  and it should be the colour of the thing it hands off to.
- **The red diagonal hero stripe.** That is Raycast's brand signature,
  not a reusable pattern. It is also semantically wrong here: red means
  `--danger` in this system, and a red band across a page about grading
  reads as an error state.
- **Inter and its `ss03` alternate.** This is an offline-capable PWA; a
  webfont means precaching ~100KB more into the service worker for a page
  seen once. The existing system stack renders as SF Pro on the
  instructor's own phone. The designed feel comes from **scale and
  letter-spacing**, not a new typeface.
- **The keycap inner-shadow treatment.** Specific to a keyboard
  launcher. Meaningless for a camera.

### Mobile-first, and what it actually changes

The phone is the primary target. This is not a preference here, it is
this repo's own history: the mode-toggle overflow, the file input that
kept showing "No file chosen", and the section/quiz rows that ran off the
right edge of the screen were all **desktop-fine, phone-broken**, and all
three were found by using the thing on a real phone rather than by any
test. A landing page authored at desktop width and squeezed down
afterwards would be the fourth. So the base styles *are* the phone
styles, and every media query is `min-width` — adding at larger sizes,
never subtracting at smaller ones.

Concretely, this amends four things specced above:

- **The type ramp is fluid and phone-rooted**, per the Raycast section —
  `clamp()` from ~32px, not a 64px headline scaled down.
- **The section rhythm starts at 48px** and grows, rather than starting
  at 96px and shrinking.
- **The pinned CTA bar must be slim.** Vertical space is the scarce
  resource on a phone, and a chunky marketing header eats the thing the
  reader came for. It stays at the top as decided — but compact, one row,
  and it must not grow taller when the page scrolls.
- **The scan animation cannot use the desktop scrollytelling layout.**
  See below; this is the biggest change of the four.

Two hard rules, both from bugs this project has already shipped:

- **No horizontal overflow at 320px.** Not "looks fine on my phone" —
  320px, the narrowest screen still in real use. `body` already carries
  `overflow-x: hidden`, which hides the symptom rather than the cause, so
  this has to be checked at the layout level rather than trusted.
- **Nothing depends on `100vh`.** iOS Safari changes viewport height as
  its address bar collapses mid-scroll, which is exactly the moment a
  pinned graphic would jump. `#root` already uses `100svh` for this
  reason; the landing page follows.

And one thing that does *not* change: the CTA stays at the top, as
decided. Worth noting only that this app's own design anchor is the
one-handed phone workflow, so if the top bar ever proves awkward to
reach mid-scroll, a thumb-reachable bottom CTA on mobile is the obvious
alternative — a real-device judgement, not one to make in advance.

### Sections, in order, and what each one is for

The page argues one thing per section, in the order someone actually asks
the questions.

1. **Hero.** The hook is that the marking is already done — what's left
   is transcription. Headline: *"You already graded it. Let the camera do
   the typing."* Sub: one sentence naming what it reads (student ID,
   serial, per-question marks), what you do (confirm each one), and what
   you get (one Excel file). Primary CTA: **Open the app**.

   **On a phone, above the fold is: headline, one line of sub, and the
   CTA** — with the animation deliberately peeking in from the bottom
   edge rather than fitting entirely. All four cannot fit on a 390×844
   screen, and trying makes every one of them small. The peek is what
   tells the reader there is more, so it earns its place. On a wide
   screen the animation moves beside the copy and all of it sits above
   the fold together.

2. **The problem, in real numbers.** Four sections of roughly thirty
   scripts, six numbers per script, is on the order of seven hundred
   numbers typed by hand per round of quizzes — at the end of a day
   already spent marking. One transposed digit is a wrong grade that
   nobody catches, because there is nothing to catch it against.

3. **How it works — four steps, told by the scan animation.** Photograph
   the grid → the table is found and straightened → each cell is read →
   you confirm, and it saves. The animation is the graphic; the steps are
   text beside it (see "The scan animation" below).

4. **What it refuses to do.** The trust section, and the genuinely
   differentiating one. An ambiguous digit is left **blank and flagged**,
   never filled with a confident guess. If the detected column count
   disagrees with the quiz you configured, the scan **fails loudly**
   rather than writing Q4's mark into Q3's column. A blank never exports
   as a zero. These are invariants in the code, not aspirations, which is
   why they can be claimed on a marketing page at all.

5. **Where your work actually goes.** The honest version, matching §12
   and 11.5's correction: the photograph reaches your own laptop and is
   never stored; on the default local recognizer nothing leaves that
   machine at all; individual cells are kept, with the value you
   confirmed, to improve recognition — no names, nothing that
   reassembles a student ID; marks live in your browser until you export
   them. No account, no sign-up, no server-side database.

6. **Why it exists.** Built for one faculty member's actual semester —
   one CSE100, one CSE200, two CSE203 — rather than as a product looking
   for users. Tuned against eighteen real photographs from a real class
   in about twenty different hands. This section is what makes the page
   credible rather than promotional, and it should stay short.

7. **Close.** The CTA again, and nothing else.

### The scan animation

One pinned SVG moving through five states as the reader scrolls, driven
by scroll-linked CSS. It must be **inline SVG animated with CSS** — a
stylised marks grid, not a screen recording. A video or a PNG sequence
would blow the weight budget by an order of magnitude and is ruled out
here rather than discovered later.

**The layout differs by size, and the phone one is the real design.**
The canonical scrollytelling pattern — graphic pinned on one side, a
column of text scrolling past it on the other — is a desktop pattern that
assumes two columns. A phone has one. So:

- **Phone (base):** the graphic pins to the *top* of the viewport at a
  bounded height, and the five step captions scroll beneath it. It must
  never occupy so much height that no caption is visible alongside it —
  a pinned graphic with its own text pushed off-screen explains nothing.
- **Wide (`min-width` up):** the graphic moves to one side and the
  captions scroll past it, the conventional two-column form.

The grid drawn in the SVG also has to be **legible at 320px**. A full
eight-question grid at that width gives cells a few pixels wide, so the
phone version draws a **reduced grid** — the ID row, the serial, and
three or four question columns, which is enough to read the idea — and
the wider layout can show more. This is a design instruction, not an
implementation detail to be discovered while building it.

1. A photographed grid, slightly rotated, the way a real phone capture
   arrives.
2. It straightens; the table's rules are found and the cells outline.
3. The cells separate — the ID row, the serial, the per-question marks.
4. Digits resolve into the cells — **and one of them resolves to a flag
   rather than a number.** This is the state the whole animation exists
   for: it *demonstrates* "flag, never guess" instead of claiming it.
5. The rows settle into a spreadsheet shape — the export.

`prefers-reduced-motion: reduce` collapses this to its final state,
statically. That is a hard requirement, not a nicety.

Note this does not violate the frequency-gate rule the design skill
applies to the scan loop ("thirty times a class, should not animate").
That rule is about frequency, and this page is seen **once**. By its own
logic, this is the one screen in the app where motion is earned.

### Weight budget

| Piece | Budget |
|---|---|
| Landing markup in the document | ~2–3KB gzip |
| Extra CSS (tokens, layout, type ramp) | ~1–2KB gzip |
| Hero visual, inline SVG | ~2–5KB |
| Scroll animation | 0 bytes of JS |
| Fonts | 0 bytes — system stack |
| Share QR code, inline SVG (added 2026-09-12) | ~2.5KB gzip |
| Landing runtime JS chunk | 0 bytes — never ships |

Under ~10KB gzipped for a complete first paint, against the current
75KB-gzip JS-before-anything. If a change pushes past this, the change is
wrong, not the budget.

**Revised to ~12KB (2026-09-12) for the share-via-QR-code addition.** A
QR code scannable at this URL's length costs ~2.5KB gzip on its own even
after the cheapest real optimizations (`QrCode.tsx`: run-length-merged
SVG path instead of one rect per module, Alphanumeric-mode encoding on
an uppercased bare origin instead of Byte mode) — there is no further
lever short of a URL shortener, which would trade a third-party
dependency and an opaque link for a few hundred bytes, a bad trade for
what this page is. That cost alone exceeded the ~2.3KB of headroom the
original ~10KB figure left. The "change is wrong, not the budget" rule
above is aimed at decorative bloat; this is a real, requested feature
whose weight is inherent to what it does, so the budget moved instead —
recorded here, not silently, and `prerender.test.ts`'s own assertion
carries the same note.

### Open risks, named rather than assumed away

**A prerender step can silently drift from the component it renders.**
The failure mode is shipping an empty shell that still passes every
component test. Guarded the way this project guards everything else: a
test that reads the built `index.html` and asserts the landing content is
actually in it, so the build fails loudly.

**The landing component must stay purely presentational.**
`renderToStaticMarkup` runs in Node with no DOM and no IndexedDB, so a
hook touching browser APIs during render throws at build time. Easy to
design for, but it rules out anything clever inside it.

**There must be a way back to the page.** Someone who dismisses it once
should still be able to re-read it — otherwise the explanation is
unreachable the moment it is most likely to be wanted (explaining the
tool to a colleague). A link from the library's existing "How this works"
disclosure is enough; a second entry point is not needed.

**Phone layout cannot be verified by the test suite.** jsdom has no
layout engine, so nothing in vitest can catch a row overflowing at 320px
or a pinned graphic covering its own captions — precisely the class of
bug this repo has shipped three times already. Real-device checks are
part of this step's Done-when bar rather than a nice-to-have, and the
suite's job here is limited to content, entry logic and weight.

**A dark page hands off to a theme-aware app.** A light-mode instructor
goes dark page → light app. That is normal for marketing → product and is
accepted, but the landing tokens must be **scoped to the page** and must
not leak into `:root`, or they will break the app's own theming.

## 20. Google Sheets live write — explored, not built (2026-09-12)

Raised as an exploratory question: what would it take to connect Google
Drive and write results directly into one specific Google Sheet, instead
of (or alongside) the local `.xlsx` pick/download/re-cache flow §17/§18
already build. **Nothing here is built.** This section exists so the
exploration doesn't get re-derived from scratch later, and so it amends
rather than silently contradicts §18's "Drive API is deliberately not the
answer here" rejection above.

Scoped by the answers given when it was raised: additive only (the
existing local-file flow stays untouched), the instructor pastes a Sheet
URL/ID rather than using a Google Picker, and the OAuth token exchange is
client-side only (no backend, no refresh-token storage) — preserving the
stateless-backend invariant even though it reopens the "no auth" one.

### What it would require

- **Google Cloud setup (manual, outside the repo)**: a project with the
  Sheets API enabled; an OAuth consent screen left in Testing mode (avoids
  Google's CASA review, caps at 100 listed test users, 7-day token
  expiry); a Web-application OAuth client ID with the app's origins
  authorized.
- **Scope**: pasting an arbitrary Sheet ID rules out the narrow
  `drive.file` scope (that scope only covers files opened through a
  picker tied to the app) — this needs the broader
  `https://www.googleapis.com/auth/spreadsheets` scope, and the consent
  screen shows the correspondingly broader warning.
- **Frontend-only additions**: Google Identity Services loaded via a
  script tag (not the heavier `gapi` client); a new `googleSheets.ts`
  module making plain `fetch` calls to the Sheets API v4 REST endpoints
  (`spreadsheets.get`, `.batchUpdate`, `.values.update`), porting
  `workbookExport.ts`'s `sanitizeSheetName`/`findSheetCollision` logic to
  work against the API's returned tab list instead of an in-memory
  `ExcelJS.Workbook`; a new optional `Section.googleSheet` field
  (spreadsheetId, sheetTitle, connectedAt) alongside the existing
  `workbook` field; a third export button on `Results.tsx` beside the two
  that exist today.
- **One real gap, not just a port**: `writeTotalsColumn`'s "write into the
  existing roster sheet" only works today because the roster was parsed
  from the uploaded `.xlsx` bytes. A Google-Sheet-sourced roster has no
  equivalent unless a parallel "read the roster via `values.get`, run it
  through the same header-matching rules" path is also built — otherwise
  a Sheets export could only write a fresh results tab, not the opt-in
  totals column.
- **Auth tradeoff**: the access token would live only in memory, never
  IndexedDB, never sent to a backend — but it's short-lived (~1 hour) with
  no refresh flow, so a long grading session may need a second consent
  popup.
- **Privacy disclosure**: this reopens the "nothing leaves the laptop"
  claim, which currently holds only because of the CNN default
  recognition path. Any Section with a connected Google Sheet would need
  its own visible disclosure that its marks data goes to Google's servers
  on every write, the same way the harvesting disclosure already is one.

### Restricting it to one instructor on the shared hosted demo

Also raised: step 11's hosted demo is a single deployed bundle other
faculty use from the same URL, and this feature should be visible/usable
only by the person who requested it, not the others. There's no accounts
system in this app (multi-user auth is deliberately deferred — see
CLAUDE.md's Deferred list), so any gate here is necessarily client-side,
not real access control. The shape discussed:

- **Declutter layer**: the entry point only renders once a localStorage
  flag is set, itself set by visiting the deployed URL once with a query
  string only the requester would know (e.g. `?labs=sheets`) — mirroring
  this app's existing env-style feature switches (`RECOGNIZER`) but moved
  to a runtime, per-browser flag since a build-time env var can't
  distinguish one visitor from another on one shared bundle.
- **Backstop layer**: since anyone can read a deployed JS bundle and find
  that query param, the feature's *function* (not just its visibility)
  should also require Google Sign-In and check the signed-in email
  against one hardcoded address baked into the build. Someone who finds
  the trigger without the matching account sees "not available," not a
  working feature.
- **What this is and isn't**: UI-hiding plus a client-side identity check,
  not real access control — there's no backend to enforce it against.
  Fine for keeping other faculty from being confused by a button that
  isn't for them; not a claim that anyone's data is protected against a
  determined reader of the bundle. Should be documented as such wherever
  it's built, not implied to be stronger than it is.

### Not decided

Whether to actually build this at all. Filed here as reference for if/when
it's picked up, in the same spirit as §18's semester-purge decisions were
filed as open questions before being resolved.
