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
| `marks-grid-template.docx` | The grid the instructor pastes into the question paper |

Commands below are the ones the specs call for. Once a step has actually
built something (check the Progress table), the corresponding command is
real and runnable, not aspirational.

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

Created starting step 0.1. Backend (steps 1–4) and the frontend scaffold +
Setup screen (step 5) exist; steps 6–9's frontend screens don't yet.

```
marks-upload/
├── plan.md · stack-reference.md · step.md · CLAUDE.md · learn.md
├── dev.sh                       # run both servers together — see Commands
├── marks-grid-template.docx
├── testset/
│   ├── images/                 # the real photographs — step 0 (2 so far)
│   ├── labels.json             # ground truth, hand-written
│   ├── check_labels.py         # labels.json <-> images/ consistency check
│   └── debug/                  # gitignored — detect.py's regenerable output
├── backend/
│   ├── detect.py               # step 1 CLI harness (single image)
│   ├── batch_detect.py         # step 1.8 — whole testset/images/ in one run
│   ├── id_ocr_accuracy.py      # step 2.4 — ID OCR accuracy harness
│   ├── gen_dev_cert.py         # step 6 — self-signed cert so the phone's HTTPS page can reach this backend
│   ├── .env.example            # copy to .env, fill in GEMINI_API_KEY
│   ├── app/
│   │   ├── models.py           # step 4 — ScanResult, QuestionMark, QuizConfig
│   │   ├── detection.py        # step 1 — the make-or-break component
│   │   ├── id_ocr.py           # step 2 — local, never leaves the laptop
│   │   ├── marks.py            # step 3 — the Gemini call
│   │   └── main.py             # step 4 — POST /api/scan
│   ├── tests/
│   │   ├── fixtures/           # cached real Gemini responses — no live API in tests
│   │   ├── test_detection_regression.py
│   │   ├── test_marks.py
│   │   └── test_main.py
│   └── requirements.txt
└── frontend/
    ├── vite.config.ts          # PWA + basicSsl (not mkcert — see Commands) + Vitest config
    └── src/
        ├── types.ts            # QuizConfig, StudentRecord — mirrors app/models.py
        ├── db.ts               # IndexedDB (idb) — step 5.2
        ├── validateConfig.ts   # pure form-validation logic, unit-tested
        ├── Setup.tsx           # step 5.3–5.4
        └── App.tsx
```

## Commands

All verified working (backend through step 4, frontend through step 5).

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

# Backend tests — offline, Gemini always mocked (21 tests as of step 4)
cd backend && source venv/bin/activate && pytest

# Backend — needs backend/.env with GEMINI_API_KEY (copy .env.example),
# and an HTTPS cert (below) generated first
cd backend && source venv/bin/activate
python gen_dev_cert.py   # only when certs/ is missing or the LAN IP changed
uvicorn app.main:app --reload --host 0.0.0.0 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Frontend — HTTPS and LAN binding are on by default via vite.config.ts,
# no --host flag needed
cd frontend && npm run dev
cd frontend && npx vitest run   # or `npx vitest` for watch mode
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

## Deferred — don't build these

Client-side detection with OpenCV.js · roster import · local mark classifier
(TFLite/ONNX) · server-side database and multi-quiz history · multi-user
auth · a template generator (there deliberately isn't one — the grid is a
Docs table pasted by hand).

## Installed skills

In `.claude/skills/` (gitignored — solo project):

- **`product-ui-design`** — the one design skill. Restrained product UI, with
  an output-time scan for AI tells. Its "frequency-gate animation" rule
  matches step 8.1 exactly: the confirm→next loop runs thirty times a class
  and should not animate.
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
