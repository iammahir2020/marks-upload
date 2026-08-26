# CNN migration — adding a local recognizer alongside the existing one

Adds a local CNN recognition path **beside** the existing Gemini +
Tesseract path, behind a common interface, with the CNN as the default.
Nothing already built gets deleted. Detection (`detection.py`) is
untouched — it works and none of this affects it.

Written against the state in `step.md` as of step 7 done, steps 8–10 not
started.

---

## Why

Three separate reasons, any one of which would justify it.

**Cost and quota.** Gemini free tier rate-limits at ~10 req/min, which
`step.md` step 3 records hitting for real during the phone session. A
local model has no ceiling and no bill.

**Tesseract is the wrong tool and the measurements prove it.** 58.9%
per-digit, 0/8 whole-ID exact match, after two rounds of tuning. The
diagnosis in step 2 is the important part: the LSTM engine read a
handwritten `0` as `D` at 86% confidence and a `1` as `l` at 90%.
Tesseract is a text engine — letters are always in its output space. A
10-class digit classifier cannot make that error at all, so the entire
`DIGIT_LOOKALIKES` fallback layer and its second unconstrained OCR pass
get deleted rather than tuned.

**Latency.** Tesseract runs ~50–100ms per digit, so ~700ms for one ID.
A small CNN does all seven in a single batched forward pass, under 5ms
on CPU.

When the CNN path is active: plan §12's privacy argument becomes trivially
true (nothing leaves the machine), `rate_limited` is unreachable, and
`marks_ocr.py`'s degraded-fallback role disappears. Those properties are
per-path, not global — the Gemini path keeps its existing behaviour and
its existing caveats when selected.

---

## Architecture

One model. Ten classes. Used three ways.

```
                          ┌──────────────────┐
   ID cells (7)  ────────►│                  │──►  7 digits, batched
                          │   digit CNN      │
   Serial cell   ──seg──► │   10 classes     │──►  glyph probabilities
                          │   ~150KB ONNX    │        │
   Mark cells    ──seg──► │                  │──►     │
                          └──────────────────┘        ▼
                                                constrained decode
                                                against legal values
```

**ID** needs no segmentation — the template gives one digit per box, which
is exactly why those boxes exist. Seven crops go through as one batch.

**Serial and marks** hold multiple glyphs in one cell, so they need
segmentation first, then constrained decoding to assemble a legal value.

### The decimal point is not a CNN class

There is no training data for a handwritten decimal point and no need for
any. It is a connected component with tiny area sitting low in the glyph
band — pure geometry, no model. Keeping the model at ten classes means
EMNIST works as-is with no relabelling.

---

## Two paths behind one interface

Neither path is special-cased in `main.py`. Both implement the same
protocol and the pipeline calls whichever is selected.

```python
# app/recognizers/base.py
from typing import Protocol

class Recognizer(Protocol):
    name: str

    def read_id(self, id_crops: list[np.ndarray]) -> IdResult:
        """Seven single-digit crops → digits + confidence per position."""

    def read_marks(
        self, serial_crop: np.ndarray,
        mark_crops: list[np.ndarray],
        total_crop: np.ndarray,
        config: QuizConfig,
    ) -> MarksResult:
        """Cell crops → serial, per-question values, total."""
```

Two implementations:

- `recognizers/remote.py` — `RemoteRecognizer`, wrapping the existing
  `id_ocr.py` (Tesseract) and `marks.py` (Gemini), including
  `marks_ocr.py` as its internal rate-limit fallback. **Moved, not
  rewritten.** The logic inside is already tested and tuned; this is an
  import-path change plus a thin adapter.
- `recognizers/local.py` — `CNNRecognizer`, everything in steps 2r/3r
  below.

Selection by environment variable, defaulting to the local path:

```python
RECOGNIZER = os.getenv("RECOGNIZER", "cnn")   # "cnn" | "remote" | "both"
```

`main.py` resolves it once at startup and holds the instance. The
pipeline's early exits are unchanged — no recognizer is called after
`table_not_found` or `column_count_mismatch`, whichever is selected.

