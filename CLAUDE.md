# CLAUDE.md

## What this is

**Script Mark Scanner** — a tool for a faculty member grading quizzes. They
photograph the marks grid at the top of each student's script; the app reads
the handwritten student ID, serial number, and per-question marks, lets the
instructor confirm or correct them on the spot, and exports the whole session
as one Excel file.

Single instructor, one quiz session, one class (pilot: CSE211L). No auth, no
uploads, no server-side database. Session state lives in IndexedDB until
export.

## Current state — read this first

Specs first, then check `step.md`'s **Progress table** at the bottom — it is
the project's actual status of record and is kept current as steps
complete. Do not assume "not started" from this file; the table is the
source of truth.

| File | What it is |
|---|---|
| [plan.md](plan.md) | Architecture, data models, screens, API contract, resolved decisions |
| [step.md](step.md) | Execution plan — steps 0–10, each with a *Before you start*, substeps, a test, and a *Done when* bar. Step numbers match plan §14. Ends with the Progress table. |
| [stack-reference.md](stack-reference.md) | Library-level notes from Context7: exact calls, starting parameter values, known traps |
| [learn.md](learn.md) | Plain-language walkthrough of what each finished step's code actually does, for learning alongside the build. Updated after each step — see "How to work here." |
| [issues.md](issues.md) | A full-repo audit (2026-08-27): real bugs, security review, design-tell scan — spot-verified, not fixed yet. Read before assuming a screen/endpoint is correct just because its own step's Done-when bar passed. |
| `marks-grid-template.docx` | The grid the instructor pastes into the question paper |

Commands below are the ones the specs call for. Once a step has actually
built something (check the Progress table), the corresponding command is
real and runnable, not aspirational.

