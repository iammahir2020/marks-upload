# CLAUDE.md

## What this is

**Script Mark Scanner** — a tool for a faculty member grading quizzes. They
photograph the marks grid at the top of each student's script; the app reads
the handwritten student ID, serial number, and per-question marks, lets the
instructor confirm or correct them on the spot, and exports the whole session
as one Excel file.

Single instructor, one quiz session, one class (pilot: CSE211L). No auth, no
server-side database. Session state lives in IndexedDB until export.

Two clauses of that sentence have been picked up deliberately since, and
both are worth knowing before trusting it:

- **"No uploads" described the MVP pilot.** An optional one was added
  2026-09-07 (plan.md §17, step.md step 12, **all four phases built**) —
  the instructor's own class-list workbook, written back into at export.
  As of step 13 (below) it's attached once per **section**, not
  re-uploaded per quiz; everything else about the sentence still holds
  for whoever doesn't use one.
- **"One quiz session" is now one semester** (2026-09-09, plan.md §18,
  step.md step 13, **all four phases done, 2026-09-10**). A faculty
  member teaches several sections at once — the real case is one section
  of CSE100, one of CSE200 and two of CSE203 — and the built code
  handles exactly that: a **Section** (course, label, semester, ID
  digits, an optional class list) and an **Assessment** (one quiz's
  config plus its records) replace the single-value `config` store that
  used to make the second CSE203 section destroy the first's marks.
  Grading into the wrong section is guarded three ways: a persistent
  context header, a confirmation when resuming an assessment last
  touched before today, and duplicate detection scoped to the assessment
  (a shared serial across two courses no longer raises a false
  conflict). A semester ends with a real, scoped purge — offered only
  when a new semester's first section is created, blocked outright while
  any assessment in that semester hasn't been exported, and comparing
  semester labels by exact string so drift never gets silently folded
  into one purge decision. Still no auth and still no server-side
  database; it all stays in IndexedDB. **Both things the spec originally
  left open are now decided** (13.22, 2026-09-10): semester labels are a
  Spring/Summer/Autumn-plus-year picker, not free text, and the app opens
  on the library rather than jumping into the last active assessment. See
  step.md's step 13 for the full account.

## Current state — read this first

Specs first, then check `step.md`'s **Progress table** at the bottom — it is
the project's actual status of record and is kept current as steps
complete. Do not assume "not started" from this file; the table is the
source of truth.

| File | What it is |
|---|---|
| [plan.md](plan.md) | Architecture, data models, screens, API contract, resolved decisions. §19 (2026-09-10) specs the landing page: static-first, prerendered, zero runtime JS, dark, Raycast's structure but not its skin — **all three phases (content, static-first prerendered delivery, the scroll-linked scan animation) built 2026-09-10; real-device verification of the animation's timing and phone layout still needed** |
| [step.md](step.md) | Execution plan — steps 0–14, each with a *Before you start*, substeps, a test, and a *Done when* bar. **Step 14 (landing page) has all three phases code-done (2026-09-10)** — content, tokens, entry/exit; real static-first delivery, prerendered at build time via `scripts/prerender-landing.mjs` with zero runtime JS of its own; and the five-state scroll-linked scan animation (`ScanAnimation.tsx`) with its reduced-motion/unsupported-browser fallback — at ~7.9KB gzip first paint against §19's ~10KB budget. **14.9 (2026-09-10) fixed two real bugs found by actually using it**: `vite dev` (the everyday `./dev.sh` workflow) never served the landing page's static shell at all, since the prerender injection only ran on `vite build` — fixed with a dev-mode Vite plugin using the same injection code as the build script, now shared via `scripts/landing-shell.mjs`. Separately, the "way back" link was undiscoverable, tucked inside a `<details>` that collapses the moment a first section exists — moved to an always-visible "About" button in `Library.tsx`'s header. **A same-day-adjacent addition (2026-09-12)**: the close section now shows a share QR code (`QrCode.tsx`) encoding the app's own deployed URL (`landingShell.ts`'s `DEPLOYED_APP_URL`), for showing the screen to a colleague to scan rather than reading the address out or typing it into a message — plus the plain link as readable text alongside it. Verified by decoding the actual built SVG path with a real QR decoder (jsQR), not just by trusting the encoder. This pushed the page's own weight budget from ~10KB to ~12KB gzip (plan.md §19's Weight budget table has the accounting) — a deliberate, documented exception to that section's "the change is wrong, not the budget" rule, since the cost is inherent to a real requested feature rather than decorative bloat. **What's left is real-device verification**, which the spec itself names as the only way to check the crossfade timing and phone layout jsdom can't simulate; see plan.md §19 for the rationale, including why it is pre-rendered at build time rather than server-rendered. Steps 0–10 match plan §14; step 11 (hosted demo), step 12 (class-list workbook round trip) and step 13 (multi-course, multi-section persistence) are later, deliberate extensions beyond plan §13's MVP scope, each running in independently-shippable phases — three for 11, four for 12, four for 13. **All four phases of step 12 are done** (2026-09-07: roster upload/parsing/identification at Setup, writing the exam sheet back into the instructor's own file, roster-aware review/results, and pre-export coverage/duplicate-blocking/an opt-in totals column/IndexedDB persistence — each verified against the real 16-student marksheet, not only synthetic shapes); it reverses three of plan §15/§2/§13's recorded decisions on purpose, amended in 12.0. What remains is real-phone verification of the file picker and download, needing the user's own participation. **Step 13's all four phases are done (2026-09-10)**: the DB v5 schema/migration, `Library.tsx`/`SectionForm.tsx`/`AssessmentForm.tsx` replacing `Setup.tsx` (deleted), the roster moved onto the Section, every "don't grade into the wrong section" protection (context header, resume confirmation, assessment-scoped duplicate detection, an identity-carrying filename), and the real scoped semester purge — offered only when a section is created under a genuinely new semester label, blocked outright while any assessment in that semester has never been exported, comparing semester labels by exact string so drift (`Fall 2026` vs `fall 2026`) is surfaced as two purge candidates rather than silently merged. It reverses 12.1's fresh-upload-per-quiz rule on purpose, replacing it with a provenance line + Re-pick + re-cache rather than quietly editing the old sentence, and 12.1 now carries an amendment note saying so. **A same-day follow-up (13.22, 2026-09-10)** replaced the free-text semester field with a Spring/Summer/Autumn-plus-year picker and confirmed the app opens on the library — the two things step 13 had originally left open. Ends with the Progress table. |
| [stack-reference.md](stack-reference.md) | Library-level notes from Context7: exact calls, starting parameter values, known traps |
| [learn.md](learn.md) | Plain-language walkthrough of what each finished step's code actually does, for learning alongside the build. Updated after each step — see "How to work here." |
| [issues.md](issues.md) | **The open-defect register — read it before trusting any screen or endpoint.** Three audits: 2026-08-27 (15 findings), a full re-read on 2026-08-31 (28 more, N1–N28), and a 2026-09-10 full-repo pass (N37) that specifically targeted the second audit's own "not read at all" list plus the entire step 14 landing-page/build-tooling codebase — see below for both, plus a first live grading session (N31–N34), N35 found while checking a direct user question, and N36 found while building the per-assessment delete feature. **46 of 52 are now fixed** — frontend (12), pair (11, closing both HIGH findings: N1 path traversal, N2 unbounded config), hot-path (**N4**, where a blank ID cell was producing a confident fabricated digit — demonstrated, not inferred, plus N18), cnn-path (N16, N17, N24, 15), dormant (4, cleared *ahead of* step 3r.6's comparison run), a **2026-09-09 live-session pass** closing **N31** and **N32**, both HIGH, plus **N33** — `decode_serial` now returns '?' per uncertain position instead of blanking the whole field (mirrors `read_id`), and harvesting refuses a crop the original scan couldn't match to a legal value regardless of what the instructor typed to get past Confirm — **N35 (2026-09-10)**, where a leading-zero mark ("03", "05") could never decode on the default `cnn` path because the decoder only ever scored a legal value's un-padded digit rendering — and **N36 (2026-09-10)**, where the section/semester delete guards blocked on `exportedAt === null` alone, which would have made a section holding even one brand-new (and therefore always-unexported) assessment permanently undeletable. **N37 (Med, found 2026-09-10) is now fixed too (2026-09-12)** — `local-stack.sh` was publishing MinIO's S3 API and console to the whole LAN with hardcoded credentials; both ports now bind to `127.0.0.1` explicitly, the one-line fix the register had already named. **5 remain open**: **N34** (Med) was deliberately left unbuilt — asked to choose a fix direction, the user chose to defer it entirely — plus four Low deploy/infra items. Everything the desk audits found on the `cnn` path is closed, and all four live-session findings are too; N34 is open by choice alone now. Suites went 148/79 → **259/358** (N37 was a shell-script finding, not covered by either suite). It also carries explicit "what audit N did NOT cover" sections naming the files never opened, updated after each audit. |
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
44.5%/0.0%), reads marks at 98.1% per-question, and — the part accuracy
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

**Step 15 (2026-09-24) taught the CNN a "crossed out" class** — plan.md
§16's "Crossed-out glyphs", step.md step 15, learn.md. A crossed-out ID box
reads `?`; a crossed-out mark/total/serial is left blank with the rest of
the cell offered as a one-tap suggestion on Review (`suggestions`, never a
pre-filled value); harvesting refuses every crossed-out cell. The
headline numbers quoted elsewhere in this file predate it and are LOWER
than current: with the step 15 model, ID is 93.4% per-digit / 58.6%
whole-ID, serial 68.4%, total 94.7%, marks 98.1% with 0 confidently wrong.
Its crossed-out examples are all one writer (the instructor), so a
student's crossed-out ID/serial digit is the least-verified case.

