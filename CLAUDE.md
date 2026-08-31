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
| [step.md](step.md) | Execution plan — steps 0–11, each with a *Before you start*, substeps, a test, and a *Done when* bar. Steps 0–10 match plan §14; step 11 (hosted demo) is a later, deliberate extension and runs in three independently-shippable phases. Ends with the Progress table. |
| [stack-reference.md](stack-reference.md) | Library-level notes from Context7: exact calls, starting parameter values, known traps |
| [learn.md](learn.md) | Plain-language walkthrough of what each finished step's code actually does, for learning alongside the build. Updated after each step — see "How to work here." |
| [issues.md](issues.md) | **The open-defect register — read it before trusting any screen or endpoint.** Two audits: 2026-08-27 (15 findings) and a full re-read on 2026-08-31 (28 more, N1–N28). **37 of 44 are now fixed** on 2026-08-31 — frontend (12), pair (11, closing both HIGH findings: N1 path traversal, N2 unbounded config), hot-path (**N4**, where a blank ID cell was producing a confident fabricated digit — demonstrated, not inferred, plus N18), cnn-path (N16, N17, N24, 15), and dormant (4, cleared *ahead of* step 3r.6's comparison run, because that run is `RECOGNIZER=both` and #3 would have handicapped the baseline it measures). **4 remain open, all Low and all deploy/infra — nothing on the `cnn` path, nothing in the frontend.** Suites went 148/79 → **246/119**; they passed before the audits too, which is the point worth internalising. It also carries an explicit "what this audit did NOT cover" section naming the files never opened. |
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
and can't be built or simulated.

**`RECOGNIZER` now defaults to `cnn` (2026-08-30, step 3r.6e).** This was
a deliberate user decision made on the real-batch numbers rather than on
the full comparison run originally required — that run still hasn't
happened, and `comparison_log/` does not exist. What the decision rests
on: the CNN beats Tesseract decisively on the ID (91.8%/55.2% vs
58.9%/0.0%), reads marks at 98.1% per-question, and — the part accuracy
numbers don't capture — costs nothing, cannot be rate-limited mid-class,
needs no network, and keeps every photo on the laptop. Two caveats live
with it: **serial is the weakest field at 63.2%** with no Gemini baseline
to compare against, and **both harnesses report 1 confidently-wrong case**
against a bar that says it must stay 0. Neither is hidden by the default;
both are the first things to look at. `RECOGNIZER=remote` remains fully
supported and is the fallback if the CNN misbehaves in a real session.

Because `cnn` is the default, **`onnxruntime` and `scipy` moved into
`requirements.txt`** — the app cannot start without them. `torch` stays
training-only in `requirements-cnn.txt`; nothing under `app/` imports it,
so the running app still never needs it.

**A hosted demo is now specced as step 11** (2026-08-30), after the user
asked about sharing this with other faculty. It is a deliberate extension
beyond plan.md §13's MVP scope; the laptop workflow stays the supported
path and nothing about it changes. Target is **AWS**, sized to the
*always-free* tiers rather than to the user's $140 of credits so it
survives their expiry: Lambda container behind **API Gateway** for the
backend (the plan said Function URL — see the deviation note below),
S3 + CloudFront for the frontend, S3 for harvested crops. **Phases A and B
are done (2026-08-30), and phase C's code-side pieces (11.4 hardening,
11.5 disclosure) are done too; **the AWS deploy itself (11.6/11.7) is not
started**
and needs the user's own account. Phase A fixed two live privacy defects
(`debug_uploads/` deleted, harvester mtime leak closed); phase B added the
config seams, the S3 store with per-faculty source tagging, and a container
verified under `docker run --read-only --tmpfs /tmp`. **Phase C is done and
the app is LIVE at <https://d2n2meq17rr1oi.cloudfront.net>** —
CloudFront serving an S3 frontend, with `/api/*` routed to API Gateway →
Lambda, one origin so there is no CORS. Structured JSON logging feeds
CloudWatch (`aws/MONITORING.md` has the queries). **The deployed shape
differs from the spec in one important way**: step 11.6.2 called for a
Lambda Function URL, but this account refuses Function URL invocation by
anything except an IAM principal — public and CloudFront-OAC both return
403 with textbook-correct policies — so API Gateway fronts the Lambda
instead. See step.md's step 11 row for the full account, learn.md for the
reasoning.

