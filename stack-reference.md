# Stack Reference

Library-by-library notes for [plan.md](plan.md), pulled from Context7. Covers
only what the plan actually calls for, mapped back to the section that needs it.

Resolved Context7 IDs, if you want to re-query any of these:

| Technology | Context7 ID |
|---|---|
| OpenCV (Python API) | `/opencv/opencv-python` |
| OpenCV (full docs, 4.13) | `/websites/opencv_4_13_0` |
| pytesseract | `/madmaze/pytesseract` |
| Google Gen AI Python SDK | `/googleapis/python-genai` |
| Gemini API | `/websites/ai_google_dev_gemini-api` |
| FastAPI | `/websites/fastapi_tiangolo` |
| Pydantic | `/pydantic/pydantic` |
| idb | `/jakearchibald/idb` |
| ExcelJS | `/exceljs/exceljs` |
| vite-plugin-pwa | `/vite-pwa/vite-plugin-pwa` |
| React | `/reactjs/react.dev` |
| Vite | `/vitejs/vite` |

---

## Three corrections to the plan

All three are now applied to `plan.md`; kept here as the record of why it
says what it says.

**1. `google-generativeai` is the wrong package (§7).** That SDK is retired.
The current one is `google-genai`, imported as `from google import genai`.
Everything below uses it.

**2. FastAPI cannot mix a file upload with a JSON body (§9).** The docs are
explicit: "you cannot combine `File` or `Form` parameters with standard JSON
Body fields in the same request, because HTTP requests encode the body as
`multipart/form-data` rather than `application/json`." So `POST /api/scan`
taking "multipart image + `QuizConfig`" doesn't work as written. Send the
config as a form field holding a JSON string and parse it in the handler.

**3. Don't hand-roll the 429 backoff (§9).** The SDK already does exactly what
the plan describes. See the retry section below.

---

## Grid detection — OpenCV (§5, §6)

The OpenCV docs ship a tutorial that is almost line-for-line the plan's
step 1: *Extract horizontal and vertical lines by using morphological
operations*. Its parameters are a good first guess before you start tuning
against the test set.

```python
# adaptive threshold on the INVERTED gray image — note the ~
bw = cv2.adaptiveThreshold(~gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                           cv2.THRESH_BINARY, 15, -2)

# kernel length scaled to image size, not a fixed pixel count
horizontal_size = bw.shape[1] // 30
vertical_size   = bw.shape[0] // 30

hk = cv2.getStructuringElement(cv2.MORPH_RECT, (horizontal_size, 1))
vk = cv2.getStructuringElement(cv2.MORPH_RECT, (1, vertical_size))

# erode-then-dilate == MORPH_OPEN; keeps only runs longer than the kernel
horizontal = cv2.dilate(cv2.erode(bw, hk), hk)
vertical   = cv2.dilate(cv2.erode(bw, vk), vk)
```

Scaling the kernel to `cols/30` rather than a constant is what makes step 2
work at any grid size — the same reason the plan insists detection be
proportional. The `/30` divisor is the first knob to turn: raise it to catch
shorter lines, lower it to reject text strokes that survive as false lines.

**Finding the table rectangles (step 2).**

```python
mask = cv2.add(horizontal, vertical)
contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
for c in contours:
    if cv2.contourArea(c) < min_area:
        continue
    approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
    if len(approx) == 4:
        ...  # a table candidate
```

`approxPolyDP`'s epsilon is the second tuning knob — too small and a slightly
curled page yields 5–6 points instead of 4, which reads as "no table found"
on exactly the crumpled-paper case in the test set.

**Deskew (step 3).** Order the four `approx` points TL/TR/BR/BL, then:

```python
M = cv2.getPerspectiveTransform(src_quad, dst_rect)
warped = cv2.warpPerspective(img, M, (w, h))
```

`cv2.minAreaRect` + `cv2.boxPoints` is the fallback when `approxPolyDP`
won't give a clean quad — it always returns exactly 4 vertices, ordered
bottomLeft, topLeft, topRight, bottomRight. Worth having as a second path
rather than failing the photo outright.

**Cell boundaries (step 4).** Recover them by projecting the `horizontal` and
`vertical` masks — column-sum the vertical mask to get x positions, row-sum
the horizontal mask to get y positions, then cluster adjacent peaks. This
reads the actual line positions, which is what the plan requires; don't
divide the width by the column count.

---

