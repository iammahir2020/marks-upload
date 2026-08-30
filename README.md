# Script Mark Scanner

A tool for a faculty member grading quizzes. They photograph the marks
grid at the top of each student's script; the app reads the handwritten
student ID, serial number, and per-question marks, lets the instructor
confirm or correct them on the spot, and exports the whole session as one
Excel file.

Scoped deliberately small: a single instructor, one quiz session, one
class (pilot: CSE211L). No auth, no hosting, no server-side database.
The backend runs on the instructor's own laptop and the phone reaches it
over the local network; session state lives in the browser's IndexedDB
until it's exported.

## How it works

```
┌──────────────────────┐        ┌─────────────────────────────────────┐
│   Frontend (PWA)      │ POST   │   Backend (FastAPI)                  │
│  React + TypeScript   │ ─────► │  OpenCV: detect table, deskew,       │
│  IndexedDB (session)  │ ◄───── │  split into cells                    │
└──────────────────────┘  JSON  │  Local CNN: ID + serial + marks      │
                                 └─────────────────────────────────────┘
                                        runs entirely on the laptop
```

That is the default path (`RECOGNIZER=cnn`). The original path is still
supported and swaps recognition out for Tesseract plus a cloud call:

```
                                 ┌─────────────────────────────────────┐        ┌──────────┐
              RECOGNIZER=remote  │  Local OCR (Tesseract): student ID   │  API   │  Gemini  │
                                 │  Gemini: serial + mark digits        │ ─────► │ (vision) │
                                 └─────────────────────────────────────┘ ◄───── └──────────┘
```

Detection, the API contract, and every validation rule are identical
either way — the two paths sit behind one `Recognizer` interface.

The instructor pastes a marks grid (`marks-grid-template.docx`) into the
question paper before printing it. While grading, they photograph that
grid on each script. Each photo is posted to the backend, which:

1. **Detects the grid with OpenCV** ([`app/detection.py`](backend/app/detection.py))
   — finds the table, deskews it, and splits it into cells from the actual
   detected line positions. Detection is proportional to image size, never
   fixed-coordinate, because the grid can be pasted anywhere at any scale.
   If no table is found, or the detected column count disagrees with the
   configured quiz, the scan fails loudly (`table_not_found` /
   `column_count_mismatch`) and **no recognizer is ever called** — writing
   Q4's mark into the Q3 column is worse than failing.
2. **Reads the ID, serial and marks** — by default with a local digit CNN
   ([`app/recognizers/local.py`](backend/app/recognizers/local.py)), on
   this machine, with no network call. On `RECOGNIZER=remote` this splits
   in two: Tesseract reads the ID locally
   ([`app/id_ocr.py`](backend/app/id_ocr.py)) while serial and marks go to
   Gemini ([`app/marks.py`](backend/app/marks.py)) as a tiled composite of
   just those cell crops — **never** including the ID crops, since the ID
   is what makes a photo personally identifying.
3. **Constrains marks to legal values.** A question out of 5 has exactly 11
   legal values (`0, 0.5, … 5`); anything outside that set is rejected
   server-side rather than stored, on both paths.
4. **Returns a `ScanResult`** the instructor confirms or corrects on the
   review screen, which is then saved to IndexedDB.

At the end of the session the Results screen exports every saved record
as a single Excel file.

Two behaviours run through the whole pipeline:

- **Flag, never guess.** Ambiguous OCR, out-of-range marks, unreadable
  cells and blocked API responses all become a blank field plus an entry
  in `low_confidence_fields` — never a filled-in best guess.
- **A failed scan is never a dead end.** Any failure still lands the
  instructor on the review screen with the reason shown and Retake /
  manual entry available, so a bad photo can't stall a class.

## Two recognition paths

Recognition sits behind one `Recognizer` protocol
([`app/recognizers/base.py`](backend/app/recognizers/base.py)), selected
at startup by the `RECOGNIZER` environment variable:

| `RECOGNIZER` | What runs | Notes |
|---|---|---|
| `cnn` | **Default.** A locally-trained digit CNN for everything | No network call at all; nothing leaves the laptop |
| `remote` | Tesseract for the ID, Gemini (`gemini-3.6-flash`) for serial + marks | Falls back to a local OCR pass on `rate_limited`/`model_error`, flagging every field it recovers |
| `both` | Runs both, returns the CNN's result, logs every disagreement to `comparison_log/` | Costs real Gemini quota — meant for an actual comparison run, not everyday use |