## Stack

Decided and justified in plan §7 and §15 — these are settled decisions, not
defaults to revisit casually.

| Layer | Choice | Notes |
|---|---|---|
| Backend | Python + FastAPI, `uvicorn`, `python-multipart` | Stateless (genuinely, since 11.0.1). The laptop is still the supported path; step 11 phase B added a container that also runs on AWS Lambda, unchanged, behind the Lambda Web Adapter. |
| Image processing | `opencv-python-headless` | Table detection, deskew, cell splitting. Headless substituted for `opencv-python` — no GUI display code (`imshow`) is used anywhere in the pipeline, only file writes, and headless avoids pulling in system Qt/GTK libs on a server. |
| **Recognition (default)** | local digit CNN, `onnxruntime` + `scipy` | `RECOGNIZER=cnn`, the default since step 3r.6e — ID, serial and marks all read on-device. No key, no quota, no network. |
| Local ID OCR (`remote` path) | `pytesseract`, `--psm 10`, digit whitelist | Keeps the student ID off the network |
| Serial + marks (`remote` path) | `google-genai` (`from google import genai`) | **Not** `google-generativeai` — that SDK is retired |
| Validation | `pydantic` | Also supplies the Gemini `response_schema` |
| Frontend | React + TypeScript, Vite, `vite-plugin-pwa` | Camera via `getUserMedia` |
| Session state | `idb` (IndexedDB) | Survives crash/refresh mid-scan |
| Excel export | `exceljs`, client-side | Chosen over SheetJS — see plan §15 |
| Database | none | |
| Tests | `pytest` (backend), `vitest` (frontend) | |

Local toolchain: Python 3.10.12, Node 20.20.2, npm 10.8.2. Nothing is pinned
yet — `requirements.txt` gets written at step 0.2.

**Tesseract only matters on the `remote` path now** (step 3r.6e made the CNN
the default, and it uses neither Tesseract nor Gemini). The note below still
applies whenever you run `RECOGNIZER=remote` or `=both`.

**Tesseract is not installed on this machine.** The pip package is a wrapper
only; install the binary separately (`apt install tesseract-ocr`) before step
2. If OCR 500s from the app but works in your shell, set
`pytesseract.pytesseract.tesseract_cmd` explicitly — that is the usual cause.

## Layout