## Student ID OCR — pytesseract (§9 step 5)

The plan's `--psm 10` + digit whitelist is confirmed correct. PSM 10 is
"single character", which is the right mode for one crop per box.

```python
config = r'--oem 3 --psm 10 -c tessedit_char_whitelist=0123456789'
digit = pytesseract.image_to_string(crop, config=config).strip()
```

For the `low_confidence_fields` logic, `image_to_string` gives you no
confidence value — use `image_to_data` instead, which returns a `conf`
column per detection:

```python
df = pytesseract.image_to_data(crop, config=config,
                               output_type=pytesseract.Output.DATAFRAME)
df = df[(df.text.notna()) & (df.text.str.strip() != '') & (df.conf > 60)]
```

Empty result or `conf` below your threshold → add `"student_id"` to
`low_confidence_fields`. A conf floor of 60 is the value the docs use in their
own example; treat it as a starting point to calibrate on real ID crops.

`--oem 3` is the default engine mode. Also set `pytesseract.pytesseract.tesseract_cmd`
explicitly if the binary isn't on the PATH the backend process actually sees —
that's the usual cause of "works in my shell, 500s from the app."

---

## Serial + marks — Google Gen AI SDK (§9 steps 7–8)

**Structured output does the plan's constrained-enumeration job for you.**
Pass a Pydantic model as `response_schema` and the model is constrained to it:

```python
from google import genai
from google.genai import types
from pydantic import BaseModel

client = genai.Client()  # reads GEMINI_API_KEY from env

class ScanPayload(BaseModel):
    serial: str | None
    marks: list[float | None]

response = client.models.generate_content(
    model='gemini-2.5-flash',
    contents=[prompt, types.Part.from_bytes(data=composite_png,
                                            mime_type='image/png')],
    config=types.GenerateContentConfig(
        response_mime_type='application/json',
        response_schema=ScanPayload,
    ),
)
```

The docs add a note worth heeding: **do not restate the schema or the expected
JSON format in the prompt** when using `response_schema` — it's redundant and
degrades results. So the prompt should carry the *legal value set per question*
(the 0, 0.5, … max enumeration from §4) and nothing about output shape.

The schema constrains structure, not range — a `float` field can still come
back as `7` for a 5-mark question. Plan §9 step 8's server-side rejection of
out-of-set values is still required. Keep it.

**Retries are built in (§9).** The SDK retries 408/429/500/502/503/504 with
exponential backoff and jitter by default: 5 attempts, 1.0s initial delay,
base 2.0, capped at 60s. That is the plan's "1s, 2s, 4s, 8s" already
implemented. Configure rather than reimplement:

```python
config=types.GenerateContentConfig(
    http_options=types.HttpOptions(
        retry_options=types.HttpRetryOptions(attempts=5, initial_delay=1.0,
                                             exp_base=2.0, max_delay=30.0)))
```

When attempts are exhausted the SDK re-raises the `APIError`; catch it, check
`e.code == 429`, and return `failure_reason: "rate_limited"`.

One trap the docs call out explicitly: **a blocked or empty response is a 200,
not an exception, so it is never retried.** Check `prompt_feedback.block_reason`
and `candidates[0].finish_reason` yourself and map those to `"model_error"` —
otherwise a blocked response surfaces as an unhandled `None` when you parse
`response.text`.

**Free tier and privacy.** Pricing docs confirm §12's premise directly: "Free
Tier usage is free of charge but may be used to improve Google products,
whereas Paid Tier data is not used for product improvement." The plan's
decision to keep the student ID off this path is correctly motivated.

Note that model naming has moved on from the 2.5 generation — check the current
model list before pinning a name, since free-tier availability varies by model.
Rate limits are per-model and published at `ai.google.dev/gemini-api/docs/rate-limits`;
the plan's "~10 RPM" assumption should be verified against whichever model you
settle on.

---

## Backend — FastAPI (§9)

Given the multipart/JSON constraint above, the endpoint looks like:

```python
from typing import Annotated
from fastapi import FastAPI, File, Form, UploadFile

@app.post("/api/scan")
async def scan(
    image: Annotated[UploadFile, File()],
    config: Annotated[str, Form()],      # QuizConfig as a JSON string
) -> ScanResult:
    quiz = QuizConfig.model_validate_json(config)
    ...
```

`UploadFile` over `bytes` for the image — `bytes` buffers the whole file in
memory, `UploadFile` spools to disk past a threshold and exposes
`.content_type`, which you want for the mime type on the Gemini call.