**Step 16: both phases built 2026-09-25; a real printed layout B page
has not been scanned yet** — plan.md §21, step.md step 16. A second paper layout with **no Serial box** (a one-row
Name/Section table, then ID, then marks), picked per quiz by a "Serial
box on paper" setting that defaults ON. **Hard rule from the user: the
current scanning flow must not break** — an absent setting means today's
behaviour everywhere, and layout A's detection must stay byte-identical
across `testset/`. Also: the section form's ID-digits input gets hidden
(IUB-only, always 7). plan.md §21 also records the paper design rules
(no enclosing border, clear gaps, cell size near the template's, Total
column last) that the detector and segmenter actually depend on.
Phase A threads `hasSerial` (default True) from `QuizConfig` through
detection, all three recognizers, the remote path's composite/prompt,
harvesting and the CLI tools; layout B fixtures made from real photos
live in `backend/tests/fixtures/layout_b/`. Backend suite 285 -> 310.
Phase B: `sections.ts`'s `hasSerialBox` is the ONE place the setting is
read (anything but an explicit `false` is yes — that is what keeps every
pre-step-16 assessment unchanged, with no DB migration). **Don't drop the
Serial column from the workbook exam sheet** for a no-serial quiz: it is
blank there on purpose, because `roster.ts`'s `hasExamSignature` tells an
exam sheet from the class list by it. Frontend suite 421 -> 450 (+3
skipped: the hidden ID-digits field's tests, kept for when it returns).

**Pre-sharing security pass (2026-09-25)** — issues.md "Fixed 2026-09-25":
N39/N47 (`app/imagecheck.py`, header-read pixel cap + JPEG/PNG only), N41
(rate limit never reads `X-Forwarded-For`; hosted keys on
`CloudFront-Viewer-Address`), N42 (CloudFront sends `X-Origin-Verify`, the
backend refuses `/api/*` without it; `ORIGIN_SECRET` — **don't remove it
while `CLIENT_IP_SOURCE=cloudfront` is set**, the two are only sound
together; API docs pages off), N22 (smoke test fails loudly), N38 (API
throttling 2/s; the account's own ~10 total Lambda concurrency is the cap,
nothing reservable; budget alarm `marks-scanner-guard` exists). Deployed and
verified live 2026-09-25. **N40/N45, same day**: hosted crops go to the
bucket's `unverified/` prefix (`HARVEST_PREFIX=unverified`, deploy.sh) and
only reach training via `fetch-crops.sh review` + `promote`; the Library
has a "share anonymised cells" switch, on by default, stored in IndexedDB's
`meta` store (`getShareCrops`/`setShareCrops`, spared by Reset everything).
**N43, same day**: a build-time CSP `<meta>` with exact inline-block hashes
(`frontend/scripts/csp.mjs`) plus a CloudFront response headers policy
(`aws/headers_policy.py`, deploy.sh) for HSTS, anti-framing, nosniff,
Referrer- and Permissions-Policy; `npm run test:e2e:prod` proves nothing
the app does is blocked. **N44, same day**: `dev.sh`/`dev.ps1` and Vite are local-only by
default; `--lan`/`-Lan` opts a phone testing session in, and routes its
crops to `training_data/unverified/`. The owner grades on the deployed site.

**Step 17 (2026-09-25, code-done; phone checks remain)** — plan.md §22,
step.md step 17. Two strands from live use. **Partial scans**: a
column-count mismatch in one table no longer fails the scan — `detect()`
writes no crops for a miscounted table, `/api/scan` returns
`table_mismatches` with those fields blank and flagged, and `/api/harvest`
harvests the tables that matched. A wrong Serial setting still fails
outright (`main.py`'s `_is_partial`). `_repair_columns` fixes a table off by
one column from evidence only (see "Conventions" below). Review has Save
photo on the failure/partial banners; real failed photos go in
`testset/private/` (gitignored). **Half marks**: `segment.py` adds WEAK
decimal points (mid-height, under the noise floor, or tucked inside a
digit), and `local.py`'s `_resolve` reads a cell with and without them — a
tie becomes `choices`, shown as separate Use buttons, never pre-filled.
Measured with `cnn/half_marks_accuracy.py` on the instructor's own practice
page: wrong 2 -> 0, correct 102 -> 114 of 121; harvested whole marks
unchanged. Backend 310 -> 351, frontend 450 -> 456. **Harvest layout
change (same day)**: every question's crops now go in ONE
`marks_questions/` folder (`harvest.py`'s `QUESTIONS_FIELD`) instead of
`marks_q1/`, `marks_q2/`, ...; the Total keeps `marks_total/`.
`fetch-crops.sh` folds older `marks_qN/` crops (still in S3 and MinIO,
deliberately not rewritten there) into `marks_questions/` after every sync.
The local `training_data/harvested` and `training_data/all` were folded once
by hand (105 and 408 crops, totals unchanged, mtimes kept).

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

**Step 11.8 (2026-09-22) added a monitoring dashboard**, after the user
asked for frontend/backend hit counts "in one place" with something like
a node graph. Two real findings shaped what actually got built, both
verified rather than assumed, and both worth knowing before touching this
again: CloudWatch dashboards have no widget type that embeds an X-Ray
trace map (checked against AWS's own docs — valid types are `metric`,
`text`, `log`, `alarm`, `explorer`, `chart`, full stop), so the live
Lambda↔S3 node graph lives on its own X-Ray-console page, one click from
the dashboard, not inside it; and X-Ray tracing is a REST-API-only
feature of API Gateway, so this project's HTTP API (chosen for its lower
cost) can never appear in that graph at all — its own request count is a
plain dashboard widget instead. `app/main.py`'s `trace` middleware
(~15 lines, hand-written) exists because `aws-xray-sdk` has no ASGI/
FastAPI integration (Django/Flask/Bottle/aiohttp only) and — separately —
because that SDK itself entered maintenance mode 2026-02-25, with AWS now
pointing people at OpenTelemetry (ADOT) instead. ADOT was considered and
set aside specifically for this deployment: it's normally delivered as a
Lambda Layer, and this Lambda is a container image, where Layers don't
apply — ADOT's own docs call for hand-embedding its collector into the
Dockerfile via a multi-stage build, real infra risk for a monitoring
nice-to-have. `XRAY_ENABLED` (`app/config.py`) is off by default, same
shape as every other deploy-only seam here — the laptop app never imports
`aws-xray-sdk`, and `local-stack.sh` doesn't set it either, since it runs
the deployed image OUTSIDE a real Lambda invocation, where the SDK has no
parent segment to attach to. That exact failure mode is pinned by a test
(`test_xray_enabled_never_breaks_a_scan_even_with_no_lambda_context`) —
tracing must never be able to fail or slow a scan, the same rule
`observability.py`'s logging already lives by. `aws/deploy-policy.json`
gained one new grant, `cloudwatch:PutDashboard`, scoped to the one
dashboard by name — its ARN has no region segment at all, confirmed
against a real `AccessDenied` error message rather than assumed. See
`aws/MONITORING.md`'s new top section for what the dashboard actually
shows and why the two hit-count numbers don't move together (a
`/api/harvest` call fires automatically on every Confirm, separately from
the `/api/scan` call the photo already made — so API Gateway's count runs
roughly double the scan count on ordinary use).

**Two real production incidents happened while shipping this, both found
by actually checking the live deployment rather than trusting a green
deploy, both fixed the same day.** Worth keeping the full account, since
both are the kind of bug that only shows up under a real Lambda
invocation — nothing in the local test suite, and nothing in `deploy.sh`'s
own smoke test at the time, could have caught either one.

1. **The first deploy broke every request, not just X-Ray-related
   ones.** `patch(("boto3",))` was originally called eagerly at
   `main.py`'s module level, guarded only by `XRAY_ENABLED`. Patching
   forces `botocore` to import immediately — confirmed by timing it
   directly (1.8s → 8.9s just to `import app.main`) — and that alone
   pushed cold-start init past Lambda's ~10s platform init-phase timeout,
   on top of an already-heavy chain (opencv, onnxruntime). Real
   production logs showed it plainly: `INIT_REPORT ... Status: timeout`,
   then `app is not ready` repeating for 30+ seconds. Fixed by moving the
   `patch()` call to the one place boto3 itself is actually imported —
   `S3Store.__init__` (`app/stores.py`), lazily, per `/api/harvest`
   request — restoring the original guarantee (patch before the first
   client is built) without paying botocore's import cost on a plain
   `/api/scan`, which never touches S3 at all. Pinned by
   `test_xray_enabled_does_not_force_boto3_to_import_at_cold_start`, a
   subprocess-based test (a same-process `sys.modules` check would be a
   coin flip on test order, since other tests legitimately import boto3
   for their own reasons).

2. **After that fix, requests worked — but every subsegment this app
   tried to record was silently discarded**, on every request, warm or
   cold, scan or harvest: `Subsegment ... discarded due to Lambda worker
   still initializing`, a misleading message for what turned out to be a
   process-architecture mismatch, not an initialization race. Root cause,
   confirmed against the SDK's own source (`lambda_launcher.py`): it
   re-reads `_X_AMZN_TRACE_ID` from the environment fresh on every
   subsegment call — correct for a native Lambda handler, but this app
   runs behind the **Lambda Web Adapter**, which forks uvicorn ONCE at
   cold start; a forked child's environment is a private copy from that
   moment, and nothing updates it per invocation the way Lambda updates
   the platform process's own. So every subsegment after the very first
   invocation was reading a value frozen at cold start. Confirmed by
   reading LWA's own behavior: it forwards the real, current
   `X-Amzn-Trace-Id` as an HTTP header on every proxied request, by
   design, for exactly this. Fixed by having `trace` copy that header
   into `os.environ["_X_AMZN_TRACE_ID"]` before asking the recorder for a
   subsegment — the SDK's own re-read logic then points at reality
   instead of a stale snapshot, with no other code changed. **Verified
   against a real trace, not just the absence of the discard message**:
   `aws xray batch-get-traces` on a real `/api/harvest` call showed the
   `/api/harvest` subsegment and 13 separate `S3` child subsegments (one
   per harvested field), each `http.response.status=200` — the exact
   Lambda→S3 graph this feature exists to draw. Pinned by
   `test_xray_syncs_the_trace_env_var_from_the_incoming_header` for the
   half of this fix that's this codebase's own responsibility (the LWA
   fork behavior itself can't be reproduced outside a real deployment).

Backend suite: 259 → 264.

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
| Tests | `pytest` (backend), `vitest` (frontend), Playwright (frontend, real browser) | Playwright added 2026-09-25 (step 16): `frontend/e2e/`, for what jsdom can't do — layout, the camera flow |

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
reconcile still pending), all exist. Step 10 doesn't yet. **All four
phases of step 12 do** (2026-09-07, plan.md §17): `frontend/src/roster.ts`
(header matching, the exclude-then-prefer-then-confirm class-list
identification rule, ID normalization for comparison) and `Setup.tsx`'s
mode toggle, upload UI, and confirm/picker card (Phase A); `examSheet.ts`
(pure row-matching against the roster) and `workbookExport.ts` (sheet-name
sanitisation pinned to ExcelJS's own thrown rules, case-insensitive
collision detection that refuses to ever mark the class-list sheet
overwritable, and the actual sheet writer), wired into `Results.tsx` as a
second export button alongside the untouched plain download (Phase B).
`RosterUpload` now threads `Setup.tsx` → `App.tsx` → `Results.tsx`. Both
phases verified against the real marksheet directly, not only synthetic
shapes, and Phase B's output was additionally round-tripped through a real
`soffice --headless` conversion. `frontend/src/rosterMatch.ts` (Phase C)
answers a different question neither of the above needed to: given one
studentId, is it on the list, and if not, is there exactly one roster
student it's plausibly a misread of (one digit off, or consistent with a
partial `?`-marked read) — offered only when that candidate is unique,
never the closest of several. `roster`/`rosterUpload` now also threads
`App.tsx` → `Scan.tsx` → `Review.tsx`, so `Scan.tsx` can show "Scanned 7 of
16" and `Review.tsx` can show a matched name or a tap-to-accept suggestion
next to the Student ID field; `Results.tsx` gained a live Name column.
Verified against the real 16-student roster's actual IDs, not just a
synthetic 2-student one. **Phase D**: `examSheet.ts`'s `missingStudents`
(who hasn't been scanned) feeds `Results.tsx`'s confirm panel, now always
shown on a workbook export and BLOCKING outright — Cancel only, the plain
download left as the escape hatch — the moment `buildExamSheet` reports a
duplicate. `workbookExport.ts`'s `writeTotalsColumn` (an opt-in checkbox,
off by default) writes each roster student's total into the class-list
sheet itself, matched to the SAME quiz's column by exact header text on
re-export; it writes to each student's own real sheet row
(`RosterStudent.row`, added specifically for this — see roster.ts's own
comment on the bug that field prevents) rather than assuming a gap-free
block of rows. `db.ts` gained a fourth store so the roster survives a
mid-session refresh, restored on mount and threaded through both the
saved-config quick-start button and "View results." All four phases
verified against the real 16-student roster directly.

