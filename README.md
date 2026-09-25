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

Two of those bounds have since been picked up deliberately. Hosting was
added as an optional demo (step 11 — the app is live, and the laptop
workflow is still the supported path), and **"one quiz session" is now
one semester**: step 13 / plan.md §18 replaces the single-session store
with sections and assessments, so a faculty member teaching several
sections can grade all of them without one destroying another. **All
four phases are built (2026-09-10)** — a second quiz genuinely no longer
overwrites the first, a section's class list is attached once and reused
by every quiz in it with staleness made visible (a provenance line +
Re-pick) rather than assumed away, scanning into the wrong section is
guarded three ways (a persistent context header, a confirmation before
resuming an assessment last touched before today, and duplicate
detection scoped to the assessment), and a semester ends with a real,
scoped purge — offered only when a new semester's first section is
created, blocked outright while any assessment hasn't been exported, and
comparing semester labels by exact string so drift never gets silently
folded into one purge decision. A server-side database and multi-user
auth stay deliberately out.

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
as a single Excel file — or, optionally (step 12), writes them as a new
sheet into the instructor's own class-list workbook instead, matched
against by student ID. See "Deliberately not built" below for what that
adds and what's still ahead of it.

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
Tesseract measured at 58.9% per-digit ID accuracy on the real photos
that existed then (44.5% once the test set grew to 29 — see below). It
became the default on 2026-08-30. Measured on the 18-photo real-class
batch (~20 different writers):

| Field | CNN | Previous path |
|---|---|---|
| ID, per-digit | **91.8%** (167/182) | Tesseract **44.5%** (81/182) |
| ID, whole-ID exact match | **55.2%** (16/29) | Tesseract 0.0% (0/29) |
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

In broad strokes, as of 2026-09-10:

- **Working end to end.** Library → section/assessment setup → camera
  capture → upload queue → review → save → results → Excel export all
  run, against both recognizer paths. Backend: **259 pytest tests
  passing**. Frontend: **383 vitest tests passing**. Passing suites are
  not the same as a defect-free app — see the known-issues bullet below.
- **Verified against real photos.** 30 test images including an 18-photo
  batch from an actual class, which exposed and got fixes for two real
  detection bugs (a neighbouring script's ID row, visible at the frame
  edge, could be silently misattributed to the current student).
- **The local CNN is the default recognizer** as of 2026-08-30 (step
  3r.6e) — the app runs with no API key, no quota and no network. See
  "Two recognition paths" above for the numbers it was decided on and the
  two caveats carried with it.
- **The hosted demo (step 11) is DEPLOYED and live** at
  <https://d2n2meq17rr1oi.cloudfront.net> — CloudFront serving an S3
  frontend with `/api/*` routed to API Gateway → Lambda, same origin so no
  CORS. Structured JSON logging feeds CloudWatch. The two privacy defects
  it uncovered are fixed, and the whole thing is still verifiable offline
  through `./local-stack.sh`. What remains is 11.7: using it as a user, on
  a phone, on mobile data.
