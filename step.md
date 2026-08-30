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
| 0 — Test set and scaffolding | in progress — repo layout, venv, requirements.txt, and the `.docx` row-height fix (0.1–0.3) are done. `labels.json` schema and `check_labels.py` (0.6) are in place. Two real photos exist, both hand-drawn with pen and ruler (no printer): `empty_file.jpeg` (blank grid) and `filled_file.jpeg` (real ID/serial/marks filled in, half-marks and a zero included), both labelled and passing regression. Still far short of the Done-when bar: need 15–20 photos total, 3–4 different people's handwriting, and all 9 awkward conditions — both photos so far are the easy "straight-on, well-lit, one person" case. 0.4–0.5's printing step is skipped in favor of hand-drawing, which the detector doesn't distinguish — see learn.md. **A 20-image synthetic dataset arrived from a separate claude.ai conversation** (2026-08-29, `synthetic_scripts/`: `images/`, `ground_truth.json`, `generate.py`) — reviewed before use, not assumed correct: `ground_truth.json` checked programmatically clean (every mark within `[0, max]` on 0.5 steps, `sum(marks) == total`, `max_total == n * max_per_question`, every ID 7 digits, across all 20), and the ID/Serial/marks-table structure genuinely matches this app's real template. Running all 20 through the actual `detect_any_orientation()` (read-only, no code changes yet) found 9/20 passing — the majority of failures traced to the generator's hand-wobble simulation being proportionally larger over the marks table's *long* horizontal rules than its short vertical ones, breaking horizontal-line detection outright on some photos (same failure family as step 1's own axis-alignment/tilt gaps, just triggered by within-stroke wobble instead of whole-photo rotation) — not a clutter or content problem, confirmed separately. Two of the original 20 were added to `testset/images/`/`labels.json` as real test cases: `synthetic_script_001.jpg` (kept as a known, still-failing regression case for the wobble issue, `expected_success: false`) and `synthetic_script_004.jpg`, whose full-pipeline garbage recognition output led directly to step 1's fifth tuning round above (the orientation-check replacement) — after that fix, the same photo's real recognizer output went from all-wrong/all-blank to all 7 marks and the total exactly correct. **The generator was then set up to run locally**: downloaded its 15 named Google Fonts into `synthetic_scripts/fonts/` (the original `generate.py` referenced a claude.ai sandbox path with no fonts included), fixed its three hardcoded sandbox paths (`FONT_DIR`/`OUT_DIR`/the `/home/claude/recs` scratch dir) to resolve relative to the script's own location, and pointed its default output at a new `synthetic_scripts/generated/` subfolder rather than `synthetic_scripts/` itself — the original 20 are already referenced by the two testset entries above and would otherwise get silently overwritten the first time the script runs locally. Verified by regenerating all 20 locally: 19/20 byte-for-byte identical to the originals (the 20th differs only in JPEG encoder bytes, not content — ground truth for all 20 matched exactly), confirming the deterministic seeding and downloaded fonts are exactly right. **Generator revised** at the user's request (2026-08-29) to match the real app's actual real-world setup more closely: the grid lines and every label ("ID", "Serial", "Qn(m)", "Total (nm)") are now machine-printed (a new `printed_line`/`printed_rect`/`printed_text`, straight/unjittered, using a separately-downloaded Liberation Sans font kept out of the handwriting-font rotation) — only the values someone actually fills in (ID digits, serial, marks) stay handwritten via the original `hand_text`. `hand_line`/`hand_rect` and the now-unused `math` import were removed as genuinely dead code once nothing called them anymore. A fresh image from this revision (`synthetic_printed_002.jpg`, added to the testset) ran through the full `/api/scan` pipeline: serial recognized exactly correct for the first time in any test on this dataset, all 8 marks exactly correct, but the Total came back `27.5` against a true `21.5` — a genuine confidently-wrong misread (a "1"-vs-"7" glyph confusion in the Caveat font, on Total's two-digit whole-number part, the only multi-digit value on that page) that passed unflagged since `27.5` is still a legal value for that `max_total`. Flagged to the user, not yet acted on — this is the first confidently-wrong value seen across every real+synthetic test this project has run so far. **18 real photos from a real CSE211L pilot class arrived (2026-08-29, `testset/images/real_photo/` + hand-transcribed `info.json`)** — reviewed and integrated, not assumed correct: moved to `testset/images/real_class_01..18.jpeg` with ground truth in `testset/real_class_info.json`, folded into `labels.json`. This is genuinely 18 different students' handwriting (finally clearing the "3-4 different writers" bar with room to spare) across three quiz templates that vary per photo (3 questions/5 each, 5 questions/5 each, 8 questions/6×5+2×10) — a new `testset/quiz_configs.json` holds each template's per-question max since `labels.json` itself has no such field, referenced per-entry via a new `"quiz"` key. A new real condition, `adjacent_scripts_in_frame` (added to the vocabulary), covers every one of these photos: each shows slivers of neighboring students' scripts at the frame's top/bottom edge (individual printed sheets stacked for photographing, not a shared notebook). One photo (`real_class_08.jpeg`) has a genuine illegal ground-truth value — Q4 is capped at 5 but the handwritten value is `7`, sum-consistent with the stated total (27) — kept deliberately as a real marking-error test case. Running detection surfaced and fixed **two real, latent bugs in `app/detection.py`'s single-row (ID/Serial) table classification**, both only exposed by this batch's adjacent-script condition: (1) originally, `id`/`serial` were picked positionally from single-row candidates sorted by column count — when a neighboring script's own ID row (same 8-column shape) is in frame, it could tie with or outrank the true, smaller Serial candidate, stealing its slot (4 of 18 photos affected, all with the exact same signature: serial resolved to an 8-column decoy instead of the true 2-column box); (2) a first fix (match by expected column count, tie-broken by proximity to the marks table) still let a decoy win when *this script's own* ID row had an unrelated, genuine column-detection shortfall (`real_class_11.jpeg`: only 7 of 8 columns found on its own ID row) — since the shortfall row no longer "matched" the expected count, the count-based filter excluded it entirely and silently accepted the decoy, turning an honest `column_count_mismatch` into a false `ok` reading the wrong student's ID. Fixed properly by selecting `id`/`serial` by *position* alone (the two single-row candidates closest above the found marks table, in template order), never by column count — count is left to the existing match/mismatch check to report honestly. Verified with real crop content, not just status: `real_class_14`/`real_class_18`'s ID crops (previously silently showing a neighboring script's digits at `status: "ok"`) now show their own correct digits; `real_class_11` now correctly fails `column_count_mismatch` on its own genuinely-short ID row rather than falsely succeeding on a decoy. Full regression re-verified after each round (84 backend tests, all previously-passing photos unaffected). Also fixed, found via this batch: `id_ocr_accuracy.py`/`cnn/accuracy.py` hardcoded `QUESTIONS = 5` when calling `detect()`, so any photo whose real template wasn't 5 questions got a spurious, unrelated `column_count_mismatch` that masked an otherwise-usable ID read — fixed to derive the real per-image count from `labels.json`, mirroring `test_detection_regression.py`'s existing pattern; and a ground-truth transcription bug of my own — `real_class_info.json` recorded single-digit serials as bare JSON integers, losing a leading zero genuinely written on 6 of the photos (confirmed by looking at each one directly), corrected to match this project's own convention (`filled_file.jpeg`'s `"07"`) of the literal written value. **Measured results after all fixes, real photos, real multi-writer ground truth**: detection 17/18 (one genuine `blurry` failure, one genuine unfixed column-detection gap on `real_class_11.jpeg`, both left as honestly-documented open cases rather than guessed around); Tesseract ID OCR 68/182 = 37.4% per-digit (down from the earlier single-writer 58.9% baseline — an expected, informative drop from real handwriting diversity, not a regression); CNN ID OCR 156/182 = 85.7% per-digit, 10/29 = 34.5% whole-ID exact match, **1 confidently wrong** — the same pre-existing `synthetic_printed_002.jpg` Caveat-font case already documented above, not a new failure (zero confidently-wrong across every real photo, old or new); CNN marks accuracy 103/105 = 98.1% per-question (half marks 12/12 = 100%), serial 12/19 = 63.2% (after the leading-zero fix), total 17/19 = 89.5%, again 1 confidently wrong (same pre-existing case) — and `real_class_08`'s illegal Q4 value came back correctly flagged (`None`), never guessed, a genuine real-world confirmation of the legal-value-rejection invariant. **Harvested for the CNN fine-tuning track (step 3r.6c)**: new `backend/harvest_real_photos.py` posts each of the 16 successfully-detected photos to `/api/harvest` with `original == confirmed` (both the transcribed ground truth), landing every field as `confirmed` in `training_data/harvested/` — spot-checked by hand (crop content matches its filename's label). This is real progress toward step 3r.6's still-open "collect from ≥4 writers" gap, but not the whole of it — actual fine-tuning on this data and a real `RECOGNIZER=both` comparison session are unstarted (see step 3r.6's own row). Real student IDs now live in plaintext in `labels.json`/`real_class_info.json` — flagged to the user, not yet resolved. |
| 1 — Detection harness | in progress — `detect.py`, `app/detection.py`, `batch_detect.py`, and the step-1.9 regression test are written per stack-reference.md's starting parameters, then genuinely tuned twice against real photos (see learn.md): (1) reused the whole-photo line masks per table instead of re-deriving them at table scale, plus raised `KERNEL_DIVISOR` 30→20, to stop handwritten label text ("ID", "Serial") from aliasing as column dividers; (2) added `MIN_LINE_COVERAGE_FRAC` (a candidate line must cover ~40%+ of the table's own height/width) to stop a tall handwritten digit — a "1" in "11" — from aliasing as one too, since raising the length bar alone couldn't distinguish "digit that happens to be tall" from "genuine rule" once the digit was written in a deliberately tall cell. Both real photos now pass end-to-end (`status: "ok"`, all three tables, exact column counts) and the regression suite (1.9) is running for real instead of skipping. Plumbing also separately proven via synthetic placeholder images: blank page correctly fails `blurry`, noisy image correctly fails `column_count_mismatch` rather than guessing. **Still far from step 1's Done-when bar** — two easy-condition photos are not the 15–20-photo, 9-condition test set. A synthetic 15°-rotated case still fails outright (axis-aligned kernel doesn't survive in-plane rotation) — open, unsolved, needs a real angled photo to tune against rather than a synthetic guess. **Third real tuning round** (2026-08-29, prompted by a user testing on a whiteboard rather than the printed template): added `MIN_RELATIVE_PEAK_FRAC=0.55` — among a table's own surviving dividers, reject one shorter than 55% of their median length, even if it already clears the absolute `MIN_LINE_COVERAGE_FRAC` floor. A stray extra line in a hand-drawn ID row cleared the 0.4 absolute floor at 0.445 coverage while its 9 genuine peers all measured 0.57–0.99 — an absolute floor alone can't tell "a real but shorter-than-usual divider" from "an anomaly among otherwise-consistent peers," but a relative check can. Deliberately guarded to only fire with ≥4 peers, so a table with too few dividers to have a meaningful "typical length" is left alone — the exact short-table failure mode `_cluster_peaks`'s own `min_value` docstring already warns a relative-only rule is unsafe for. Fixed the ID table completely (9→8 columns) and, once the ratio was tightened from an initial 0.5 to 0.55, also the tall-"1"-aliasing-as-a-divider case in a Serial table (the same class of bug step 1's own KERNEL_DIVISOR fix and step 6's still-open 0.449-coverage note both already hit before — see learn.md) — one whiteboard photo now passes `status: "ok"` completely end to end. Verified against the full regression suite both times: all 9 real `testset/images/` photos still pass, all 63 backend tests still pass. **A second, unrelated bug surfaced on the same whiteboard photo, not yet fixed**: a genuine narrow last column's divider (real coverage 0.43, nowhere near an outlier) sits only 9px from the table's true right edge and gets incorrectly merged away by `_merge_close_bounds` — structurally the same small gap size (8-9px) as the *original* case that function was built to fix (learn.md step 6), meaning gap-distance alone can't tell "duplicate detection of the same border" from "a genuine divider for a narrow column" apart; whatever discriminates them will need to look at something else (e.g. the peak's own coverage strength). Deliberately not touched yet — flagged for the user rather than guessed at, since a wrong fix here risks silently reopening the exact historical bug this function exists to prevent, and there's no photo left in the current regression set that's known to exercise that original case. **Fourth real tuning round** (2026-08-29, prompted by the user asking whether stray page content — a notebook's spiral binding, other handwritten notes, a second page peeking into frame — gets mistaken for the grid, then taking 3 real cluttered photos to check). The clutter concern itself came back clean: none of the background content in any of the 3 photos produced a false table candidate, confirming detection works off ruled-line geometry, not text content. All 3 photos failed anyway, for an unrelated and genuinely new reason: several real, intended column dividers measured too little "coverage" to clear either floor above — not because they were short, but because `MIN_LINE_COVERAGE_FRAC`/`MIN_RELATIVE_PEAK_FRAC` were both scored on the *binarized-and-morphologically-cleaned line mask's* own surviving pixel count, and `cv2.adaptiveThreshold` plus the erode/dilate line-isolation step (both tuned for the whole image, not per-line) can fragment one genuine, fully dark line into disconnected pieces under uneven lighting or a steep angle — measured directly: two real ID-row dividers in one photo scored only 41-43% *mask* coverage (below both floors) while their own raw pixels were just as dark against the paper (contrast 80-94) as every accepted divider in the same row (63-116). Fixed by adding `CONTRAST_FLOOR=30` and a new `_contrast_coverage()` that measures each candidate's coverage directly from the source grayscale image (fraction of its length where the pixel is `CONTRAST_FLOOR`-darker than its own local same-row/column background) instead of from the binary mask — the mask is kept only for cheaply *locating* candidate positions, never for scoring them. This is a strictly better signal for the same job the mask coverage was already doing (full-height/width span as the discriminator between a rule and a digit stroke), not a loosened one. Verified needed re-tuning `MIN_RELATIVE_PEAK_FRAC` up from 0.55 to 0.65: the whiteboard photo's already-known stray marker line (learn.md's third round) turned out to be genuinely dark end-to-end, and on the new contrast scale it measured 0.562 relative to its peers' near-uniform 1.0 — high enough to slip back past the old 0.55 floor and reopen the exact bug that floor exists to prevent. 0.65 was chosen with real margin on both sides: every genuine divider measured across all 3 new photos plus the whiteboard photo has a relative ratio of at least 0.705, and the stray line's 0.562 sits well clear below it. Result: 2 of the 3 new cluttered photos now pass `status: "ok"` completely (previously all 3 failed); the whiteboard photo not only keeps the third round's original fix but the second, previously-flagged-open bug (a genuine narrow last column's divider incorrectly merged into the table's edge) is now also resolved as a side effect of scoring on real contrast instead of a fragile mask-survival proxy — it now passes `status: "ok"` end to end for the first time. One case remains genuinely unfixed: the third new photo's ID table is still missing one interior divider between two specific digits, and it isn't a scoring-threshold problem — that divider's own raw contrast, sampled directly at every position across its expected location, peaks at only ~0.48, i.e. a real, physically faint line in that one photo (the fastest way to confirm is retaking the same shot with a firmer pen stroke there), not a detection-logic gap. Full regression re-verified after this round: all 9 `testset/images/` photos still pass, the whiteboard photo now passes (previously failed), 2/3 new cluttered photos pass (previously 0/3), all 63 backend tests pass. **Fifth real tuning round** (2026-08-29, prompted by adding one of the user's own AI-generated synthetic photos — `testset/images/synthetic_script_004.jpg`, from a 20-image synthetic dataset built via a separate claude.ai conversation, `synthetic_scripts/` — to the testset and finding its full-pipeline recognition output was garbage: student ID, serial, and all marks wrong). Root cause, measured directly rather than assumed: at this photo's true right-side-up orientation, the marks table's *header* row (81px) is actually taller than its *value* row (77px) — a 4px, ~5% inversion of the row-height convention the third round's orientation check depends on. That check correctly rejected the true 0° orientation as "looks upside down," and `detect_any_orientation`'s rotation retry landed on the genuinely upside-down 180° reading instead, which passed the same check by the same coincidence in reverse — reading every table backwards and mirrored. This is the *third* time this project has hit some version of this exact orientation-ambiguity problem (a real phone photo originally motivated the height check; the whiteboard photo above found a case it still couldn't resolve; now a synthetic photo shows the check itself can flip on a razor-thin margin) — evidence the row-height signal needed replacing, not another threshold nudge. Fixed with a new, independent signal: `_label_column_is_backwards()` compares connected-ink-component counts between the first and last column of the ID/Serial rows — column 0 is always the multi-character label ("ID"/"Serial") and every other column a lone digit/number, by construction, so a real word reliably fragments into more disconnected components than a digit does, regardless of ink weight or lighting. Measured directly on 3 real photos plus this synthetic one before trusting it: the true label column had strictly more components than the opposite end in all 6 ID/Serial rows checked (gaps of 1-7 components), including a case (`filled_file.jpeg`'s Serial row) where an ink-darkness-based measure came out nearly tied — component count discriminated cleanly where darkness alone wouldn't have. Since a 180-degree flip reverses row and column order together as one transformation, resolving left-right order on the ID/Serial row is sufficient by itself to catch it for the whole page, including the marks table — the old height check is now only a fallback for when no ID/Serial signal is available at all (both absent, or genuinely tied), never overriding a positive confirmation. Verified: `synthetic_script_004.jpg` now passes detection at its native 0° orientation with no rotation retry needed, and the full `/api/scan` pipeline (CNN recognizer) now reads all 7 marks and the total exactly correctly (previously all null/wrong) and 6 of 7 ID digits correctly with the 7th properly flagged rather than wrong (previously all 7 wrong); serial still isn't recovered but now fails safe (flagged null) rather than returning a wrong 6-digit value. Full regression re-verified: all 9 original `testset/images/` photos still pass, the whiteboard photo still passes, 2/3 cluttered photos still pass (same known unrelated gap), and all 64 backend tests pass (63 plus one new parametrized case for the newly-labelled synthetic photo). `tests/test_detection_regression.py`'s hardcoded `QUESTIONS = 5` was also fixed to read the real per-image question count from `labels.json` (`len(label["questions"])`) — a latent assumption that only real photos (always 5 questions) had never exposed, broken by this synthetic photo's 7. |
| 2 — Local ID recognition | in progress — tesseract-ocr installed, unblocking real measurement. `app/id_ocr.py` (2.1–2.3) and `id_ocr_accuracy.py` (2.4) written, then tuned twice against the one real filled photo (see learn.md): (1) inset crops 12% before thresholding — the raw crop included a sliver of the cell's own border line, which read to Tesseract as extra ink and tanked recognition; (2) switched `PSM` from stack-reference.md's suggested 10 ("single character") to 8 ("single word") after measuring 10 completely failing on two clean, legible digits that 8 read correctly — real evidence overriding the doc default. `CONFIDENCE_FLOOR` lowered 60→35 (correct reads landed at 39–41 on this photo); noted in-code as provisional, calibrated from n=1. First real result (n=1): 3/7 digits correct, 4 correctly flagged uncertain, 0 confidently wrong, whole-ID exact match 0/1 — honest but not yet a real accuracy number, that sample being far too thin. **Widened from n=1 to n=8** using real photos from the step 6/7 phone test session (`backend/debug_uploads/`, pulled in with the user-confirmed `student_id` as ground truth — see `testset/labels.json`'s `phone_*` entries and their notes on why serial/marks were deliberately left unlabeled). Re-measuring against this larger, still-single-handwriting sample: **21/56 digits (37.5%), 0/8 exact match, 0 confidently wrong** — a real number now, if still not "different handwriting" per the original caveat. That sample surfaced a genuine bug, not just noise: positions 5–7 were wrong in *every* photo. Inspecting the actual crops (`id_d5.png`/`id_d6.png`/`id_d7.png`) showed Tesseract's LSTM engine was reading correctly-shaped digits as look-alike letters at high confidence — a handwritten "0" as `"D"` (86%), a handwritten "1" as `"l"` (90%) — and `tessedit_char_whitelist` was silently discarding the whole result instead of falling back within the digit alphabet. Fixed with a second, unconstrained OCR pass (`FALLBACK_PSM=7`) that only fires when the whitelisted pass finds nothing, and only accepts a result if it's a known digit/letter look-alike (`DIGIT_LOOKALIKES`) above a stricter confidence floor (60) — see learn.md step 2. Re-measured: **33/56 digits (58.9%), 0/8 exact match, still 0 confidently wrong** — every gain came from resolving previously-flagged-uncertain digits correctly; none introduced a wrong answer. All 28 backend tests and 9/9 `batch_detect.py` still pass. **Still not the Done-when bar** — same handwriting throughout, and whole-ID exact match is still 0/8 (getting all 7 digits right in one photo needs every position right at once, and positions like the always-hard "7" glyph are still correctly flagged rather than guessed). |
| 3 — Serial and marks via Gemini | in progress — `GEMINI_API_KEY` added, unblocking a live run. `app/marks.py` (3.1–3.5) and `tests/test_marks.py`'s 16 offline tests still pass unchanged. First live call 404'd on the model name (`gemini-2.5-flash` retired — Google's own error named the replacement, `gemini-3.6-flash`; switched to it, a real-world API-drift fix, not a code bug). Second live call, against `filled_file.jpeg`: **every field exactly correct** — serial `07`, marks `[3.0, 2.5, 1.0, 0.0, 4.5]`, total `11.0`, nothing flagged low-confidence. Cached to `tests/fixtures/filled_file_gemini_response.json` per step 3.6 so step 4's tests can mock it without spending quota. **One clean photo passing is not step 3's Done-when bar** — same caveat as steps 0–2: this is the easy, well-lit, single-photo case, not evidence across messy real conditions. **Rate-limited fallback added** (2026-08-26, prompted by the real `rate_limited` hit during the step 6/7 phone session): `app/marks_ocr.py` is a local Tesseract-based fallback, invoked from `main.py` only when `recognize()` itself fails (rate_limited/model_error) — never a replacement for the Gemini path, and explicitly not what plan.md's "Deferred" local-mark-classifier note rules out, since it's a degraded last resort rather than a primary recognizer. Reuses `id_ocr.py`'s `_prepare`/fallback-PSM approach but reads whole short strings (PSM 7, no single-character restriction) instead of single digits, since serial/mark crops hold more than one character. Every value is still run through `marks.py`'s own `legal_values` check — an illegal or unparseable read is rejected exactly like a bad Gemini read, never stored. Every field this function touches is unconditionally flagged low-confidence, recovered or not, since this path is deliberately weaker than a fresh Gemini read even when it does parse. If nothing at all is recoverable, `recognize_locally` returns `None` and `main.py` falls through to the original failure — a rate-limited scan with zero local recovery still says so honestly rather than presenting an all-blank result as if it were a normal scan. Tested against real crops from `filled_file.jpeg` (2/7 fields recovered — Q2, Q5 — everything else correctly `None`, nothing wrong) plus 6 new backend tests (4 unit, 2 `main.py` integration via mocks). All 34 backend tests pass. No frontend changes needed — this reuses the existing `low_confidence_fields` flagging the Review screen (step 7) already renders. |
| 2r.0 — Extract recognizer interface (optional CNN track) | done — `app/recognizers/base.py` defines the `Recognizer` protocol (`read_id`, `read_marks`) and `IdResult`, taking `cells_dir: Path` rather than plan.md §16's illustrative pre-loaded-crop-array signature (documented as a deliberate deviation in the file itself — steps 2/3's tuned code is file-path-based throughout, and forcing an array boundary here would have meant rewriting it, which this step's own "zero behavior change" goal rules out). `app/recognizers/remote.py`'s `RemoteRecognizer` wraps `id_ocr.read_id`, `marks.recognize`, and `marks_ocr.recognize_locally` unchanged — including folding main.py's old inline rate-limited-fallback if-statement into `read_marks`, since that behavior belongs to the path that actually has it. `main.py` now resolves one `Recognizer` at import time via `RECOGNIZER` (`env var, default "remote"`) and calls only `recognizer.read_id`/`recognizer.read_marks`; `"cnn"`/`"both"` raise `NotImplementedError` immediately (verified by hand) rather than silently falling back, since `CNNRecognizer` doesn't exist yet. `test_main.py`'s three separate "never calls Gemini" tests collapsed into one `@pytest.mark.parametrize`d `test_detection_failure_never_calls_recognizer` per step 2r.0.4, asserting against `app.marks.recognize` directly (implementation-agnostic, holds regardless of which `Recognizer` is selected) rather than a call site inside `main.py` that no longer exists. All mock patch targets moved from `app.main.X` to the modules' own names (`app.marks.recognize`, `app.id_ocr.read_id`, `app.marks_ocr.recognize_locally`), since `RemoteRecognizer` references them by module attribute for exactly this reason. All 34 backend tests pass unchanged in count and assertions; `batch_detect.py` still 9/9. Live-verified end to end with zero mocks, real Gemini + real Tesseract, through the actual endpoint against `filled_file.jpeg`: identical output to step 3/4's own live runs (`serial: "07"`, marks `[3.0, 2.5, 1.0, 0.0, 4.5]`, `total: 11.0`), confirming `RemoteRecognizer` is a true behavior-preserving move, not just a mock-passing one. |
| 2r — Train the digit CNN (optional CNN track) | done — `backend/cnn/model.py` is the exact architecture from plan.md §16 (Conv32x2→pool→Conv64x2→pool→FC128→FC10). `backend/cnn/preprocess.py` (2r.2) implements the MNIST-matched preprocessing (12% inset, Otsu binarize inverted to white-ink-on-black, crop to ink bounding box, scale longest side to 20px, paste onto a 28×28 canvas centered by **centre of mass**, not bounding-box centre). Verified by eye per 2r.2's own instruction: `inspect_preprocess.py` run over real `id_d*.png` crops produced 28×28 outputs visually indistinguishable from real EMNIST samples. `backend/cnn/train.py` (2r.1/2r.3) loads EMNIST Digits (240k train / 40k test) through an `OrientationFixedEMNIST` wrapper — the transpose bug was independently confirmed against this environment's own download (a raw sample renders rotated/mirrored until transposed), not taken on faith. Trained 8 epochs, CPU-only, ~9-10 min/epoch: **99.74% EMNIST test-split accuracy**. Two real bugs surfaced and fixed during export, caught by a smoke test against a throwaway untrained-model export *before* the real run finished, not after: (1) this torch version's default ONNX exporter needs the `onnxscript` package, uncaught until the export call itself; (2) that same default exporter splits even this small model into a companion `digit_cnn.onnx.data` file rather than one self-contained `.onnx` — switched to the legacy exporter (`dynamo=False`), which this fully static, control-flow-free model has no reason not to use, giving one clean file and one fewer dependency. Re-exported from the completed run's saved checkpoint (`digit_cnn_best.pt`) rather than retraining, since only the export step's code had changed. ONNX/PyTorch parity check: max abs diff 1.91e-06 (threshold 1e-4). `backend/cnn/accuracy.py` (2r.4) mirrors `id_ocr_accuracy.py` exactly — same `testset/labels.json` ground truth, same per-digit-accuracy definition — plus test-time augmentation (5 perturbations, averaged probabilities) and a separately reported confidently-wrong count. `--calibrate` against the real trained model showed a stark, clean split across all 56 real digit reads: 54 landed at confidence ≥0.99 (all correct), and exactly 2 sat in a cluster around 0.58 confidence / 0.4 margin, one of which was wrong — `CONFIDENCE_FLOOR=0.9`/`MARGIN_FLOOR=0.8` (set well inside that gap, not at its edge) separate the two clusters cleanly. **Final measured result, real photos, real ground truth: per-digit accuracy 54/56 = 96.4% (baseline 58.9%), confidently wrong = 0, whole-ID exact match 7/8 = 87.5% (baseline 0.0%).** Both this step's Done-when conditions are met: materially beats the baseline, and confidently-wrong stayed at zero. Same caveat steps 0–2 already carry: n=8 images, all one person's handwriting — a real number on a still-thin, single-writer sample, not evidence of cross-writer generalization (that's what step 3r.6's collection-sheet/comparison-run work is for). New deps (`torch`/`torchvision`/`onnx`/`onnxruntime`/`scipy`) live in `backend/requirements-cnn.txt`, deliberately separate from `requirements.txt` since the main app has no dependency on any of this — nothing in `app/` was touched by this step; the CNN is not wired into the running app (that's step 3r.4). All 34 backend tests still pass, unaffected. **Recalibrated (2026-08-30) against the real_class_* batch's ~20 different writers** (n=182 real digit reads, up from n=56/1 writer) — the clean two-cluster split the original 0.9/0.8 floor relied on doesn't hold with real writer diversity: correct reads span confidence down to 0.40, and only one read in the whole set is both wrong and above 0.75 (the same genuinely-ambiguous cursive "9" already noted in step 0's row). Measured directly by sweeping candidate floors against raw, pre-floor argmax correctness rather than guessing: the old 0.9/0.8 floor passed 157/182 digits (1 wrong let through, 20 correct digits needlessly flagged); `CONFIDENCE_FLOOR=0.75`/`MARGIN_FLOOR=0.6` passes 168/182 with the *same* single wrong digit let through (unavoidable below 0.924) but 11 fewer false flags. Applied to `cnn/accuracy.py` (and, since `app/recognizers/local.py` imports these same two constants for the live ID path, to the actual app too). **Result: per-digit accuracy 85.7% -> 91.8%, whole-ID exact match 34.5% -> 55.2%, confidently wrong unchanged at 1** (same pre-existing `synthetic_printed_002.jpg` case) — a real accuracy gain with zero safety cost. All 84 backend tests still pass. Serial/marks decoding's own floors (`app/recognizers/local.py`'s `SERIAL_CONFIDENCE_FLOOR`/`SERIAL_MARGIN_FLOOR`, step 3r) were not touched — still calibrated on the original thin sample, a natural next recalibration candidate. |
| 3r — Segmentation and constrained decoding (optional CNN track) | done — `backend/cnn/segment.py` (3r.1/3r.2): Otsu binarize, `connectedComponentsWithStats`, drop-below-noise-floor, merge-horizontally-overlapping (disconnected-stroke glyphs), classify decimal-vs-digit by geometry alone. `backend/cnn/decode.py` (3r.3): `decode_value` scores every candidate in `legal_values(max_mark)` directly against per-glyph probabilities (reuses `marks.py`'s `legal_values` and `_fmt` — deliberately not plan.md §16's own illustrative `f"{value}".replace(".", "")`, which silently double-counts a whole number's digits since Python renders `4.0` as `"4.0"`; `_fmt` is what `marks.py` itself already uses to avoid exactly this); `decode_serial` decodes each glyph independently (mathematically equivalent to full enumeration for serial's unconstrained per-position search space) and flags the whole field if any glyph is uncertain, never a partial guess. `backend/cnn/id_infer.py` factors the TTA+softmax inference primitive out of `cnn/accuracy.py` so serial/mark decoding can reuse it — re-ran `cnn/accuracy.py` immediately after and confirmed byte-identical output (96.4%/0/87.5%), a real zero-behavior-change check, not an assumption. `app/recognizers/local.py`'s `CNNRecognizer` wires both paths behind the step 2r.0 protocol; `main.py`'s `RECOGNIZER=cnn` now resolves it via a lazy import (never at module load, so the default `RECOGNIZER=remote` path still has zero dependency on onnxruntime — verified by literally uninstalling torch/onnxruntime/onnx/scipy and re-running the full 48-test suite clean). All 14 new unit tests (`tests/test_cnn_segment.py`, `tests/test_cnn_decode.py`) pass with no network, no model, no torch — synthetic probability vectors and synthetic cell images only, per this step's own Test section. **Two real bugs found and fixed via real photos, not synthetic tests**: (1) `preprocess_for_cnn`'s 12% border-inset — correct for the ID's whole-boxed-cell input — was being reused on `segment_cell`'s already-tight glyph crops, clipping real strokes off the edges and turning a real "3" into a confident, wrong "2"; split into `preprocess_for_cnn` (unchanged, ID-only) and a new `glyph_to_canvas` (no inset) sharing a common `_to_canvas` core. (2) `NOISE_AREA_FRAC=0.01` silently dropped a real handwritten decimal point (58px, ~0.36% of a real cell) before it ever reached decimal-vs-digit classification, and separately `DECIMAL_LOWER_BAND_FRAC=1/3` missed that same dot's centroid by half a pixel (a hand-drawn dot between two digits sits closer to mid-height than a printed period) — both recalibrated from this real measurement (`0.0015`, `0.5`), which fixed both real half-mark cells (`2.5`, `4.5`) at the cost of one whole-mark cell (`3`) now correctly flagging on an unrelated stray pen mark rather than accidentally reading it right — net improvement, and confidently-wrong stayed at 0 throughout both calibrations. `backend/cnn/marks_accuracy.py` (3r.5) mirrors `accuracy.py`'s structure for serial/marks/total, reporting whole-mark and half-mark accuracy separately as required. **Measured result** (the one labelled real photo with real serial/marks/total ground truth — `testset/labels.json`'s own documented gap, thinner even than the ID's n=8): per-question accuracy 4/5 (80%), **half marks 2/2 (100%)**, whole marks 2/3, serial 1/1, total 1/1, confidently wrong 0. Also fixed a real, unrelated documentation bug found while reinstalling the CNN deps: `requirements-cnn.txt`'s install command used `--index-url` (restricts pip to only that index) instead of `--extra-index-url` (adds it alongside PyPI), which fails outright since PyTorch's own index doesn't host onnx/onnxruntime/scipy. **Caveat carried forward honestly**: n=1 image for marks/serial (vs n=8 for the ID), so this is a real, measured number on a still-thin sample — not evidence the decimal-point geometry heuristic generalizes across different handwriting yet. All 48 backend tests pass; full real end-to-end verification with zero mocks through the actual `/api/scan` endpoint (`RECOGNIZER=cnn`) reproduced the same values as direct `CNNRecognizer` calls. **Follow-up round (2026-08-29), prompted by a user testing on a whiteboard with `RECOGNIZER=cnn` set as the actual default**: `segment_cell`'s decimal-height baseline switched from the *median* surviving-component height to the *tallest* one. A stray, unintended pen/marker mark elsewhere in a cell (not the decimal point, not a real digit) was dragging the median down enough that a genuine decimal point measured as "too tall to be a dot" by comparison — anchoring to the tallest component instead is robust to any number of stray components, since the tallest one is always a real digit's own full height regardless of what else is in the cell. Verified against `cnn/marks_accuracy.py`'s real result: byte-identical to the original (4/5, half marks 2/2, 0 confidently wrong) — a genuine improvement to the general case with zero observed regression on the one real calibration photo available. A second attempted fix — only merging horizontally-overlapping components in `_merge_overlapping` when they're comparably sized in height, meant to stop a decimal point from being merged into an adjacent digit — was tried, found to break a real, working case (a genuinely disconnected "5" whose lifted-pen top flourish and lower body differ almost as much in height as the decimal-vs-digit case does), and reverted. **Left as a known, open gap at the time, resolved in a third round (2026-08-29, prompted by the user re-testing the same script and finding Q1/Q3 missed "every time")**: height ratio couldn't discriminate the two cases, but a different signal can — comparable-height broken-stroke pieces are roughly *stacked* (similar x-centre), while a decimal point sits *beside* its digit, offset toward one edge. Added `CENTER_OFFSET_MERGE_FRAC=0.36`, gating the merge on `|centre_a - centre_b| / wider_width` in addition to the existing x-overlap check. Measured directly on both real cases rather than guessed: the real decimal-beside-"2" case measured 0.44 (now correctly rejected from merging), the real disconnected-"5" case measured 0.28 (still correctly merges) — a real, if still thin (n=2), gap between them. Verified: all 5 existing `test_cnn_segment.py` cases still pass unchanged (including the disconnected-stroke test), `cnn/marks_accuracy.py`'s real result is byte-identical to the original baseline (4/5, half marks 2/2, 0 confidently wrong), ID accuracy and detection regression both unaffected. On the real whiteboard cell this was found on, Q3 (`2.5`) now decodes correctly at 0.999 score — previously flagged. Q1 remains open: its failure is a *different* root cause (a genuine stray pen mark elsewhere in the cell surviving the noise floor as an extra digit-glyph, not a merge problem), and is provably not fixable by any single area threshold — the real stray mark measures 62px while the real decimal calibrated earlier measures 58px, so no floor can drop one without dropping the other. On the same whiteboard photo, two of five questions still came back flagged rather than read (down from three) — in every case the safety property held throughout (0 confidently wrong, always flagged not guessed), but recall on whiteboard-marker input remains visibly worse than on the pen-and-paper input this track was actually tuned and measured against. Also fixed, unrelated: the user's own edit setting `main.py`'s `RECOGNIZER` default from `"remote"` to `"cnn"` had silently broken 4 of `test_main.py`'s tests (they mock `app.marks.recognize`/`app.id_ocr.read_id`/`app.marks_ocr.recognize_locally`, which only matter when `RemoteRecognizer` is actually the active recognizer) — fixed by having those tests explicitly pin `app.main.recognizer` to a fresh `RemoteRecognizer()` via a `force_remote_recognizer` fixture, so they're correct regardless of whatever the ambient default happens to be. All 63 backend tests pass. |
| 3r.6 — Collection sheet and comparison run (optional CNN track) | in progress — every piece buildable without real human handwriting or a real quiz session is done; the step's actual Done-when bar (a real comparison run, the CNN winning, `RECOGNIZER=cnn` set as default) genuinely requires both and can't be simulated. **3r.6d (comparison mode) — built and live-verified**: `app/recognizers/both.py`'s `BothRecognizer` runs both paths, returns the CNN's result (matching plan.md §16), and logs every disagreeing field to `comparison_log/comparisons.jsonl`. `cnn`/`remote` are constructor parameters (not hardwired), so the disagreement-detection logic is unit-tested (6 tests) against fake recognizers with zero network/model dependency — verified by uninstalling torch/onnxruntime entirely and re-running the full suite clean, same discipline as steps 2r.0 and 3r's own wiring. `main.py`'s `RECOGNIZER=both` now actually works (previously raised `NotImplementedError` as a placeholder). Live-verified with zero mocks against `filled_file.jpeg`: correctly returned the CNN's result end to end, and correctly logged exactly two real disagreements (`student_id`: CNN right, Tesseract wrong; `q1`: CNN correctly flagged, Gemini right) while correctly logging nothing for the four fields both paths agreed on. **3r.6c (harvesting) — built and tested, higher priority per plan.md §16's own reasoning that retrofitting later loses every pilot-period label**: `app/harvest.py` copies each relevant cell crop into `training_data/harvested/<field>/{confirmed,corrected}/<value>_<uuid>.png` — the label lives in the filename, so no separate annotation file can drift out of sync; a field the original scan flagged (None) that the instructor then fills in counts as a correction, same as an outright wrong reading. New `POST /api/harvest` endpoint (9 tests: 7 direct `harvest()` unit tests, 2 endpoint integration tests against a real photo) re-runs detection on the same image rather than requiring cell crops to survive across requests, keeping the backend's existing statelessness intact. Frontend: `api.ts`'s `harvestScan` and `Review.tsx`'s `commitSave` now fire this on every Confirm, deliberately unawaited (fire-and-forget) so it can never delay the confirm-to-next-capture loop (step 8) or be mistaken for a save failure if it errors (2 new Vitest tests, including confirming nothing fires when no image preview exists). **3r.6a — split**: the collection-sheet *generator* (`backend/generate_collection_sheet.py`) is built and verified — a 10-row × 20-sample `.docx` table, row position as the label, reusing the row-height fix from step 0's own `marks-grid-template.docx` work (`height_rule=EXACTLY`, easy to silently get wrong); rendered to PNG via LibreOffice and visually confirmed correct. The *other* half of 3r.6a — turning a photographed, filled-in sheet into `training_data/<writer>/<digit>/<uuid>.png` — is deliberately not built: no real filled sheet exists yet to tune a detector against, and this project's own established rule (step 1: don't build a detector before real photos exist to tune it on) applies exactly the same way here. **Explicitly not started, and cannot be simulated**: collecting real samples from ≥4 different writers plus the instructor's own marks samples (3r.6a's collection itself), fine-tuning two separate heads on real collected/harvested data (3r.6b), running an actual full quiz with `RECOGNIZER=both` (3r.6d's real run), and setting `RECOGNIZER=cnn` as the default (3r.6e) — all require the user's real-world participation (printing and distributing the sheet, a real class session) that no amount of code can substitute for. 63 backend tests pass (54 -> 63), 51 frontend tests pass (49 -> 51); the "zero CNN dependency in the default path" property re-verified by literally uninstalling torch/onnxruntime/onnx/scipy again and confirming the suite still passes clean. **3r.6a/3r.6c's "collect from ≥4 writers" gap substantially narrowed (2026-08-29)**: 18 real photos from a real class arrived (see step 0's row for the full account, including two real detection bugs this batch surfaced and fixed) — genuinely 18 different students' handwriting, not the collection-sheet route 3r.6a originally envisioned, but the same real substance: real, differently-handwritten digits with known ground truth. `backend/harvest_real_photos.py` ran all 16 successfully-detected ones through `/api/harvest` (`original == confirmed`, both the transcribed ground truth), adding real multi-writer crops to `training_data/harvested/` alongside whatever the review-screen fire-and-forget path had already collected. **Still not done, still needs the user's own participation**: this is real collected data, not yet a fine-tuning run (3r.6b) — the model in `cnn/checkpoints/` is unchanged — and a real `RECOGNIZER=both` comparison session (3r.6d's actual run, as opposed to its already-built mechanism) still hasn't happened. **3r.6e (default flip) — done 2026-08-30, by explicit user decision, and deliberately NOT by the route this step specified.** The bar written here was "a real comparison run, the CNN winning, `RECOGNIZER=cnn` set as default"; the comparison run still hasn't happened and `comparison_log/` does not exist. The user chose to flip the default on the measured real-batch numbers instead, and the reasoning is recorded rather than glossed: on the ID the CNN wins decisively and measurably (91.8% per-digit / 55.2% whole-ID vs Tesseract's 58.9% / 0.0%), on marks it reads 98.1% per-question (half marks 100%), and the operational argument is independent of accuracy — zero per-scan cost, no quota that can die mid-class (a real `rate_limited` was what motivated this whole track), no network dependency, and every photo stays on the laptop. Accepted with two open caveats, neither hidden: **serial is the weakest field at 63.2% (12/19)** with no Gemini baseline on the same batch to compare against — survivable because a low-confidence serial is flagged blank not guessed and identity holds on the ID alone, but it is the first thing to fix and segmentation of the 2-digit serial cell is the likeliest culprit, not the classifier; and **both harnesses report `confidently wrong: 1`** against this track's own "must stay 0" bar, from one genuinely ambiguous cursive digit. Packaging consequence handled: `onnxruntime` and `scipy` moved from `requirements-cnn.txt` into `requirements.txt`, since the default path genuinely cannot start without them — `torch`/`torchvision`/`onnx` stay training-only, re-verified by poisoning `torch` in `sys.modules` and constructing `CNNRecognizer` clean. `main.py`'s docstring (which had claimed the default was `remote` while the code already said `cnn`), plan.md §16, CLAUDE.md and README.md all reconciled to match. `RECOGNIZER=remote` remains fully supported as the fallback. **Still genuinely not done**: fine-tuning on the harvested data (3r.6b), and the real full-quiz comparison run (3r.6d) — the flip does not retire either, and running one is now more valuable, not less, since it is the only thing that would validate this decision on marks and serial. |
| 4 — FastAPI wrapper | in progress — `app/models.py` (4.1, matching plan.md §8 exactly) and `app/main.py`'s `POST /api/scan` (4.2–4.5) written as a thin wrapper over steps 1–3, unchanged. Multipart image + JSON-string config field (4.2), pipeline wired with the required early exits — Gemini never called after `table_not_found`/`column_count_mismatch` (4.3), CORS via a regex matching localhost + all private LAN ranges rather than one hardcoded address (4.4), statelessness via a per-request `TemporaryDirectory` deleted before the response returns, no globals (4.5). All 21 tests pass offline (`TestClient`, only `recognize`/Gemini mocked — detection and local ID OCR run for real): each of the three failure reasons confirmed to never call the Gemini mock (`assert_not_called`), a known-good image matches expected values exactly, two back-to-back requests with different configs proven not to contaminate each other. Then verified live, no mocks: a real HTTP request through the real endpoint hitting the real Gemini API reproduced the CLI's exact values (`serial: "07"`, marks `[3.0, 2.5, 1.0, 0.0, 4.5]`, `total: 11.0`) and honestly surfaced the still-imperfect ID OCR as `low_confidence_fields: ["student_id"]` rather than hiding it. **Still not the Done-when bar** — "the endpoint agrees with the CLI on the whole test set" is true for the one real photo with values in it; the set itself is still thin (steps 0–3's shared, repeated caveat). |
| 5 — Frontend scaffold and Setup | in progress — Vite + React + TypeScript scaffolded, `vite-plugin-pwa` and HTTPS configured (5.1: `@vitejs/plugin-basic-ssl` instead of `mkcert` — no passwordless sudo for the system binary/CA trust, same wall as Tesseract; self-signed means a real click-past warning on the phone, kept deliberately per user decision — see learn.md). `db.ts`'s IndexedDB schema (5.2) — non-unique indexes on serial/studentId, a caching bug caught by tests (not code review) and fixed by not caching the connection. `Setup.tsx` (5.3) and persistence on submit/reload (5.4) built. 14 Vitest tests pass, clean `tsc`, clean production build. **Real-browser testing found a real bug**: the LAN address the phone actually connects through wasn't in the generated cert's hostname list, which broke service worker registration specifically (harder failure than the plain page load, which can be clicked past) — fixed by detecting this machine's actual LAN IPs at config time (`os.networkInterfaces()`) and adding them to the cert, the same no-hardcoding approach already used for backend CORS. Verified two ways post-fix: `openssl s_client -verify_hostname` shows only the expected self-signed warning, no hostname mismatch; `dev-sw.js` now returns 200 over the LAN address. **Still not the full Done-when bar** — a real hard-refresh persistence check on an actual phone remains the one piece nothing here can substitute for. |
| 6 — Camera and upload queue | in progress — real phone testing underway, three real detection bugs found and fixed from actual captures (see learn.md). Infrastructure: fixed a mixed-content gap (backend needed HTTPS too, `gen_dev_cert.py`); `getUserMedia` + framing guide (6.1), capture-to-blob (6.2), `scanQueue.ts`'s tested upload-queue state machine (6.3), raw `ScanResult` rendering (6.4) built in `Scan.tsx`/`api.ts`. Diagnosed via `backend/debug_uploads/` (gitignored, explicitly marked temporary, since the backend is otherwise stateless — there was nothing else to inspect real captures with). Three bugs found and fixed, all variants of the same root issue — a shape-only match (row/column counts) can't tell geometrically-valid-but-wrong content from correct content: (1) this phone's camera reports portrait video dimensions without actually rotating the pixel content to match — fixed with `detect_any_orientation()`, retrying at 90/180/270° only on `table_not_found`, `detect()` itself kept strict; (2) a real border line detected 8px short of the table's true edge tripped the edge-insertion fallback into adding a spurious second boundary, silently flipping a table's row_count — fixed with `_merge_close_bounds`, collapsing any two final boundaries closer than every genuine gap ever measured (190px+); (3) a table rotated a full 180° still has the *right shape* (same row/column counts) while reading every value backwards — the rotation retry from fix (1) could confidently lock onto exactly this false match. Fixed using a rule already in the template by design, for an unrelated reason: the answer row is deliberately taller than the header row (plan.md §3, originally for handwriting room) — enforcing "the second row must be the taller one" rejects any upside-down match outright. **Result: 3 of 4 real phone photos now pass completely**, matching every value already proven in steps 1–4; the fourth correctly reports `table_not_found` (unrelated, already-understood cause — some genuine dividers not detected, likely lighting; refusing to guess is correct behavior, not a bug, and unchanged by any of today's three fixes). All 21 backend tests, both existing real testset photos, and the synthetic set stayed green throughout every fix — no regressions. The synthetic 15°-rotation case remains genuinely open (needs fine-grained angle correction, not 90°-snapping) — distinguished from the near-90°/180° "held at a different quadrant" cases this session solved. A fourth issue surfaced on new photos with different marks: the ID table found 9 columns instead of 8 (a handwritten "1" measured at 0.449 coverage, uncomfortably close to the weakest genuine line ever measured, ~0.49) — flagged as a real, still-open threshold-tuning gap, not yet fixed. Rather than tune the threshold again, fixed the *recurring pattern* at its source instead: `Scan.tsx` now rotates a portrait-shaped capture (videoHeight > videoWidth) 90° before upload, since the template is always physically wider than tall — this needs no orientation guessing at all for the common case. Verified by replicating the exact canvas transform math against a real saved photo and running it through actual detection (perfect match) plus a visual check that the result is genuinely upright, not just shape-matched by luck. Backend's 4-way retry and upside-down check stay as a safety net for other devices, not retired. **Still not the Done-when bar** — five-captures-in-a-row and dead-backend-error-handling are untested; both need direct phone interaction, and the new frontend rotation itself is unverified on a real device yet. **Two live-testing usability fixes (2026-08-30)**: a Retake used to dismiss a failed scan from `nextToReview` but leave its entry sitting in the queue list forever, showing "Scan failed: ..." with a live Review button that could reopen a discarded scan — `Scan.tsx` now filters dismissed entries out of the rendered list entirely (`visibleEntries = entries.filter((e) => !dismissedIds.has(e.id))`). Separately, the only feedback that a capture had registered was a thumbnail appearing in the queue list below the camera — easy to miss with eyes on the frame — fixed by ringing the capture button with a spinning loader and disabling it while that shot is uploading/recognizing, both cleared once the request resolves. **Known trade-off, not yet validated live**: this changes captures from running in parallel (the original step 6.3 design, "the camera never blocks") to one at a time — the next capture can't start until the previous one's full round trip finishes. Whether that's worth the added clarity for a real 30-script class session needs the same real-phone verification this step's Done-when bar already requires. 67 frontend tests pass, `tsc` clean, production build clean, design-tell scanner clean. |
| 7 — Review screen | done — built ahead of step 6's own Done-when bar (real-phone testing of five-in-a-row capture and dead-backend handling), by explicit user direction rather than the usual step order. `validateMarks.ts` (7.3–7.5: sum check, legal-value check, serial normalization, plan.md §10's identity cross-check) and `Review.tsx` (7.1, 7.2, 7.6) written. Identity fields render first at 2rem, above editable marks shown beside the capture preview; low-confidence fields get an amber border; a failed scan reuses the same form with empty fields, a reason banner, and Retake/Enter-manually rather than a dead end; save runs the cross-check via `db.ts`'s by-serial/by-studentId indexes and blocks/warns/allows per plan.md's table, with a conflict panel offering Overwrite or Save-anyway. Minimally wired into `Scan.tsx` (a Review button per finished capture) so the screen is actually reachable — the frictionless "Confirm advances straight to a live camera" loop is step 8's job, not built here. All of this step's own Done-when bar is met without a phone, since it's pure form logic: 18 pure-function tests (`validateMarks.test.ts`, including all five cross-check table rows as one parameterized block) plus 6 component tests (`Review.test.tsx`, via React Testing Library + fake-indexeddb) directly assert the sum check recomputes live on edit, an illegal edit blocks Confirm, and a failed result reaches an editable screen. 45/45 frontend tests pass, `tsc` clean, production build clean. First real-phone pass (review + confirm) found one genuine bug: the minimal `Scan.tsx` wiring used an early `return <Review />` that swapped out the whole render tree, unmounting `<video>` — the camera-setup effect only binds the live stream to the video element once on first mount, so closing Review left a fresh, streamless `<video>` node behind (frozen preview, `Capture` silently no-oping on `videoWidth === 0`). Fixed by rendering `Review` as a `position: fixed` overlay instead, so `<video>` and its stream stay mounted the whole time — see learn.md. **Not done**: how this actually feels in an instructor's hand end-to-end is still unverified — that needs step 8's real loop and, per CLAUDE.md's testing conventions, a real device. |
| 8 — Scan loop wiring | in progress — `Scan.tsx` and `scanQueue.ts` wired for the full loop rather than requiring a manual tap per script. (8.1) Review now auto-opens for the next finished capture instead of needing a "Review" click — `scanQueue.ts`'s new pure `nextToReview(entries, handledIds)` picks the earliest done-and-unhandled entry, and a `Scan.tsx` effect calls it whenever nothing is currently open; Retake adds the entry to a `dismissedIds` set (rather than reopening it forever) but leaves its manual Review button in the debug list so it isn't lost. The camera was already never unmounted (step 7's overlay fix), so "reopens camera" needed no new code — there's nothing to reopen. (8.2) The in-flight count already existed (`inFlightCount`); added a persisted running count. (8.3) `scannedCount` was a plain `useState(0)` that a mid-session refresh would silently reset to 0 while IndexedDB still held every prior record — replaced with `savedCount`, seeded from `getAllRecords().length` on mount and incremented only on an actual save, so a refresh reflects what's really persisted rather than restarting from zero. 4 new Vitest cases for `nextToReview` (49/49 frontend tests pass), clean `tsc`, clean production build; 34/34 backend tests unaffected and re-run. **Not done** — this step's own Done-when bar (ten scripts end to end on a real device, plus a hard refresh at record six) is explicitly phone-only per CLAUDE.md's testing conventions and hasn't been run. |
| 9 — Results and Excel export | in progress — `frontend/src/results.ts` (9.1/9.2, pure and unit-tested: 8 tests) sorts by serial then student ID, both compared numerically with leading zeros stripped via `normalizeSerial` (so "2"/"02" sort together and a missing serial sorts last, matching plan.md §11's own mockup) and flags a single-identity record with which field is missing ("no serial"/"no ID"). `Results.tsx` (9.1) renders the table with per-row inline editing — each field commits to IndexedDB on blur, reusing `isLegalValue`/`sumCheck` from `validateMarks.ts` so a bad edit is rejected the same way an initial Review-screen edit already is, and an edit that would clear *both* identity fields is refused outright (CLAUDE.md's "at least one of studentId/serial must be non-null" invariant, now enforced at edit time too, not just at first save). Record count and unverified count shown (9.2); the attendance-sheet expectation stated plainly, not as a surprise (9.3, plan.md §10). Excel export (9.4) builds `ws.columns` from `QuizConfig` so question columns follow the quiz; verified two ways beyond the component test that just checks the download fires: the exact row-building logic was run standalone through real ExcelJS (not mocked) and read back programmatically — confirmed half marks land as JS numbers (`2.5`), not text, and every blank field (a missing serial, an unrecognized question, a missing total) comes back genuinely blank, never `0`, matching step 9's own "the worst possible failure" warning — then the same file was opened in LibreOffice (real Excel unavailable in this environment) via both a PNG and a PDF render; the PDF confirmed the same values across what turned out to be two print pages (a LibreOffice pagination artifact — the PNG render alone looked like a misaligned column at first glance until the second page's `Total` values were checked directly). Bundle verified per the Test section's own instruction to check this first: `exceljs` builds cleanly with Vite, no stream/buffer polyfill issues. One unplanned but low-risk addition: `Results` is now `React.lazy`-loaded from `App.tsx`, since ExcelJS is most of its bundle weight (934KB) and the screen is rarely visited — this keeps it out of the main Setup/Scan/Review bundle (back down to ~210KB) without changing anything the spec asked for. 65 frontend tests pass (59 + 6 new for `Results.tsx`, on top of `results.ts`'s own 8). **Not done** — the actual "open a real export in Excel and LibreOffice" check (step 9's own Test section) has only had the LibreOffice half done for real; a genuine full class session's worth of records has not been exported and reconciled by hand yet. **"Reset everything" added (2026-08-30)**: nothing previously cleared a finished session — records and quiz config would still be there next time the app opened. New `db.ts`'s `resetAll()` clears both IndexedDB stores in one call; `Results.tsx` gets a "Reset everything" button that opens the same inline confirm/cancel warning-banner pattern `Review.tsx` already uses for a conflict, so nothing is deleted without an explicit second click. Confirming wipes the DB and calls back to `App.tsx`, which — with no config left — lands the instructor back on Setup for a genuinely clean session. 2 new component tests (confirm-then-cancel deletes nothing; confirm-then-delete clears both stores and calls back), 67 frontend tests pass total, `tsc` clean, production build clean. |
| 10 — Full rehearsal | not started |