The CNN path exists because the deferral condition for building one
actually happened: real `rate_limited` responses from Gemini, and
Tesseract measured at 58.9% per-digit ID accuracy on real photos. It
became the default on 2026-08-30. Measured on the 18-photo real-class
batch (~20 different writers):

| Field | CNN | Previous path |
|---|---|---|
| ID, per-digit | **91.8%** (167/182) | Tesseract 58.9% |
| ID, whole-ID exact match | **55.2%** (16/29) | Tesseract 0.0% |
| Marks, per-question | **98.1%** (103/105), half marks 100% | Gemini — not measured on this batch |
| Total | 89.5% | Gemini — not measured on this batch |
| Serial | 63.2% (12/19) | Gemini — not measured on this batch |

The ID gap is the headline, but the operational case matters just as much
and is independent of accuracy: the CNN costs nothing per scan, has no
quota that can die in the middle of a class, needs no network, and keeps
every photo on the laptop.

Two caveats are carried openly rather than buried:

- **Serial is the weakest field at 63.2%**, with no Gemini baseline on the
  same batch — the full `RECOGNIZER=both` comparison run hasn't happened
  and `comparison_log/` doesn't exist. It's survivable because a
  low-confidence serial is flagged blank rather than guessed, identity
  holds on the student ID alone, and the instructor confirms every scan;
  it's still the first thing to fix, most likely in segmentation of the
  two-digit serial cell rather than in the classifier.
- **Both accuracy harnesses report one confidently-wrong case**, against
  this track's own stated bar that it must stay zero. One genuinely
  ambiguous cursive digit, not a systematic error — but the bar isn't
  currently met.

`RECOGNIZER=remote` remains fully supported as the fallback.

## Project status

Built incrementally, step by step, per [step.md](step.md) — which holds
the **Progress table that is the actual status of record**. Read it before
assuming any component is finished: this project holds a strict
"Done when" bar per step, so several steps whose code is written, wired
up and passing tests are still honestly marked *in progress* because
their real-world verification bar hasn't been cleared.

In broad strokes, as of 2026-08-30:

- **Working end to end.** Setup → camera capture → upload queue → review
  → save → results → Excel export all run, against both recognizer paths.
  Backend: **84 pytest tests passing**. Frontend: **67 vitest tests
  passing**.
- **Verified against real photos.** 30 test images including an 18-photo
  batch from an actual class, which exposed and got fixes for two real
  detection bugs (a neighbouring script's ID row, visible at the frame
  edge, could be silently misattributed to the current student).
- **The local CNN is the default recognizer** as of 2026-08-30 (step
  3r.6e) — the app runs with no API key, no quota and no network. See
  "Two recognition paths" above for the numbers it was decided on and the
  two caveats carried with it.
- **Not finished.** Step 10 (full rehearsal) hasn't started. The test set
  is still short of its own target for awkward conditions. The CNN track's
  remaining work — fine-tuning on harvested handwriting, and a real
  full-quiz `RECOGNIZER=both` comparison — needs real classroom
  participation and can't be simulated. That comparison run matters more
  now that the CNN is the default, not less: it is the only thing that
  would validate the choice on marks and serial rather than on the ID.
- **Known issues are tracked**, not silently carried:
  [issues.md](issues.md) records a full-repo audit (real bugs, security
  review, design-tell scan), spot-verified but not yet fixed.
- **One deliberate temporary exception to statelessness**: `main.py`
  currently writes every upload to `backend/debug_uploads/` (gitignored)
  for phone-capture debugging. It's marked TEMPORARY in the code and
  should be removed when step 6 closes.

## Repository layout

