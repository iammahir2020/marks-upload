# Build Steps

Execution plan for [plan.md](plan.md). One step at a time, in order.

The ordering is inherited from plan §14 and the step numbers match it, so
`step.md` step 4 is plan §14 step 4. Everything before step 4 runs as a script
against a folder of images — no camera, no browser, no HTTP. That is
deliberate and it is the fastest loop you will get.

---

## Working protocol

Three rules, applied to every step below.

**Before starting a step, read what already exists.** Not the plan — the
code. Open the files the step touches and confirm what is actually
implemented, because the previous step may have left something partial, or
solved part of this one, or made an assumption this step is about to break.
Each step below opens with a *Before you start* line naming what to look at.

**Do not begin a step until the previous one meets its bar.** Every step has
a *Done when* that is written to be checkable, not aspirational. A step that
is "basically working" is not done. This matters most in step 1, where the
temptation to move on is strongest and the cost of doing so is highest.

**Test after every step, and re-run the earlier tests too.** The detection
parameters in step 1 stay live for the whole project — a change made in step
3 to fix one photo can silently break four others. Any change to detection
re-runs the full test set (step 1.9), every time, no exceptions.

### What "testing" means at each layer

Not every step has unit tests, and pretending otherwise produces theatre
instead of confidence.

| Layer | How it is verified |
|---|---|
| Detection (step 1) | Visual review of overlays + automated shape regression against labels |
| Recognition (steps 2–3) | Accuracy measured against labelled ground truth, reported as a number |
| API (step 4) | `TestClient`, Gemini mocked — no network in the test suite |
| Frontend logic (steps 5, 7) | Vitest over pure functions — sum check, cross-check, normalisation |
| Camera, PWA, export (steps 6, 9) | Manual, on the real phone, over HTTPS |
| Whole system (step 10) | Timed rehearsal at full class volume |

---

## Repo layout

Create this in step 0 so later steps have somewhere to land.

```
marks-upload/
├── plan.md · stack-reference.md · step.md
├── marks-grid-template.docx
├── testset/
│   ├── images/                 # the photographs
│   └── labels.json             # ground truth, hand-written
├── backend/
│   ├── detect.py               # step 1 CLI harness
│   ├── app/
│   │   ├── models.py           # step 4
│   │   ├── detection.py        # step 1
│   │   ├── id_ocr.py           # step 2
│   │   ├── marks.py            # step 3
│   │   └── main.py             # step 4
│   ├── tests/
│   └── requirements.txt
└── frontend/                   # steps 5-9
    └── src/
```

---

## Step 0 — Test set and scaffolding

**Goal.** A labelled set of deliberately awkward photographs, and somewhere
to put code. Plan §14 is emphatic that this comes before any code, and it is
right: the detector is tuned against these images, so their absence means
tuning against imagination.

**Before you start.** Nothing exists yet. Confirm the working directory holds
only the three markdown files and the `.docx`.

### Substeps

- **0.1** Create the repo layout above. `git init`. Add a `.gitignore` for
  `venv/`, `__pycache__/`, `node_modules/`, `debug/`, `.env`.
- **0.2** Backend virtualenv, and install: `opencv-python`, `pytesseract`,
  `google-genai`, `fastapi`, `uvicorn`, `python-multipart`, `pydantic`,
  `pytest`. Install the Tesseract binary itself separately — the pip package
  is only a wrapper. Pin versions in `requirements.txt`.
- **0.3** Fix the template first. The marks table's answer row has no height
  set, so it renders the same height as the header — plan §3 requires it
  noticeably taller. Set an explicit row height in the `.docx` before
  printing anything, or every photograph in the test set will be of a grid
  that doesn't match the spec.
- **0.4** Print 15–20 copies of the corrected template and fill them in by
  hand. Use whole and half marks in a realistic mix, and leave a couple of
  cells blank. **Get three or four different people to write them** — a test
  set in one person's handwriting will teach the ID recogniser that
  handwriting, and step 2's accuracy number will be a lie.
- **0.5** Photograph them under the nine conditions in plan §6: straight-on,
  20–30° angle, shadow across the grid, crumpled paper, grid low on the page,
  fluorescent light, daylight, slightly out of focus, one column nearly cut
  off, grid small in frame. Most of the set should be imperfect on purpose.
  Include at least one genuinely unusable photo — it is the only way to test
  that failures are reported rather than guessed at.