Created starting step 0.1. Backend through step 3's rate-limited fallback
plus steps 2r.0/2r/3r's full local CNN path, and frontend through step 9's
Results screen and Excel export (code done, a real full-class export/
reconcile still pending), all exist. Step 10 doesn't yet. **Step 11's
phases A and B do** — `app/config.py`, `app/stores.py`, the `Dockerfile`,
and per-faculty source tagging through `db.ts`'s `getSourceId()`; phase C
(the AWS deploy itself) does not. The CNN
track (steps 2r.0/2r/3r/3r.6,
plan.md §16) — **no longer optional, it is the default path since
3r.6e**: `app/recognizers/` (2r.0's interface, 3r's `local.py`
wiring, 3r.6's `both.py` comparison mode), `backend/cnn/`'s trained model
plus segmentation/decoding (2r, 3r) are all done, and `RECOGNIZER` selects
between `cnn` (default), `remote` and `both`. Step 3r.6's harvesting pipeline (`app/harvest.py`,
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
├── local-stack.sh               # step 11 — the DEPLOYED shape, locally: container on a
│                                # read-only FS + MinIO standing in for S3
├── deploy.sh                    # step 11.6 — idempotent AWS deploy (ECR/Lambda/S3)
├── preflight.sh                 # step 11.6 — pre-deploy checks; creates NOTHING,
│                                # exits with the blocker count
├── aws/deploy-policy.json       # least-privilege IAM policy for the deploy user,
│                                # derived from deploy.sh's actual API calls.
│                                # aws/README.md explains each grant
├── fetch-crops.sh               # pulls crops (disk/MinIO/S3) into training_data/all/
│                                # and reports source/tag/class balance
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
│   │                           # (debug_uploads/ lived here until step 11.0.1
│   │                           # deleted it — see "The backend is stateless")
│   ├── training_data/all/      # gitignored — fetch-crops.sh's merged training set
│   ├── training_data/harvested/ # gitignored — step 3r.6c's labelled crops. RESET
│   │                           # 2026-08-31: 229 crops, one source, 211 confirmed /
│   │                           # 18 corrected. Keys are content-addressed (dedupe).
│   │                           # Every crop carries a constant mtime (11.0.2)
│   ├── Dockerfile              # step 11.3 — slim base + Lambda Web Adapter, no apt layer
│   ├── .dockerignore           # keeps venv/ (1.5G) and cnn/data/ (2.2G) out of the build context
│   ├── .env.example            # copy to .env, fill in GEMINI_API_KEY; step 11.1's seams documented too
│   ├── app/
│   │   ├── config.py           # step 11.1 — THE only place under app/ that reads the environment
│   │   ├── observability.py    # structured JSON logs for CloudWatch; scrubs IDs by design
│   │   ├── ratelimit.py        # step 11.4 — per-IP sliding window + client-IP extraction
│   │   ├── stores.py           # step 11.2 — LocalStore / S3Store behind one put(key, src)
│   │   ├── cells.py            # issues.md N18 — read_cell(): the ONE guarded reader for
│   │   │                       # detection's crop files. cv2.imread returns None rather
│   │   │                       # than raising, and five call sites did .shape on it
│   │   ├── models.py           # step 4 — ScanResult, QuestionMark, QuizConfig; HarvestFields (3r.6c).
│   │   │                       # Bounds + q-order + totalMax rules (N2/#10/#14); the bounds
│   │   │                       # are pinned against validateConfig.ts by tests/test_models.py
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
│   │   ├── test_config.py      # step 11.1 — asserts an unset env IS the laptop app
│   │   ├── test_stores.py      # step 11.2 — key construction; boto3 stubbed, never real AWS
│   │   ├── test_ratelimit.py   # step 11.4 — limiter maths + 413/429 behaviour incl. CORS-on-429
│   │   ├── test_observability.py # asserts a real scan's logs contain no student ID
│   │   ├── test_harvest.py     #   step 3r.6c — harvest() unit tests
│   │   └── test_harvest_endpoint.py #  step 3r.6c — /api/harvest against a real photo
│   ├── requirements.txt        # includes python-docx (step 0's template fix, step 3r.6a's generator)
│   ├── requirements-deploy.txt # step 11.2 — boto3, container only. NOT provided by a custom
│   │                           # Lambda image the way it is by the managed runtime
│   ├── requirements-cnn.txt    # step 2r — torch/torchvision/onnx: TRAINING only.
│   │                           # onnxruntime/scipy moved to requirements.txt when the
│   │                           # CNN became the default (3r.6e) — inference needs them
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
        │                       # clears records+config; getSourceId() (11.2.5) lives in a
        │                       # separate `meta` store (DB v2) that resetAll deliberately spares
        ├── api.ts              # POST /api/scan client (step 6.4); harvestScan,
        │                       # POST /api/harvest client (step 3r.6c)
        ├── validateConfig.ts   # pure form-validation logic, unit-tested
        ├── validateMarks.ts    # sum check, legal-value check, serial normalisation,
        │                       # identity cross-check (plan.md §10) — step 7
        ├── results.ts          # step 9.1/9.2 — sort by serial then ID, unverified-record rule
        ├── scanQueue.ts        # upload-queue reducer — step 6.3
        ├── Setup.tsx           # step 5.3–5.4; saved-session notice + View +
        │                       # Reset everything (2026-08-31)
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

# Backend tests — offline, Gemini always mocked, never any AWS (148 tests
# as of observability, 2026-08-31)
cd backend && source venv/bin/activate && pytest

# CNN accuracy harnesses (steps 2r/3r, plan.md §16). These need NO extra
# install as of step 3r.6e — onnxruntime/scipy are in requirements.txt now
# that the CNN is the default path, and digit_cnn.onnx is committed.
cd backend && source venv/bin/activate
python cnn/accuracy.py                                                # ID accuracy + confidently-wrong count — 91.8% per-digit,
                                                                       # 55.2% whole-ID, 1 confidently wrong (2026-08-30),
                                                                       # vs id_ocr_accuracy.py's 58.9% / 0.0% whole-ID
python cnn/accuracy.py --calibrate                                    # dump confidence/margin per real digit, to pick floors —
                                                                       # last recalibrated 2026-08-30 (0.9/0.8 -> 0.75/0.6) against
                                                                       # the real_class_* batch's ~20 writers, see step.md step 2r
python cnn/marks_accuracy.py                                          # step 3r.5 — 98.1% per-question (half marks 100%),
                                                                       # total 89.5%, serial 63.2% (the weak spot); reads
                                                                       # testset/quiz_configs.json per photo when a label has a "quiz" key

# RETRAINING only — torch/torchvision/onnx are training-only deps, kept out
# of requirements.txt on purpose. CPU-only wheels (no GPU on this machine).
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-cnn.txt
python cnn/inspect_preprocess.py ../testset/debug/*/cells/id_d*.png   # look at the 28x28 outputs directly before training anything
python cnn/train.py --epochs 8 --out cnn/checkpoints                  # EMNIST Digits, ~8-10 min/epoch on CPU

# Run the app against a NON-default recognizer. Plain `uvicorn`/`./dev.sh`
# already gives the CNN (step 3r.6e). "remote" needs GEMINI_API_KEY and the
# Tesseract binary; "both" costs real Gemini quota, logs every disagreement
# to comparison_log/comparisons.jsonl, and is only meant for an actual
# comparison run, not everyday use. RECOGNIZER also works from backend/.env.
RECOGNIZER=remote uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
RECOGNIZER=both uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Step 11.6 — check before deploying. Creates nothing; exit code is the
# number of blockers. Run it under the deploy profile, not your default:
# it is the NEW user's permissions that matter.
AWS_PROFILE=marks-scanner ./preflight.sh
AWS_PROFILE=marks-scanner ./deploy.sh backend

# Step 11.3 — the deployable container. --read-only --tmpfs /tmp reproduces
# Lambda's filesystem on this laptop, which is the whole point: it catches a
# missed write path in a second instead of through CloudWatch after a deploy.
cd backend && docker build -t marks-backend .
docker run --rm -p 9000:8000 --read-only --tmpfs /tmp -e HARVEST_ENABLED=false marks-backend
curl -X POST http://localhost:9000/api/scan -F image=@../testset/images/filled_file.jpeg \
  -F 'config={"quizName":"d","idDigits":7,"totalMax":25,"questions":[{"q":1,"max":5},{"q":2,"max":5},{"q":3,"max":5},{"q":4,"max":5},{"q":5,"max":5}]}'

# Step 3r.6a — blank handwriting-sample sheet (not the marks-grid template).
# Print, get real people to fill it in, photograph it — none of that is scriptable.
python generate_collection_sheet.py --out ../collection_sheet.docx

# Redeploy after a change. Idempotent; the container is the artifact, so a
# backend edit does nothing until `backend` rebuilds and pushes the image.
export AWS_PROFILE=marks-scanner
./deploy.sh backend      # backend/ changed
./deploy.sh frontend     # frontend/ changed (builds, syncs S3, invalidates CDN)
./deploy.sh all          # both + the distribution

# Pull harvested crops into ONE training set, from whichever of the three
# places they landed. Prints source/tag/class balance — look at that before
# fine-tuning: half marks are currently ~9x rarer than whole ones, and the
# harvest_real_photos.py batch is all tagged "confirmed" regardless of what
# the model would have read (it posts original == confirmed).
./fetch-crops.sh merge                 # local disk only
./fetch-crops.sh local                 # + local-stack.sh's MinIO
AWS_PROFILE=marks-scanner \
  ./fetch-crops.sh s3 marks-scanner-crops-105322541848   # + the live bucket

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

# Backend — needs an HTTPS cert (below) generated first. No GEMINI_API_KEY
# needed on the default CNN path; copy .env.example and fill it in only if
# you intend to run RECOGNIZER=remote/both.
cd backend && source venv/bin/activate
python gen_dev_cert.py   # only when certs/ is missing or the LAN IP changed
uvicorn app.main:app --reload --host 0.0.0.0 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Frontend — HTTPS and LAN binding are on by default via vite.config.ts,
# no --host flag needed
cd frontend && npm run dev
cd frontend && npx vitest run   # 79 tests as of Setup's saved-session notice, 2026-08-31
                                # (use `npm run build` to typecheck — see the tsc caveat below); or `npx vitest` for watch mode
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

> **Every invariant the 2026-08-31 audit found broken is now fixed**, each
> with a regression test written as the failure rather than the
> implementation. Worth keeping the reason they broke: the privacy
> invariants held throughout because they are enforced by `assert`
> statements and tests written as attacks, while the four that broke were
> enforced by prose.
>
> Two enforcement seams added in the pair pass, both load-bearing:
>
> - **`QuizConfig`'s bounds exist twice**, in `app/models.py` and
>   `frontend/src/validateConfig.ts`. `tests/test_models.py` **reads the
>   TypeScript file** and fails if either side moves alone. Change one,
>   change the other.
> - **A serial is validated on both sides** — `marks.validate_serial` and
>   `validateMarks.isValidSerial`, same rule. It was the one identity field
>   nothing checked anywhere.
>
> Still open and backend-side, all Low except one Medium: see issues.md's
> "At a glance". Nothing High remains on the default path.

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
they identify nobody without the instructor's attendance sheet. **On the
default `cnn` path nothing at all leaves the machine**, which makes this
invariant trivially true — but it still governs, because `remote`/`both`
remain supported and the assertion protects them.

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
request data between calls. This used to be false in two places, and both
are now resolved. `main.py`'s TEMPORARY `debug_uploads/` block, which wrote
every upload to disk, was deleted in step 11.0.1 (2026-08-30) along with
the 605 real scripts / 99 MB it had accumulated — verified by running a
real scan and confirming nothing lands under `backend/` at all. Step
3r.6c's harvester still persists labelled cell crops, which is wanted, but
step 11.2 moved that behind a `Store` seam: `HARVEST_BACKEND=s3` writes to
object storage and touches no filesystem, `HARVEST_ENABLED=false` disables
it entirely, and `local` remains the laptop default. Confirmed by running
the container under `--read-only`: the local backend raises `OSError:
[Errno 30] Read-only file system`, the S3 backend does not.

**Harvested crops are written in a random order, on purpose.**
`harvest.py`'s `_write_unordered` shuffles before writing. This is not
tidiness and not an optimisation target: crops are collected in ID order,
so any store that records *arrival time* re-sorts them back into that
order. `CONSTANT_MTIME` handles that on a local disk, but **cannot on S3**,
where `LastModified` is stamped server-side at millisecond precision —
measured against a real S3 API, sorting one harvest's ID crops by
LastModified reproduced the student ID digit for digit. Guarded by
`test_harvest.py::test_write_order_does_not_reconstruct_a_student_id`.

**Harvested crops carry a constant mtime, on purpose.** `harvest.py`'s
`CONSTANT_MTIME` / `os.utime` is not cosmetic and not a bug: the per-crop
`uuid4` was meant to make one student's ID digits unlinkable, but they are
written in loop order, so sorting by mtime put them straight back in order
(2 of the 18 real class IDs were recoverable verbatim this way before the
fix). `tests/test_harvest.py::test_mtime_ordering_cannot_reconstruct_a_student_id`
guards it as the attack, not the implementation. Don't "clean it up".

**A Gemini failure tries a local OCR fallback before giving up.** This is
a `remote`-path rule — it lives inside `RemoteRecognizer` and does not run
on the default `cnn` path, which has no API call that can fail this way.
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
  explicitly deferred (plan §12, §13). Still true on the `cnn` default: the
  photo leaves the *phone* for the laptop either way. What the default did
  change is that nothing leaves the **laptop** — so "no third party ever
  sees a script" is now accurate, while "never leaves the device" is not.
- **Don't replace the content hash in a harvested crop's key with a
  uuid.** `harvest.py`'s `_key` hashes the crop's own bytes so a re-harvest
  overwrites instead of duplicating. This is not a micro-optimisation: the
  first corpus had to be thrown away because a testing session
  re-photographed two scripts dozens of times and every Confirm harvested
  again, leaving a digit histogram that described one student ID rather
  than handwriting. Dedupe must stay keyed on **content, never on the
  label** — two students' `7`s must both survive, or the corpus loses the
  variation it exists to capture.
- **Don't harvest test data into the real namespace.** Sources prefixed
  `test-` (`harvest.py`'s `TEST_SOURCE_PREFIX`) are dropped by
  `fetch-crops.sh` unless `INCLUDE_TEST=1`. Verification crops previously
  shared a namespace with real ones and could not be separated afterwards.
- **Don't commit a real session's output.** `.gitignore` covers `*.xlsx`
  and `collection_sheet*.docx` as of 2026-08-31 — added *before* the pilot
  runs, because afterwards the fix stops being a `.gitignore` edit and
  becomes a history rewrite. An exported workbook is every student's ID,
  serial and marks in one file, and the Results screen explicitly tells the
  instructor to check it against their attendance sheet, which is exactly
  how it ends up sitting in this tree. Note the committed `testset/`
  photos are **not** an instance of this: their IDs, serials and marks are
  fabricated (real handwriting, made-up values), which is why they can live
  in git at all. If a genuinely-real batch is ever added, it belongs
  outside git with the crops. (issues.md N26.)
- **Don't loosen the deploy policy to make a check pass.** `preflight.sh`
  once probed `iam:ListRoles` — account-wide, deliberately absent from
  `aws/deploy-policy.json`, and never called by `deploy.sh` — and reported
  a blocker on a correct policy. Fix the probe, not the policy. Probes must
  also treat `NoSuchEntity`/`NotFound` as a PASS: before a first deploy
  nothing exists, and "authorised but absent" is not "denied".
- **Don't tag harvested crops per scan.** Multi-writer collection needs a
  source tag (step 11.2.4) so plan.md §16's held-out-writer evaluation is
  possible at all — but it must be **per-faculty**, random, and
  client-generated. A per-scan or per-student id would regroup one
  student's seven ID digits and undo the unlinkability step 11.0.2 exists
  to create. Coarse enough to isolate nobody, fine enough to hold out one
  writer. **Built in 11.2.5** as `db.ts`'s `getSourceId()`. It lives in the
  `meta` store, *not* beside the quiz config, because `resetAll()` clears
  that store — a tag regenerated on every "Reset everything" would split
  one writer across unrelated prefixes and defeat its own purpose. Don't
  move it there, and don't add it to `resetAll()`.
- **Don't verify the frontend with a bare `npx tsc --noEmit`.** The root
  `tsconfig.json` is a solution file (`"files": []` plus references), so
  that command typechecks *nothing* and passes on genuinely broken code.
  Use `npm run build` (which runs `tsc -b`) or `tsc -p tsconfig.app.json`.
- **Don't state that everything stays on the device.** `Setup.tsx` said
  exactly that from step 5 until 11.5 corrected it, while `/api/harvest`
  had been saving labelled cell crops server-side since 3r.6c. The true
  statement has two halves and both must stay: the *photograph* is never
  stored, and *individual cells* are kept with their confirmed values to
  train and tune recognition. `Setup.test.tsx` pins the always-visible
  line and asserts it is NOT inside the collapsible `<details>` — a
  returning instructor has that section collapsed and would otherwise
  never see it.
- **Don't assume a stubbed dependency exists at runtime.** `test_stores.py`
  stubs `boto3` (correctly — its subject is key construction), and every
  test passed while the built image had no boto3 in it at all. AWS docs say
  the Lambda runtime provides it; that's the *managed* runtime, not a
  custom container on a slim base. It's in `requirements-deploy.txt` now.
  The general rule: a stub proves the call is right, never that the library
  will be there.
- **Don't assume anything outside `/tmp` is writable once deployed.** The
  step-11 target is AWS Lambda, whose filesystem is read-only everywhere
  else. Both former offenders are handled — 11.0.1 deleted
  `debug_uploads/`, and 11.2 put harvesting behind a Store — but the
  *default* is still `local`, so a deployment MUST set `HARVEST_BACKEND=s3`
  or `HARVEST_ENABLED=false`. Don't guess whether a new write path is safe:
  `docker run --read-only --tmpfs /tmp` answers it in a second. The
  `TemporaryDirectory` in the scan handler is fine — it lands in `/tmp`.
- **Don't size the hosted demo against the AWS credits.** They expire
  (18 Aug 2027) and a Free-plan account closes even sooner (~18 Feb 2027,
  6 months from issue — the credits' expiry date is not the account's
  lifetime). The design targets AWS's *always-free* tiers instead, which
  are permanent: Lambda's 1M requests + 400,000 GB-s and CloudFront's 1 TB
  egress per month. Credits are the safety net, not the funding.
- **Don't count CORS preflights against the rate limit.** Browsers send
  them automatically and they cost nothing to answer; throttling them
  turns a generous budget into a tight one for no benefit. And a 429 must
  still carry CORS headers, or the browser reports an opaque failure
  instead of the real status — that depends on `CORSMiddleware` wrapping
  the `guard` middleware, which is an ordering property of how they're
  registered in `main.py` and is pinned by a test.
- **Don't reintroduce a Lambda Function URL on this account.** step.md
  11.6.2 argued for one over API Gateway, and it was right in the abstract
  — but this account refuses Function URL invocation by any non-IAM
  principal. Proven three ways: `AuthType NONE` with a correct public
  resource policy → 403; CloudFront's service principal with a correct OAC
  grant (verified principal, action, `FunctionUrlAuthType` and a matching
  `SourceArn`) → 403; a directly IAM-signed request → 200. Hours went into
  proving a correct configuration was correct. API Gateway is what works.
- **Don't add `CustomErrorResponses` to the distribution.** The usual SPA
  fallback (403 → `/index.html`, 200) applies **distribution-wide**, not
  per behaviour, so it silently rewrites API errors into an HTML page with
  a 200 status — a failed scan looks like a success returning gibberish.
  This app has no client-side routing and needs no fallback.
- **Don't let `/api/*` become cacheable.** It is pinned to the AWS-managed
  `CachingDisabled` policy. A cached scan response would serve one
  student's marks for another's script — the worst failure this app has.
  Verify with two different photos after any distribution change.
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
progress on collecting from multiple writers.

**The CNN is no longer a deferred option at all — it is the default
recognizer** (3r.6e, 2026-08-30), decided on the batch numbers above rather
than on the comparison run this step originally required. That run still
hasn't happened. Still not done: fine-tuning on the harvested data, and a
real full quiz session with `RECOGNIZER=both` — which is now *more*
valuable, not less, since it is the only thing that would validate the
default on marks and serial rather than on the ID alone.

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