```
marks-upload/
├── plan.md                  # Architecture, data models, screens, API contract, resolved decisions
├── step.md                  # Execution plan, step by step — ends in the Progress table (status of record)
├── stack-reference.md       # Library-level notes: exact calls, starting params, known traps
├── learn.md                 # Plain-language walkthrough of what each finished step's code does
├── issues.md                # Full-repo audit: real bugs, security review, design-tell scan
├── CLAUDE.md                # Conventions, invariants and working protocol for this repo
├── Cnn migration.md         # Original design note for the CNN path — superseded by plan.md §16
├── marks-grid-template.docx # The grid the instructor pastes into the question paper
├── dev.sh                   # Runs both dev servers together, stops both on Ctrl+C
│
├── backend/
│   ├── app/
│   │   ├── main.py          # POST /api/scan and POST /api/harvest; resolves the recognizer at startup
│   │   ├── detection.py     # OpenCV grid detection — the make-or-break component
│   │   ├── id_ocr.py        # Local Tesseract student-ID reader
│   │   ├── marks.py         # The Gemini call for serial + marks
│   │   ├── marks_ocr.py     # Local OCR fallback, only after Gemini itself fails
│   │   ├── harvest.py       # Confirmed values -> labelled training crops
│   │   ├── models.py        # ScanResult, QuestionMark, QuizConfig, HarvestFields
│   │   └── recognizers/     # base.py (protocol) · remote.py · local.py (CNN) · both.py
│   ├── cnn/                 # Optional local digit CNN
│   │   ├── model.py · train.py · preprocess.py      # architecture, EMNIST training, 28x28 prep
│   │   ├── segment.py · decode.py · id_infer.py     # cell -> glyphs, constrained decoding, TTA inference
│   │   ├── accuracy.py · marks_accuracy.py          # accuracy harnesses against testset/
│   │   ├── inspect_preprocess.py                    # visual check of preprocessing output
│   │   └── checkpoints/digit_cnn.onnx               # the trained model actually used at runtime
│   ├── tests/               # 84 pytest tests; Gemini always mocked from fixtures/, never live
│   ├── detect.py            # CLI harness: run detection on one image, write debug overlays
│   ├── batch_detect.py      # Same, across the whole testset in one run
│   ├── id_ocr_accuracy.py   # Tesseract ID-accuracy harness
│   ├── gen_dev_cert.py      # Self-signed HTTPS cert for the backend (LAN IP auto-detected)
│   ├── generate_collection_sheet.py  # Blank handwriting-sample sheet (.docx) for gathering training data
│   ├── harvest_real_photos.py        # One-off: push a labelled photo batch through /api/harvest
│   ├── requirements.txt              # Backend deps, pinned — includes onnxruntime/scipy
│   │                                 # since the default CNN path needs them at runtime
│   └── requirements-cnn.txt          # Training only: torch/torchvision/onnx
│
├── frontend/
│   ├── vite.config.ts       # PWA, HTTPS via basic-ssl with LAN IPs, LAN binding, vitest config
│   └── src/
│       ├── App.tsx          # Screen state machine — no router: Setup -> Scan -> Results
│       ├── Setup.tsx        # Quiz config + a "How this works" explainer
│       ├── Scan.tsx         # Camera, framing guide, upload queue; hosts Review as an overlay
│       ├── Review.tsx       # Confirm/edit screen — identity fields first and largest
│       ├── Results.tsx      # Results table, inline editing, Excel export, "Reset everything"
│       ├── api.ts           # scanImage() and harvestScan() clients
│       ├── db.ts            # IndexedDB session store (idb) + resetAll()
│       ├── scanQueue.ts     # Upload-queue reducer + nextToReview()
│       ├── validateConfig.ts · validateMarks.ts · results.ts   # Pure, unit-tested logic
│       ├── types.ts         # Mirrors backend/app/models.py
│       └── *.test.ts(x)     # 67 vitest tests
│
├── testset/                 # 30 labelled test photographs
│   ├── images/               # 2 originals, 7 phone captures, 18 from a real class, 3 synthetic
│   ├── labels.json           # Ground truth, hand-written
│   ├── real_class_info.json  # Source ground truth for the real-class batch
│   ├── quiz_configs.json     # Per-question max marks for that batch's three templates
│   └── check_labels.py       # labels.json <-> images/ consistency check
│
└── synthetic_scripts/       # 20 generated test images: printed grid, handwritten values
    ├── generate.py · ground_truth.json · images/
```

Gitignored and not in the repo: `venv/`, `node_modules/`, `.env`,
`certs/`, `debug/`, `debug_uploads/`, `comparison_log/`,
`backend/training_data/harvested/`, the EMNIST download, and
`synthetic_scripts/fonts/`.