- **0.6** Write `testset/labels.json` by hand: for each image, the true
  student ID, serial, per-question marks, total, the condition it exercises,
  and whether it is *expected* to succeed. That last field is what lets an
  unusable photo count as a pass when it fails correctly.

### Test

`labels.json` parses, has an entry for every file in `images/`, and no entry
without a file. Write that check as a script now — it is three lines and it
runs in every later step.

### Done when

Fifteen or more labelled photographs exist, the nine conditions are all
represented, more than one person's handwriting appears, and the
label/image consistency check passes.

---

## Step 1 — Standalone detection harness

**Goal.** `detect.py <image> --questions 5 --id-digits 7 --out debug/`
producing an overlay, cell crops, and a shape report.

This is the step that decides whether the project works. Plan §6: it has no
manual fallback, and its correct parameter values cannot be reasoned out in
advance. Expect to spend longer here than on any other step and expect that
to be time well spent.

**Before you start.** Confirm step 0's test set is present and labelled. Read
`stack-reference.md` §"Grid detection" for the starting parameter values —
they are a starting point for tuning, not answers.

### Substeps

- **1.1** CLI skeleton: parse arguments, load the image, create the output
  directory, write an empty `result.json`. Get the plumbing right before any
  vision code.
- **1.2** Binarize and isolate lines. Adaptive threshold on the inverted
  grayscale, then morphological open with a long horizontal kernel and a long
  vertical kernel. Kernel length is a fraction of image width and height, not
  a pixel constant (plan §5 step 1). Dump both masks to `debug/` — you cannot
  tune what you cannot see.
- **1.3** Find table rectangles. Contours on the combined mask, filter by
  minimum area, approximate to quadrilaterals. Expect three. Classify by
  aspect ratio and row count — the marks table is the only one with two rows.
  Report the count found in `result.json` whatever it is.
- **1.4** Deskew each table via a perspective transform from its four
  corners. Keep `minAreaRect` as the fallback for when the quad approximation
  won't yield four clean points — a curled page is in the test set precisely
  to exercise this.
- **1.5** Recover cell boundaries from the intersections of the detected
  lines within each table. Read the actual line positions; do not divide the
  width by the column count (plan §5 step 4).
- **1.6** Map columns to fields using the config, and implement
  `column_count_mismatch`. Plan §6 calls this core logic rather than error
  handling, because it is the difference between failing loudly and writing
  Q4's mark into the Q3 column. Never guess when the shape disagrees.
- **1.7** Write the three artifacts: `overlay.jpg` with table rectangles and
  every cell boundary drawn on the source photo, `cells/` with each crop
  named by position (`marks_r1_c3.png`, `id_d5.png`), and `result.json` with
  table count, per-table row/column counts, and shape-match status.
- **1.8** Batch runner: one command over the whole test set, writing per-image
  output into a directory you can review side by side.
- **1.9** Regression test: compare each `result.json` against `labels.json`
  and assert table count, column count, and expected success or failure
  reason. This is what makes step 1 re-runnable in one command for the rest
  of the project.

### Test

Two passes, and both are required.

**Automated** — `pytest` over the batch output for the shape assertions in
1.9. Fast, and the thing you re-run after every parameter change.

**Visual** — open every `overlay.jpg` and look at it. A wrong split is
obvious in the overlay and invisible in the JSON. Then look through `cells/`:
those crops are exactly what recognition receives, so a digit clipped here
will be misread in steps 2 and 3 and you will spend a day blaming Tesseract.

### Done when

Every image in the test set either produces correct cell crops or fails with
an accurate reason. **A wrong split that reports success is a defect.** A
genuinely unusable photo that returns `table_not_found` is correct behaviour
and counts as a pass. Do not proceed to step 2 before this holds for the
whole set.

---

## Step 2 — Local student ID recognition

**Goal.** Read the seven ID digits from the step 1 crops, locally, with a
confidence signal. Still a script.

The ID has no arithmetic guard and no second opinion — nothing downstream
catches a misread the way the sum check catches a wrong mark. Test it in
isolation.

**Before you start.** Confirm step 1 writes `cells/id_d*.png` and that those
crops look clean. If a digit is clipped, fix step 1 first — no OCR
configuration recovers a cropped digit.

### Substeps

- **2.1** Per-crop preparation: pad, threshold, and scale each digit box.
  Tesseract does poorly on a tightly-cropped glyph touching the frame edge.