### Comparison mode

`RECOGNIZER=both` runs both and returns the CNN's result, while logging
every field where they disagree to `comparison_log/`:

```json
{
  "image": "phone_003.jpeg",
  "field": "q3",
  "cnn": {"value": 4.5, "confidence": 0.71},
  "remote": {"value": 4.0, "confidence": null},
  "confirmed": 4.5
}
```

This is worth more than it looks. Your labelled set is thin, so accuracy
numbers alone are noisy — but disagreements are self-selecting hard cases,
and the instructor's confirmation in the review screen resolves each one
into a labelled sample. Running `both` for a full quiz gives you a
targeted error analysis and a batch of training labels from the same
session.

Do not run `both` in normal use — it costs Gemini quota for no benefit
once the CNN is ahead.

### Keeping the old path honest

`rate_limited` stays in the failure enum. It is unreachable under the CNN
path and still reachable under the remote one, and deleting it would break
the path you are deliberately keeping.

Step 4's existing test — that no recognizer runs after a detection failure
— gets parameterised over both implementations rather than rewritten. The
property it protects applies to both.

---

## Segmentation

Only for serial and mark cells. Per cell, after the 12% inset already
established in `id_ocr.py`:

1. Otsu binarize.
2. `cv2.connectedComponentsWithStats`.
3. Drop components below a noise-area floor (fraction of cell area).
4. **Merge horizontally-overlapping components.** A `4` or `5` written
   with a disconnected stroke produces two components that are really one
   glyph. If two components' x-ranges overlap by more than ~50% of the
   narrower one, merge them. This is the single most common segmentation
   failure and it is cheap to fix.
5. Sort remaining components left to right by centroid x.
6. **Classify each as digit or decimal point**: a component whose height
   is below ~35% of the median component height *and* whose centroid sits
   in the lower third of the glyph band is a decimal point. Everything
   else is a digit.

Blank detection happens before any of this — count ink pixels after
binarizing and return empty below threshold. A classifier always outputs
something; feed it a blank cell and you get a confident wrong digit. This
is already the right behaviour in `id_ocr.py`; keep it.

---

## Constrained decoding

This is the part that makes local recognition beat the Gemini path rather
than merely match it, and it is where the constrained-value-set design
from plan §5 finally pays off properly.

Do not parse the CNN output into a string and validate afterwards. Score
every legal value directly:

```python
def decode_cell(glyph_probs, has_decimal_at, legal_values):
    """
    glyph_probs: list of (10,) probability vectors, left to right
    has_decimal_at: index where a decimal point was found, or None
    legal_values: e.g. [0, 0.5, 1, 1.5, ... 5] for a 5-mark question
    Returns (value, confidence) or (None, confidence) to flag.
    """
    best, best_score = None, 0.0
    for value in legal_values:
        digits = [int(c) for c in f"{value}".replace(".", "")]
        expects_decimal = "." in f"{value}"

        if len(digits) != len(glyph_probs):
            continue
        if expects_decimal != (has_decimal_at is not None):
            continue

        score = 1.0
        for d, probs in zip(digits, glyph_probs):
            score *= probs[d]

        if score > best_score:
            best, best_score = value, score

    if best_score < DECODE_FLOOR:
        return None, best_score
    return best, best_score
```

For a 5-mark question that is eleven candidates — trivial to enumerate.
`45` can never be returned because it is not a candidate. A smudged `4.5`
that a free-form parser would read as `45` resolves correctly by
construction rather than by validation-after-the-fact.

Same mechanism for serial, where the legal set is every integer the class
could plausibly use (1–99 unless configured otherwise) and `2` and `02`
both decode to 2.

Same for total, where the legal set is multiples of 0.5 in `0..totalMax`.

`DECODE_FLOOR` starts around 0.3 and gets calibrated on real data — treat
it as provisional the way `CONFIDENCE_FLOOR` is currently annotated.

---

## Confidence, and when to flag

Two signals, both needed:

- **Max probability** — the top class's score.
- **Margin** — top-1 minus top-2. A `4` at 0.51 with `9` at 0.47 is worse
  than a `4` at 0.70 with nothing close behind, even though the max is
  lower in the second case.

Below either threshold, add the field to `low_confidence_fields` and leave
it blank. The existing review screen already renders these with an amber
border, so no frontend change is needed.

The bias here is the same one already established in step 2's notes and it
was the right call: **0 confidently wrong** matters more than raw accuracy,
because a flagged blank costs the instructor one second and a confident
wrong digit costs a student their marks.

---

## Model and training

### Architecture

Deliberately small. This is MNIST-class difficulty and a large model buys
nothing but latency.

```
Conv(1→32, 3x3) → BN → ReLU → Conv(32→32, 3x3) → BN → ReLU → MaxPool → Dropout(0.25)
Conv(32→64, 3x3) → BN → ReLU → Conv(64→64, 3x3) → BN → ReLU → MaxPool → Dropout(0.25)
Flatten → Linear(→128) → BN → ReLU → Dropout(0.5) → Linear(→10)
```

~150KB as ONNX. Sub-millisecond per batch on CPU.

### Data: EMNIST Digits, not MNIST

240k training samples versus MNIST's 60k, and considerably more writer
variety. Same 28×28 format, so preprocessing is identical.

```python
torchvision.datasets.EMNIST(root="data", split="digits", download=True)
```

Note EMNIST ships transposed relative to MNIST — images need
`.transpose(1, 2)` or they train on rotated digits. This bites everyone
once.

### Preprocessing must match MNIST's normalization exactly

This is worth more than any architecture change, and getting it wrong is
the most common reason a model that scores 99% on test data performs
badly on real crops.

Per digit crop:

1. Inset 12% (already in `id_ocr.py` — keep it, it is the fix that
   stopped the cell border reading as extra ink).
2. Otsu binarize, white ink on black.
3. Find the ink bounding box, crop tight to it.
4. Scale so the longest side is 20px, preserving aspect ratio.
5. Paste onto a 28×28 black canvas, centred **by centre of mass**, not by
   bounding box centre.

Step 5 is exactly how MNIST was built. Centring by bounding box instead
looks correct and costs several points of accuracy, because the training
distribution the model learned is centre-of-mass centred.

### Augmentation

Train with rotation ±10°, translation ±2px, scale 0.9–1.1, and slight
elastic distortion. Real photographed digits have residual skew that
deskewing does not fully remove.

### Test-time augmentation

Since inference is ~1ms, run each crop at 3–5 small perturbations and
average the probability vectors. Almost nobody does this because it is
normally too expensive; at this scale it is free and it measurably helps
borderline cases. Apply it to the ID especially, which has no arithmetic
guard.

---

## Collecting your own handwriting samples

EMNIST is American handwriting from the 1990s. Bangladeshi conventions
differ in exactly the places that matter — the crossed `7`, the closed
`4`, the `1` with or without a base serif. A cold EMNIST model
systematically misreads whichever conventions your writers use, and no
amount of augmentation fixes a style mismatch.

Hand-collected samples fix it. But *whose* hand matters, and the answer
is different for the two fields.

### The asymmetry that decides who writes what

**Marks are written by you.** One writer, every time, forever. Training on
your own handwriting for the marks field is not overfitting — it is
targeting the exact distribution production will see. A few hundred of
your own samples is close to ideal here.

**IDs and serials are written by students.** Many writers, changing every
semester, and you will never see most of them in advance. Your own samples
are nearly useless for this field. What helps is writer *variety*: fifteen
different hands beats three thousand samples of one. Recruit colleagues,
family, students if you can.

Collect both. Tag each sheet with its writer so you can weight them
differently — heavily for marks if it is your hand, evenly across writers
for the ID model.

### The collection sheet

You already have a working detector, so make the collection sheet a table
and let the existing pipeline do the cropping. **The labels come from
position, so there is no manual annotation at all.**