## Stack

Settled decisions, justified in plan.md §7 and §15 — not defaults to
revisit casually.

| Layer | Choice |
|---|---|
| Backend | Python 3.10 + FastAPI, `uvicorn`, `python-multipart` |
| Image processing | `opencv-python-headless` |
| Local ID OCR | `pytesseract` (`--psm 10`, digit whitelist) |
| Serial + marks | `google-genai` (**not** the retired `google-generativeai`) |
| Optional local recognizer | PyTorch-trained CNN, exported to ONNX, run with `onnxruntime` |
| Validation | `pydantic` (also supplies the Gemini `response_schema`) |
| Frontend | React 19 + TypeScript, Vite, `vite-plugin-pwa` |
| Session state | `idb` (IndexedDB) |
| Excel export | `exceljs`, client-side |
| Database | none — the backend is stateless |
| Tests | `pytest` (backend), `vitest` (frontend) |

## Running it

**Prerequisites:** Python 3.10+ and Node 20+.

A Gemini API key and the Tesseract binary are needed **only** for
`RECOGNIZER=remote` — the default CNN path uses neither. For `remote`, get
a key into `backend/.env` and run `apt install tesseract-ocr` (the pip
package is a wrapper only; OCR 500s from the app while working in your
shell is almost always a missing binary or an unset
`pytesseract.pytesseract.tesseract_cmd`).

### One-time setup

```bash
# Backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # only needed for RECOGNIZER=remote — fill in GEMINI_API_KEY
python gen_dev_cert.py      # self-signed HTTPS cert; re-run if the LAN IP changes

# Frontend
cd frontend && npm install
```

### Run both servers

```bash
./dev.sh
```

Starts the backend (HTTPS, bound to all interfaces) and the Vite dev
server together, generating the backend cert first if it's missing. Ctrl+C
stops both.

Then open the frontend's HTTPS URL **on the phone**, on the same network.
Both servers use self-signed certificates, so each device clicks past a
one-time "not trusted" warning — `getUserMedia` needs a *secure* context,
not a *trusted* one, so this is enough for the camera to work.

To run them separately:

```bash
# Backend — HTTPS is required, not optional: an HTTPS page cannot fetch a
# plain-HTTP endpoint over the LAN (mixed content), and the phone reaches
# the backend by LAN IP, not localhost.
cd backend && source venv/bin/activate
uvicorn app.main:app --reload --host 0.0.0.0 \
  --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Frontend — HTTPS and LAN binding are already on via vite.config.ts
cd frontend && npm run dev
```

The frontend derives the backend's address from whatever host served the
page, on port 8000. Override with `VITE_API_BASE` if the backend runs
somewhere else. CORS is a regex matching `localhost`, `127.0.0.1` and all
three private LAN ranges, so no address is hardcoded anywhere.

### Tests

```bash
cd backend && source venv/bin/activate && pytest   # 84 tests, fully offline
cd frontend && npx vitest run                      # 67 tests (npx vitest for watch mode)
cd frontend && npm run lint                        # oxlint
cd frontend && npm run build
```

The backend suite never touches the network — Gemini responses are served
from cached fixtures in `backend/tests/fixtures/`.

### Detection and recognition tuning

The fast loop for working on detection or recognition, without a browser
or a phone in the way:

```bash
cd backend && source venv/bin/activate

# One image, with debug overlays written out to look at directly
python detect.py <image-path> --questions 5 --id-digits 7 --out ../testset/debug/<name>

# The whole test set in one run
python batch_detect.py ../testset/images --questions 5 --id-digits 7 --out ../testset/debug/

# Tesseract ID accuracy against testset/labels.json
python id_ocr_accuracy.py

# Test set consistency
python ../testset/check_labels.py
```

Any change to detection re-runs the full test set. A tweak that fixes one
photo silently breaks four others otherwise.

### The local CNN: retraining and accuracy

Running the app needs nothing extra — `onnxruntime` and `scipy` are in
`requirements.txt`, and a trained `cnn/checkpoints/digit_cnn.onnx`
(~1.8 MB) is committed, so the default path works straight after setup.
The accuracy harnesses run on that same base install:

```bash
cd backend && source venv/bin/activate
python cnn/accuracy.py                 # ID accuracy + confidently-wrong count
python cnn/accuracy.py --calibrate     # dump confidence/margin per digit, to pick floors
python cnn/marks_accuracy.py           # serial/marks/total accuracy, half marks reported separately
```

**Retraining** is the only part that needs the extra dependencies, since
`torch` is training-only:

```bash
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-cnn.txt

python cnn/inspect_preprocess.py ../testset/debug/*/cells/id_d*.png  # look at the 28x28 inputs first
python cnn/train.py --epochs 8 --out cnn/checkpoints                 # EMNIST Digits, ~8-10 min/epoch on CPU
```

To run the app against a different recognizer than the default:

```bash
RECOGNIZER=remote uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
RECOGNIZER=both   uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
```

`remote` additionally needs `GEMINI_API_KEY` set in `backend/.env` and the
Tesseract binary installed; the default `cnn` path needs neither.

Collecting real handwriting to fine-tune on:

```bash
# Blank sample sheet to print and have people fill in (not the marks grid)
python generate_collection_sheet.py --out ../collection_sheet.docx

# Push an already-labelled photo batch through the live harvesting endpoint
uvicorn app.main:app --port 8123 &
python harvest_real_photos.py --base-url http://127.0.0.1:8123
```

The live app harvests too: every Confirm on the review screen posts the
original and corrected values to `/api/harvest`, fire-and-forget, turning
routine grading into labelled training data.

### Synthetic test images

```bash
cd synthetic_scripts
python3 generate.py 0 20   # writes generated/images/ + _recs/*.json
python3 generate.py        # assembles generated/ground_truth.json from _recs/
```

Needs 15 Google Fonts plus Liberation Sans, none carried in the repo —
`generate.py` documents exactly which.

## Invariants worth knowing before changing anything

These come from the specs and are load-bearing. Breaking one is a defect,
not a style difference — [CLAUDE.md](CLAUDE.md) has the full list with
reasoning.

- **Detection is proportional, never fixed-coordinate.** Kernel lengths
  are a fraction of image dimensions; cell boundaries come from detected
  line positions, never from dividing table width by column count.
- **`column_count_mismatch` is core logic, not error handling.** When the
  detected shape disagrees with the config, fail — never guess.
- **The student ID never reaches Gemini.** This is asserted in code, not
  just conventionally observed.
- **Marks are a constrained enumeration.** The Pydantic `response_schema`
  constrains structure, not range — the server-side legal-value check is
  what actually stops a 7 landing in a 5-mark question, and must stay.
- **Derive, don't store, the sum check.** A stored pass/fail flag goes
  stale behind an edit.
- **IndexedDB indexes on serial and studentId must permit duplicates** — a
  repeated serial is exactly what the cross-check exists to surface.
- **Serial comparison strips leading zeros.** `2`, `02`, `002` are one
  serial.
- **At least one of `studentId` / `serial` must be non-null** to save.
- **Never export a blank as `0`.** It reads as a mark of zero and nothing
  downstream catches it.

## Deliberately not built

Client-side detection with OpenCV.js · roster import · a server-side
database or multi-quiz history · multi-user auth · a template generator
(the grid is a Docs table pasted by hand, on purpose).

On the default CNN path, **no third party ever sees a script** — nothing
leaves the laptop at any point. That is a real and meaningful property, but
it is not the same as "the ID never leaves the device": the photo still
travels from the phone to the laptop, and the backend does see it (writing
nothing to disk). Making the stronger claim true would require client-side
OpenCV.js, which is explicitly deferred (plan.md §12, §13). On
`RECOGNIZER=remote` the weaker guarantee applies too — serial and marks
reach Gemini, though the ID crops never do.

## Further reading

| File | What it's for |
|---|---|
| [plan.md](plan.md) | Full architecture, data models, API contract, and the reasoning behind each resolved decision |
| [step.md](step.md) | The step-by-step build plan and the Progress table — the real status of record |
| [learn.md](learn.md) | Plain-language explanation of what each finished step's code actually does |
| [stack-reference.md](stack-reference.md) | Library-level specifics: exact calls, starting parameters, known traps |
| [issues.md](issues.md) | Known bugs and gaps, found by audit, not yet fixed |
| [CLAUDE.md](CLAUDE.md) | Conventions, invariants, and the working protocol for this repo |