`Cnn migration.md` (repo root) was a standalone design note proposing a
local CNN recognizer as an optional second path alongside Gemini+Tesseract.
It's been reviewed and folded into [plan.md](plan.md) §16 and
[step.md](step.md)'s steps 2r.0/2r/3r/3r.6 (learn.md has the plain-language
rationale) — treat those as the current spec, not the standalone file,
which is kept only as the original source note. That track is optional and
additive; nothing about the existing Gemini+Tesseract path changes unless
it's picked up. **It has been picked up**: steps 2r.0, 2r, and 3r are all
done. **A real 18-photo, ~20-different-writer batch from an actual class
arrived (2026-08-30)** and materially changed the numbers below — see
step.md's step 0 row for the full account, including two real detection
bugs (a neighboring script's ID row could get silently misattributed as
this student's) found and fixed along the way. Measured on that real,
diverse batch, then recalibrated (the original confidence/margin floors
were tuned on 8 single-writer photos and were badly over-conservative once
real diversity showed up): the CNN reads IDs at **91.8% per-digit, 55.2%
whole-ID exact match, 1 confidently-wrong case** (a single genuinely
ambiguous cursive digit — down from Tesseract's much lower baseline on the
same photos), and marks at **98.1% per-question** (half marks 100%),
correctly flagging the one deliberately-illegal handwritten value in the
batch rather than guessing it. `RECOGNIZER=cnn` is wired into `main.py`
and works end to end through the real endpoint. **Step 3r.6 is partly
done**: `RECOGNIZER=both` (comparison logging to `comparison_log/`), the
harvesting pipeline (`/api/harvest`, wired into the review screen's
Confirm), and a `.docx` collection-sheet generator are all built and
tested. **The 18-photo batch also fed this pipeline directly** — a
one-off `backend/harvest_real_photos.py` posted 16 of the 18 photos
through `/api/harvest`, landing real, correctly-labelled training crops
in `training_data/harvested/` and giving step 3r.6a's "collect from ≥4
writers" goal real, substantive progress. What's still left — actually
fine-tuning on that data, and running a real full quiz with
`RECOGNIZER=both` — needs the user's own further real-world participation
and can't be built or simulated. `RECOGNIZER=remote` stays the actual
default until that real comparison says otherwise.

## Stack

Decided and justified in plan §7 and §15 — these are settled decisions, not
defaults to revisit casually.

| Layer | Choice | Notes |
|---|---|---|
| Backend | Python + FastAPI, `uvicorn`, `python-multipart` | Stateless. Runs on the instructor's laptop for the pilot — no hosting. |
| Image processing | `opencv-python-headless` | Table detection, deskew, cell splitting. Headless substituted for `opencv-python` — no GUI display code (`imshow`) is used anywhere in the pipeline, only file writes, and headless avoids pulling in system Qt/GTK libs on a server. |
| Local ID OCR | `pytesseract`, `--psm 10`, digit whitelist | Keeps the student ID off the network |
| Serial + marks | `google-genai` (`from google import genai`) | **Not** `google-generativeai` — that SDK is retired |
| Validation | `pydantic` | Also supplies the Gemini `response_schema` |
| Frontend | React + TypeScript, Vite, `vite-plugin-pwa` | Camera via `getUserMedia` |
| Session state | `idb` (IndexedDB) | Survives crash/refresh mid-scan |
| Excel export | `exceljs`, client-side | Chosen over SheetJS — see plan §15 |
| Database | none | |
| Tests | `pytest` (backend), `vitest` (frontend) | |

Local toolchain: Python 3.10.12, Node 20.20.2, npm 10.8.2. Nothing is pinned
yet — `requirements.txt` gets written at step 0.2.

**Tesseract is not installed on this machine.** The pip package is a wrapper
only; install the binary separately (`apt install tesseract-ocr`) before step
2. If OCR 500s from the app but works in your shell, set
`pytesseract.pytesseract.tesseract_cmd` explicitly — that is the usual cause.

## Layout

Created starting step 0.1. Backend through step 3's rate-limited fallback
plus steps 2r.0/2r/3r's full local CNN path, and frontend through step 9's
Results screen and Excel export (code done, a real full-class export/
reconcile still pending), all exist. Step 10 doesn't yet. The optional CNN
track (steps 2r.0/2r/3r/3r.6,
plan.md §16): `app/recognizers/` (2r.0's interface, 3r's `local.py`
wiring, 3r.6's `both.py` comparison mode), `backend/cnn/`'s trained model
plus segmentation/decoding (2r, 3r) are all done and reachable via
`RECOGNIZER=cnn`/`both`. Step 3r.6's harvesting pipeline (`app/harvest.py`,
`/api/harvest`, wired into the review screen) and its `.docx` collection-
sheet generator are also built; real handwriting collection has now
started (see the real_class_* batch below), but the fine-tuning and
comparison run that collection exists to support are not — see step.md's
Progress table for exactly what's built versus what needs the user's own
participation.

A 20-image synthetic dataset (`synthetic_scripts/`, from a separate
claude.ai conversation) has been reviewed, partly integrated into
`testset/`, and its generator (`generate.py`) both fixed to run locally
and revised at the user's request so the grid and all labels are
machine-printed and only the filled-in values (ID/serial/marks) are
handwritten — matching the real app's actual printed-template-plus-
handwritten-values setup more closely than the original generator's
fully-hand-drawn style. See step.md's step 0 entry for the full account,
including a real confidently-wrong misread it surfaced (a Total field
read as `27.5` against a true `21.5`, unflagged) that's noted but not
yet acted on.

**18 real photos from an actual class arrived and got integrated
(2026-08-30)**: `testset/images/real_class_01..18.jpeg`, ground truth in
`testset/real_class_info.json` (the source record) folded into
`labels.json`, and a new `testset/quiz_configs.json` since these photos
use three different quiz templates and `labels.json` itself has nowhere
to record a question's max marks. Running them through detection exposed
and fixed two real bugs in `app/detection.py` — a neighboring script's own
ID row, visible at the edge of frame, could get silently picked as *this*
student's ID or Serial — see step.md's step 0 row and learn.md for the
full account. The CNN's confidence/margin floors were then recalibrated
against this much larger, real-diversity sample (step.md's step 2r row),
and 16 of the 18 photos were fed through the harvesting pipeline via a new
one-off script, `backend/harvest_real_photos.py` (step.md's step 3r.6
row). Also fixed along the way: `id_ocr_accuracy.py`/`cnn/accuracy.py`
hardcoded a 5-question assumption when calling `detect()`, masking usable
ID reads on this batch's 3- and 8-question photos.

**Three frontend usability fixes from live testing (2026-08-30)**: a
Retake used to leave a dead, still-clickable "Scan failed" row in the
capture screen's queue list forever — now filtered out once dismissed
(`Scan.tsx`). The capture button now shows a spinning ring and disables
itself while a shot is uploading/being recognized, so there's feedback
right where the instructor is actually looking — see step.md's step 6 row
for the throughput trade-off this makes (captures no longer run in
parallel) and why it still needs real-phone verification. And a new
"Reset everything" button on the Results screen (`db.ts`'s `resetAll()`)
clears every saved record and the quiz config behind the same
confirm/cancel warning-banner pattern `Review.tsx` already uses for a
conflict, for starting a genuinely clean new session.

```
marks-upload/
├── plan.md · stack-reference.md · step.md · CLAUDE.md · learn.md
├── Cnn migration.md            # folded into plan.md §16 / step.md — see note above
├── dev.sh                       # run both servers together — see Commands
├── marks-grid-template.docx
├── testset/
│   ├── images/                 # real photographs — step 0's two, 7 real phone
│   │                           # captures added while tuning id_ocr.py, 3
│   │                           # synthetic_*.jpg copied from synthetic_scripts/
│   │                           # (see below), and real_class_01..18.jpeg — 18
│   │                           # real photos from an actual class (2026-08-30)
│   ├── real_class_info.json    # source ground truth for real_class_*.jpeg,
│   │                           # transcribed by the user — same role
│   │                           # synthetic_scripts/ground_truth.json plays below
│   ├── quiz_configs.json       # per-question max marks for the real_class_*
│   │                           # batch's 3 varying templates — labels.json
│   │                           # itself has no such field; referenced per-entry
│   │                           # via a "quiz" key, read by cnn/marks_accuracy.py
│   ├── labels.json             # ground truth, hand-written
│   ├── check_labels.py         # labels.json <-> images/ consistency check
│   └── debug/                  # gitignored — detect.py's regenerable output
├── synthetic_scripts/           # a 20-image synthetic dataset from a separate
│   │                            # claude.ai conversation, reviewed and partly
│   │                            # folded into testset/ — see step.md step 0
│   ├── images/                  # the original 20 — do not overwrite; two are
│   │                            # already referenced by testset/labels.json
│   ├── ground_truth.json        # ground truth for images/, verified clean
│   ├── generate.py              # the generator — fixed to run locally (fonts,
│   │                            # paths) and revised so the grid/labels are
│   │                            # machine-printed, only values handwritten
│   ├── fonts/                   # 15 handwriting fonts (downloaded, gitignored-
│   │                            # sized) + fonts/print/ for the one print font
│   └── generated/                # gitignored — generate.py's own output dir,
│                                  # kept separate from images/ on purpose
├── backend/
│   ├── detect.py               # step 1 CLI harness (single image)
│   ├── batch_detect.py         # step 1.8 — whole testset/images/ in one run
│   ├── id_ocr_accuracy.py      # step 2.4 — ID OCR accuracy harness
│   ├── gen_dev_cert.py         # step 6 — self-signed cert so the phone's HTTPS page can reach this backend
│   ├── generate_collection_sheet.py  # step 3r.6a — blank .docx handwriting-sample sheet generator
│   ├── harvest_real_photos.py  # 2026-08-30 — one-off: feeds the real_class_*
│   │                           # batch through /api/harvest (original == confirmed)
│   ├── debug_uploads/          # gitignored, TEMPORARY (step 6 phone debugging) —
│   │                           # every real upload saved since the backend is
│   │                           # otherwise stateless; remove once step 6 closes
│   ├── training_data/harvested/ # gitignored — step 3r.6c's real, per-Confirm labelled crops
│   ├── .env.example            # copy to .env, fill in GEMINI_API_KEY
│   ├── app/
│   │   ├── models.py           # step 4 — ScanResult, QuestionMark, QuizConfig; HarvestFields (3r.6c)
│   │   ├── detection.py        # step 1 — the make-or-break component
│   │   ├── id_ocr.py           # step 2 — local, never leaves the laptop
│   │   ├── marks.py            # step 3 — the Gemini call
│   │   ├── marks_ocr.py        # step 3 addition — local OCR fallback for
│   │   │                       # when Gemini itself fails (rate_limited/model_error)
│   │   ├── harvest.py          # step 3r.6c — confirmed values -> training_data/harvested/
│   │   ├── main.py             # step 4 — POST /api/scan, /api/harvest (3r.6c); calls
│   │   │                       # recognition only through the Recognizer protocol (2r.0)
│   │   └── recognizers/        # step 2r.0 — the Recognizer seam (plan.md §16)
│   │       ├── base.py         #   Recognizer protocol + IdResult
│   │       ├── remote.py       #   RemoteRecognizer — wraps id_ocr/marks/marks_ocr
│   │       │                   #   unchanged, moved not rewritten
│   │       ├── local.py        #   step 3r — CNNRecognizer: segmentation + constrained
│   │       │                   #   decoding wired behind the same protocol
│   │       └── both.py         #   step 3r.6d — BothRecognizer: runs both, returns the
│   │                           #   CNN's result, logs disagreements to comparison_log/
│   ├── tests/
│   │   ├── fixtures/           # cached real Gemini responses — no live API in tests
│   │   ├── test_detection_regression.py
│   │   ├── test_marks.py
│   │   ├── test_marks_ocr.py
│   │   ├── test_main.py
│   │   ├── test_cnn_segment.py # step 3r — synthetic cell images, no model needed
│   │   ├── test_cnn_decode.py  #   step 3r — synthetic probability vectors, no model needed
│   │   ├── test_both_recognizer.py  # step 3r.6d — fake sub-recognizers, no network/model
│   │   ├── test_harvest.py     #   step 3r.6c — harvest() unit tests
│   │   └── test_harvest_endpoint.py #  step 3r.6c — /api/harvest against a real photo
│   ├── requirements.txt        # includes python-docx (step 0's template fix, step 3r.6a's generator)
│   ├── requirements-cnn.txt    # step 2r — torch/torchvision/onnx/onnxruntime/scipy,
│   │                           # kept separate: the main app has no dependency on any of it
│   └── cnn/                    # steps 2r/3r — model + inference code the app's
│       │                       # optional CNN path (app/recognizers/local.py) imports
│       ├── model.py            #   DigitCNN architecture (plan.md §16)
│       ├── preprocess.py       #   MNIST-matched 28x28 preprocessing, torch-free —
│       │                       #   preprocess_for_cnn (ID) and glyph_to_canvas (segmented glyphs)
│       ├── inspect_preprocess.py #  visual check: real crops -> 28x28 previews
│       ├── segment.py          #   step 3r — cell -> glyphs (merge rule, decimal-by-geometry)
│       ├── decode.py           #   step 3r — constrained decoder (marks/total/serial)
│       ├── id_infer.py         #   step 3r — shared TTA+softmax inference, factored out of accuracy.py
│       ├── train.py            #   EMNIST Digits + augmentation -> ONNX export + parity check
│       ├── accuracy.py         #   ID accuracy harness, apples-to-apples with id_ocr_accuracy.py;
│       │                       #   CONFIDENCE_FLOOR/MARGIN_FLOOR recalibrated 2026-08-30 against
│       │                       #   the real_class_* batch's ~20 writers (0.9/0.8 -> 0.75/0.6)
│       ├── marks_accuracy.py   #   step 3r.5 — serial/marks/total accuracy, half marks reported
│       │                       #   separately; reads testset/quiz_configs.json's per-photo max
│       │                       #   marks when a label has a "quiz" key (2026-08-30)
│       ├── data/                #  gitignored — EMNIST download (~2GB), regenerated by train.py
│       └── checkpoints/         #  gitignored *.pt; digit_cnn.onnx (~1.8MB) is the real deliverable
└── frontend/
    ├── vite.config.ts          # PWA + basicSsl (not mkcert — see Commands) + Vitest config
    └── src/
        ├── types.ts            # QuizConfig, StudentRecord — mirrors app/models.py
        ├── db.ts               # IndexedDB (idb) — step 5.2; resetAll() (2026-08-30)
        │                       # clears both stores for a full session reset
        ├── api.ts              # POST /api/scan client (step 6.4); harvestScan,
        │                       # POST /api/harvest client (step 3r.6c)
        ├── validateConfig.ts   # pure form-validation logic, unit-tested
        ├── validateMarks.ts    # sum check, legal-value check, serial normalisation,
        │                       # identity cross-check (plan.md §10) — step 7
        ├── results.ts          # step 9.1/9.2 — sort by serial then ID, unverified-record rule
        ├── scanQueue.ts        # upload-queue reducer — step 6.3
        ├── Setup.tsx           # step 5.3–5.4
        ├── Scan.tsx            # camera + upload queue — step 6; capture-button
        │                       # spinner/disable and Retake dead-row fix (2026-08-30)
        ├── Review.tsx          # review/edit/save screen (step 7); fires harvestScan
        │                       # on Confirm, fire-and-forget (step 3r.6c)
        ├── Results.tsx         # step 9 — results table, inline editing, Excel export;
        │                       # React.lazy-loaded from App.tsx (ExcelJS is most of its weight);
        │                       # "Reset everything" button + confirm banner (2026-08-30)
        └── App.tsx
```

## Commands

All verified working (backend through step 3's rate-limited fallback,
frontend through step 9's Results screen and Excel export).

```bash
# Run both servers together — for actual scanning use (step 6+), not
# detector tuning. Ctrl+C stops both, reliably (see learn.md step 6 for
# why that took two fixes: process-group signal targeting, then a
# self-signal re-entrancy bug in the cleanup trap itself).
./dev.sh

# Detection harness — the primary loop for steps 1–3
cd backend && source venv/bin/activate && python detect.py <image-path> --questions 5 --id-digits 7 --out ../testset/debug/<name>
cd backend && source venv/bin/activate && python batch_detect.py ../testset/images --questions 5 --id-digits 7 --out ../testset/debug/
cd backend && source venv/bin/activate && python id_ocr_accuracy.py

# Backend tests — offline, Gemini always mocked (84 tests as of the
# real_class_* batch's detection-regression cases, 2026-08-30)
cd backend && source venv/bin/activate && pytest

# Optional CNN track (steps 2r/3r, plan.md §16) — reachable via
# RECOGNIZER=cnn/both once trained. One-time setup: CPU-only wheels (no
# GPU on this machine), kept out of the main requirements.txt on purpose.
cd backend && source venv/bin/activate
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-cnn.txt
python cnn/inspect_preprocess.py ../testset/debug/*/cells/id_d*.png   # look at the 28x28 outputs directly before training anything
python cnn/train.py --epochs 8 --out cnn/checkpoints                  # EMNIST Digits, ~8-10 min/epoch on CPU
python cnn/accuracy.py --calibrate                                    # dump confidence/margin per real digit, to pick floors —
                                                                       # last recalibrated 2026-08-30 (0.9/0.8 -> 0.75/0.6) against
                                                                       # the real_class_* batch's ~20 writers, see step.md step 2r
python cnn/accuracy.py                                                # ID accuracy + confidently-wrong count — 91.8%/1-confidently-
                                                                       # wrong as of 2026-08-30, vs id_ocr_accuracy.py's 37.4%/0-of-29
python cnn/marks_accuracy.py                                          # step 3r.5 — serial/marks/total accuracy, half marks reported
                                                                       # separately; reads testset/quiz_configs.json per photo when
                                                                       # a label has a "quiz" key (2026-08-30)

# Run the actual app against the CNN path, or both paths side by side
# (step 3r.6d) — "both" costs real Gemini quota, logs every disagreement
# to comparison_log/comparisons.jsonl, and is only meant for an actual
# comparison run, not everyday use.
RECOGNIZER=cnn uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
RECOGNIZER=both uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Step 3r.6a — blank handwriting-sample sheet (not the marks-grid template).
# Print, get real people to fill it in, photograph it — none of that is scriptable.
python generate_collection_sheet.py --out ../collection_sheet.docx

# Feed an already-ground-truthed batch of real photos into the same
# harvesting pipeline the live Review screen uses on Confirm — needs a
# running backend (plain HTTP is fine, this is a local script, not a phone).
uvicorn app.main:app --port 8123 &
python harvest_real_photos.py --base-url http://127.0.0.1:8123

# Synthetic dataset generator (synthetic_scripts/, step.md step 0) — one-time
# setup: 15 Google Fonts + Liberation Sans, none included in the repo.
# Two-phase run per its own main(): build images first, then assemble
# ground_truth.json from the per-image records the first phase wrote.
cd synthetic_scripts
python3 generate.py 0 20   # writes generated/images/ + _recs/*.json
python3 generate.py        # reads _recs/, writes generated/ground_truth.json

# Backend — needs backend/.env with GEMINI_API_KEY (copy .env.example),
# and an HTTPS cert (below) generated first
cd backend && source venv/bin/activate
python gen_dev_cert.py   # only when certs/ is missing or the LAN IP changed
uvicorn app.main:app --reload --host 0.0.0.0 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Frontend — HTTPS and LAN binding are on by default via vite.config.ts,
# no --host flag needed
cd frontend && npm run dev
cd frontend && npx vitest run   # 67 tests as of the "Reset everything" button, 2026-08-30; or `npx vitest` for watch mode
cd frontend && npm run build
```

The dev server serves HTTPS via `@vitejs/plugin-basic-ssl`, not `mkcert` —
this machine has no passwordless sudo, and mkcert needs a system binary plus
a trusted CA in the OS store. basic-ssl is a pure npm plugin: a self-signed
cert with no system install, at the cost of a one-time "not trusted"
warning to click past on each device (the phone included) instead of a
silently-trusted one. `getUserMedia` only needs a secure context, not a
*trusted* one, so self-signed still satisfies it (plan.md §9). Revisit
mkcert if the click-past warning becomes annoying enough to matter.

**The backend needs HTTPS too, not just the frontend** — found in step 6,
not step 5, because nothing crossed origins over the network until then.
A page loaded over HTTPS can't fetch a plain-HTTP endpoint except
`localhost`/`127.0.0.1` (browsers block it as mixed content), and the phone
reaches the backend via the LAN IP, not `localhost`. `gen_dev_cert.py`
generates a matching self-signed cert (`backend/certs/`, gitignored,
regenerate if the LAN IP changes) the same way `vite.config.ts` does for
the frontend — LAN IP detected via a socket trick, never hardcoded.

CORS is a regex in `app/main.py` matching `localhost`/`127.0.0.1` and all
three private LAN ranges (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`),
rather than one hardcoded address — the actual LAN IP changes per network.

## How to work here

`step.md`'s working protocol governs. Three rules:

1. **Read the code before starting a step**, not just the plan. Each step
   names what to look at in its *Before you start* line.
2. **Do not begin a step until the previous one meets its *Done when* bar.**
   "Basically working" is not done. This matters most at step 1.
3. **Re-run earlier tests after every step.** Any change to detection re-runs
   the full test set (step 1.9), every time. A step-3 tweak that fixes one
   photo silently breaks four others otherwise.

Testing means something different per layer, and pretending otherwise
produces theatre: detection is verified by *looking at overlays* plus shape
regression; recognition by an accuracy number against labelled ground truth;
the API by `TestClient` with Gemini mocked; frontend logic by Vitest over
pure functions; camera/PWA/export by hand on the real phone.

4. **Update [learn.md](learn.md) as the last piece of work after finishing
   each step** — a plain-language section explaining what the step's code
   actually does, written for someone learning alongside the build (the
   user explicitly wants this). Simple wording, real file references, real
   code snippets pulled from the files just written — not a restatement of
   `step.md`'s task list. Only write the section once the step genuinely
   meets its *Done when* bar; a partially-done step gets a partial, honestly
   labelled entry (see step 0/1's entries for the pattern), not a section
   describing work that hasn't happened yet.

## Conventions and invariants

These come from the specs and are load-bearing. Breaking one is a defect, not
a style difference.

**Detection is proportional, never fixed-coordinate.** Morphological kernel
lengths are a fraction of image width/height (`cols // 30` as the starting
divisor), never a pixel constant. The grid is pasted into a question paper,
so it sits anywhere at any size. Recover cell boundaries from actual detected
line positions — never divide table width by column count.

**`column_count_mismatch` is core logic, not error handling.** It is the
difference between failing loudly and writing Q4's mark into the Q3 column.
When the detected shape disagrees with the Setup config, fail — never guess.

**The student ID never reaches Gemini.** It is cropped and read locally by
pytesseract; ID crops are excluded from the composite sent to the API. Step
3.1 requires this be an *assertion in code*, not a convention — the privacy
property is one line away from being false. Serial and marks do go to Gemini;
they identify nobody without the instructor's attendance sheet.

**Marks are a constrained enumeration.** A question out of 5 has exactly 11
legal values (0, 0.5, … 5), derived per question from its own max. The
Pydantic `response_schema` constrains *structure, not range* — a 7 can still
come back for a 5-mark question, so the server-side legal-value rejection is
required and must stay. Rejected values go to `low_confidence_fields` and
stay blank. Never store a wrong number.

**Flag, never guess.** Low-confidence OCR, out-of-range marks, unreadable
cells — all become blank plus a flag for the instructor, never a filled-in
best guess.

**Derive, don't store, the sum check.** `sumCheck` is computed on render. A
stored pass/fail flag goes stale behind an edit.

**IndexedDB indexes on serial and studentId must permit duplicates.** A
repeated serial is exactly what the cross-check exists to *surface*; a unique
index throws on write and loses the two records the instructor needs to see
side by side.

**Serial comparison strips leading zeros.** `2`, `02`, `002` are the same
serial.

**At least one of `studentId` / `serial` must be non-null** to save a record.
One filled is valid but unverified; both empty blocks the save.

**A failed scan is never a dead end.** Any `status: "failed"` lands the
instructor on the review screen with empty fields, the reason shown, and
Retake plus Enter-manually available. A bad photo must never block the
session.

**Identity fields render first and largest** on the review screen, above the
marks. Never as ordinary small fields — the instructor is holding the script
and this is the highest-value check in the workflow.

**The backend is stateless.** Nothing written to disk, no globals carrying
request data between calls.

**A Gemini failure tries a local OCR fallback before giving up.**
`marks_ocr.py`'s `recognize_locally` runs only after `marks.py`'s
`recognize` itself fails (`rate_limited`/`model_error`) — never a
replacement for the Gemini path, never called on the happy path. Every
field it touches is unconditionally flagged low-confidence, recovered or
not, and every recovered value still has to pass `marks.py`'s own
`legal_values` check — same as a bad Gemini read, never store a wrong
number. If it recovers nothing at all it returns `None`, so `main.py`
falls through to the original `status: "failed"` rather than presenting an
all-blank result as if it were a normal scan.

## Things to avoid

- **Don't build the app scaffolding first.** Steps 0–3 are standalone scripts
  over a folder of images — no camera, no browser, no HTTP. That loop is
  seconds; the browser loop is minutes. Do not discover the detector's limits
  through the UI.
- **Don't wrap detection in FastAPI before it works** (step 4, not step 1).
- **Don't call Gemini after `table_not_found` or `column_count_mismatch`.**
  The test suite asserts the mock was *not* invoked — it protects the quota
  and the privacy property at once.
- **Don't restate the JSON shape in the Gemini prompt** when a
  `response_schema` is attached. The docs are explicit that it degrades
  results. The prompt carries the legal value set per question and nothing
  about output format.
- **Don't hand-roll 429 backoff.** The SDK retries 408/429/500/502/503/504
  with exponential backoff by default (5 attempts, 1.0s initial, base 2.0).
  Configure `HttpRetryOptions`; don't reimplement it.
- **Don't assume a blocked Gemini response raises.** It returns 200, so
  nothing retries and nothing throws. Check `prompt_feedback.block_reason`
  and `candidates[0].finish_reason` on every response and map them to
  `model_error` — otherwise a blocked reply becomes an unhandled `None` at
  parse time.
- **Don't try to send the image and a JSON body together.** HTTP encodes a
  body as multipart *or* JSON, not both. `QuizConfig` rides as a JSON string
  in a form field, parsed with `model_validate_json`.
- **Don't let the test suite touch the network.** Step 3.6 caches Gemini
  responses to fixtures for exactly this.
- **Don't export a blank as `0`.** It reads as a mark of zero and nothing
  downstream catches it. Named in step 9 as the worst possible failure.
- **Don't use `bytes` for the upload** — `UploadFile` spools past a threshold
  and exposes `.content_type`.
- **Don't over-compress the capture.** It destroys the thin table rules the
  whole detector depends on.
- **Don't add a tap to the confirm→next loop.** It gets paid thirty times per
  class.
- **Don't claim the ID never leaves the device.** The full photo does reach
  the backend — that's the instructor's own laptop, writing nothing to disk.
  Making the stronger claim true means client-side OpenCV.js, which is
  explicitly deferred (plan §12, §13).
- **Don't swap out a component's whole render tree to show an overlay
  screen if anything underneath holds a live browser resource.** `Scan.tsx`
  did this with an early `return <Review />` and it silently unmounted
  `<video>` — the camera-setup effect only binds the live stream to the
  video element once, on first mount, so closing Review left a fresh,
  streamless `<video>` node behind (frozen preview, `Capture` silently
  no-oping). Fixed by rendering `Review` as a `position: fixed` overlay
  instead, so `<video>` stays mounted the whole time — see learn.md step 7.

## Deferred — don't build these

Client-side detection with OpenCV.js · roster import · server-side database
and multi-quiz history · multi-user auth · a template generator (there
deliberately isn't one — the grid is a Docs table pasted by hand).

**No longer simply deferred:** a local mark classifier (TFLite/ONNX) was on
this list until the deferral's own trigger condition — "only if Gemini
accuracy or quota becomes a real constraint" — actually happened (a real
`rate_limited` response, and `id_ocr.py` measured at 58.9% per-digit on
real photos). There's now a concrete, additive, optional build order for
it: plan.md §16, step.md steps 2r.0/2r/3r/3r.6, rationale in learn.md.
**Picked up deliberately, not as a side effect of other step work**: steps
2r.0 (recognizer interface), 2r (training the digit CNN, under
`backend/cnn/`), and 3r (segmentation and constrained decoding for
serial/marks/total) are all done. Measured on the original n=8
single-writer sample, the CNN read IDs at 96.4% per-digit / 0 confidently
wrong; **measured again on a real, ~20-writer batch (2026-08-30) and
recalibrated once that diversity exposed the old confidence floor as
over-conservative, the real number is 91.8% per-digit, 55.2% whole-ID
exact match, 1 confidently-wrong case** (a single genuinely ambiguous
digit) — see step.md's steps 0/2r rows and learn.md for the full account.
Step 3r.6 (the comparison run and harvesting infrastructure that would
make the CNN the default) is in progress: the harvesting pipeline and
comparison-logging mode are both built and tested, and the same real
18-photo batch fed 16 photos through harvesting directly, giving real
progress on collecting from multiple writers. Still not done: actually
fine-tuning on that harvested data, and running a real full quiz session
with `RECOGNIZER=both`.

## Frontend design system

Built via the `product-ui-design` skill (2026-08-29), replacing the
untouched Vite scaffold CSS (`--accent: #aa3bff` purple, centered
marketing layout) `index.css` shipped with since step 5. Anchor: **Apple-
airy** (large hit areas, generous spacing — fits the one-handed phone
workflow during live grading), with the skill's table primitives
(tabular-nums, hairline rows, sticky header, right-aligned numeric
columns) applied to the Results screen specifically. One deliberate
divergence from Apple's own system blue: the brand accent is a petrol
teal (`--primary: #1f6f64` light / `#47a897` dark) — chosen specifically
to stay clear of the indigo/periwinkle family the skill's own tell-list
bans.

All colors are semantic CSS variables in `index.css` (`--background`,
`--foreground`, `--muted`, `--border`, `--primary`, plus
`--success`/`--danger`/`--warning` status pairs) — never raw hex inline
in a component. Buttons commit to one norm app-wide (Apple/HIG pill,
`.btn` + variants); the Results table follows the skill's
`Tables & data-dense surfaces` primitives. Re-run
`.claude/skills/product-ui-design/scripts/scan-tells.py frontend/src/`
after any visual change — it should stay clean.

`Setup.tsx` also gained a "How this works" section (a native
`<details>`, no JS): four numbered steps plus what stays local versus
gets flagged. Open by default with no saved config (first-time use),
collapsed once one exists.

## Installed skills

In `.claude/skills/` (gitignored — solo project):

- **`product-ui-design`** — the one design skill. Restrained product UI, with
  an output-time scan for AI tells. Its "frequency-gate animation" rule
  matches step 8.1 exactly: the confirm→next loop runs thirty times a class
  and should not animate. **A deliberate, narrow exception**: the capture
  button's loading spinner (step 6, 2026-08-30) also runs on every capture,
  but it's tied to real async state (disabled + spinning exactly while that
  shot is uploading/recognizing, gone the instant it resolves) rather than
  a decorative transition — functional feedback for an action whose result
  wasn't otherwise visible where the instructor was looking, not motion for
  its own sake.
- **`fastapi-templates`** — async patterns and error handling for step 4.
  **Caveat: its recommended layout does not apply here.** It assumes a CRUD
  service with SQLAlchemy, auth, versioned routers, and
  services/repositories layers. This backend is one stateless endpoint with
  no database. Follow the flat layout in `step.md` — `app/{models,detection,
  id_ocr,marks,main}.py` — and take only the async and error-handling
  patterns.
- **`frontend-patterns`** — React state and performance, for the step-6
  upload queue. Its Framer Motion section conflicts with
  `product-ui-design`'s restraint rule; when they disagree,
  `product-ui-design` wins on anything visual. No animation library is in
  plan §7, and none is needed.