**Five fixes from actually using step 12 on a real phone (2026-09-07)**,
found after the phases above were already marked done — the same pattern
step 6/9's own live-testing fixes followed. The mode toggle's two buttons
could overflow the screen on a narrow phone (`.btn`'s `white-space:
nowrap` plus a `.row` with no wrap — fixed with a scoped `flexWrap: wrap`
on that one row, not the shared class). The file input kept showing "No
file chosen" after a successful upload, because clearing it (so re-picking
the same filename still fires `onChange`) also clears the browser's own
displayed name — fixed with a `selectedFileName` state that shows the real
answer regardless of what the native input says. Column headers ("Q1",
"Total") now carry their max mark ("Q1 (5)", "Total (20)") on the Results
table, both export paths, **and** the opt-in totals column added to the
class-list sheet itself ("Quiz 1 (20)", `writeTotalsColumn`'s own
`headerText`, matched on re-export by the full annotated string — a quiz
whose max has genuinely changed since the last export gets a fresh column
rather than a silently different number under the old one). None of this
was free: `hasExamSignature` matched `Total` by exact canonical key, and
"Total (20)" canonicals to "TOTAL20" — shipping the header change without
also loosening that check to `/^TOTAL\d*$/` would have stopped a workbook
this app itself wrote from being recognized as exam-shaped on its next
re-upload, reopening the exact misdetection plan.md §17's exclusion rule
exists to prevent. Caught before shipping, guarded by two new
`roster.test.ts` cases (one proving the new header format still matches,
one proving a real "Total Marks Trend" column still correctly doesn't)
and verified against the real 16-student roster directly, including a
re-upload of the app's own output to confirm `data` is still identified
correctly with the annotated headers actually present.

**A sixth fix, same origin (2026-09-08).** Clearing any Setup number field
— ID digits, question count, a per-question max — put a literal `0` back
into the box, so the next digits typed landed after it (`10` became
`010`). `Number('')` is `0`, and every keystroke was coerced through it.
The three fields now hold `NumField = number | ''`; an emptied box reaches
`validateConfig` as `NaN`, which its existing `Number.isInteger` /
`Number.isFinite` checks already reject with the same message a `0` gets,
so **no validation rule and no bound changed** — the pinned
`validateConfig.ts` ↔ `app/models.py` pair was not touched. Two knock-ons
handled deliberately: `handleQuestionCountChange` short-circuits on `''`
*before* issues.md #1's array-resize guard, and `parseRosterSheet` gets
`0` for an empty ID-digits box, which is exactly what it already received
when the field coerced to `0`. Frontend suite 238 → 241. Note the honest
limit recorded in `learn.md` and in the test file itself: jsdom has no
caret, so only one of the three new cases fails against the old code — the
symptom needed a phone, the tests pin the cause.

**Redeployed 2026-09-08** (`./deploy.sh frontend`) so the live URL carries
all six fixes: preflight clean, bundle `index-WQ0p53dA.js`, CloudFront
invalidation `IEYK5IQAFMGB3JPE25XCWNLPFD`, and `GET /api/scan` still
returning `405` from the Lambda afterwards — a frontend-only deploy must
not disturb the `/api/*` behaviour. Backend image not rebuilt; nothing
under `backend/` changed.

**Step 13's all four phases are done (2026-09-10, plan.md §18)** —
`db.ts` bumped to v5 (`sections`/`assessments` stores, `StudentRecord`
gained `assessmentId`, `config`/`rosterUpload` retired with a
three-case-tested migration folding any v1-v4 database, including a
persisted roster, into one Section + one Assessment). `Setup.tsx` is
**deleted outright**, its role fully absorbed by three new files:
`Library.tsx` (the new entry point — semester → course → sections →
assessments, plus the disclosure and "Reset everything" that used to
live in Setup), `SectionForm.tsx` (course/label/semester/ID-digits, plus
the class-list workbook upload ported from Setup's old workbook mode —
now an always-optional field rather than a plain/workbook toggle, since
the roster is a property of the section, not a per-quiz choice), and
`AssessmentForm.tsx` (quiz name/question count/maxes — Setup's old form
minus ID digits, inherited from the section). `sections.ts` is the new
pure-logic module (grouping, sorting, `assessmentConfig()`), matching
`resultsTable.ts`/`examSheet.ts`'s shape. `App.tsx` got a real screen enum
(`library | section | assessment | scan | results`) replacing
`config === null` as the router. Every workbook export now shows
provenance ("the file you picked" / "the copy this app wrote," with
**when**) and a **Re-pick** button, and re-caches the bytes it just wrote
so a second quiz in the same section builds on the first quiz's sheet
instead of silently losing it — verified end to end by actually exporting
two quizzes and reloading the real downloaded bytes. `Review.tsx` also
gained a `sectionLabel` prop: it renders as a fixed overlay that hides
Scan's own header, so the section context needed its own copy at the
exact moment a save is confirmed. **Phase C, same day**:
`findRecordsBySerial`/`findRecordsByStudentId` now take an `assessmentId`
and filter to it (a shared serial across two courses no longer raises a
conflict, verified against the case that must still fire within one
course); `sections.ts`'s `needsResumeConfirmation`/`lastActivityAt` drive
a confirm banner on `Library.tsx` when opening an assessment last touched
before today (derived from records already fetched, not a stored field);
`exportFilename` now produces `CSE203-2_Quiz-1_2026-09-09.xlsx`.
**Phase D, same week**: the real scoped semester purge (13.18) — offered
exactly when `App.tsx` detects a section was just CREATED (never edited)
under a semester label that matched none of the prior sections, never on
a timer, never from merely revisiting a multi-semester library.
`sections.ts`'s `otherSemesters`/`purgePreview` compare labels by EXACT
string, deliberately not normalized — `Fall 2026` and `fall 2026` show
up as two separate purge candidates, surfacing plan.md §18's own
label-drift risk instead of hiding it inside the one feature that
deletes data. The unexported guard (13.19) blocks a semester's purge
outright while any assessment in it has `exportedAt === null`, named by
section and quiz, Cancel only. `Library.tsx`'s old "Reset everything"
(full wipe) is untouched, staying as the blunt escape hatch alongside
the new scoped purge. Frontend suite: 245 → 282 (Phase A/B) → 301
(Phase C) → 322 (Phase D), five consecutive full runs confirmed stable,
including a first `App.test.tsx` for the one piece of this step's logic
that lives in App.tsx's routing glue rather than a screen component.
**13.22, same week**: the semester field became a Spring/Summer/Autumn +
year picker (`sections.ts`'s `SEMESTER_SEASONS`/`formatSemesterLabel`/
`parseSemesterLabel`/`currentSemesterSeason`, wired into
`SectionForm.tsx`), closing the free-text-vs-picker question for all new
data — a pre-picker label the picker can't parse falls back to today's
own season/year on edit rather than crashing, costing at most one extra
tap to correct. The app opening on the library was confirmed rather than
built (`App.tsx` already defaulted there). Frontend suite: 322 → 333,
three consecutive full runs confirmed stable. **13.23, same week**: a
per-section **Delete section** button, for one mis-created section rather
than a whole semester or a full device wipe — reuses `db.ts`'s existing
`deleteSection()` cascade behind a confirm with real counts, no undo.
(It originally BLOCKED on an unexported assessment, like the purge; since
2026-09-24 section and quiz deletes only WARN about never-exported work
inside the typed confirm — the semester purge alone still blocks. See
`sections.ts`'s `hasUnexportedWork`.)
Frontend suite: 333 → 339. **13.24, same day**: a per-assessment
**Delete quiz** button (`db.ts`'s new `deleteAssessment()`, one quiz
narrower than `deleteSection()`), and both delete flows now require
TYPING the section/assessment name back (`CSE100-1`, `Quiz 1`) before the
confirm button even enables — a shared `TypedDeleteConfirm` component,
not a copy per flow. Building this exposed a real bug (issues.md N36):
the existing unexported-assessment guard blocked on `exportedAt ===
null` alone, so a brand-new, wrongly-added (and therefore
always-unexported) assessment would have made its own section
permanently undeletable — fixed by narrowing the guard everywhere
(`sections.ts`'s `isBlocking`) to also require a real record count.
Frontend suite: 339 → 358. See step.md's step 13 for the complete
account.

**Step 11's
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
├── dev.sh                       # run both servers together (Linux) — see Commands
├── dev.ps1                      # the Windows counterpart — see "Running on Windows"
├── shell-portability.sh         # sourced by the four .sh scripts: portable_python
│                                # (python3 does not exist on Windows), venv_exe
│                                # (Scripts\ vs bin/), native_path/MSYS guards for docker+aws
├── .gitattributes               # pins *.sh and Dockerfile to LF — core.autocrlf=true on
│                                # Windows would otherwise hand bash a CRLF shebang line
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
│   ├── training_data/unverified/ # gitignored — the HOSTED site's crops, downloaded by
│   │                           # `fetch-crops.sh review` for a look; never trained on
│   │                           # until `fetch-crops.sh promote <source-id>` (issues.md N40)
│   ├── training_data/pages/    # gitignored — step 15's photographed practice pages
│   │                           # (loose digits in rows, clean and crossed out) plus
│   │                           # pages.json, the per-row labels cnn/pages.py reads
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
│   │   ├── stores.py           # step 11.2 — LocalStore / S3Store behind one put(key, src);
│   │   │                       # step 11.8 — S3Store.__init__ is ALSO the one place
│   │   │                       # `patch(("boto3",))` runs, deliberately not main.py: doing
│   │   │                       # it eagerly at cold start force-imports botocore and once
│   │   │                       # broke every request, not just harvesting (~7s added to
│   │   │                       # init, past Lambda's ~10s timeout) — moved to here, lazily,
│   │   │                       # per /api/harvest request, the one place boto3 itself was
│   │   │                       # already being imported
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
│   │   │                       # recognition only through the Recognizer protocol (2r.0);
│   │   │                       # step 11.8 — the `trace` middleware (X-Ray, XRAY_ENABLED-
│   │   │                       # gated, registered LAST so it wraps `guard`/CORS too, and
│   │   │                       # hand-written since aws-xray-sdk has no ASGI/FastAPI
│   │   │                       # integration). Syncs `_X_AMZN_TRACE_ID` from the incoming
│   │   │                       # `X-Amzn-Trace-Id` header before opening a subsegment — a
│   │   │                       # real incident, not defensive code: Lambda Web Adapter
│   │   │                       # forks uvicorn once at cold start, so the env var the SDK
│   │   │                       # reads is frozen from that moment on every later request,
│   │   │                       # and every subsegment was silently discarded until this
│   │   │                       # existed. `patch(("boto3",))` deliberately does NOT live
│   │   │                       # here — see stores.py
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
│   │                           # Lambda image the way it is by the managed runtime.
│   │                           # step 11.8 added aws-xray-sdk here too, same reasoning
│   ├── requirements-cnn.txt    # step 2r — torch/torchvision/onnx: TRAINING only.
│   │                           # onnxruntime/scipy moved to requirements.txt when the
│   │                           # CNN became the default (3r.6e) — inference needs them
│   └── cnn/                    # steps 2r/3r — model + inference code the app's
│       │                       # optional CNN path (app/recognizers/local.py) imports
│       ├── classes.py          #   step 15 — NUM_CLASSES/CROSSED_OUT, torch-free (the app reads it)
│       ├── model.py            #   DigitCNN architecture (plan.md §16); 11 outputs since step 15
│       ├── preprocess.py       #   MNIST-matched 28x28 preprocessing, torch-free —
│       │                       #   preprocess_for_cnn (ID) and glyph_to_canvas (segmented glyphs)
│       ├── inspect_preprocess.py #  visual check: real crops -> 28x28 previews
│       ├── segment.py          #   step 3r — cell -> glyphs (merge rule, decimal-by-geometry)
│       ├── decode.py           #   step 3r — constrained decoder (marks/total/serial);
│       │                       #   issues.md N35 (2026-09-10) — decode_value also tries
│       │                       #   each legal value with a leading zero prepended, so a
│       │                       #   mark written "03"/"05" can decode at all
│       ├── id_infer.py         #   step 3r — shared TTA+softmax inference, factored out of accuracy.py
│       ├── train.py            #   EMNIST Digits + augmentation -> ONNX export + parity check;
│       │                       #   step 15 — CROSSED_OUT examples, practice pages, --init-from
│       │                       #   (widens a 10-class checkpoint), --samples-per-epoch
│       ├── pages.py            #   step 15 — practice-page photo -> row-labelled glyph crops
│       ├── strikes.py          #   step 15 — synthetic strikes over EMNIST, rendered through
│       │                       #   inference's own _to_canvas (clean digits too — see its
│       │                       #   docstring), barred 7s rendered as 7s
│       ├── crossed_accuracy.py #   step 15 — caught (held-out practice rows) vs false calls
│       │                       #   (every clean testset/ glyph); --sweep over floors
│       ├── accuracy.py         #   ID accuracy harness, apples-to-apples with id_ocr_accuracy.py;
│       │                       #   CONFIDENCE_FLOOR/MARGIN_FLOOR recalibrated 2026-08-30 against
│       │                       #   the real_class_* batch's ~20 writers (0.9/0.8 -> 0.75/0.6)
│       ├── marks_accuracy.py   #   step 3r.5 — serial/marks/total accuracy, half marks reported
│       │                       #   separately; reads testset/quiz_configs.json's per-photo max
│       │                       #   marks when a label has a "quiz" key (2026-08-30)
│       ├── data/                #  gitignored — EMNIST download (~2GB), regenerated by train.py
│       └── checkpoints/         #  gitignored *.pt; digit_cnn.onnx (~1.8MB) is the real deliverable
└── frontend/
    ├── playwright.config.ts    # 2026-09-25 — real-browser tests (e2e/): Pixel 7 viewport, fake
    │                           # camera, service worker BLOCKED (a request it handles never reaches
    │                           # page.route, so the API mocks would silently stop applying),
    │                           # VITE_API_BASE='' so /api/* is same-origin
    ├── e2e/                    # Playwright specs. Excluded from Vitest in vite.config.ts — their
    │                           # *.spec.ts names match Vitest's default pattern too
    ├── vite.config.ts          # PWA + basicSsl (not mkcert — see Commands) + Vitest config.
    │                           # Step 14.9 — landingShellDevPlugin (apply: 'serve') injects the
    │                           # SAME static landing shell into `vite dev`'s served index.html
    │                           # that scripts/prerender-landing.mjs injects into a real build,
    │                           # via server.ssrLoadModule('/src/prerenderEntry.tsx') — Vite's own
    │                           # supported way to run app source through its dev transform
    │                           # pipeline, no second toolchain. Exported so
    │                           # landingShellDev.test.ts can drive it through a real dev server
    │                           # in middleware mode; before this, `./dev.sh` never served the
    │                           # landing page at all, on any visit
    ├── scripts/
    │   ├── landing-shell.mjs   # step 14.9 — buildBootstrapScript/injectLandingShell, factored
    │   │                       # out of prerender-landing.mjs so the dev plugin above and the
    │   │                       # real build inject byte-identical markup, never two copies that
    │   │                       # can drift; landing-shell.d.mts is its hand-written companion
    │   │                       # (tsconfig.node.json has no allowJs, so a plain .mjs import from
    │   │                       # vite.config.ts needs a declaration file)
    │   └── prerender-landing.mjs  # step 14.5/14.6 — now a thin wrapper: bundles
    │                           # prerenderEntry.tsx via Vite's own SSR build, calls
    │                           # renderLandingMarkup(), and hands the result to
    │                           # landing-shell.mjs's injectLandingShell()
    └── src/
        ├── types.ts            # QuizConfig, StudentRecord — mirrors app/models.py
        ├── db.ts               # IndexedDB (idb) — step 5.2, now DB v5 (step 13):
        │                       # sections/assessments stores replace the retired
        │                       # config/rosterUpload (13.1, migration folds any v1-v4
        │                       # database into them, 13.2); resetAll() clears
        │                       # records+sections+assessments; getSourceId() (11.2.5)
        │                       # lives in a separate `meta` store (DB v2) that resetAll
        │                       # deliberately spares; findRecordsBySerial/
        │                       # findRecordsByStudentId take an assessmentId and
        │                       # filter to it (13.15) — a shared serial/ID across two
        │                       # courses no longer cross-matches; deleteAssessment()
        │                       # (13.24) — one quiz and its records, narrower than
        │                       # deleteSection(), which it does not call
        ├── api.ts              # POST /api/scan client (step 6.4); harvestScan,
        │                       # POST /api/harvest client (step 3r.6c)
        ├── validateConfig.ts   # pure form-validation logic, unit-tested
        ├── validateMarks.ts    # sum check, legal-value check, serial normalisation,
        │                       # identity cross-check (plan.md §10) — step 7
        ├── sections.ts         # step 13.3 (plan.md §18) — pure grouping/sorting/labelling:
        │                       # groupSections (semester -> course -> section, natural-
        │                       # numeric label sort), isDuplicateSection, assessmentConfig
        │                       # (combines an Assessment with its Section into the
        │                       # QuizConfig shape Scan/Review/Results already take —
        │                       # idDigits read from the SECTION, never copied); step
        │                       # 13.14 — lastActivityAt (derived, not stored) and
        │                       # needsResumeConfirmation (compares LOCAL calendar day,
        │                       # not a rolling 24h window); step 13.18 —
        │                       # otherSemesters (EXACT string match, "Fall 2026" and
        │                       # "fall 2026" stay separate on purpose) and purgePreview
        │                       # (per-semester counts + the unexported-assessment block
        │                       # list, 13.19); step 13.22 — SEMESTER_SEASONS (Spring/
        │                       # Summer/Autumn, no Winter), formatSemesterLabel/
        │                       # parseSemesterLabel (the picker <-> stored-string
        │                       # round trip; parse returns null for a pre-picker label
        │                       # like "F26"), currentSemesterSeason (today's own
        │                       # season, used as a brand-new section's starting point
        │                       # and a pre-picker section's edit-time fallback); step
        │                       # 13.23 — sectionDeletePreview, purgePreview's single-
        │                       # section counterpart; step 13.24 — assessmentDeletePreview
        │                       # (one level narrower still) and the shared isBlocking()
        │                       # both now route through — issues.md N36: blocking used to
        │                       # trigger on exportedAt === null alone, which made a
        │                       # brand-new empty assessment (always unexported)
        │                       # permanently undeletable; now also requires a real
        │                       # record count, everywhere the guard is used
        ├── moduleNames.test.ts # a PORTABILITY guard, not a style check: fails if any two
        │                       # source files differ only by case. Windows and macOS resolve
        │                       # `./Results` to `results.ts`, so Landing.tsx/landing.ts and
        │                       # Results.tsx/results.ts each rendered as `undefined`
        ├── resultsTable.ts     # step 9.1/9.2 — sort by serial then ID, unverified-record rule
        ├── roster.ts           # step 12.2/12.3/12.4 (plan.md §17) — class-list roster
        │                       # parsing: header matching, the exclude-then-prefer-then-
        │                       # confirm class-list identification rule, ID normalization
        │                       # for comparison (verbatim IDs are never rewritten); also
        │                       # exports RosterUpload, the shape Setup hands up to App/Results.
        │                       # RosterStudent.row (12.13) carries each student's REAL sheet
        │                       # row — a blank-ID row is skipped while parsing, so student i
        │                       # is not generally at headerRow+1+i; found and fixed before
        │                       # writeTotalsColumn could be trusted, not left as a latent bug
        ├── examSheet.ts        # step 12.5 — pure exam-sheet row matching: roster order,
        │                       # blank (never 0) for an unscanned student, an unmatched
        │                       # scan appended rather than dropped, duplicates AND
        │                       # missingStudents reported (12.12: Results.tsx blocks on the
        │                       # former, lists the latter before every workbook export)
        ├── workbookExport.ts   # step 12.6/12.7/12.8 — the ExcelJS-touching half of the
        │                       # export: sanitizeSheetName (pinned to ExcelJS's own thrown
        │                       # rules), findSheetCollision (case-insensitive; the class-list
        │                       # sheet can never be marked overwritable), writeExamSheet;
        │                       # writeTotalsColumn (12.13, opt-in) writes to each student's
        │                       # own REAL row (RosterStudent.row), never headerRow+1+i —
        │                       # see roster.ts's own comment on why that arithmetic is wrong
        ├── rosterMatch.ts      # step 12.10 — live "is this ID on the list" matching:
        │                       # matched/not-on-list/blank/no-roster, plus a single-candidate
        │                       # suggestion (one digit off, or consistent with a partial
        │                       # "?"-marked read) offered only when it's the UNIQUE explanation
        ├── scanQueue.ts        # upload-queue reducer — step 6.3
        ├── Library.tsx         # step 13.4 (plan.md §18) — the new entry point,
        │                       # `Setup.tsx`'s replacement: semester -> course ->
        │                       # sections -> assessments, self-fetching its own
        │                       # sections/assessments/per-assessment scanned counts.
        │                       # Also absorbed what Setup.tsx used to own: the "How
        │                       # this works" disclosure + always-visible privacy
        │                       # lines, and "Reset everything" (full wipe, untouched —
        │                       # the blunt escape hatch alongside the scoped purge
        │                       # below, step 13.18); step 13.14 — a resume-confirmation
        │                       # banner when opening an assessment last touched before
        │                       # today (needsResumeConfirmation/lastActivityAt,
        │                       # sections.ts); step 13.18/13.19 — the real scoped
        │                       # semester purge, offered ONLY via App.tsx's
        │                       # pendingSemesterOffer prop (one-shot, set right after
        │                       # creating a section in a genuinely new semester),
        │                       # blocked outright by PurgeReviewPanel while any
        │                       # assessment in that semester has exportedAt === null;
        │                       # step 13.23 — a per-section Delete section button (a
        │                       # smaller-blast-radius escape hatch than the semester
        │                       # purge or Reset everything), SectionDeleteReviewPanel
        │                       # using the same block-then-confirm shape,
        │                       # deleteSection()'s existing cascade (db.ts) reused
        │                       # rather than duplicated; step 13.24 — a per-assessment
        │                       # Delete quiz button, AssessmentDeleteReviewPanel (same
        │                       # shape, one level narrower), and the shared
        │                       # TypedDeleteConfirm both delete panels now use — the
        │                       # confirm button stays disabled until the section/quiz
        │                       # name is typed back exactly; step 14.9 — the landing
        │                       # page's "About" way-back button lives in the always-
        │                       # visible .app-header now, not inside the "How this
        │                       # works" <details>, which collapses itself the instant
        │                       # sections.length > 0 and made the original placement
        │                       # undiscoverable for any Library with real data in it
        ├── SectionForm.tsx     # step 13.5/13.9 — create/edit a Section: course code,
        │                       # label, semester (step 13.22 — a Spring/Summer/Autumn
        │                       # button group + a year NumField, not free text; an
        │                       # unparseable pre-picker value falls back to today's
        │                       # own season/year rather than crashing), ID digits, and
        │                       # (Phase B, built in the same pass) an optional
        │                       # class-list workbook upload ported from Setup.tsx's
        │                       # old workbook mode — unchanged in behaviour, but no
        │                       # longer gated behind a plain/workbook mode toggle,
        │                       # since attaching a roster stopped being a per-quiz
        │                       # choice. NumField (2026-09-08 fix) governs the
        │                       # ID-digits and semester-year fields here now
        ├── AssessmentForm.tsx  # step 13.6 — create an Assessment: quiz name, question
        │                       # count, per-question maxes; idDigits inherited from the
        │                       # section, never asked. Setup.tsx's old form minus the
        │                       # ID-digits field and the workbook mode; NumField governs
        │                       # question count/maxes here now; validateConfig.ts reused
        │                       # unchanged
        ├── Scan.tsx            # camera + upload queue — step 6; capture-button
        │                       # spinner/disable and Retake dead-row fix (2026-08-30);
        │                       # step 12.9's "Scanned N of M" header, roster passed to Review;
        │                       # step 13.13 — sectionLabel in the eyebrow, "All sections" button
        ├── Review.tsx          # review/edit/save screen (step 7); fires harvestScan
        │                       # on Confirm, fire-and-forget (step 3r.6c); step 12.10/12.11's
        │                       # matched-name / not-on-list-with-suggestion UI on the ID field;
        │                       # step 13.13 — its own sectionLabel eyebrow, since Review
        │                       # renders as a fixed overlay that hides Scan's header entirely
        ├── Results.tsx         # step 9 — results table, inline editing, Excel export;
        │                       # React.lazy-loaded from App.tsx (ExcelJS is most of its weight);
        │                       # step 12.5-12.8's second export button — writes into the
        │                       # instructor's own class-list workbook when the SECTION has
        │                       # one attached (step 13), always alongside the untouched plain
        │                       # download; step 12.11's Name column; step 12.12/12.13's confirm
        │                       # panel — always shown on a workbook export, blocking outright
        │                       # on a duplicate (Cancel only) or listing who hasn't been
        │                       # scanned yet; the opt-in totals-column checkbox, off by default;
        │                       # step 13.11/13.12 — provenance line + Re-pick + re-cache on
        │                       # every workbook export, verified end to end by exporting two
        │                       # quizzes into one section and reloading the real bytes; step
        │                       # 13.16 — exportFilename(section, quizName) now produces
        │                       # "CSE203-2_Quiz-1_2026-09-09.xlsx"; step 13.20 — stamps
        │                       # exportedAt on both export paths. "Reset everything" moved
        │                       # to Library.tsx (step 13)
        ├── landingShell.ts     # step 14.4/14.6 (plan.md §19) — LANDING_SEEN_KEY and
        │                       # APP_VISIBLE_CLASS, re-exported through prerenderEntry.tsx so
        │                       # the build-time prerender script and the app embed the exact
        │                       # same literals; showLandingOverlay() (Library's "way back")
        │                       # just clears APP_VISIBLE_CLASS, revealing the static landing
        │                       # markup that's been sitting in the DOM the whole visit. Phase
        │                       # A's hasSeenLanding/markLandingSeen are RETIRED — nothing calls
        │                       # them now that scripts/prerender-landing.mjs's inline bootstrap
        │                       # script (plain JS, embedded in dist/index.html) is that check.
        │                       # DEPLOYED_APP_URL (added 2026-09-12) is the app's own live
        │                       # URL, encoded into the close section's share QR code
        │                       # (QrCode.tsx) — the one place in frontend code this string
        │                       # lives; keep it pointed at wherever deploy.sh last published to
        ├── landing.css         # step 14.1/14.6/14.7/14.8/14.9/14.10 — the landing page's own dark palette, scoped
        │                       # entirely under `.landing` (nothing on :root, so the app's
        │                       # own theming is provably unaffected); a 4-step surface ladder
        │                       # reusing the app's dark values verbatim plus one deeper
        │                       # --lp-canvas step; fluid clamp() type ramp rooted at the phone
        │                       # size; section rhythm 48px base -> 64/96 via min-width;
        │                       # .landing .btn-primary etc. override only COLOR on the shared
        │                       # .btn system, since it otherwise reads the app's theme-aware
        │                       # tokens, wrong on a page that's dark unconditionally. Since
        │                       # Phase B, also the static-shell visibility toggle (14.6):
        │                       # `html:not(.ms-app-visible) #root{display:none}` — deliberately
        │                       # never a display:block/flex rule for the visible case, since
        │                       # index.css already owns #root's real flex layout and a same-
        │                       # specificity override would have clobbered it. This file is no
        │                       # longer bundled into the app's own CSS at all (nothing in the
        │                       # client import graph reaches it post-Phase-B) — it's read as
        │                       # raw text by scripts/prerender-landing.mjs instead, becoming
        │                       # dist/index.html's inlined critical CSS. Also carries the scan
        │                       # animation's CSS (14.7/14.8/14.10): `body`/`.landing` use
        │                       # `overflow: clip visible`, NOT `overflow-x: hidden` (14.9 — the
        │                       # latter silently computes `overflow-y: auto` too, which breaks
        │                       # every `position: sticky` descendant, including this section's
        │                       # own pin and the topbar, since Phase A). Phone (base) plays the
        │                       # five states as a plain, self-looping, time-based `animation`
        │                       # (10s, infinite, no `@supports` needed — it runs on the default
        │                       # document timeline) with captions kept as an ordinary compact
        │                       # list below it, NOT scroll-driven (14.10 — a single narrow
        │                       # column has no room for the 55vh-per-caption scroll-runway the
        │                       # crossfade needs, which read as broken even though the
        │                       # underlying sticky/crossfade mechanism was technically correct).
        │                       # Wide (`min-width: 64em`) overrides to the real scroll-linked
        │                       # crossfade via `.lp-scan-scroller`'s view-timeline-name/-axis and
        │                       # five `@keyframes scanStateN` blocks, gated behind
        │                       # `@supports (animation-timeline: view()) and
        │                       # (prefers-reduced-motion: no-preference)` — outside that guard
        │                       # (any narrower viewport, an unsupported browser, or reduced
        │                       # motion) every `.scan-state` defaults to `opacity:0` except
        │                       # `.scan-state-5`, so the worst case is always the settled export
        │                       # view, statically (14.8 ships in the same change as 14.7)
        ├── ScanGraphic.tsx     # step 14.2 — the HERO's static peek only: a settled marks grid
        │                       # (ID row, four marks, one flagged), unanimated by design even
        │                       # after Phase C, since the hero is a peek above the fold, not
        │                       # the scrollytelling section
        ├── QrCode.tsx          # added 2026-09-12 — the share QR code on the landing page's
        │                       # close section: a plain, hand-rolled inline SVG (no image
        │                       # request, matching ScanGraphic.tsx's convention) built from
        │                       # qrcode-generator's raw module matrix, run-length merged per
        │                       # row into one <path> instead of one <rect> per module, and
        │                       # encoded in QR's Alphanumeric mode on an uppercased bare
        │                       # origin rather than Byte mode — both purely to fit plan.md
        │                       # §19's weight budget (raised to ~12KB gzip the same day to
        │                       # cover this feature's real, unavoidable cost; see plan.md
        │                       # §19's Weight budget table). A bare-origin URL's scheme and
        │                       # host are case-insensitive, so the uppercasing changes
        │                       # nothing about where it resolves — isBareOrigin() gates this
        │                       # so a future caller passing a URL with a path/query keeps its
        │                       # exact case in the more expensive Byte mode instead. Verified
        │                       # by decoding the actual built SVG path with a real QR decoder
        │                       # (jsQR), not just by trusting the encoder
        ├── ScanAnimation.tsx   # step 14.7/14.8 (plan.md §19) — the "How it works" section's
        │                       # actual scroll-linked animation: one shared viewBox, five
        │                       # <g class="scan-state-N"> groups (photographed/rotated,
        │                       # straightened/detected, cells separated, digits resolved with
        │                       # Q3 flagged, the export as a mini spreadsheet row) crossfading
        │                       # via opacity so there's no layout shift between them; unlike
        │                       # ScanGraphic, includes a SERIAL row (§19's phone-reduced grid
        │                       # needs one). The pin is aria-hidden — the captions beside/
        │                       # beneath it (reusing .lp-step/.lp-list unchanged) already carry
        │                       # the same content as real text. Purely presentational, no
        │                       # hooks, for the same renderToStaticMarkup reason as Landing.tsx
        ├── Landing.tsx         # step 14.2/14.3 — the landing page itself (plan.md §19's
        │                       # seven sections); purely presentational, no hooks, since
        │                       # prerenderEntry.tsx runs it through renderToStaticMarkup in
        │                       # Node; every factual claim pinned by its own Landing.test.tsx
        │                       # case. Since Phase B (14.6), a BUILD-TIME INPUT ONLY — nothing
        │                       # in the shipped app imports it any more (App.tsx dropped its
        │                       # 'landing' screen), so it ships no runtime chunk. The three
        │                       # data-open-app attributes are what let the static markup's own
        │                       # buttons work with zero JS of their own — onClick={onOpenApp}
        │                       # never serializes into static HTML and exists only for
        │                       # Landing.test.tsx's component-level tests. The close section
        │                       # (added 2026-09-12) also renders QrCode.tsx against
        │                       # landingShell.ts's DEPLOYED_APP_URL, plus the same URL as plain
        │                       # readable/clickable text — for showing the screen to a
        │                       # colleague to scan, instead of reading the address out loud
        │                       # or typing it into a message
        ├── prerenderEntry.tsx  # step 14.5 — the ONLY module scripts/prerender-landing.mjs
        │                       # imports: renderLandingMarkup() (renderToStaticMarkup, actually
        │                       # run) plus a re-export of landingShell.ts's two shared constants, so
        │                       # the Node script embeds the same literals rather than a second,
        │                       # hand-typed copy that could drift
        └── App.tsx             # step 13.7 — a real screen enum (library/section/assessment/
                                 # scan/results) replaces `config === null` as the router;
                                 # threads Section/Assessment down to Scan/Review/Results via
                                 # sections.ts's assessmentConfig(); step 13.18 — the
                                 # SectionForm save handler reads every prior section's
                                 # semester BEFORE saving, and only for a genuine creation
                                 # (never an edit), to decide whether to hand Library a
                                 # one-shot pendingSemesterOffer. Step 14.6 RETIRED the
                                 # 'landing' Screen entirely — the app always starts on the
                                 # library now, since the pre-load landing decision moved into
                                 # the static shell scripts/prerender-landing.mjs builds; Library's
                                 # onShowLanding prop (unchanged) is now wired straight to
                                 # landingShell.ts's showLandingOverlay()
```

`frontend/scripts/prerender-landing.mjs` (step 14.5/14.6, not under `src/`
since it's a Node build script, not app code that Vite ever bundles for
the browser) runs after `vite build`, wired into `npm run build`. It
bundles `prerenderEntry.tsx` to plain JS via Vite's own SSR build mode —
reusing the bundler already doing this exact JSX/TS transform for the
real app is what keeps this step's "no new dependency" rule intact — then
injects the rendered markup, `landing.css`'s raw text, and a ~15-line
inline bootstrap script into the real `dist/index.html`, outside `#root`.

## Commands

All verified working (backend through step 3's rate-limited fallback,
frontend through step 9's Results screen and Excel export).

**These are written for Linux. On Windows, two substitutions cover
everything below** (2026-09-22 — the project was moved to a Windows
laptop; see "Running on Windows" further down for what actually had to
change in code):

- `source venv/bin/activate` becomes `.\venv\Scripts\Activate.ps1` in
  PowerShell, or `source venv/Scripts/activate` in Git Bash. A venv's
  programs live in `Scripts\` there, not `bin/`, and carry `.exe`.
- `./dev.sh` becomes `.\dev.ps1`. The `.sh` scripts themselves do run
  under Git Bash and resolve the venv layout on their own
  (`shell-portability.sh`), but `dev.sh`'s Ctrl+C cleanup depends on
  POSIX process groups that MSYS only approximates — `dev.ps1` is the
  real Windows entry point.

```bash
# Run both servers together — for actual scanning use (step 6+), not
# detector tuning. Ctrl+C stops both, reliably (see learn.md step 6 for
# why that took two fixes: process-group signal targeting, then a
# self-signal re-entrancy bug in the cleanup trap itself).
./dev.sh          # Linux
#  .\dev.ps1     # Windows — same job, console signal + taskkill /T + a Job object
# Both are LOCAL ONLY by default (issues.md N44): this machine can use
# them, the phone can't. For a phone testing session, opt in explicitly —
# both servers then bind every interface, and crops go to
# training_data/unverified/ (review + promote) instead of harvested/:
./dev.sh --lan
#  .\dev.ps1 -Lan
# Real grading uses the deployed site, not the laptop.

# Detection harness — the primary loop for steps 1–3
cd backend && source venv/bin/activate && python detect.py <image-path> --questions 5 --id-digits 7 --out ../testset/debug/<name>
cd backend && source venv/bin/activate && python batch_detect.py ../testset/images --questions 5 --id-digits 7 --out ../testset/debug/
cd backend && source venv/bin/activate && python id_ocr_accuracy.py

# Backend tests — offline, Gemini always mocked, never any AWS. 351 tests
# as of step 17 (2026-09-25); with Tesseract
# installed all 351 run and pass — without it, 2 SKIP (the only ones that
# exercise a real ID read rather than mocking it; the rest of the remote
# path is mocked and needs no binary).
cd backend && source venv/bin/activate && pytest

# CNN accuracy harnesses (steps 2r/3r, plan.md §16). These need NO extra
# install as of step 3r.6e — onnxruntime/scipy are in requirements.txt now
# that the CNN is the default path, and digit_cnn.onnx is committed.
cd backend && source venv/bin/activate
python cnn/accuracy.py                                                # ID accuracy + confidently-wrong count — 91.8% per-digit,
                                                                       # 55.2% whole-ID, 1 confidently wrong (2026-08-30),
                                                                       # vs id_ocr_accuracy.py's 44.5% / 0.0% whole-ID
python cnn/accuracy.py --calibrate                                    # dump confidence/margin per real digit, to pick floors —
                                                                       # last recalibrated 2026-08-30 (0.9/0.8 -> 0.75/0.6) against
                                                                       # the real_class_* batch's ~20 writers, see step.md step 2r
python cnn/half_marks_accuracy.py                                     # 2026-09-25 — decimal points: practice pages
                                                                       # (training_data/pages/values.json) + every harvested
                                                                       # mark cell. WRONG must stay 0 on pages, 3 on harvested
                                                                       # (old corrected misreads). --show / --all-crops to look
python cnn/crossed_accuracy.py --sweep                                # step 15 — crossed-out caught 33/36, clean glyphs
                                                                       # falsely called crossed out 1/328 at floor 0.8
python cnn/marks_accuracy.py                                          # step 3r.5 — 98.1% per-question (half marks 100%),
                                                                       # total 89.5%, serial 63.2% (the weak spot); reads
                                                                       # testset/quiz_configs.json per photo when a label has a "quiz" key

# RETRAINING only — torch/torchvision/onnx are training-only deps, kept out
# of requirements.txt on purpose. CPU-only wheels (no GPU on this machine).
pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements-cnn.txt
python cnn/inspect_preprocess.py ../testset/debug/*/cells/id_d*.png   # look at the 28x28 outputs directly before training anything
python cnn/train.py --epochs 8 --out cnn/checkpoints                  # EMNIST Digits, ~8-10 min/epoch on CPU
python cnn/train.py --init-from cnn/checkpoints/digit_cnn_best.pt     --epochs 3 --samples-per-epoch 80000 --lr 3e-4                   # warm start, ~4 min/epoch — how step 15 trained

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
./deploy.sh frontend     # frontend/ changed (builds, syncs S3, invalidates CDN,
                         # waits for it, then the live browser check)
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

# Crops from the HOSTED site land in the bucket's unverified/ prefix, not
# harvested/ (issues.md N40: anyone with the URL can post any labels). They
# never reach the training set unless you look at them first:
AWS_PROFILE=marks-scanner   ./fetch-crops.sh review marks-scanner-crops-105322541848   # -> training_data/unverified/
./fetch-crops.sh promote <source-id>                           # one checked source -> all/

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
uvicorn app.main:app --reload --host 127.0.0.1 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
#   (--host 0.0.0.0 only for a phone session; ./dev.sh --lan does that for you)

# Frontend — HTTPS is on via vite.config.ts; it binds localhost only unless
# MARKS_LAN=1 (set by ./dev.sh --lan / .\dev.ps1 -Lan), issues.md N44
cd frontend && npm run dev
cd frontend && npx vitest run   # 456 as of step 17 (2026-09-25); 421 at step 15's follow-ups (2026-09-24); 408 at the 2026-09-22 Windows port (moduleNames.test.ts);
                                 # 407 at the 2026-09-12 share-QR-code addition (dev-mode landing
                                 # shell, "About" button, the overflow/sticky fix, and the phone scan
                                 # animation fix were step 14.10, 2026-09-10)
                                # (use `npm run build` to typecheck — see the tsc caveat below); or `npx vitest` for watch mode
cd frontend && npm run build

# Real-browser tests (Playwright, added 2026-09-25 for step 16). Starts its
# own Vite dev server on :5199 and MOCKS /api/scan, so no backend is needed.
# Chromium runs with a fake camera, so the capture flow works. Screenshots
# for eyeballing land in frontend/test-results/screens/ (gitignored).
cd frontend && npx playwright install chromium   # once per machine
cd frontend && npm run test:e2e
# The PRODUCTION build in a real browser (issues.md N43): builds, serves
# with `vite preview`, and fails on any Content-Security-Policy violation
# across the landing page, camera, Confirm, Results and Excel export.
cd frontend && npm run test:e2e:prod
# The LIVE site in a real browser — CSP <meta> present, landing -> app ->
# service worker with zero CSP violations. Sends no scans. deploy.sh RUNS
# THIS ITSELF as the last step of `frontend` and `all` (verify_live_site,
# after waiting for the CloudFront invalidation) and fails the deploy if it
# fails; run it by hand only to re-check without deploying.
cd frontend && node e2e-prod/live-check.mjs
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

## Running on Windows

Built and run on Ubuntu until 2026-09-22, then moved to a Windows 11
laptop. Both are supported now; nothing was made Windows-only, and the
Linux path is unchanged. Verified on Windows: both test suites, a real
end-to-end scan through the HTTPS backend, the production build with its
prerendered landing page, `dev.ps1`, `preflight.sh`, `fetch-crops.sh`, and
both CNN accuracy harnesses — the last two reproduce the documented
numbers exactly (91.8% per-digit ID / 55.2% whole-ID / 1 confidently
wrong; 98.1% per-question marks), which is the real evidence that
recognition behaves identically on the two platforms.

Docker Desktop, the AWS CLI and Tesseract were installed on 2026-09-22,
which closed most of that gap. Also verified since: `preflight.sh` at 0
blockers (including the container building for linux/amd64 and a real scan
succeeding inside it on a read-only root), `local-stack.sh up` end to end
with harvesting to MinIO over the real S3 API, `fetch-crops.sh local`, and
a real scan on `RECOGNIZER=remote` — Tesseract reading the ID locally
(flagging uncertain digits as `?` rather than guessing) while Gemini
returned serial and marks correctly.

Two things only running them could have found:

- **`local-stack.sh`'s docker BUILD CONTEXT still used an MSYS path.** The
  first run died with `unable to prepare context: path not found`. The
  `-v` mount had been fixed and the build context had not — a build
  context is a host path handed to docker.exe exactly like a mount is.
  Fixed, and an audit across all four scripts then found the same
  omission in `fetch-crops.sh`'s `aws s3 sync` destination.
- **The harvested keys in MinIO use forward slashes** —
  `harvested/<source>/id_digits/confirmed/7_<hash>.png` — live proof that
  `.as_posix()` in the harvest tests was fixing the TEST rather than
  masking a real Windows key-layout bug. The `test-` source prefix was
  honoured too: 14 crops excluded, the real corpus untouched at 319.

**Still not verified:** `deploy.sh` itself, which has never been run.
preflight covers the image build and AWS auth, but not `docker push` to
ECR, the Lambda update, `aws s3 sync` of the frontend, or the CloudFront
invalidation. The `mktemp` + `file://` CloudFront-config path only runs
when CREATING a distribution, and one already exists, so that branch
stays untested by design.

**Windows Firewall is a step Linux never needed.** The LAN network here
is categorised Public, inbound defaults to block, and the pre-existing
node/python rules point at other binaries entirely (`E:\node js\node.exe`,
an nvm Node, the base Python) — none of them the ones this project runs.
Two inbound rules were added, by PORT rather than by binary so they
survive a Node or Python upgrade, scoped to `LocalSubnet` so only devices
on the same Wi-Fi can reach them:

    Marks Scanner backend (dev)   TCP 8000  LocalSubnet  Allow
    Marks Scanner frontend (dev)  TCP 5173  LocalSubnet  Allow

Whether they are sufficient can only be settled by a real phone — a
request from this machine to its own LAN IP does not traverse the
firewall at all, so it proves the servers bind and serve, nothing more.


Six things genuinely broke. Two were real bugs that existed on Linux too
and were merely invisible there:

**1. Two pairs of modules collided on a case-insensitive filesystem.**
`Landing.tsx`/`landing.ts` and `Results.tsx`/`results.ts`. Vite resolves
an extensionless `./Results` by trying extensions in order, and on
Windows the `stat` for `Results.ts` finds `results.ts` — so
`import Results from './Results'` returned the pure-logic module, whose
default export does not exist. Every component rendered as `undefined`,
with React's generic "Element type is invalid" as the only clue, and 52
tests failed. Renamed to `landingShell.ts` and `resultsTable.ts`.
`moduleNames.test.ts` now fails on ANY two source files whose names
differ only by case — including on Linux, which is the point: the person
who creates the collision is usually not the person whose machine breaks.

**2. `python3` is not a name that exists on Windows** — and worse than
absent, a stock Windows 11 has an app-execution alias at exactly that
name which prints "Python was not found" and exits non-zero. Four shell
scripts called it. `shell-portability.sh`'s `portable_python` resolves it
by *executing* a candidate rather than trusting `command -v`, which the
stub answers.

**3. A venv keeps its programs in `Scripts\`, not `bin/`.** Same helper:
`venv_bin_dir`, `venv_exe`, `venv_activate`. This is why `dev.sh`,
`preflight.sh` and `local-stack.sh` could not find their own venv.

**4. `execFileSync('npm', ...)` in `prerender.test.ts`** — `npm` is
`npm.cmd` on Windows, which fails twice over: `execFileSync` does not
consult PATHEXT (ENOENT), and since the fix for CVE-2024-27980 Node
refuses to spawn a `.cmd` without `shell: true` (EINVAL).

**5. Two harvest tests compared Store keys against `str(WindowsPath)`,**
so every assertion saw `\` where the key has `/`. The production code was
right — `harvest.py`'s `_key` builds keys with `/` on every platform,
which is what keeps the local and S3 layouts byte-identical — and the
tests now use `.as_posix()`. A test-only bug, but it would have been read
as an S3 key-layout failure.

**6. Native Windows tools do not understand MSYS paths, and MSYS mangles
container paths.** `aws.exe` and `docker.exe` cannot open `/g/Dev/...`,
and Git Bash rewrites any argument starting with `/` — so `-v vol:/data`
became `-v vol:C:/Program Files/Git/data`. Host paths now go through
`native_path`; `disable_msys_path_conversion` protects container-side
ones. Both are no-ops on Linux. **Untested** — see above.

Two things were made more helpful rather than fixed, both about optional
binaries that Windows installs without putting on PATH:

- `app/id_ocr.py` now probes `C:\Program Files\Tesseract-OCR` when
  `tesseract` is not on PATH, with `TESSERACT_CMD` in `backend/.env` as
  the explicit override (`app/config.py`). `tesseract_missing_message()`
  replaces a six-frame `TesseractNotFoundError` traceback with an
  actionable message, and the two `test_main.py` tests that need a real
  Tesseract now SKIP rather than fail — the binary is genuinely optional
  since `cnn` became the default, so a suite that hard-fails without it
  reports a broken app on a correct default install.
- `gen_dev_cert.py` finds Git for Windows' own `openssl.exe` when
  `openssl` is not on PATH, which it usually is not. Verified by
  stripping PATH to `C:\Windows\System32` and generating a cert anyway.

**`.gitattributes` was added, and it is load-bearing.** Git for Windows
defaults to `core.autocrlf=true`, which would rewrite every `.sh` file's
line endings on checkout — a CRLF shebang makes the kernel look for an
interpreter literally named `bash\r`. `*.sh` and `Dockerfile` are pinned
to `eol=lf`; the photos, the `.onnx` model and the `.pem` certs are
pinned `binary` so they are never translated at all.

Deliberately NOT changed: `dev.sh` keeps its `kill -TERM 0` process-group
cleanup, because that is correct on Linux and the long comment explaining
it records two real bugs. `dev.ps1` is a separate file rather than a
branch inside `dev.sh` — Windows has no process groups in that sense, so
the mechanism is different all the way down: the shared console carries
Ctrl+C, `taskkill /T` walks the tree in the finally block, and a Job
object with KILL_ON_JOB_CLOSE covers a hard kill of the script itself.
That last one needed a second, delayed pass to actually work —
`venv\Scripts\python.exe` is a launcher that spawns the real interpreter
faster than the script can assign it to the job, so uvicorn and its
reload worker were being born outside. Verified by hard-killing the
script twice and confirming both ports come back bindable.

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
**Per table, since 2026-09-25**: a mismatch in one table no longer fails the
whole scan. `detect()` writes no crops for a miscounted table, and `main.py`
reads only the tables that matched, returning `table_mismatches` with those
fields blank and flagged (a partial scan). Two cases still fail outright: a
mismatch in every table, and a wrong "Serial box on paper" setting
(`_is_partial` — the ID is picked by position, so the wrong setting shifts
the pick onto the wrong box). Separately, `_repair_columns` fixes a table off
by exactly one, but only by restoring a line the detector really saw (above
the absolute coverage floor) or removing a split, and only when exactly one
such change makes the boxes evenly spaced with both neighbouring cells the
right width. `tests/test_grid_repair.py` is mostly the refusals — keep them.

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
- **Don't call Gemini after `table_not_found`, or for a marks table whose
  column count mismatched.** The test suite asserts the mock was *not*
  invoked — it protects the quota and the privacy property at once. Since
  partial scans (2026-09-25) Gemini IS still called when only the ID or
  Serial row mismatched, because the marks table it reads was fine.
- **Don't commit a photo saved from the failure screen.** Review's Save
  photo keeps the capture on the phone for adding to the detector's test
  set, and it is a real script with a real student ID on it. Put those in
  `testset/private/` (gitignored), never `testset/images/`.
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
- **Don't add a `style="…"` attribute or a new inline `<script>`/`<style>`
  to the prerendered landing page and assume it works in production**
  (issues.md N43). `scripts/csp.mjs` hashes the inline blocks that exist at
  build time, so new `<style>`/`<script>` blocks are covered automatically,
  but style ATTRIBUTES are blocked by the policy and `vite dev` has no policy
  at all, so it will look fine locally. `npm run test:e2e:prod` is the check:
  it runs the real production build in a browser and fails on any CSP
  violation. The response headers (HSTS, framing, Permissions-Policy) are
  `aws/headers_policy.py`'s, applied by deploy.sh.
- **Don't point the hosted Lambda's `HARVEST_PREFIX` back at `harvested/`,
  and don't promote an unverified source without looking.** `/api/harvest`
  is public and takes the labels from the caller, so a hosted crop's label
  is a claim (issues.md N40). `deploy.sh` sets `HARVEST_PREFIX=unverified`;
  `fetch-crops.sh review` then `promote <source-id>` is the only way in.
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
- **Don't coerce a number input's value on every keystroke.** `Number('')`
  is `0`, not `NaN`, and an `<input>` reports `''` the moment you delete
  its last character — so `onChange={e => setX(Number(e.target.value))}`
  writes a literal `0` into any box the instructor clears, and the digits
  they type next land after it (`10` → `010`). Controlled inputs re-render
  from state on every keystroke, so a lossy transform in the handler is
  applied to what was typed *before it is finished*. Hold `number | ''` and
  convert once, at submit — to `NaN`, not to a default, so an emptied field
  fails validation instead of silently validating as something the user
  never typed. Fixed in `Setup.tsx` 2026-09-08; the caret behaviour that
  produces the visible symptom cannot be reproduced in jsdom, so the tests
  pin the cause (a cleared box stays empty) rather than the symptom.
- **Don't verify the frontend with a bare `npx tsc --noEmit`.** The root
  `tsconfig.json` is a solution file (`"files": []` plus references), so
  that command typechecks *nothing* and passes on genuinely broken code.
  Use `npm run build` (which runs `tsc -b`) or `tsc -p tsconfig.app.json`.
- **Don't add a source file whose name differs from an existing one only
  by case.** `Landing.tsx` + `landing.ts` and `Results.tsx` + `results.ts`
  both existed and both were broken — invisibly on Linux, catastrophically
  on Windows and macOS, where the filesystem is case-insensitive and Vite
  resolves an extensionless `./Results` by `stat`-ing `Results.ts`, which
  *finds* `results.ts`. The component came back `undefined` and React
  reported only "Element type is invalid"; 52 tests failed at once. The
  files are `landingShell.ts` and `resultsTable.ts` now, and
  `moduleNames.test.ts` fails on any new collision — on every platform,
  deliberately, because whoever creates one is usually not the person
  whose machine breaks.
- **Don't call `python3` from a shell script.** It is not a name that
  exists on Windows, and the failure is worse than absence: a stock
  Windows 11 has an app-execution alias at that exact path which answers
  `command -v` and then prints "Python was not found" and exits non-zero.
  Use `shell-portability.sh`'s `portable_python`, which resolves the name
  by *running* a candidate. Same file for the venv layout —
  `venv/bin/python` does not exist on Windows, it is
  `venv\Scripts\python.exe` — via `venv_exe` / `venv_activate`.
- **Don't spawn `npm` (or any `.cmd`) with `execFileSync` and no
  `shell: true`.** On Windows `npm` is `npm.cmd`, and two separate things
  break: `execFileSync` does not consult PATHEXT, so the bare name is
  ENOENT; and since the fix for CVE-2024-27980 Node refuses to spawn a
  `.cmd`/`.bat` without a shell at all, which is EINVAL. `prerender.test.ts`
  hit both in turn.
- **Don't compare a Store key against `str(some_path)` in a test.**
  `harvest.py` builds keys with `/` on every platform on purpose — that is
  what keeps the local and S3 layouts byte-identical, which is
  `stores.py`'s entire premise — but `str()` on a `WindowsPath` returns
  `\`. Six harvest tests failed on Windows for a reason that had nothing
  to do with harvesting, while reading exactly like an S3 key-layout
  failure. Use `.as_posix()`.
- **Don't hand an MSYS path to a native Windows program, or a
  container-side path to MSYS.** These are two halves of the same trap and
  both bite in the same scripts. `aws.exe` and `docker.exe` cannot open
  `/g/Dev/...`, so host paths go through `native_path`. Git Bash rewrites
  any argument starting with `/` before the program sees it, turning
  `-v vol:/data` into `-v vol:C:/Program Files/Git/data`, so scripts that
  drive docker call `disable_msys_path_conversion` first. Both are no-ops
  on Linux. Note these are the one part of the Windows work that is
  **untested** — this laptop has neither Docker nor the AWS CLI.
- **Don't remove `.gitattributes`, and don't "fix" its `eol=lf` lines.**
  Git for Windows installs with `core.autocrlf=true`. Without the pin, a
  fresh clone there gets CRLF in every `.sh` file, and a CRLF shebang
  makes the kernel look for an interpreter named `bash` followed by a
  carriage return — an error message with an invisible character in it.
  The photos, `digit_cnn.onnx` and the dev `.pem` files are pinned
  `binary` for the same reason, one layer worse: translation corrupts them
  outright.
- **Don't state that everything stays on the device.** `Setup.tsx` said
  exactly that from step 5 until 11.5 corrected it, while `/api/harvest`
  had been saving labelled cell crops server-side since 3r.6c. The true
  statement has two halves and both must stay: the *photograph* is never
  stored, and *individual cells* are kept with their confirmed values to
  train and tune recognition. This disclosure now lives in `Library.tsx`
  (step 13 retired `Setup.tsx` and moved it there, since Library is the
  new first-visited screen); `Library.test.tsx` pins the always-visible
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
- **Don't set `overflow-x` without also setting `overflow-y` (or vice
  versa) on anything that's an ancestor of a `position: sticky` element.**
  `body`'s and `.landing`'s `overflow-x: hidden` (there to guarantee no
  horizontal scroll at 320px) each silently computed `overflow-y: auto`
  too — the CSS Overflow spec couples the two axes whenever exactly one is
  non-`visible` — which turns the element into a scroll container, and any
  scroll-container ancestor between a sticky element and the real viewport
  confines its stickiness to a box that, here, never itself scrolls. The
  practical effect: `.lp-topbar` (the pinned CTA, decision 1's own core
  requirement) and step 14.7's scan-animation pin never stuck to anything,
  since Phase A — and the real app's own `.data-table thead th` sticky
  Results header almost certainly hasn't either, on any real device,
  since nothing before this could have caught it (jsdom renders no layout
  at all). Found from a user screenshot (step 14.9), fixed with
  `overflow: clip visible` instead of `overflow-x: hidden` in both
  places — `clip` clips the same overflow without ever computing a
  non-`visible` value on the other axis. Verified with a real Playwright/
  Chromium browser, not jsdom: before the fix, sticky elements' positions
  drifted in lockstep with `window.scrollY`; after, they held their `top`
  offset through 2000px of real scrolling.
- **Don't force a scroll-linked, multi-caption scrollytelling layout into
  a single narrow column.** Step 14.7's phone layout gave a pinned
  graphic's five captions `min-height: 55vh` each so the pin would have
  scroll-runway to crossfade against — correct in a two-column desktop
  layout, where a second column is genuinely that tall anyway, but on
  one narrow column it meant several full screens of near-empty black
  space per caption. The crossfade and the sticky pin were both, by
  every measurement, working *correctly* — that's what made this one
  easy to miss by inspecting the CSS alone, and why it had to be caught
  with an actual iPhone-sized Playwright viewport (step 14.10) rather
  than assumed fixed once 14.9's sticky bug was gone. Technically-correct
  behavior surrounded by that much dead space still reads as broken. The
  fix wasn't more tuning — it was recognizing phone doesn't have room for
  scrollytelling at all, and falling back to a plain, self-looping,
  non-scroll-driven animation there instead, with the captions kept as
  an ordinary compact list (not removed — the graphic is `aria-hidden`,
  so the captions are the section's only text for a screen reader).

## Deferred — don't build these

Client-side detection with OpenCV.js · **server-side** database ·
multi-user auth · a template generator (there deliberately isn't one — the
grid is a Docs table pasted by hand) · an override for a mark above a
question's printed max (see plan.md §13 for the full account — a real
want raised 2026-09-09, not yet specced).

**Local multi-quiz history came off this list on 2026-09-09**, and the
split matters: this line used to read "server-side database and multi-quiz
history" as one item, which conflated a server with *remembering more than
one quiz*. Holding a semester in IndexedDB needs no server, no account,
and no privacy surface beyond the device the marks are already on. Without
it, four sections cost eight config entries and eight class-list uploads
per quiz round, and grading the second CSE203 section requires deleting
the first's marks. Specced as plan.md §18 / step.md step 13; **Phases A
and B are built (2026-09-10)** — a second quiz genuinely no longer
destroys the first, and a section's class list is picked once. **Not
built**: the real scoped semester purge (a full "Reset everything" wipe
stands in for it), resume confirmation, and assessment-scoped duplicate
detection (still global — a shared serial across two courses raises a
false conflict today). A server-side database and multi-user auth stay
deferred for the original reason.

**A deliberate override for a mark above a question's printed max —
raised 2026-09-09, not specced, no code.** Today `[0, max]` is
unrepresentable by design: `decode_value` never scores an out-of-range
value as a candidate, `isLegalValue` blocks Confirm client-side,
`legal_values` rejects it server-side — there is no way to type `6` on a
5-mark question and save it. That's correct for a misread or a
printed-max mismatch (N31/N33, fixed the same day, exist to make the
resulting blank informative rather than silent). It is NOT yet correct
for a genuine bonus mark the instructor means to award — today the only
route is outside the app, hand-editing the exported `.xlsx` after the
fact. Two directions, undecided between: a per-question tolerance set at
config time (cheap, widens the ceiling for every student on that
question) or an explicit per-field override action on Review (keeps every
other student's ceiling untouched, needs its own confirmation UI and its
own harvest tagging so it never trains the model to treat an above-max
read as legal). Either way, what `sumCheck`/`totalMax` compare against
once one question can legitimately exceed its own max is unresolved. See
plan.md §13 for the full writeup.

**Roster import is no longer on this list.** It was deferred "to avoid
file-upload complexity"; picked back up 2026-09-07 once it became clear
the roster already exists as a workbook the instructor keeps all semester,
so the complexity being avoided was a roster *management* system, not a
file picker. See plan.md §17 and step.md step 12 — four
independently-shippable phases, **all four built 2026-09-07**, plus six
fixes from real phone use. Step 13 then moves the upload from the quiz to
the *section*, which is where the class list actually belongs.

**No longer simply deferred:** a local mark classifier (TFLite/ONNX) was on
this list until the deferral's own trigger condition — "only if Gemini
accuracy or quota becomes a real constraint" — actually happened (a real
`rate_limited` response, and `id_ocr.py` measured at 58.9% per-digit on
the real photos that existed at the time — 8 of them; re-measured on the
full 29-photo set on 2026-09-22 it is 44.5%). There's now a concrete, additive, optional build order for
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