- **2.2** Recognise with `--psm 10` (single character) and a digit whitelist.
- **2.3** Confidence: use `image_to_data` rather than `image_to_string` —
  only the former returns a `conf` column. Empty result or confidence below
  the floor adds `"student_id"` to `low_confidence_fields`. Flag, never guess.
- **2.4** Accuracy harness over the whole test set, reporting per-digit
  accuracy and whole-ID exact-match rate against `labels.json`.

### Test

Run 2.4 and read the numbers. Per-digit accuracy is the diagnostic;
whole-ID exact match is what the instructor actually experiences, and at
seven digits it is much lower than per-digit accuracy suggests. Inspect every
miss individually — a systematic confusion (1 vs 7, 5 vs 6) is a preparation
problem in 2.1, not a reason to change tools.

### Done when

Both accuracy numbers are measured and written down, every misread digit has
been looked at, and low-confidence boxes are flagged rather than filled with
a guess. If accuracy is poor and 2.1 doesn't fix it, plan §7's noted fallback
is a small trained classifier — but decide that on the numbers.

---

## Step 3 — Serial and marks via Gemini

**Goal.** One API call per script returning the serial and every mark, as
validated structured JSON. Still a script.

**Before you start.** Confirm steps 1 and 2 both pass. Read
`stack-reference.md` §"Serial + marks" — particularly the retry behaviour and
the blocked-response trap, which are easy to get wrong in ways that only show
up under load.

### Substeps

- **3.1** Tile the serial and mark crops into one composite image, labelled
  by position. **Assert in code that no ID crop is in the composite** — plan
  §12's privacy property is a one-line mistake away from being false, so make
  it a test rather than a convention.
- **3.2** Build the prompt: the legal value set per question, derived from
  each question's own max, and the instruction to return one value from that
  set per cell plus the serial as written. Nothing about output format.
- **3.3** Attach a Pydantic response schema so the reply is structurally
  constrained. Do not restate the shape in the prompt — with a schema
  attached that makes results worse.
- **3.4** Reject any value outside the legal set for its question. The schema
  constrains structure, not range: a 7 can still arrive for a 5-mark
  question. Rejected fields go to `low_confidence_fields` and stay blank.
- **3.5** Configure the SDK's retry options rather than writing a backoff
  loop. Then handle the case retries don't cover: a blocked or empty response
  is a 200, so nothing raises and nothing retries. Check the block and finish
  reasons on every response and map them to `model_error`.
- **3.6** Accuracy run over a subset of the test set. Cache responses to
  fixture files so later steps can replay them without spending quota.

### Test

Unit-testable without the network, and these are the ones that matter most:

- The legal-value rejection, fed synthetic responses containing `7` for a
  5-mark question, `4.25`, `-1`, and `null`. All four must be rejected or
  passed through as blank, never stored.
- The ID-exclusion assertion from 3.1.
- Block-reason and finish-reason handling, fed a mocked 200 with empty
  content. Must produce `model_error`, not a crash.

Then a live accuracy run on the subset, compared against `labels.json`. Pay
attention to half marks specifically — 4 versus 4.5 is the discrimination the
whole constrained-enumeration design exists to make reliable.

### Done when

Mark accuracy is measured and written down, no illegal value can reach
storage, ID crops are provably absent from the composite, and a blocked
response produces a clean `model_error` rather than an exception.

---

## Step 4 — Wrap steps 1–3 in FastAPI

**Goal.** `POST /api/scan`. By this point the hard part is proven, and the
endpoint is a thin wrapper over working code — which is the entire reason it
comes fourth rather than first.

**Before you start.** Confirm steps 1–3 run end to end from the command line
on a single image. If they don't, the endpoint will just make debugging
harder.

### Substeps

- **4.1** `models.py`: `ScanResult`, `QuestionMark`, `QuizConfig` per plan §8.
- **4.2** The endpoint. One `multipart/form-data` request: the image as
  `UploadFile`, the config as a JSON string in a form field. A JSON body
  cannot ride alongside a file — parse the field with
  `QuizConfig.model_validate_json`.
- **4.3** Wire the pipeline in order, honouring plan §9's early exits: never
  call Gemini after `table_not_found` or `column_count_mismatch`.
- **4.4** CORS for both `localhost` and the laptop's LAN address.
- **4.5** Confirm statelessness — nothing written to disk, no globals holding
  request data between calls.

### Test

`TestClient`, with the Gemini call mocked using step 3.6's cached fixtures.
The suite must not touch the network.

