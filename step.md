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

## Steps 2r.0 / 2r / 3r / 3r.6 — Local CNN recognizer (optional track)

Folded in from `Cnn migration.md` after steps 2, 3, and 7 were already
done and the rate-limited fallback (`marks_ocr.py`) had just shipped —
full design in [plan.md §16](plan.md#16-local-cnn-recognizer-optional-alongside-gemini).
**This track is optional and additive.** It does not replace or renumber
steps 4–10 below, and nothing in steps 2 or 3 above gets deleted or
rewritten by it — `id_ocr.py`, `marks.py`, and `marks_ocr.py` get moved
behind a shared interface, not discarded. Pick this up whenever step 3's
own two triggers (real quota pressure, real accuracy ceiling) are worth
spending more time on than moving straight to step 4; both triggers have
already fired for real once (`step.md` step 2 and step 3's own Progress
notes), which is why this track exists at all rather than staying a
"maybe someday" note in plan.md §13.

### Step 2r.0 — Extract the recognizer interface

**Goal.** Give the CNN a working seam to slot into later, with zero
behavior change right now. This step only moves code and adds a thin
adapter — it does not touch what any of steps 2 or 3's logic actually
does.

**Before you start.** Confirm steps 2 and 3 (including the `marks_ocr.py`
rate-limited fallback) are in the state the Progress table below
describes — this step relocates that code, so it has to exist first. Read
plan.md §16's "Two paths behind one interface" in full.

#### Substeps

- **2r.0.1** Define the `Recognizer` protocol in `app/recognizers/base.py`:
  `read_id(id_crops) -> IdResult`, `read_marks(serial_crop, mark_crops,
  total_crop, config) -> MarksResult`.
- **2r.0.2** Move the existing logic — `id_ocr.py` (Tesseract),
  `marks.py` (Gemini), and `marks_ocr.py` (the rate-limited fallback) —
  behind `app/recognizers/remote.py`'s `RemoteRecognizer`. An import-path
  change plus a thin adapter, not a rewrite; the logic inside is already
  tested and tuned.
- **2r.0.3** Switch `main.py` to resolve one `Recognizer` at startup via
  `RECOGNIZER` (`"cnn" | "remote" | "both"`, defaulting to `"remote"` —
  see plan.md §16) and call through it instead of calling `recognize` /
  `read_id` / `recognize_locally` directly. Since `CNNRecognizer` doesn't
  exist yet, wire `"cnn"`/`"both"` to fail loudly rather than silently
  falling back to `"remote"` — that failure is what makes 2r/3r's absence
  obvious instead of quietly masked.
- **2r.0.4** Parameterize the existing "no recognizer runs after a
  detection failure" test (step 4's test suite) over the `Recognizer`
  implementation, rather than duplicating it — the property applies to
  both paths equally.

#### Test

The full existing backend test suite (34 tests as of the rate-limited
fallback) must pass **unchanged** after this move. Any failure means the
move rewrote something it should have only relocated — treat that as a
defect in this step, not an acceptable side effect of refactoring.

#### Done when

`main.py` calls only through the `Recognizer` protocol, `RemoteRecognizer`
reproduces the exact current behavior end to end (including the
`rate_limited`/`model_error` → local-OCR fallback), and every existing
test passes with zero behavior changes.

---

### Step 2r — Train the digit CNN

**Goal.** A small local digit classifier that beats Tesseract's measured
baseline — 58.9% per-digit, 0-of-8 whole-ID exact match, both against real
phone photos (step 2's Progress note) — while holding the same "0
confidently wrong" bar `id_ocr.py` already holds itself to. Standalone; no
app integration yet.

**Before you start.** Complete step 2r.0. Read plan.md §16's "Model and
training" section in full — the MNIST-matched preprocessing (centering by
centre of mass, not bounding-box centre) is called out there as the single
most common way this kind of model quietly underperforms in production,
and is worth re-reading twice before writing the preprocessing function.

#### Substeps

- **2r.1** Training script: EMNIST Digits (not MNIST — 240k samples, more
  writer variety), the small CNN architecture from plan.md §16 (~150KB as
  ONNX), rotation/translation/scale/elastic augmentation. Watch the EMNIST
  transpose bug — `.transpose(1, 2)` needed, or the model trains on
  rotated digits.
- **2r.2** Implement the MNIST-matched preprocessing (12% inset — already
  in `id_ocr.py` — Otsu binarize, crop to the ink bounding box, scale the
  longest side to 20px, paste centered by centre of mass onto a 28×28
  canvas) as a standalone function. Run it over the existing real
  `cells/id_d*.png` crops and **look at the 28×28 outputs directly** —
  they should be visually indistinguishable from real EMNIST samples. If
  they're not, no training run fixes it; fix the preprocessing first.
- **2r.3** Train, export to ONNX, verify the ONNX output matches the
  PyTorch model on a fixed batch — a numerical parity check, not just "it
  exports without error."
- **2r.4** Accuracy harness over the real crops already in `testset/` and
  `backend/debug_uploads/`, using the exact ground truth
  `id_ocr_accuracy.py` already reads from `testset/labels.json`. Report
  per-digit accuracy and whole-ID exact match, directly comparable to the
  current 58.9% / 0-of-8 numbers.

#### Test

Run the accuracy harness against every real photo currently labelled with
a `student_id` (9 images as of the rate-limited-fallback work) and report
the same two numbers `id_ocr_accuracy.py` already reports, so the
comparison to the Tesseract baseline is apples to apples.

#### Done when

Per-digit accuracy on real crops is measured — not estimated — and
materially beats 58.9%, and the confidently-wrong count stays at zero. A
lower-but-honest number beats a higher-but-sometimes-wrong one, per this
project's existing "flag, never guess" rule.

---

### Step 3r — Segmentation and constrained decoding

**Goal.** Extend the CNN from single isolated digits (the ID, already
boxed one-per-cell by the template) to the serial and mark cells, which
hold multiple glyphs in one cell and need segmenting before the same
classifier can read them.

**Before you start.** Complete step 2r. Read plan.md §16's "Segmentation"
and "Constrained decoding" sections — the overlap-merge rule for
disconnected strokes and "score every legal value directly" are both
load-bearing there, not optional refinements.

#### Substeps

- **3r.1** Segmentation per cell (after the existing 12% inset): Otsu
  binarize, `cv2.connectedComponentsWithStats`, drop components below a
  noise-area floor, **merge horizontally-overlapping components** (a
  disconnected-stroke `4` or `5` produces two components that are really
  one glyph — merge if x-ranges overlap more than ~50% of the narrower
  one), sort left to right by centroid x.
- **3r.2** Classify each segmented component as digit or decimal point by
  geometry alone (height below ~35% of median component height, centroid
  in the lower third of the glyph band) — no model, no training data
  needed for the decimal point.
- **3r.3** Constrained decoder: score every legal value in the question's
  own legal set directly against the per-glyph probability vectors
  (product of per-digit class probabilities), rather than parsing free
  text and validating after. Reuses `marks.py`'s existing
  `legal_values()`.
- **3r.4** Wire serial, marks, and total through the segmenter + decoder,
  behind the `Recognizer` protocol from 2r.0, as `CNNRecognizer` in
  `app/recognizers/local.py`.
- **3r.5** Accuracy run against `testset/labels.json`, with half marks
  (`4` vs `4.5`) called out separately in the report — that discrimination
  is exactly what the constrained decoder exists to make reliable.

#### Test

Unit tests, no network needed for any of them:

- The decoder, fed synthetic probability vectors, returns the legal value
  they encode.
- The decoder never returns a value outside the legal set, whatever it's
  fed.
- A disconnected-stroke `4` (two components) merges into one glyph rather
  than two.
- A blank cell returns empty, not a confident digit — mirrors
  `id_ocr.py`'s existing blank-handling, extended to this path.
- Ambiguous/low-margin input returns `None` and flags rather than
  guessing.

#### Done when

Mark accuracy on real photos is measured, half marks are distinguished
reliably from whole marks, and no illegal value can reach storage — the
same standard `marks.py`'s `validate_payload` already holds Gemini's own
output to.

---

### Step 3r.6 — Collection sheet and comparison run

**Goal.** Decide, with real evidence rather than a hunch, whether the CNN
path is actually ready to become the default — and build the sample-
collection pipeline this project keeps needing regardless of that outcome.

**Before you start.** Complete step 3r. Read plan.md §16's "Collecting
real handwriting samples" section in full, especially the asymmetry it
draws between who should write marks-training samples (the one instructor,
every time, forever) versus ID/serial-training samples (many different
writers — the instructor's own handwriting is nearly useless for that
field).

#### Substeps

- **3r.6a** Build the collection-sheet generator (a `.docx` variant of the
  existing marks-grid template, one row per digit 0–9, ~20 empty cells per
  row — labels come from row position, so no manual annotation is needed
  at all). Collect from at least four different writers for the ID/serial
  samples; collect the instructor's own handwriting separately for the
  marks samples. Process both through the existing `detect.py` into
  `training_data/<writer>/<digit>/<uuid>.png`.
- **3r.6b** Fine-tune two separate heads on the frozen conv base (~1e-4
  learning rate) — one weighted toward the instructor's hand for marks,
  one weighted evenly across writers for the ID — holding out a real,
  unseen-writer photo set to measure against. Re-run the step 2r/3r
  accuracy harnesses. This is the number that decides whether the CNN path
  is genuinely ready, not a guess.
- **3r.6c** Also build the harvesting path from real use: on Confirm
  (Review screen, step 7), POST the cell crops alongside the confirmed
  values to `training_data/harvested/`, tagging corrections separately
  from confirmations (corrections are the model's actual failures and
  worth oversampling; confirmations mostly re-teach what it already
  knows). Build this now even though nothing consumes it yet —
  retrofitting later means losing every label from the pilot, which is the
  period these labels matter most.
- **3r.6d** Run a full quiz (or the fullest rehearsal available) with
  `RECOGNIZER=both` and read `comparison_log/` — every disagreement
  between the CNN and the remote path is a hard case with a
  human-confirmed answer attached from the review screen, worth more than
  an aggregate accuracy number off a thin labelled set.
- **3r.6e** Set `RECOGNIZER=cnn` as the default only once it wins on the
  comparison run. Leave `RemoteRecognizer` in place regardless — it costs
  nothing sitting unused, and it's the only independent check available on
  the local model.

#### Test

Manual: run `RECOGNIZER=both` across a real batch of scripts and confirm
every logged disagreement in `comparison_log/` has both values and a
resolved (instructor-confirmed) answer recorded. Re-run the step 2r/3r
accuracy harnesses after fine-tuning and confirm they improved against the
pre-fine-tune numbers, not just against Tesseract's original baseline.

#### Done when

The CNN path's accuracy is measured against the remote path's on the same
real batch (not estimated), the CNN wins the comparison, and
`RECOGNIZER=cnn` is set as the default with `RECOGNIZER=remote` confirmed
still working as a fallback.

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
| 0 — Test set and scaffolding | in progress — repo layout, venv, requirements.txt, and the `.docx` row-height fix (0.1–0.3) are done. `labels.json` schema and `check_labels.py` (0.6) are in place. Two real photos exist, both hand-drawn with pen and ruler (no printer): `empty_file.jpeg` (blank grid) and `filled_file.jpeg` (real ID/serial/marks filled in, half-marks and a zero included), both labelled and passing regression. Still far short of the Done-when bar: need 15–20 photos total, 3–4 different people's handwriting, and all 9 awkward conditions — both photos so far are the easy "straight-on, well-lit, one person" case. 0.4–0.5's printing step is skipped in favor of hand-drawing, which the detector doesn't distinguish — see learn.md. |
| 1 — Detection harness | in progress — `detect.py`, `app/detection.py`, `batch_detect.py`, and the step-1.9 regression test are written per stack-reference.md's starting parameters, then genuinely tuned twice against real photos (see learn.md): (1) reused the whole-photo line masks per table instead of re-deriving them at table scale, plus raised `KERNEL_DIVISOR` 30→20, to stop handwritten label text ("ID", "Serial") from aliasing as column dividers; (2) added `MIN_LINE_COVERAGE_FRAC` (a candidate line must cover ~40%+ of the table's own height/width) to stop a tall handwritten digit — a "1" in "11" — from aliasing as one too, since raising the length bar alone couldn't distinguish "digit that happens to be tall" from "genuine rule" once the digit was written in a deliberately tall cell. Both real photos now pass end-to-end (`status: "ok"`, all three tables, exact column counts) and the regression suite (1.9) is running for real instead of skipping. Plumbing also separately proven via synthetic placeholder images: blank page correctly fails `blurry`, noisy image correctly fails `column_count_mismatch` rather than guessing. **Still far from step 1's Done-when bar** — two easy-condition photos are not the 15–20-photo, 9-condition test set. A synthetic 15°-rotated case still fails outright (axis-aligned kernel doesn't survive in-plane rotation) — open, unsolved, needs a real angled photo to tune against rather than a synthetic guess. |
| 2 — Local ID recognition | in progress — tesseract-ocr installed, unblocking real measurement. `app/id_ocr.py` (2.1–2.3) and `id_ocr_accuracy.py` (2.4) written, then tuned twice against the one real filled photo (see learn.md): (1) inset crops 12% before thresholding — the raw crop included a sliver of the cell's own border line, which read to Tesseract as extra ink and tanked recognition; (2) switched `PSM` from stack-reference.md's suggested 10 ("single character") to 8 ("single word") after measuring 10 completely failing on two clean, legible digits that 8 read correctly — real evidence overriding the doc default. `CONFIDENCE_FLOOR` lowered 60→35 (correct reads landed at 39–41 on this photo); noted in-code as provisional, calibrated from n=1. First real result (n=1): 3/7 digits correct, 4 correctly flagged uncertain, 0 confidently wrong, whole-ID exact match 0/1 — honest but not yet a real accuracy number, that sample being far too thin. **Widened from n=1 to n=8** using real photos from the step 6/7 phone test session (`backend/debug_uploads/`, pulled in with the user-confirmed `student_id` as ground truth — see `testset/labels.json`'s `phone_*` entries and their notes on why serial/marks were deliberately left unlabeled). Re-measuring against this larger, still-single-handwriting sample: **21/56 digits (37.5%), 0/8 exact match, 0 confidently wrong** — a real number now, if still not "different handwriting" per the original caveat. That sample surfaced a genuine bug, not just noise: positions 5–7 were wrong in *every* photo. Inspecting the actual crops (`id_d5.png`/`id_d6.png`/`id_d7.png`) showed Tesseract's LSTM engine was reading correctly-shaped digits as look-alike letters at high confidence — a handwritten "0" as `"D"` (86%), a handwritten "1" as `"l"` (90%) — and `tessedit_char_whitelist` was silently discarding the whole result instead of falling back within the digit alphabet. Fixed with a second, unconstrained OCR pass (`FALLBACK_PSM=7`) that only fires when the whitelisted pass finds nothing, and only accepts a result if it's a known digit/letter look-alike (`DIGIT_LOOKALIKES`) above a stricter confidence floor (60) — see learn.md step 2. Re-measured: **33/56 digits (58.9%), 0/8 exact match, still 0 confidently wrong** — every gain came from resolving previously-flagged-uncertain digits correctly; none introduced a wrong answer. All 28 backend tests and 9/9 `batch_detect.py` still pass. **Still not the Done-when bar** — same handwriting throughout, and whole-ID exact match is still 0/8 (getting all 7 digits right in one photo needs every position right at once, and positions like the always-hard "7" glyph are still correctly flagged rather than guessed). |
| 3 — Serial and marks via Gemini | in progress — `GEMINI_API_KEY` added, unblocking a live run. `app/marks.py` (3.1–3.5) and `tests/test_marks.py`'s 16 offline tests still pass unchanged. First live call 404'd on the model name (`gemini-2.5-flash` retired — Google's own error named the replacement, `gemini-3.6-flash`; switched to it, a real-world API-drift fix, not a code bug). Second live call, against `filled_file.jpeg`: **every field exactly correct** — serial `07`, marks `[3.0, 2.5, 1.0, 0.0, 4.5]`, total `11.0`, nothing flagged low-confidence. Cached to `tests/fixtures/filled_file_gemini_response.json` per step 3.6 so step 4's tests can mock it without spending quota. **One clean photo passing is not step 3's Done-when bar** — same caveat as steps 0–2: this is the easy, well-lit, single-photo case, not evidence across messy real conditions. **Rate-limited fallback added** (2026-08-26, prompted by the real `rate_limited` hit during the step 6/7 phone session): `app/marks_ocr.py` is a local Tesseract-based fallback, invoked from `main.py` only when `recognize()` itself fails (rate_limited/model_error) — never a replacement for the Gemini path, and explicitly not what plan.md's "Deferred" local-mark-classifier note rules out, since it's a degraded last resort rather than a primary recognizer. Reuses `id_ocr.py`'s `_prepare`/fallback-PSM approach but reads whole short strings (PSM 7, no single-character restriction) instead of single digits, since serial/mark crops hold more than one character. Every value is still run through `marks.py`'s own `legal_values` check — an illegal or unparseable read is rejected exactly like a bad Gemini read, never stored. Every field this function touches is unconditionally flagged low-confidence, recovered or not, since this path is deliberately weaker than a fresh Gemini read even when it does parse. If nothing at all is recoverable, `recognize_locally` returns `None` and `main.py` falls through to the original failure — a rate-limited scan with zero local recovery still says so honestly rather than presenting an all-blank result as if it were a normal scan. Tested against real crops from `filled_file.jpeg` (2/7 fields recovered — Q2, Q5 — everything else correctly `None`, nothing wrong) plus 6 new backend tests (4 unit, 2 `main.py` integration via mocks). All 34 backend tests pass. No frontend changes needed — this reuses the existing `low_confidence_fields` flagging the Review screen (step 7) already renders. |
| 2r.0 — Extract recognizer interface (optional CNN track) | not started — folded in from `Cnn migration.md` into plan.md §16 and this file. Optional and additive; does not block or reorder steps 4–10. |
| 2r — Train the digit CNN (optional CNN track) | not started — depends on 2r.0. |
| 3r / 3r.6 — Segmentation, constrained decoding, and comparison run (optional CNN track) | not started — depends on 2r. |
| 4 — FastAPI wrapper | in progress — `app/models.py` (4.1, matching plan.md §8 exactly) and `app/main.py`'s `POST /api/scan` (4.2–4.5) written as a thin wrapper over steps 1–3, unchanged. Multipart image + JSON-string config field (4.2), pipeline wired with the required early exits — Gemini never called after `table_not_found`/`column_count_mismatch` (4.3), CORS via a regex matching localhost + all private LAN ranges rather than one hardcoded address (4.4), statelessness via a per-request `TemporaryDirectory` deleted before the response returns, no globals (4.5). All 21 tests pass offline (`TestClient`, only `recognize`/Gemini mocked — detection and local ID OCR run for real): each of the three failure reasons confirmed to never call the Gemini mock (`assert_not_called`), a known-good image matches expected values exactly, two back-to-back requests with different configs proven not to contaminate each other. Then verified live, no mocks: a real HTTP request through the real endpoint hitting the real Gemini API reproduced the CLI's exact values (`serial: "07"`, marks `[3.0, 2.5, 1.0, 0.0, 4.5]`, `total: 11.0`) and honestly surfaced the still-imperfect ID OCR as `low_confidence_fields: ["student_id"]` rather than hiding it. **Still not the Done-when bar** — "the endpoint agrees with the CLI on the whole test set" is true for the one real photo with values in it; the set itself is still thin (steps 0–3's shared, repeated caveat). |
| 5 — Frontend scaffold and Setup | in progress — Vite + React + TypeScript scaffolded, `vite-plugin-pwa` and HTTPS configured (5.1: `@vitejs/plugin-basic-ssl` instead of `mkcert` — no passwordless sudo for the system binary/CA trust, same wall as Tesseract; self-signed means a real click-past warning on the phone, kept deliberately per user decision — see learn.md). `db.ts`'s IndexedDB schema (5.2) — non-unique indexes on serial/studentId, a caching bug caught by tests (not code review) and fixed by not caching the connection. `Setup.tsx` (5.3) and persistence on submit/reload (5.4) built. 14 Vitest tests pass, clean `tsc`, clean production build. **Real-browser testing found a real bug**: the LAN address the phone actually connects through wasn't in the generated cert's hostname list, which broke service worker registration specifically (harder failure than the plain page load, which can be clicked past) — fixed by detecting this machine's actual LAN IPs at config time (`os.networkInterfaces()`) and adding them to the cert, the same no-hardcoding approach already used for backend CORS. Verified two ways post-fix: `openssl s_client -verify_hostname` shows only the expected self-signed warning, no hostname mismatch; `dev-sw.js` now returns 200 over the LAN address. **Still not the full Done-when bar** — a real hard-refresh persistence check on an actual phone remains the one piece nothing here can substitute for. |
| 6 — Camera and upload queue | in progress — real phone testing underway, three real detection bugs found and fixed from actual captures (see learn.md). Infrastructure: fixed a mixed-content gap (backend needed HTTPS too, `gen_dev_cert.py`); `getUserMedia` + framing guide (6.1), capture-to-blob (6.2), `scanQueue.ts`'s tested upload-queue state machine (6.3), raw `ScanResult` rendering (6.4) built in `Scan.tsx`/`api.ts`. Diagnosed via `backend/debug_uploads/` (gitignored, explicitly marked temporary, since the backend is otherwise stateless — there was nothing else to inspect real captures with). Three bugs found and fixed, all variants of the same root issue — a shape-only match (row/column counts) can't tell geometrically-valid-but-wrong content from correct content: (1) this phone's camera reports portrait video dimensions without actually rotating the pixel content to match — fixed with `detect_any_orientation()`, retrying at 90/180/270° only on `table_not_found`, `detect()` itself kept strict; (2) a real border line detected 8px short of the table's true edge tripped the edge-insertion fallback into adding a spurious second boundary, silently flipping a table's row_count — fixed with `_merge_close_bounds`, collapsing any two final boundaries closer than every genuine gap ever measured (190px+); (3) a table rotated a full 180° still has the *right shape* (same row/column counts) while reading every value backwards — the rotation retry from fix (1) could confidently lock onto exactly this false match. Fixed using a rule already in the template by design, for an unrelated reason: the answer row is deliberately taller than the header row (plan.md §3, originally for handwriting room) — enforcing "the second row must be the taller one" rejects any upside-down match outright. **Result: 3 of 4 real phone photos now pass completely**, matching every value already proven in steps 1–4; the fourth correctly reports `table_not_found` (unrelated, already-understood cause — some genuine dividers not detected, likely lighting; refusing to guess is correct behavior, not a bug, and unchanged by any of today's three fixes). All 21 backend tests, both existing real testset photos, and the synthetic set stayed green throughout every fix — no regressions. The synthetic 15°-rotation case remains genuinely open (needs fine-grained angle correction, not 90°-snapping) — distinguished from the near-90°/180° "held at a different quadrant" cases this session solved. A fourth issue surfaced on new photos with different marks: the ID table found 9 columns instead of 8 (a handwritten "1" measured at 0.449 coverage, uncomfortably close to the weakest genuine line ever measured, ~0.49) — flagged as a real, still-open threshold-tuning gap, not yet fixed. Rather than tune the threshold again, fixed the *recurring pattern* at its source instead: `Scan.tsx` now rotates a portrait-shaped capture (videoHeight > videoWidth) 90° before upload, since the template is always physically wider than tall — this needs no orientation guessing at all for the common case. Verified by replicating the exact canvas transform math against a real saved photo and running it through actual detection (perfect match) plus a visual check that the result is genuinely upright, not just shape-matched by luck. Backend's 4-way retry and upside-down check stay as a safety net for other devices, not retired. **Still not the Done-when bar** — five-captures-in-a-row and dead-backend-error-handling are untested; both need direct phone interaction, and the new frontend rotation itself is unverified on a real device yet. |
| 7 — Review screen | done — built ahead of step 6's own Done-when bar (real-phone testing of five-in-a-row capture and dead-backend handling), by explicit user direction rather than the usual step order. `validateMarks.ts` (7.3–7.5: sum check, legal-value check, serial normalization, plan.md §10's identity cross-check) and `Review.tsx` (7.1, 7.2, 7.6) written. Identity fields render first at 2rem, above editable marks shown beside the capture preview; low-confidence fields get an amber border; a failed scan reuses the same form with empty fields, a reason banner, and Retake/Enter-manually rather than a dead end; save runs the cross-check via `db.ts`'s by-serial/by-studentId indexes and blocks/warns/allows per plan.md's table, with a conflict panel offering Overwrite or Save-anyway. Minimally wired into `Scan.tsx` (a Review button per finished capture) so the screen is actually reachable — the frictionless "Confirm advances straight to a live camera" loop is step 8's job, not built here. All of this step's own Done-when bar is met without a phone, since it's pure form logic: 18 pure-function tests (`validateMarks.test.ts`, including all five cross-check table rows as one parameterized block) plus 6 component tests (`Review.test.tsx`, via React Testing Library + fake-indexeddb) directly assert the sum check recomputes live on edit, an illegal edit blocks Confirm, and a failed result reaches an editable screen. 45/45 frontend tests pass, `tsc` clean, production build clean. First real-phone pass (review + confirm) found one genuine bug: the minimal `Scan.tsx` wiring used an early `return <Review />` that swapped out the whole render tree, unmounting `<video>` — the camera-setup effect only binds the live stream to the video element once on first mount, so closing Review left a fresh, streamless `<video>` node behind (frozen preview, `Capture` silently no-oping on `videoWidth === 0`). Fixed by rendering `Review` as a `position: fixed` overlay instead, so `<video>` and its stream stay mounted the whole time — see learn.md. **Not done**: how this actually feels in an instructor's hand end-to-end is still unverified — that needs step 8's real loop and, per CLAUDE.md's testing conventions, a real device. |
| 8 — Scan loop wiring | not started |
| 9 — Results and Excel export | not started |
| 10 — Full rehearsal | not started |