Requires `python-multipart` installed. CORS via `CORSMiddleware` from
`fastapi.middleware.cors`, since the phone loading the PWA and the
laptop serving the API are different origins even on the same machine.

FastAPI ≥ 0.113 also supports annotating a whole Pydantic model with `Form()`
to parse form fields into it, if you'd rather send config as flat fields than
a JSON string.

---

## Session state — idb (§7, §8)

```typescript
import { openDB, DBSchema } from 'idb';

interface ScanDB extends DBSchema {
  records: {
    key: string;                        // StudentRecord.id (uuid)
    value: StudentRecord;
    indexes: { 'by-serial': string; 'by-studentId': string };
  };
  config: { key: string; value: QuizConfig };
}

const db = await openDB<ScanDB>('marks', 1, {
  upgrade(db) {
    const s = db.createObjectStore('records', { keyPath: 'id' });
    s.createIndex('by-serial', 'serial');
    s.createIndex('by-studentId', 'studentId');
    db.createObjectStore('config');
  },
});
```

Those two indexes are what make §10's identity cross-check a lookup rather
than a scan of every saved record — `db.getFromIndex('records', 'by-serial', s)`
on save.

Note the indexes must not be `{ unique: true }`. A duplicate serial is exactly
the condition the cross-check exists to *detect and report*; a unique index
would instead throw on write and lose the "show both records side by side"
behavior the plan specifies.

Use `db.put` for both insert and update. Wrap multi-store writes in
`db.transaction([...], 'readwrite')` and `await tx.done`.

---

## Excel export — ExcelJS (§11 Results)

Fully client-side. `writeBuffer()` returns the file in memory; the download is
an object URL and an anchor click, since there is no `writeFile` in a browser:

```javascript
import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Marks');

// built from QuizConfig, so the question columns vary per quiz
ws.columns = [
  { header: 'Serial',     key: 'serial',    width: 8 },
  { header: 'Student ID', key: 'studentId', width: 12 },
  ...config.questions.map(q => ({ header: `Q${q.q}`, key: `q${q.q}`, width: 6 })),
  { header: 'Total',      key: 'total',     width: 8 },
];

ws.addRows(records.map(r => ({
  serial: r.serial,
  studentId: r.studentId,
  ...Object.fromEntries(r.questions.map(q => [`q${q.q}`, q.value])),
  total: r.total,
})));

const buffer = await wb.xlsx.writeBuffer();
const blob = new Blob([buffer], {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `${quizName}.xlsx`;
a.click();
URL.revokeObjectURL(url);
```

The `columns` array carries header text, the row key, and the width together,
which suits a schema that changes per quiz — build it from `QuizConfig` rather
than hardcoding.

Bold the header row with `ws.getRow(1).font = { bold: true }` if you want it;
nothing else here needs styling.

**One thing to watch when bundling.** ExcelJS is written Node-first — its
dependency list includes `archiver`, `unzipper`, `readable-stream`, and `tmp`.
It ships a prebuilt browser bundle at `exceljs/dist/exceljs.min.js` and
declares it via the package's `browser` field, which Vite normally resolves on
its own. If you hit missing-`stream`-or-`buffer` errors at build time, alias
the import to that dist path rather than reaching for Node polyfills. Worth
verifying the export builds early — at step 9 of §14, not the night before.

## PWA shell — vite-plugin-pwa (§7)

```typescript
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [VitePWA({
    registerType: 'autoUpdate',
    devOptions: { enabled: true },      // service worker in dev too
    manifest: {
      name: 'Script Mark Scanner',
      short_name: 'Marks',
      theme_color: '#ffffff',
      icons: [
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png',
          purpose: 'any maskable' },
      ],
    },
  })],
});
```

`devOptions.enabled` matters for this project — camera access via
`getUserMedia` requires a secure context, so you want to be testing the
installed-PWA path early rather than discovering it at the classroom door.
Both 192 and 512 icons are the documented minimum for installability.

---

## Build-order impact

Nothing here changes §14's ordering. Steps 0–3 stay standalone scripts, and
the OpenCV parameters above are starting values for step 1's tuning loop, not
answers to it — the plan is right that only real photographs settle them.

The two items worth acting on before you start: install `google-genai` rather
than `google-generativeai`, and decide now how `QuizConfig` rides along with
the image, since that shapes the step 4 wrapper.