A table with one row per digit, a printed label in the first column, and
~20 empty cells across:

```
┌─────┬───┬───┬───┬───┬───  … 20 cells …
│  0  │   │   │   │   │
├─────┼───┼───┼───┼───┼───
│  1  │   │   │   │   │
├─────┼───┼───┼───┼───┼───
│  2  │   │   │   │   │
   … through 9 …
```

200 samples per sheet. Six or seven sheets gets ~150 per digit, which is
enough to fine-tune well. That is an evening's work, not a project.

Write the generator as a variant of the existing `.docx` template so cell
geometry, border weight, and inset behaviour match the real thing exactly.

### Rules that keep the samples useful

- **Same pen, same paper as real quizzes.** A model fine-tuned on thick
  marker samples underperforms on ballpoint. This is the easiest way to
  waste an evening's collection.
- **Write naturally, at normal speed.** Carefully-formed digits are not
  what a marker in a hurry produces on script 24 of 30.
- **Include your genuinely messy variants.** The whole point is covering
  the cases that fail, not the ones that already work.
- **Vary within each row deliberately** — different slants, sizes, and
  stroke styles for the same digit.

### Processing

Photograph each sheet under the same conditions as the test set, run it
through `detect.py`, and write crops to
`training_data/<writer>/<digit>/<uuid>.png`. Row index gives the label.
Spot-check a sample of the crops before training — a shifted row mapping
would mislabel an entire sheet silently.

### Harvesting labels from real use — build this now

The review screen is already a labelling machine. Every digit the
instructor confirms or corrects is a labelled crop of exactly the
handwriting that matters, including student handwriting you could never
collect in advance.

- On Confirm, POST the cell crops alongside the confirmed values.
- Backend writes to `training_data/harvested/`.
- **Tag corrections separately from confirmations.** Corrections are the
  model's actual failures and are worth oversampling during fine-tuning;
  confirmations mostly re-teach what it already knows.

One 30-student class yields ~210 labelled ID digits. Three or four quizzes
is enough to fine-tune meaningfully.

Build this in step 2r even though nothing uses it until later. Retrofitting
means discarding every label from the pilot, which is the period you most
need them.

### Fine-tuning

Freeze the conv layers, retrain the classifier head at a low learning rate
(~1e-4), hold out a real photo set to measure against. Two separate
fine-tunes are reasonable once you have the data: one weighted toward your
own hand for marks, one weighted across writers for IDs. Same base model,
different heads.

Expect the first fine-tune on ~150 samples per digit to move real-photo
accuracy substantially — this is the step that takes whole-ID exact match
from poor to usable.

## Serving

Train in PyTorch, export to ONNX, serve with `onnxruntime`.

```bash
pip install onnxruntime numpy opencv-python   # runtime
pip install torch torchvision                 # training only, not in requirements.txt
```

`onnxruntime` is ~15MB against PyTorch's ~800MB, and the backend only ever
does inference. Keep torch in a separate `requirements-train.txt` so the
deployed backend does not carry it.

Load the session once at module import, not per request.

---

## Migration steps

Slot these into `step.md` in place of the current steps 2 and 3.

### Step 2r — Train the digit CNN

Standalone, no app integration.

- **2r.1** Training script: EMNIST Digits, the architecture above,
  augmentation. Watch the transpose.
- **2r.2** Implement the MNIST-matched preprocessing as a standalone
  function. Run it over your existing `cells/id_d*.png` crops and **look
  at the 28×28 outputs**. They should be visually indistinguishable from
  MNIST samples. If they are not, nothing downstream will work and no
  training run will fix it.
- **2r.3** Train, export ONNX, verify ONNX output matches PyTorch on a
  fixed batch.
- **2r.4** Accuracy harness over the real crops in `testset/` and
  `debug_uploads/`, using the same ground truth `id_ocr_accuracy.py`
  already uses. Report per-digit and whole-ID exact match, directly
  comparable to the current 58.9% / 0-of-8.

**Done when** per-digit accuracy on real crops is measured and materially
beats 58.9%, and confidently-wrong count stays at zero.