- Each failure reason produces the right `status` and `failure_reason`.
- A `table_not_found` image never reaches the Gemini call — assert the mock
  was not invoked. This is the one that protects the quota and the privacy
  property together.
- A known-good image returns the same values the CLI produced for it.
  Divergence here means the endpoint reimplemented something.

### Done when

The suite passes offline, the endpoint agrees with the CLI on the whole test
set, and two consecutive requests cannot influence each other.

---

## Step 5 — Frontend scaffold and Setup screen

**Goal.** Config in, persisted, surviving a refresh.

**Before you start.** Confirm the backend runs and responds. Read plan §9
"Running locally" before configuring the dev server — the HTTPS requirement
in 5.1 is not optional and is much cheaper to set up now than to retrofit in
step 6.

### Substeps

- **5.1** Vite + React + TypeScript, `vite-plugin-pwa`, and a locally-trusted
  certificate for the dev server (mkcert or the basic-ssl plugin), bound to
  `--host` so the phone can reach it. Trust the certificate on the phone now
  and confirm the page loads there — before there is any camera code to
  confuse the diagnosis.
- **5.2** IndexedDB schema via `idb`: a `records` store keyed by uuid with
  indexes on serial and student ID, and a `config` store. **The indexes must
  permit duplicates** — a repeated serial is what step 7's cross-check exists
  to surface, and a uniqueness constraint would throw on write instead.
- **5.3** The Setup form per plan §11: quiz name, ID digits, question count,
  per-question max, and the note that these must match the pasted table.
- **5.4** Persist `QuizConfig` on submit and reload it on start.

### Test

Vitest over config validation — question count drives the number of max
inputs, `totalMax` is the sum, zero questions and non-numeric maxima are
rejected. Then manually: fill the form, hard-refresh, confirm the config
survives. Confirm on the phone, over HTTPS, that the page loads.

### Done when

Config persists across a refresh, and the phone loads the app over HTTPS
without a certificate warning.

---

## Step 6 — Camera capture and upload queue

**Goal.** Photograph a script and see a raw result come back.

**Before you start.** Confirm 5.1's HTTPS setup works on the phone. If
`getUserMedia` fails here, that is almost always the cause — it fails at the
camera rather than at page load, so it looks like a permissions problem.

### Substeps

- **6.1** `getUserMedia` preview, rear camera, with a framing guide
  reflecting plan §3: tight on the three tables, marks table the largest
  rectangle in the shot.
- **6.2** Capture to a blob at a resolution high enough for the detector.
  Check what step 1 actually needs — an over-compressed capture destroys the
  thin table rules the whole detector depends on.
- **6.3** Upload queue: capture the next script while the previous is in
  flight, so the camera never blocks on a call. Show the in-flight count.
- **6.4** Render the raw `ScanResult` — no review UI yet, just proof the
  round trip works.

### Test

On the real phone, on the real network, against the laptop backend. Capture
five scripts in quick succession and confirm the camera stays responsive and
all five results arrive. Then kill the backend mid-queue and confirm the app
reports it rather than hanging.

### Done when

Five consecutive captures round-trip without blocking the camera, and a dead
backend produces a visible error instead of a spinner.

---

## Step 7 — Review screen

**Goal.** The correctness layer. Plan §10 in full.

**Before you start.** Re-read plan §10 and §11's Review mockup. Confirm the
IndexedDB indexes from 5.2 exist, since the cross-check depends on them.

### Substeps

- **7.1** Identity fields first and largest, above the marks. Plan §10 is
  explicit that these must never render as ordinary small fields — the
  instructor is holding the script, and this is the highest-value check in
  the workflow.
- **7.2** Editable mark fields and total, with the deskewed grid image beside
  them for comparison.
- **7.3** Sum check, derived on render, never stored. A stored flag can go
  stale behind an edit.
- **7.4** Legal value check on manual edit — a multiple of 0.5 within
  `0..max` — so a typo during correction cannot slip through either.
- **7.5** Identity cross-check on save, implementing plan §10's table by
  index lookup. Serial comparison strips leading zeros.
- **7.6** Failure states: a failed scan lands here with empty fields, the
  reason shown, and Retake and Enter-manually available. A bad photo never
  blocks the session.

### Test

The heart of the suite, and all of it pure functions with no DOM:

- Sum check, including half marks — the case the design exists for.
- Legal value: `4.25`, `-1`, `5.5` on a 5-mark question all rejected.
- Serial normalisation: `2`, `02`, `002` all equal.
- **Plan §10's cross-check table as a parameterised test** — all five rows.
  Same serial same ID blocks; same serial different ID warns; same ID
  different serial warns; both empty blocks; one filled saves as unverified.
  The table is already written as test cases; use it as one.

Then manually: correct a mark and confirm the sum check updates live.

### Done when

All five cross-check rows pass as tests, the sum check recomputes on edit,
and a `status: "failed"` result reaches an editable screen rather than a
dead end.

---

## Step 8 — Scan loop wiring

**Goal.** Confirm → save → camera reopens, thirty times without friction.

**Before you start.** Confirm step 7 saves correctly to IndexedDB and step 6
still queues while the review screen is open.

### Substeps

- **8.1** Confirm advances to the next capture with the camera already live.
  Anything that adds a tap here gets paid thirty times per class.
- **8.2** Running count, and the in-flight upload count.
- **8.3** Crash and refresh recovery — reload mid-session and confirm every
  saved record is still there. This is what IndexedDB is for.

### Test

Ten scripts end to end without touching the keyboard except to correct a
misread. Then hard-refresh at record six and confirm the first five survive
and the loop resumes.

### Done when

Ten consecutive scripts complete, and a mid-session refresh loses nothing.

---

## Step 9 — Results table and Excel export

**Goal.** The file that is the point of the whole exercise.

**Before you start.** Confirm records save with all fields populated. Read
`stack-reference.md` §"Excel export" — including the bundling note, which is
the one thing here that can fail at build time rather than run time.

### Substeps

- **9.1** Results table sorted by serial then ID, inline-editable, with edits
  writing back to IndexedDB.
- **9.2** Unverified marking for single-identity records, and the record
  count.
- **9.3** The attendance-sheet note. Plan §10 is clear this must be stated
  plainly at Finish: the app has no class list, so it cannot know a serial is
  out of range or a student was skipped. Say it as an expectation, not a
  surprise.
- **9.4** ExcelJS export. Build `ws.columns` from `QuizConfig` so question
  columns follow the quiz, then `writeBuffer()` → Blob → object URL →
  anchor click.

### Test

Verify the bundle builds first — ExcelJS is Node-first and this is where a
bundling problem surfaces. Then export a full session and **open it in both
Excel and LibreOffice**: column headers correct, half marks as numbers rather
than text, blanks genuinely blank rather than zero, row order as specified.

A blank that exports as `0` is the worst possible failure here — it looks
like a mark of zero and there is nothing downstream to catch it.

### Done when

The file opens cleanly in both applications, blanks are distinguishable from
zeros, and the export matches the on-screen table exactly.

---

## Step 10 — Full rehearsal

**Goal.** Find the failure on a quiet evening rather than on script nineteen
of thirty with a class waiting.

Not in plan §14, but everything it tests only appears at volume: the free-tier
rate limit, sustained queueing, battery, and how the workflow feels when you
have done it twenty-nine times already.

**Before you start.** Steps 0–9 all meeting their bars.

### Substeps

- **10.1** Thirty filled scripts. Reuse the test set and pad it out — the
  point is volume and pace, not novelty.
- **10.2** Scan all thirty at realistic speed, on battery, on the classroom
  network if you can get to it. Time it.
- **10.3** Watch for `rate_limited`. This is the first time the free-tier
  ceiling is genuinely exercised, and if the queue mishandles it the session
  degrades rather than recovers.
- **10.4** Export and reconcile against the attendance sheet exactly as you
  would in practice.
- **10.5** Write down what was slow or annoying. Thirty repetitions surfaces
  friction that ten does not.

### Test

The reconciliation is the test. Every mark in the spreadsheet matches the
script it came from — checked by hand, all thirty.

### Done when

Thirty scripts complete in one session, no record is lost or wrong, rate
limiting degrades gracefully rather than killing the session, and you know
how long a class actually takes.

---

## Progress

| Step | State |
|---|---|
| 0 — Test set and scaffolding | not started |
| 1 — Detection harness | not started |
| 2 — Local ID recognition | not started |
| 3 — Serial and marks via Gemini | not started |
| 4 — FastAPI wrapper | not started |
| 5 — Frontend scaffold and Setup | not started |
| 6 — Camera and upload queue | not started |
| 7 — Review screen | not started |
| 8 — Scan loop wiring | not started |
| 9 — Results and Excel export | not started |
| 10 — Full rehearsal | not started |