- **Monitoring (step 11.8) is DEPLOYED** — a CloudWatch dashboard carrying
  frontend hits, backend hits and Lambda health on one page, plus X-Ray
  tracing giving a real Lambda→S3 request-flow graph. Both are private to
  the AWS console; no public URL and no new auth. See
  [Monitoring](#monitoring-hit-counts-and-the-request-flow-graph) for what
  each shows and why the two hit counts deliberately don't match.
- **An optional class-list workbook round trip (step 12) is DONE, all four
  phases** — the instructor's own semester marksheet, uploaded once,
  matched against by student ID, written back into as a new sheet per
  quiz, with the class list and every prior sheet left untouched. Reverses
  a decision this project made deliberately for the pilot ("no file
  uploads"), on the grounds that the roster already exists as a file the
  instructor keeps all semester. Reading the roster in, writing the sheet
  back out, roster-aware scanning ("Scanned 7 of 16," a matched name or a
  tap-to-accept single-candidate suggestion next to a misread ID, never
  applied automatically), and reconciliation (a pre-export coverage
  summary, an outright block on two scripts matching one student, an
  opt-in totals column, and a roster that survives a mid-session refresh)
  are all built and verified against a real 16-student marksheet — one
  real bug (a totals column that would have silently landed next to the
  wrong name the moment a roster had a gap) was caught and fixed before
  shipping, not left latent. See [plan.md §17](plan.md) and step.md's step
  12. What's left is real-phone verification of the file picker and
  download, which needs the user's own participation.
- **Multi-course, multi-section persistence (step 13) — ALL FOUR PHASES
  DONE, 2026-09-10.** A faculty member teaching several sections (the
  real case: one CSE100, one CSE200, two CSE203) can now grade any of
  them, in any order, without one destroying another — `Setup.tsx` is
  retired outright, replaced by a `Library` screen (semester → course →
  sections → assessments) plus separate Section and Assessment forms. A
  class list is attached once per section rather than re-uploaded every
  quiz, and every workbook export shows which copy of the file it's
  writing into with a **Re-pick** option, re-caching what it just wrote
  so a later quiz in the same section builds on an earlier one's sheet
  instead of silently losing it — verified end to end by actually
  exporting two quizzes into one section and reloading the real
  downloaded bytes. Grading into the wrong section is guarded three ways:
  a persistent context header on every screen (including Review's own
  overlay, which otherwise hides it), a confirmation before resuming an
  assessment last touched before today, and duplicate detection scoped to
  the assessment so a shared serial between two courses no longer raises
  a false conflict. The plain download is now named
  `CSE203-2_Quiz-1_2026-09-09.xlsx`. And a semester ends with a real,
  scoped purge — offered only when a section is created under a
  genuinely new semester label (never a timer, never automatic), blocked
  outright while any assessment in that semester hasn't been exported
  yet (named individually), and comparing semester labels by exact
  string rather than normalizing them, so a typo'd variant like
  "fall 2026" shows up as its own separate purge candidate instead of
  being silently folded into "Fall 2026." The old full "Reset everything"
  wipe is untouched, staying as the blunt escape hatch alongside the new
  scoped purge. **A same-day follow-up (13.22)** turned the semester
  field into a Spring/Summer/Autumn-plus-year picker instead of free
  text — closing the label-drift risk above for all new data — and
  confirmed the app opens on the library. **13.23** added a per-section
  **Delete section** button, for removing one mis-created section without
  purging a whole semester or wiping the device — reusing the same
  cascade delete and block-then-confirm shape the semester purge already
  had. **13.24** added the matching **Delete quiz** button for one
  wrongly-added assessment, and made both delete flows require *typing*
  the section or quiz name back before the confirm button even enables —
  building it surfaced a real gap (issues.md N36) where the delete guard
  would have made a section with even one brand-new assessment permanently
  undeletable, fixed the same day. See [plan.md §18](plan.md) and step.md's
  step 13.
- **A landing page (step 14) is specced and Phase A is built, 2026-09-10.**
  The link used to open straight into "Your sections", a screen that
  assumes the reader already knows why they'd want a section — this adds
  the story before the tool, dark and mobile-first (Raycast's structure,
  not its palette), pre-rendered at build time rather than server-rendered
  once Phase B lands, specifically so it stays fast on a flaky connection
  without putting a Lambda cold start in front of the first paint. **Phase
  A** (the seven-section page, its own scoped dark tokens, and first-visit
  entry/exit via a `localStorage` flag — never shown again once dismissed,
  with a way back from Library's "How this works") is done and
  client-rendered. **Phases B (static-first delivery: zero runtime JS,
  prerendered HTML) and C (the animated scan) are not built yet** — the
  current build is intentionally heavier than the eventual budget, since
  Phase A still ships the page as an ordinary screen in the bundle. See
  [plan.md §19](plan.md) and step.md's step 14.
- **Not finished.** Step 10 (full rehearsal) hasn't started. The test set
  is still short of its own target for awkward conditions. The CNN track's
  remaining work — fine-tuning on harvested handwriting, and a real
  full-quiz `RECOGNIZER=both` comparison — needs real classroom
  participation and can't be simulated. That comparison run matters more
  now that the CNN is the default, not less: it is the only thing that
  would validate the choice on marks and serial rather than on the ID.
- **Known issues are tracked**, not silently carried:
  [issues.md](issues.md) is the open-defect register. 51 findings across two
  audits, plus the first live grading session, one deploy-time find, and
  two found while building later features (N35, N36);
  **46 fixed**, including both HIGH ones from the desk audits and, as of
  2026-09-09, both HIGH ones the live session found too (**N31**:
  harvesting mislabelled a crop when the instructor worked around an
  out-of-range mark; **N32**: a confident serial digit was discarded
  along with an uncertain sibling — 11 of 17 real serials survived where
  14 of 17 were correct at raw argmax). **N35** (2026-09-10): a mark
  written with a leading zero ("03", "05") could never decode on the
  default `cnn` path — the decoder only ever scored a legal value's
  un-padded digit rendering, so no candidate at any length could match.
  **N36** (2026-09-10): the section/semester delete guards blocked on
  "not yet exported" alone, which would have made a section holding even
  one brand-new, wrongly-added assessment permanently undeletable — found
  and fixed while building the per-assessment delete feature that would
  have shipped broken by it. **5 remain open** — four Low
  deploy/infra items, plus one Medium (N34, live detection failures can't
  be debugged) left open **by explicit choice**: asked to pick a fix
  direction, the answer was to defer it rather than build any of the
  options. Backend and frontend suites went 148/79 →
  **259/383**, and both passed before the audits too, which is why a full
  read-through found 46 things they did not.
- **No whole script is stored anywhere.** A scan is processed in a
  per-request temp directory and discarded. The one exception used to be
  `backend/debug_uploads/`, a temporary step-6 phone-debugging capture that
  wrote every upload to disk; it was deleted in step 11.0.1 along with the
  605 real scripts it had accumulated. What still persists by design is
  individual labelled cell crops (step 3r.6c's harvester) — one digit each,
  with no name, no ID, and no key linking one student's crops together.
  Crops are also written in a **random order**, because collection order is
  ID order and any store that records arrival time re-sorts them back into
  it — see Invariants.

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
├── local-stack.sh           # Runs the DEPLOYED shape locally: container on a
│                            # read-only FS + MinIO standing in for S3
├── deploy.sh                # Step 11 AWS deploy (ECR/Lambda/S3) — idempotent
├── preflight.sh             # Pre-deploy checks — creates nothing, exits with
│                            # the number of blockers
├── aws/                     # Least-privilege IAM policy for the deploy user
│                            # (deploy-policy.json) + MONITORING.md, the
│                            # CloudWatch queries, the dashboard and the
│                            # X-Ray trace map for a live session
├── fetch-crops.sh           # Pulls harvested crops (disk/MinIO/S3) into one
│                            # training set and reports its class balance;
│                            # `review`/`promote` for the hosted site's
│                            # unverified/ crops
│
├── backend/
│   ├── app/
│   │   ├── main.py          # POST /api/scan and POST /api/harvest; resolves the recognizer at startup;
│   │   │                    # the X-Ray `trace` middleware (outermost, so a guard rejection still traces)
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
│   ├── tests/               # 259 pytest tests; Gemini always mocked from fixtures/, never live
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
│       ├── App.tsx          # Screen enum (step 13) — Library -> Section/Assessment forms
│       │                    # -> Scan -> Results; no router
│       ├── Library.tsx      # Step 13 — entry point: semester -> course -> sections ->
│       │                    # assessments; also "How this works" + "Reset everything"
│       ├── SectionForm.tsx  # Step 13 — course/label/ID digits, plus the optional
│       │                    # class-list workbook upload (a section-level property now);
│       │                    # semester is a Spring/Summer/Autumn + year picker (13.22)
│       ├── AssessmentForm.tsx # Step 13 — one quiz's name/question count/maxes
│       ├── sections.ts      # Step 13 — pure grouping/sorting/labelling, no IndexedDB;
│       │                    # 13.22 — the semester picker's format/parse helpers
│       ├── Scan.tsx         # Camera, framing guide, upload queue; hosts Review as an overlay
│       ├── Review.tsx       # Confirm/edit screen — identity fields first and largest
│       ├── Results.tsx      # Results table, inline editing, Excel export
│       ├── api.ts           # scanImage() and harvestScan() clients
│       ├── db.ts            # IndexedDB store (idb) — sections/assessments/records + resetAll()
│       ├── scanQueue.ts     # Upload-queue reducer + nextToReview()
│       ├── validateConfig.ts · validateMarks.ts · results.ts   # Pure, unit-tested logic
│       ├── roster.ts        # Step 12 — class-list parsing: header matching, the
│       │                    # exclude-then-prefer-then-confirm class-list identification
│       │                    # rule, ID normalization for comparison (IDs written back verbatim)
│       ├── examSheet.ts     # Step 12 — pure exam-sheet row matching against the roster
│       ├── workbookExport.ts # Step 12 — sheet-name sanitisation pinned to ExcelJS's own
│       │                    # thrown rules, collision detection, the actual sheet writer
│       ├── rosterMatch.ts   # Step 12 — live "is this ID on the list" matching, plus a
│       │                    # single-candidate suggestion offered only when it's unique
│       ├── types.ts         # Mirrors backend/app/models.py; Section/Assessment (step 13)
│       ├── Landing.tsx      # Step 14 (Phase A) — the landing page: seven sections,
│       │                    # purely presentational, no hooks (renderToStaticMarkup-ready)
│       ├── ScanGraphic.tsx  # Step 14 — the hero/how-it-works visual; a static
│       │                    # illustration for now, built so Phase C can animate it
│       ├── landing.css      # Step 14 — the landing page's own dark palette, scoped
│       │                    # under `.landing` only, never leaking into :root
│       ├── landing.ts       # Step 14 — hasSeenLanding/markLandingSeen, a single
│       │                    # localStorage key (sync, unlike the IndexedDB meta store)
│       └── *.test.ts(x)     # 383 vitest tests
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
`certs/`, `debug/`, `comparison_log/`,
`backend/training_data/harvested/`, `backend/training_data/all/`,
`backend/training_data/unverified/`, the EMNIST download, and
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

**Prerequisites:** Python 3.10+ and Node 20+. Linux, macOS and Windows are
all supported. Where a command differs, the Windows form sits directly
beside it below.

**On Windows, which shell.** PowerShell runs `dev.ps1`, the Python
harnesses and npm. The four `.sh` scripts (`local-stack.sh`,
`fetch-crops.sh`, `preflight.sh`, `deploy.sh`) are bash and want **Git
Bash** — right-click the repo folder and pick *Git Bash Here*. They
resolve the venv layout themselves, so nothing inside them needs
adjusting. After installing any new tool, open a **new** terminal; an
existing one keeps the PATH it started with.

A Gemini API key and the Tesseract binary are needed **only** for
`RECOGNIZER=remote` — the default CNN path uses neither. For `remote`, get
a key into `backend/.env` and install Tesseract: `apt install tesseract-ocr`
on Linux, or the [UB Mannheim installer](https://github.com/UB-Mannheim/tesseract/wiki)
on Windows. The pip package is a wrapper only. On Windows the installer
does not add itself to PATH by default, so `app/id_ocr.py` looks in
`C:\Program Files\Tesseract-OCR` automatically; set `TESSERACT_CMD` in
`backend/.env` if it lives anywhere else.

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

```powershell
# Windows — a venv keeps its programs in Scripts\, not bin/
cd backend
py -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env      # only needed for RECOGNIZER=remote
python gen_dev_cert.py      # finds openssl inside Git for Windows automatically

cd ..\frontend
npm install
```

Every other `bash` block below works as written on Windows with one
substitution: `source venv/bin/activate` becomes
`.\venv\Scripts\Activate.ps1` in PowerShell, or `source venv/Scripts/activate`
in Git Bash. Everything after the activate line is identical.

**Optional tools.** None of these are needed for the default `cnn` path:

```bash
apt install docker.io awscli tesseract-ocr        # Linux
```

```powershell
winget install Docker.DockerDesktop       # local-stack.sh, deploy.sh backend
winget install Amazon.AWSCLI              # deploy.sh, fetch-crops.sh s3
winget install UB-Mannheim.TesseractOCR   # RECOGNIZER=remote only
```

**After installing any of these on Windows, restart your terminal — and
your editor, if the terminal lives inside one.** These installers add
themselves to the machine PATH, but a running process keeps the PATH it
started with and passes that stale copy to everything it spawns. The
symptom is `docker: command not found` in an editor's terminal while
`docker` works perfectly in a new window. The four `.sh` scripts work
around this themselves (`ensure_native_tools_on_path` in
`shell-portability.sh` looks where Windows actually installs Docker and
the AWS CLI), so they run either way — but anything you type by hand
needs the fresh terminal.

### Run both servers

```bash
./dev.sh          # Linux / macOS
```

```powershell
.\dev.ps1         # Windows
```

Starts the backend (HTTPS) and the Vite dev server together, generating
the backend cert first if it's missing. Ctrl+C stops both.

**By default both listen on this machine only** (issues.md N44). On campus
Wi-Fi "the network" is everyone on it, and grading happens on the deployed
site anyway. To test with the phone, start a LAN session explicitly:

```bash
./dev.sh --lan         # Linux / macOS
```

```powershell
.\dev.ps1 -Lan         # Windows
```

In a LAN session both servers accept connections from the whole network
until Ctrl+C, and harvested crops go to `backend/training_data/unverified/`
rather than the trusted `harvested/`, so testing never feeds the training
set; `./fetch-crops.sh promote <source-id>` if you want any of them.

The two scripts do the same job by different means, because process groups
are a POSIX idea: `dev.sh` broadcasts with `kill 0`, while `dev.ps1` relies
on the shared console, `taskkill /T`, and a Job object that catches even a
hard kill of the script. `dev.sh` does run under Git Bash on Windows, but
its cleanup is much less reliable there — prefer `dev.ps1`.

If a run is ever orphaned — the window closed without Ctrl+C, say — free
the ports with:

```bash
kill $(lsof -t -i:8000 -i:5173)                    # Linux / macOS
```

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8000,5173 |
  ForEach-Object { taskkill /PID $_.OwningProcess /T /F }
```

**Then open the frontend's HTTPS URL on the phone**, on the same network
(a `--lan` / `-Lan` session — without it the phone can't connect).
`dev.sh` and `dev.ps1` both print the LAN IP on startup. Visit the **API**
first and accept its certificate there:

```
https://<lan-ip>:8000/docs     accept the warning here FIRST
https://<lan-ip>:5173          then open the app
```

That order matters. Both servers use self-signed certificates, and while
the page itself prompts you, a blocked API request does not — scans just
fail silently. `getUserMedia` needs a *secure* context, not a *trusted*
one, so a self-signed cert is enough for the camera.

**On Windows, one extra step the phone will not work without.** Windows
blocks inbound connections by default, more so on a network marked
*Public*, which is what a home Wi-Fi usually is. Skipping this looks
exactly like the app being broken: the page simply never loads. Add two
rules once, from an **admin** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Marks Scanner backend (dev)" `
  -Direction Inbound -Protocol TCP -LocalPort 8000 `
  -RemoteAddress LocalSubnet -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "Marks Scanner frontend (dev)" `
  -Direction Inbound -Protocol TCP -LocalPort 5173 `
  -RemoteAddress LocalSubnet -Action Allow -Profile Any
```

By **port** rather than by program, so a Node or Python upgrade does not
silently break them, and scoped to `LocalSubnet` so only devices on the
same Wi-Fi can connect.

If the phone still cannot load the page, the cause is usually not this
laptop. Open `https://<lan-ip>:8000/docs` on the phone: a certificate
warning means the network is fine and something else is wrong; a timeout
means the phone is on mobile data, on a different SSID or band, or the
router has client isolation switched on — and that last one cannot be
worked around from the laptop at all.

To run the servers separately:

```bash
# Backend — HTTPS is required, not optional: an HTTPS page cannot fetch a
# plain-HTTP endpoint over the LAN (mixed content), and the phone reaches
# the backend by LAN IP, not localhost.
cd backend && source venv/bin/activate
# --host 0.0.0.0 makes it reachable by the phone — and by everyone else on
# the network (issues.md N44); use 127.0.0.1 when the phone isn't needed.
uvicorn app.main:app --reload --host 0.0.0.0 \
  --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Frontend — HTTPS is on via vite.config.ts; add MARKS_LAN=1 for the phone
cd frontend && npm run dev
```

The frontend derives the backend's address from whatever host served the
page, on port 8000. Override with `VITE_API_BASE` if the backend runs
somewhere else. CORS is a regex matching `localhost`, `127.0.0.1` and all
three private LAN ranges, so no address is hardcoded anywhere.

### Run it the way it deploys

`./dev.sh` runs the laptop workflow: source on disk, auto-reload, crops
harvested to a local directory. That is the right loop for building.

`./local-stack.sh` runs the **deployed shape** instead, entirely offline —
the real container image on a read-only filesystem with only `/tmp`
writable (exactly how AWS Lambda mounts it), harvesting over the S3 API to
a local MinIO, `ALLOWED_ORIGINS` set as it will be in production, rate
limiting on, and a production frontend *build* rather than the dev server.

**On Windows, run these from Git Bash**, not PowerShell — they are bash
scripts. They resolve the venv layout and convert host paths to the form
`docker.exe` and `aws.exe` expect, so nothing inside them needs changing.

```bash
./local-stack.sh up       # MinIO + backend container, then builds the frontend
cd frontend && npx vite preview --host --port 5173   # leave running

./local-stack.sh crops    # what has landed in the bucket
./local-stack.sh logs     # backend request log
./local-stack.sh down     # stop — collected crops SURVIVE in a named volume
./local-stack.sh reset    # stop and wipe the collected crops too
```

Two things that will otherwise waste your time:

- **Accept the certificate warning twice** on the phone — once for the page
  (`https://<lan-ip>:5173`) and once for the API (`https://<lan-ip>:8443`).
  Nothing prompts you for the second one; scans just fail. Visit the API
  URL directly in the phone browser first.
- **The container is a build artifact.** After changing backend code, run
  `docker build -t marks-backend backend/` before `./local-stack.sh up`, or
  you are testing the previous version.

This is what caught the S3 ordering leak described under Invariants — a
real S3 implementation stamping real timestamps, which no stubbed test
could have reproduced.

### Redeploying after a change

`deploy.sh` is idempotent, so redeploying is just running it again. Which
part you run depends on what you changed:

```bash
export AWS_PROFILE=marks-scanner

./deploy.sh backend     # backend/ changed: rebuild image, push, update Lambda
./deploy.sh frontend    # frontend/ changed: build, sync to S3, invalidate CDN
./deploy.sh all         # both, plus the CloudFront distribution (idempotent)
```

Four things worth knowing, because each has bitten at least once:

- **The container is the artifact.** A backend source change does nothing
  until the image is rebuilt and pushed — `./deploy.sh backend` does that,
  but running only `frontend` after a backend edit deploys nothing new.
- **`VITE_API_BASE` is inlined at build time.** The frontend deploy builds
  with it empty (same origin), so `/api/*` stays relative. Editing it after
  a build has no effect; you have to rebuild.
- **The API is never cached, the frontend is.** `deploy.sh frontend`
  invalidates `index.html`, `sw.js` and `registerSW.js` — the only files
  whose names don't change. Hashed assets need no invalidation because a
  new build produces new filenames.
- **It's a PWA, so a phone may hold the old version.** The service worker
  is uploaded with `no-cache`, but a phone that already has the app open
  can need a reload (or a close-and-reopen) before it picks up a new build.

After a backend deploy the first request pays a **~9 s cold start**. The
deploy ends with a smoke test that doubles as the warm-up, so the first
*human* request isn't the slow one.

### Getting the crops back, for fine-tuning

Harvested crops end up in one of three places depending on how the app ran
— the laptop's own disk, `local-stack.sh`'s MinIO, or a real S3 bucket once
deployed. The key layout is identical in all three on purpose, so they
merge into one training set and the training code never needs to know
where any given crop came from:

**On Windows, run these from Git Bash**, not PowerShell — they are bash
scripts. They resolve the venv layout and convert host paths to the form
`docker.exe` and `aws.exe` expect, so nothing inside them needs changing.

```bash
./fetch-crops.sh merge                 # local disk only
./fetch-crops.sh local                 # local disk + local-stack's MinIO
AWS_PROFILE=marks-scanner \
  ./fetch-crops.sh s3 marks-scanner-crops-105322541848   # + the live bucket
```

The deployed bucket is the one real classroom use fills. Each faculty
member's browser gets its own random source id, so a pull looks like:

```
pilot-real-class                            229   # the 18-photo batch
d6ca05c6-519d-4fe4-833b-184e3051a3b4         34   # one phone
30770caf-442c-4a04-87d0-87f673f17f98         28   # another
```

**Crops from the hosted site are held apart** (issues.md N40). Anyone
with the site's URL can post any image with any labels to `/api/harvest`,
so the deployed Lambda writes to the bucket's `unverified/` prefix, not
`harvested/`, and none of the commands above download it. To use them:

```bash
# 1. Download into backend/training_data/unverified/ — a separate,
#    gitignored folder that training never reads — with a per-source summary.
AWS_PROFILE=marks-scanner \
  ./fetch-crops.sh review marks-scanner-crops-105322541848

# 2. Open a source's folders and check each image matches the value in its
#    filename. Then copy that one source into the training set:
./fetch-crops.sh promote <source-id>
```

A source is one browser (one faculty member's phone or laptop), so a bad
one can be left out whole. Your own sessions on the hosted site land in
`unverified/` too, under your own source id; the laptop always writes
straight to its trusted `harvested/`. Crops harvested before 2026-09-25
are already in `harvested/` and stay there.

Everything that is promoted or merged lands in `backend/training_data/all/`
(gitignored), laid out as

```
<source-id>/<field>/<confirmed|corrected>/<value>_<uuid>.png
```

The label is the filename up to the first underscore — there is no
annotation file that can drift out of sync with the images. `<source-id>`
is per-faculty, which is the axis to hold out when measuring whether
fine-tuning generalises to an unseen writer (plan.md §16).

It also prints what it actually pulled, because two properties of this
dataset will quietly ruin a fine-tuning run if you don't look first:

```
by tag:      confirmed 689,  corrected 48
ID digits:   rarest 20, commonest 82   ! imbalanced (4.1x)
marks:       290 whole, 31 half        ! half marks are 9.4x rarer
```

Half marks being ~9x rarer matters most: they are exactly the values the
model finds hardest to tell apart from whole ones. And `corrected` crops
are the model's real failures, worth weighting above `confirmed` ones —
except that `harvest_real_photos.py` posts `original == confirmed`, so its
entire batch files as `confirmed` regardless of what the model would have
read. Valid labelled data; not a valid list of failures.

**Fine-tuning itself (step 3r.6b) is not built, and shouldn't be run yet.**
Three reasons, in order of how much they matter:

1. **There isn't enough data.** ~290 crops against EMNIST's 240,000.
   Fine-tuning on this would overfit or cause catastrophic forgetting, and
   would most likely make the model *worse* than the 91.8% per-digit it
   currently gets. Several real class sessions' worth is the realistic bar.
2. **Half marks are ~10x rarer than whole marks** — and they're exactly
   the values the model finds hardest. Training on this distribution
   teaches it that half marks barely exist. Step 3r.6a's blank collection
   sheet generator (`backend/generate_collection_sheet.py`) exists to fix
   this deliberately, and is still unused.
3. **The method is undecided.** Which head to fine-tune, how to hold out a
   source to measure generalisation honestly, and how to weight `corrected`
   above `confirmed` are open questions in plan.md §16. Guessing at them
   produces a model whose choices nobody vetted.

So the loop today is: **collect** (real sessions), **pull** (above), and
**look at the balance report** before deciding anything. The pull prints
the class balance for exactly that reason.

### Deploying

Check first — `./preflight.sh` creates nothing and validates everything
that could fail halfway through a deploy: tooling, AWS identity and
per-service permissions, whether the target names are free, that the image
builds for `linux/amd64` and carries the adapter, model, and `boto3` but
*not* `torch`, that a real scan succeeds on a read-only root, that
`VITE_API_BASE` actually reaches the frontend bundle, and that both test
suites pass. It exits with the number of blockers.

**On Windows, run these from Git Bash**, not PowerShell — they are bash
scripts. They resolve the venv layout and convert host paths to the form
`docker.exe` and `aws.exe` expect, so nothing inside them needs changing.

```bash
./preflight.sh
./deploy.sh backend      # ECR build+push, Lambda (incl. X-Ray tracing), API Gateway, crops bucket
./deploy.sh cdn          # CloudFront distribution (S3 + /api/* -> API Gateway)
./deploy.sh frontend     # needs API_URL, and CloudFront permissions
./deploy.sh dashboard    # the CloudWatch monitoring dashboard (step 11.8)
./deploy.sh all          # all four, in dependency order
```

`deploy.sh` is idempotent — re-running updates in place, which step 11's
own Done-when requires (harvested crops must survive a redeploy).

**`deploy.sh backend` and `dashboard` have now been run from Windows
repeatedly** (2026-09-22), and doing so found a real bug worth knowing
about if you ever see a deploy "fail" with nothing obviously wrong. The
smoke test passed its photo as an MSYS path (`/g/Dev/...`) to `curl`,
which is a native program — and because these scripts switch MSYS path
conversion *off* (they have to, so Docker's container-side paths survive
verbatim), curl could not open the file and exited 26. Under
`set -euo pipefail` that aborted the script **inside `deploy_backend`**,
so `./deploy.sh all` deployed the backend and then stopped silently,
never reaching cdn, frontend or dashboard. Fixed by passing the native
path, the same way `preflight.sh` already did. Still not exercised from
Windows: `deploy.sh cdn` and `frontend`.

**It is deployed and live**: <https://d2n2meq17rr1oi.cloudfront.net>

```
phone ──► CloudFront ──┬──► S3 (frontend, private, read via OAC)
                       └──► API Gateway ──► Lambda ──► S3 (crops)
                            /api/*
```

One origin serves both, so the frontend and API share a domain and there is
**no CORS anywhere**. `/api/*` has caching explicitly disabled — a cached
scan response would serve one student's marks for another's script.

**Why API Gateway and not a Lambda Function URL**, which the plan
originally specified: this AWS account refuses Function URL invocation by
anything except an IAM principal. Verified three ways — public (`NONE`)
with a correct public resource policy returned 403; CloudFront's service
principal with a correct OAC grant returned 403; only a directly IAM-signed
request succeeded. API Gateway sidesteps Function URL auth entirely. See
[aws/MONITORING.md](aws/MONITORING.md) for where to watch it run.

### Monitoring: hit counts and the request-flow graph

Two pages, one click apart, both free and both behind your own AWS login —
no public URL and no new auth was built for this.

**The dashboard** is the one to open first. It carries frontend hits,
backend hits, Lambda's health, and the scan success-rate query on a single
page, instead of the four separate console tabs this used to take:

```
https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=marks-scanner
```

```bash
AWS_PROFILE=marks-scanner ./deploy.sh dashboard   # create or update it; idempotent
```

**The X-Ray trace map** is the actual node graph — Lambda and the calls it
makes, drawn from real traces. CloudWatch console, left nav: **X-Ray
traces → Trace Map** (the documented route; the deep link is
`…/cloudwatch/home?region=us-east-1#xray:traces/map`). A `/api/scan`
renders as just the Lambda box, because recognition runs entirely
in-process and never touches S3. A `/api/harvest` also lights up an **S3**
edge — one call per field written, so a full harvest shows thirteen.

Two things the graph will never show, both by design rather than
oversight:

- **API Gateway.** X-Ray tracing is a REST-API-only feature; this project
  uses an HTTP API, chosen for its lower cost. Its request count is a
  dashboard widget instead.
- **CloudFront.** Serving a static file from cache is not a traced call at
  all. Same answer: a dashboard widget.

**The two hit counts do not move together, and shouldn't.** CloudFront's
is file-level — opening the app pulls the bundle, CSS, icons and the
service worker, so one visit is several hits. API Gateway's is
request-level and runs roughly *double* your scan count, because the
review screen fires `/api/harvest` on every Confirm, separately from the
`/api/scan` the photo already made. Telling those two kinds of backend hit
apart is exactly what the trace map is for.

Tracing is off unless a deployment turns it on: `XRAY_ENABLED` defaults to
false, `deploy.sh` sets it only on the real Lambda, and the laptop never
installs `aws-xray-sdk` at all (it lives in `requirements-deploy.txt`).
Leave it off locally — outside a real Lambda invocation there is no parent
segment to attach to, so every subsegment is discarded. Harmless, but it
buys nothing and logs a warning per request.

Watching it from a terminal instead of the console:

```bash
AWS_PROFILE=marks-scanner \
  aws logs tail /aws/lambda/marks-scanner-api --since 30m --region us-east-1 --format short
```

```bash
# Windows (Git Bash) — MSYS_NO_PATHCONV is required, not optional
export AWS_PROFILE=marks-scanner MSYS_NO_PATHCONV=1
aws logs tail /aws/lambda/marks-scanner-api --since 30m --region us-east-1 --format short
```

Without `MSYS_NO_PATHCONV=1`, Git Bash rewrites the log-group name
`/aws/lambda/...` into a filesystem path before `aws.exe` sees it, and the
failure names a path you never typed:
`AccessDenied ... log-group:C:/Program Files/Git/aws/lambda/marks-scanner-api`.

Pulling one trace back by id, to see its structure rather than its
picture — useful for confirming the S3 edge is really being recorded:

```bash
aws xray batch-get-traces --trace-ids 1-xxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxx \
  --region us-east-1 --output json
```

Trace ids appear on every `REPORT` line in the Lambda log group
(`XRAY TraceId: 1-...`). Note this needs X-Ray *read* permission, which
the `marks-scanner` deploy profile deliberately does not have — it can
configure tracing but not read traces, since reading is a console-and-human
operation rather than a deploy-time one.

[aws/MONITORING.md](aws/MONITORING.md) has the saved Logs Insights queries
(success rate, stage timings, which field the model struggles with, cold
starts, rate limiting) and the retention and cost notes.

### Tests

```bash
cd backend && source venv/bin/activate && pytest   # 264 tests, fully offline
                                                   # (262 pass, 2 skip without Tesseract)
cd frontend && npx vitest run                      # 408 tests (npx vitest for watch mode)
cd frontend && npm run lint                        # oxlint
cd frontend && npm run build
```

```powershell
cd backend; .\venv\Scripts\Activate.ps1; pytest
cd ..\frontend; npx vitest run; npm run lint; npm run build
```

The backend suite never touches the network — Gemini responses are served
from cached fixtures in `backend/tests/fixtures/`.

**Use `npm run build` to typecheck, never a bare `npx tsc --noEmit`.** The
root `tsconfig.json` is a solution file (`"files": []` plus references), so
that command typechecks *nothing* and passes on genuinely broken code.

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

```powershell
cd backend; .\venv\Scripts\Activate.ps1
python detect.py ..\testset\images\filled_file.jpeg --questions 5 --id-digits 7 --out ..\testset\debug\one
python batch_detect.py ..\testset\images --questions 5 --id-digits 7 --out ..\testset\debug\
python id_ocr_accuracy.py
python ..\testset\check_labels.py
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

```powershell
cd backend; .\venv\Scripts\Activate.ps1
python cnn\accuracy.py
python cnn\accuracy.py --calibrate
python cnn\marks_accuracy.py
```

**Retraining** is the only part that needs the extra dependencies, since
`torch` is training-only:

```bash
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-cnn.txt

python cnn/inspect_preprocess.py ../testset/debug/*/cells/id_d*.png  # look at the 28x28 inputs first
python cnn/train.py --epochs 8 --out cnn/checkpoints                 # EMNIST Digits, ~8-10 min/epoch on CPU
```

On Windows the same two commands work, but PowerShell does not expand the
glob — pass a concrete path to `inspect_preprocess.py`:

```powershell
python cnn\inspect_preprocess.py ..\testset\debug\one\cells\id_d1.png
python cnn\train.py --epochs 8 --out cnn\checkpoints
```

To run the app against a different recognizer than the default:

```bash
RECOGNIZER=remote uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
RECOGNIZER=both   uvicorn app.main:app --reload --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
```

```powershell
# Windows — an environment variable, set before launching; $null to undo
$env:RECOGNIZER = "remote"
.\dev.ps1
$env:RECOGNIZER = $null
```

`remote` additionally needs `GEMINI_API_KEY` set in `backend/.env` and the
Tesseract binary installed; the default `cnn` path needs neither. `both`
costs real Gemini quota and is meant for an actual comparison run, not
everyday use.

Collecting real handwriting to fine-tune on:

```bash
# Blank sample sheet to print and have people fill in (not the marks grid)
python generate_collection_sheet.py --out ../collection_sheet.docx

# Push an already-labelled photo batch through the live harvesting endpoint
uvicorn app.main:app --port 8123 &
python harvest_real_photos.py --base-url http://127.0.0.1:8123
```

On Windows, `&` does not background a command — start the server in its
own window first:

```powershell
Start-Process .\venv\Scripts\python.exe -ArgumentList '-m','uvicorn','app.main:app','--port','8123'
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

```powershell
cd synthetic_scripts
py -3 generate.py 0 20
py -3 generate.py
```

`python3` is not a usable name on Windows — it resolves to a Microsoft
Store stub that prints "Python was not found" and exits non-zero. Use
`py -3`, or `python` inside an activated venv. (The `.sh` scripts resolve
this themselves, so nothing in them needs changing.)

Needs 15 Google Fonts plus Liberation Sans, none carried in the repo —
`generate.py` documents exactly which.

## Invariants worth knowing before changing anything

These come from the specs and are load-bearing. Breaking one is a defect,
not a style difference — [CLAUDE.md](CLAUDE.md) has the full list with
reasoning.

> The 2026-08-31 audit found four of these broken in code. **All four were
> fixed the same day**, each with a regression test. Two of them are now
> enforced across the language boundary as well: `QuizConfig`'s bounds live
> in both `app/models.py` and `validateConfig.ts`, with a backend test that
> reads the TypeScript and fails if they drift apart; and a serial is
> validated by the same rule on both sides.

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
  serial. Normalized on write, with a DB v3 migration for records saved before that (#2).
- **At least one of `studentId` / `serial` must be non-null** to save.
- **Flag, never guess.** Low-confidence reads become blank plus a flag,
  never a filled-in best guess. One shared `parseMarkField`
  rule covers Total on both edit screens, and a partial ID (one still
  carrying a `?`) is blocked at Confirm (#4, N6, N5).
- **A failed scan is never a dead end.** A 60 s request timeout turns a
  hung upload into a recoverable error, and failed queue entries have a
  Dismiss action (#6, N3).
- **Never export a blank as `0`.** It reads as a mark of zero and nothing
  downstream catches it.
- **Harvested crops are written in a random order, and carry a constant
  mtime.** Both defend the same property and neither is cosmetic: a
  student's ID digits are collected in ID order, so any store recording
  *when* each crop arrived re-sorts them straight back into the ID. The
  constant mtime handles a local disk; it cannot handle S3, where
  `LastModified` is stamped server-side at millisecond precision —
  measured against a real S3 API, sorting one harvest's crops by
  LastModified reproduced a student ID digit for digit. Hence the shuffle,
  which works on any backend. Both are guarded by tests written as the
  attack rather than as the implementation.
- **No two source files may differ only by case.** Windows and macOS have
  case-insensitive filesystems, where `import Results from './Results'`
  resolves to `results.ts` — the component comes back `undefined` and
  React reports only "Element type is invalid". This was real:
  `Landing.tsx`/`landing.ts` and `Results.tsx`/`results.ts` both existed,
  invisibly broken on Linux, and failed 52 tests the moment the project
  was opened on Windows. `moduleNames.test.ts` now fails on any new
  collision, on every platform.
- **`.gitattributes` pins line endings, and is load-bearing.** Git for
  Windows defaults to `core.autocrlf=true`, which would rewrite every
  `.sh` file on checkout — and a CRLF shebang makes the kernel look for an
  interpreter named `bash` followed by a carriage return. The photos, the
  `.onnx` model and the dev `.pem` files are pinned `binary` for the same
  reason one layer worse: translation corrupts them outright.
- **Shell scripts must not call `python3` or `venv/bin/...` directly.**
  Neither name exists on Windows — and `python3` is worse than absent
  there, since a stock Windows 11 answers `command -v` with a Microsoft
  Store stub that then refuses to run. `shell-portability.sh` resolves
  both (`portable_python`, `venv_exe`), and any new `docker` or `aws` call
  taking a host path must go through its `native_path` too.

## Deliberately not built

Client-side detection with OpenCV.js · a **server-side** database ·
multi-user auth · a template generator (the grid is a Docs table pasted
by hand, on purpose) · an override for a mark above a question's printed
max (raised 2026-09-09, not yet specced — see below).

**Local multi-quiz history came off this list on 2026-09-09.** It used to
read "a server-side database or multi-quiz history" as one item; they are
two. Keeping a semester of quizzes in the browser's own IndexedDB needs no
server, no account and no new privacy surface beyond the device the marks
are already on — and without it, a faculty member teaching four sections
must delete one section's marks to grade the next. Specced as step 13 /
plan.md §18 (sections and assessments, the class list attached to the
section, a prompted end-of-semester purge). **All four phases are built
(2026-09-10)**: sections and assessments replace the single-value config
store, a class list is attached once per section and reused by every
quiz in it, every workbook export shows which copy of the file it's
writing into with a Re-pick option, grading into the wrong section is
guarded by a persistent context header, a confirmation when resuming an
older assessment, and duplicate detection scoped to the assessment, and
a semester ends with a real, scoped, prompted purge — never automatic,
blocked outright while any assessment hasn't been exported, comparing
semester labels by exact string so a typo'd variant is never silently
folded into the wrong purge. A server-side database and multi-user auth
stay deferred for the original reason.

**A deliberate override for a mark above a question's printed max —
raised 2026-09-09, not yet specced or built.** Today a mark outside
`[0, max]` can't be saved at all: it's rejected on both client and server,
by design, so a misread or a wrong printed max always ends up a flagged
blank rather than a silently-stored wrong number. What's missing is a way
for the instructor to genuinely mean it — a real bonus mark that legitimately
exceeds the max. Right now the only way to record one is to hand-edit the
exported `.xlsx` afterward, outside the app entirely. See [plan.md §13](plan.md)
for the two directions being weighed (a per-question tolerance vs. an
explicit per-field override) and the open question of what the sum check
compares against once one question can legitimately exceed its own max.

**Roster import is no longer on this list.** It was deferred "to avoid
file-upload complexity" until it became clear the roster already exists —
a workbook the instructor keeps all semester — so the complexity being
avoided was a roster *management* system, not a file picker. Step 12
(plan.md §17) picked it back up: an optional upload at Setup, matched
against by student ID, written back as a new sheet on export, the
instructor's own file otherwise untouched. All four phases — reading the
roster in, writing the sheet back out, roster-aware review, and
reconciliation (coverage, duplicate blocking, an opt-in totals column,
persistence across a refresh) — are done.

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