### Step 3r — Segmentation and constrained decoding

- **3r.1** Segmentation with the overlap-merge rule.
- **3r.2** Decimal point detection by geometry.
- **3r.3** Constrained decoder against legal value sets.
- **3r.4** Wire serial, marks, and total through it.
- **3r.5** Accuracy run against `labels.json`, with half marks called out
  separately — `4` versus `4.5` is the discrimination this whole design
  exists to make reliable.

Unit tests, no network needed for any of them:

- Decoder fed synthetic probability vectors returns the legal value.
- Decoder never returns a value outside the legal set, whatever it is fed.
- A disconnected-stroke `4` merges into one glyph rather than two.
- A blank cell returns empty, not a confident digit.
- Ambiguous input returns `None` and flags rather than guessing.

**Done when** mark accuracy on real photos is measured, half marks are
distinguished reliably, and no illegal value can reach storage.

### Step 2r.0 — Extract the recognizer interface first

Before any CNN work. Define the `Recognizer` protocol, move the existing
`id_ocr.py` / `marks.py` / `marks_ocr.py` behind `RemoteRecognizer`, and
switch `main.py` to call through it. **No behaviour changes.**

The full existing test suite must pass untouched after this. If anything
breaks, the move rewrote something it should have only relocated.

Doing this first means the CNN slots into a working seam rather than being
grafted into `main.py` alongside the old path.

### Step 3r.6 — Collection sheet and comparison run

Instead of deleting the old path:

- **3r.6a** Build the collection sheet generator (section above), collect
  from at least four writers, process into `training_data/`.
- **3r.6b** Fine-tune on the collected samples, re-measure. This is the
  number that decides whether the CNN path is genuinely ready.
- **3r.6c** Run a full quiz with `RECOGNIZER=both` and read
  `comparison_log/`. Every disagreement is a hard case with a
  human-confirmed answer attached.
- **3r.6d** Set `RECOGNIZER=cnn` as the default once the CNN wins on the
  comparison run. Leave the remote path in place — it costs nothing
  sitting unused and it is the only independent check you have on the
  local model.

Revisit deletion after a semester of real use, not before.

## What stays the same

Detection is untouched. Every hard-won fix in `step.md` — the whole-photo
line masks, `MIN_LINE_COVERAGE_FRAC`, `_merge_close_bounds`, the
taller-answer-row check that rejects 180° rotations, the frontend
portrait rotation — all of it is upstream of recognition and unaffected.

The review screen is untouched. `low_confidence_fields` is the same
contract; only what populates it changes.

The sum check is untouched and becomes more valuable under the CNN path,
since it is the main independent check on mark recognition once Gemini is
no longer the default.

Everything already built and tuned stays in the repo and stays working.
`RECOGNIZER=remote` restores the current behaviour exactly, which is worth
having the first time the CNN produces something surprising.

---

## Open risks

**Segmentation is the new fragile part.** It is doing work Gemini did
invisibly. Touching digits and disconnected strokes are the two failure
modes; the overlap-merge rule addresses the second and the constrained
decoder absorbs some of the first. Watch it in the accuracy harness
specifically, not just in aggregate numbers.

**Cold-start accuracy on your students' handwriting is unknown.** EMNIST
gives a strong prior, not a guarantee. The honest expectation is a large
improvement over 58.9% per-digit but whole-ID exact match still poor until
fine-tuning. Plan around the review screen catching it, which it already
does — and keep `RECOGNIZER=remote` available as the fallback while that
is still true.

**Self-collected samples can narrow the model rather than widen it.** If
every sheet is your handwriting, fine-tuning makes the ID model worse on
students, not better. The per-writer tagging exists so this is measurable
rather than a surprise: hold out an unseen writer entirely and measure
against them, not against a random split of samples you collected.

**A stray pen dot could read as a decimal point.** The sum check catches
it — a `4` read as `4.5` throws the total off by exactly enough to be
visible. This is the failure the sum check was designed for.