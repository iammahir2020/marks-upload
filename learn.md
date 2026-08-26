# Learn — what each step actually does, in plain language

This is a companion to [step.md](step.md). That file tells you *what to
build*. This one explains *what the code that got built actually does*, in
the simplest words that are still true, with pointers to the real files so
you can go read them.

Updated once after each step in `step.md` is finished — not before, so
nothing in here describes code that doesn't exist yet.

---

## Step 0 — Test set and scaffolding

**The idea, in one sentence:** before writing any "smart" code, get the raw
material that code will be tested against — like a teacher wanting real
student handwriting samples before building a grading rubric, not
imagining what handwriting looks like.

### What actually happened

1. **Folders.** [backend/](backend/) for the Python side,
   [frontend/](frontend/) for the browser side, [testset/](testset/) for the
   photos and their answer key. Empty folders now, filled in later steps.

2. **A Python "sandbox".** `backend/venv/` is a private copy of Python just
   for this project, so its packages (OpenCV, pytesseract, etc.) don't
   collide with anything else on your machine.
   [requirements.txt](backend/requirements.txt) is the shopping list —
   exact versions, so "works on my machine" doesn't rot later.

3. **Fixed the template.** [marks-grid-template.docx](marks-grid-template.docx)
   had a bug: the row where a student writes their marks was the *same
   height* as the header row above it — not enough room to actually write
   a number by hand. Fixed with a small Python script
   ([python-docx](https://python-docx.readthedocs.io/)) that sets the
   answer row to about 2cm tall versus the header's 0.6cm — roughly
   3× taller, enough room for "4.5" written by hand.

4. **An answer key, empty for now.** [testset/labels.json](testset/labels.json)
   is where the *true* values go for every test photo — the real student
   ID, the real marks, whether the photo is *supposed* to succeed or fail.
   Later, the detector's guesses get compared against this file to see if
   it's right. Right now it only has one placeholder example entry.

5. **A three-line consistency checker.**
   [testset/check_labels.py](testset/check_labels.py) makes sure every photo
   in `testset/images/` has a matching entry in `labels.json`, and vice
   versa — so nobody accidentally grades a photo that has no answer key, or
   trusts an answer key for a photo that got deleted. The core of it:

   ```python
   missing_labels = files - labelled
   missing_files = labelled - files
   ```

   That's just set subtraction — "photos with no label" and "labels with no
   photo." If either set isn't empty, something's out of sync.

### What's still missing

Steps 0.4 and 0.5 — printing the template, getting 3–4 different people to
fill it in by hand, and photographing it under messy real-world conditions
(shadows, tilt, blur, bad lighting) — need a printer, real people, and a
camera. That part's on you; the code can't do it.

---

## Step 1 — Detection harness

**The idea, in one sentence:** teach the computer to find the table drawn on
a photographed piece of paper — no matter the angle, lighting, or how
close-up the photo is — and cut it into individual boxes, one per answer.

This is the single most important piece of the whole project (see
[plan.md §6](plan.md)): every other part has a fallback if it gets something
wrong, but if the table-finder fails, there's nothing left to fall back to.

All of the logic below lives in
[backend/app/detection.py](backend/app/detection.py). Two small wrapper
scripts drive it: [backend/detect.py](backend/detect.py) runs it on one
photo, [backend/batch_detect.py](backend/batch_detect.py) runs it on a
whole folder at once.

### The pipeline, as a story

Imagine you're handed a photo and asked to do this by hand:

**1. Make the lines pop.** The photo gets converted to black-and-white in a
way that makes ink strokes stand out sharply from the paper, even under
uneven lighting (a "shadow across half the page" doesn't fool it as easily
as a plain brightness cutoff would). This is `cv2.adaptiveThreshold` —
think of it as "auto-contrast, but smart about it region by region."

**2. Keep only long straight lines, throw away everything else.** Handwriting,
noise, and stray marks aren't long straight lines — the ruled borders of
the table are. The trick ("erode then dilate") is: shrink every white blob
until only shapes at least as long as a table rule survive, then puff the
survivors back up to their original thickness. Do this once expecting
*horizontal* survivors, once expecting *vertical* survivors:

   ```python
   horizontal = cv2.dilate(cv2.erode(bw, hk), hk)
   vertical   = cv2.dilate(cv2.erode(bw, vk), vk)
   ```

   The "how long is long enough" isn't a fixed number of pixels — it's a
   *fraction* of the photo's width and height (`image width ÷ 30`, roughly).
   That's what lets the same code work whether the table fills the whole
   photo or just a corner of it.

**3. Find the rectangles.** Add the horizontal and vertical survivors
together and look for closed loops — `cv2.findContours`. A closed
four-cornered loop above a minimum size is a candidate table. (If the paper
is a little curled and the loop isn't a clean rectangle, there's a
fallback — `minAreaRect` — that fits the tightest rectangle around whatever
shape did survive.)

**4. Straighten it out.** Real photos are never perfectly square-on — the
phone is held at a slight angle, the paper isn't perfectly flat. A
"perspective transform" (the same math a document-scanner app uses) warps
the four corners of the found rectangle into a perfect flat rectangle, as
if the photo had been taken straight down.

**5. Find where each cell actually is.** Rather than assuming six equal
columns, the code re-measures: it sums up the straightened line-mask
column by column and row by row, and the *actual* peaks — where a real
line was drawn — become the cell boundaries. A hand-drawn table in Google
Docs never has perfectly even columns; this is what makes the code
tolerant of that.

**6. Work out which table is which.** The photo has three tables (ID,
Serial, Marks) and they all get found by step 3 with no labels attached.
The code sorts them out using their shape: the Marks table is the only one
with two rows (a header and an answer row), so that's an easy tell. Between
the two remaining single-row tables, the one with more boxes is the ID
table (7 digit boxes + a label = 8), and the one with fewer is Serial (a
label + one box = 2):

   ```python
   marks_candidates = [c for c in candidates if c.row_count == 2]
   single_row = sorted((c for c in candidates if c.row_count == 1),
                        key=lambda c: c.col_count, reverse=True)
   marks = marks_candidates[0] if marks_candidates else None
   id_table = single_row[0] if len(single_row) >= 1 else None
   serial_table = single_row[1] if len(single_row) >= 2 else None
   ```

**7. Check the shape matches what was expected.** Before class, the
instructor types in "5 questions, 7-digit ID." If the detected Marks table
doesn't have exactly 6 columns (5 questions + Total), something's wrong —
wrong photo framing, or the printed table doesn't match what was typed in.
Rather than guess, the code flags `column_count_mismatch` and refuses to
extract anything from that table. This is deliberate: silently writing a
mark into the wrong column is worse than stopping and asking a human to
look.

**8. Cut out every cell as its own tiny image**, named by position —
`id_d3.png` is ID digit 3, `marks_r1_c4.png` is row 1 (the answer row),
column 4 (Q5). These crops are exactly what later steps (OCR, Gemini) will
read — nothing else.

**9. Draw the result on top of the original photo** (`overlay.jpg`) so a
human can eyeball whether the split was right, and write a plain-English
report (`result.json`) saying what was found and whether it matched.

### Proof it works (with a caveat)

Real handwritten photos aren't ready yet (that's step 0's missing piece),
so the pipeline was smoke-tested against a few computer-drawn placeholder
images instead — same table shapes, printed text instead of handwriting,
generated purely to prove the *code* runs correctly end to end. This is
**not** the real test the project needs; it only proves the plumbing works.

What it showed:

- A clean, straight-on image: all three tables found, correctly told apart,
  every cell cut out cleanly, `status: "ok"`.
- A blank page: correctly refused to guess, reported `"blurry"`.
- A noisy image: the Marks table was read correctly, but noise created a
  fake extra line in the ID table — and the code correctly refused to trust
  it, reporting `"column_count_mismatch"` instead of quietly writing a wrong
  digit somewhere.
- A tilted (15°) image: **failed outright.** The line-finder in step 2 above
  only looks for lines that are exactly horizontal or exactly vertical in
  the photo. Tilt the paper and its "horizontal" lines are now diagonal in
  the photo, so the erode step throws them away as noise. This is a real,
  open problem — not a bug to patch blindly, but something to fix once
  there are real angled photos to tune against (plan.md's build philosophy
  is explicit about this: tune against real photos, not guesses).

### The first real photo (still just one — not the whole test set yet)

A hand-drawn version — pen and ruler on plain paper, following the same
three-table layout, no printer needed — was photographed and dropped into
`testset/images/empty_file.jpeg` as the project's first genuinely real test
case. No values were written in it (empty boxes), so it only tests step 1's
geometry, not step 2/3's later recognition.

It failed the first time, and the failure was informative rather than
mysterious. The overlay (`overlay.jpg`) showed the bug directly: extra
vertical lines running straight through the *handwritten label text* —
"ID" and especially "Serial", which had five spurious column dividers
running through its own letters.

**Why:** step 2 above ("keep only long straight lines") decides "long
enough" as a *fraction of the image it's currently looking at*. For the
first pass over the whole photo, that's a fraction of the whole page — big
enough that a single letter's ink stroke never qualifies. But the original
code then re-ran that same "how long is long enough" logic *a second time*,
freshly, on each small cropped-out table. For a short, single-row table
like ID or Serial, "a fraction of this crop's own height" is a much smaller
number — small enough that an ordinary handwritten letter stroke (the tall
vertical part of a capital "D" or a lowercase "l") became "long enough" to
be mistaken for a real table rule.

**The fix, in two parts:**

1. Stop re-measuring "long enough" at the small table's scale. Reuse the
   *exact same* line-mask that was already computed once from the whole
   photo (where a letter never had a chance), just re-shaped
   (`cv2.warpPerspective`) to sit inside each table's own straightened
   coordinates:

   ```python
   w_h_mask = cv2.warpPerspective(horizontal, m, (width, height), flags=cv2.INTER_NEAREST)
   w_v_mask = cv2.warpPerspective(vertical, m, (width, height), flags=cv2.INTER_NEAREST)
   ```

   This alone fixed the Marks table completely and cut Serial's error from
   5 extra lines down to 1.

2. One number left over: a hand-drawn capital "D" and lowercase "l" are
   *tall enough relative to their own short row* to still occasionally pass,
   even measured against the whole photo. Raising `KERNEL_DIVISOR` from 30
   to 20 — meaning "a line must span 1/20th of the photo's height to count,
   not just 1/30th" — pushed the bar just above what a handwritten letter
   stroke reaches, while staying safely below the height of an actual table
   row. Tried 15 first; that was *too* strict and started rejecting real
   table lines too. 20 was the value that fixed all three tables with no
   regressions. This is exactly the tuning stack-reference.md warned would
   be needed — "the first knob to turn" — now turned against a real photo
   instead of a guess.

A smaller, separate bug turned up alongside this: re-running `detect.py`
against the same `--out` folder (the normal way you iterate while tuning)
left old cell-crop files behind from the previous run — an artifact of
testing, not of detection itself, but a real trap for exactly the "iterate
dozens of times" workflow step 1 is built around. Fixed by clearing the
`cells/` folder at the start of every run.

After both fixes: all three tables detected, all three column counts exact,
`status: "ok"`.

### The second real photo — same disease, a different symptom

The photo above (`empty_file.jpeg`) had empty boxes — good for testing
geometry, but it never put anything *inside* a cell. The next real photo,
`testset/images/filled_file.jpeg`, had real values written in with a pen:
a 7-digit ID, a serial, and marks including a "0", a couple of half-marks,
and a Total of "11".

It failed too, and the overlay showed exactly the same disease as before,
just a different symptom: two extra vertical lines running straight through
the "11" in the Total cell. A handwritten "1" is, geometrically, almost
nothing but a tall thin vertical stroke — which is also the entire
definition of a table rule. The two are genuinely hard to tell apart by
"is there a long vertical mark here," which is all the detector was asking.

Tellingly, the ID row has two "1"s in it too (the student ID ends in
`...711`), and *those* didn't cause a problem. The difference is height: the
ID row is short, so even a confidently-written "1" only fills part of it.
The Marks table's answer row is deliberately tall (that's the very fix from
step 0.3, giving room to write "4.5" clearly) — and more room means people
write bigger, so a "1" in that cell can end up nearly as tall as the row
itself. The fix that stopped letters from aliasing as lines didn't stop
this, because the "1" genuinely *was* long enough by the same yardstick.

**The fix this time isn't about length, but about completeness.** A real
table rule spans (almost) the *entire* table, edge to edge. A digit,
however tall, is written with a little margin above and below — it
essentially never touches both the very top ruling and the very bottom
ruling of its cell the way a drawn line does. So a second check was added:
a candidate line must cover a large fraction of the table's own height (or
width), not just be the tallest thing nearby:

```python
idx = np.where((profile > profile.max() * 0.3) & (profile >= min_value))[0]
```

Getting the actual number right took measuring, not guessing. Printing the
real coverage values out of the photo showed the six genuine column
dividers in the Marks table ranged from **66% to 82%** coverage, while the
two false "1"-shaped peaks measured **25–26%** — a wide, clean gap. A first
attempt at 75% was too strict (it rejected some of those genuine
66–70%-coverage lines and broke `empty_file.jpeg`, which had been passing);
settling on **40%** — comfortably above the false peaks, comfortably below
every real line measured — fixed `filled_file.jpeg` completely without
disturbing anything that worked before.

After this: both real photos pass, with every column exactly where it
should be, and the digit crops (`marks_r1_c5.png` is a clean, uncropped
"11", `id_d1.png` a clean "2") are exactly what step 2/3's recognition will
eventually read.

### The tests

[backend/tests/test_detection_regression.py](backend/tests/test_detection_regression.py)
is the automated check for this step. It now has two real, passing cases —
`empty_file.jpeg` and `filled_file.jpeg` — instead of finding zero photos
and skipping. That's two photos out of the 15–20, across 9 deliberately
awkward conditions, that step 0 actually calls for — real progress, not the
finish line, and both are still the easy "straight-on, well-lit" condition.
The synthetic placeholder images from the smoke test weren't touched by any
of this — they still exist only in the scratchpad, never in `testset/`, and
re-ran clean after every change above to confirm nothing regressed.

---

## Step 2 — Local ID recognition (in progress — first real numbers, not done)

**The idea, in one sentence:** read the 7 digit crops that step 1 already
cut out, entirely on this laptop, without sending them anywhere — because
the student ID is the one field the whole project keeps off the network
(plan.md §12).

The code lives in [backend/app/id_ocr.py](backend/app/id_ocr.py). It does
three things per digit crop:

1. **Clean the crop up.** Trim a small margin off each edge, threshold it
   to pure black-and-white, pad it, and scale it up. Tesseract (the OCR
   engine) reads a clean, appropriately-sized glyph much better than a
   tiny, tightly-cropped one.
2. **Ask Tesseract for one character.** Restricted to only the digits
   0–9 — it's never allowed to guess a letter.
3. **Check how sure it was.** Tesseract reports a confidence number per
   guess. Below a threshold, the digit is marked unreadable (`?`) rather
   than trusted — the same "flag, don't guess" rule as everywhere else in
   this project.

### It was blocked, then it was wrong, in an informative way

First blocker: `pytesseract` is just a thin wrapper — it needs the real
`tesseract` program installed separately (`sudo apt install tesseract-ocr`).
The code was written and confirmed to run correctly right up to that missing
piece, then genuinely tested once it was installed.

**First real run: 0 out of 7 digits.** Not "some wrong" — every single digit
came back unreadable. That's a strong signal something structural is wrong,
not that the handwriting is just hard.

Looking at the actual image handed to Tesseract (saving it out and opening
it, rather than guessing) showed the bug immediately: the crop included a
thin sliver of the cell's own black border line, left over from step 1's
cell-cutting (the cell boundary sits *on* the ruled line, so a plain crop
grabs a bit of it). To a character-recognition engine expecting one clean
glyph, a stray black bar next to the digit is confusing — it looks like
extra ink that doesn't belong to any known character. Trimming 12% off
every edge before doing anything else removed it.

### A documented default that didn't hold up

stack-reference.md's own notes recommended Tesseract's "single character"
mode (`--psm 10`) as "the right mode for one crop per digit box" — a
reasonable-sounding default. Measured against this photo, it was
genuinely bad: two completely legible digits ("6" and a "1"), visually no
different from the ones that worked, came back as nothing at all under that
mode.

Rather than trust the documentation over the evidence, five different modes
were tried against the same real crops and compared side by side. "Single
word" mode (`--psm 8`) read every digit `--psm 10` did, plus two more, and
lost nothing. Switched to it — not because a tutorial was wrong in general,
but because this specific photo proved it wrong for this specific job, and
step.md's whole methodology is to trust that kind of evidence over a
document.

### The honest result

After both fixes: **3 out of 7 digits correct**, with the other 4 correctly
flagged as uncertain rather than guessed — no digit was ever confidently
wrong. Two of the four flagged ones simply produced no reading at all
(complete misses, not close calls); a third was read correctly but at such
low confidence (9%) that trusting it would have been luck, not accuracy, so
it stayed flagged too.

This is a real, useful number — and also clearly not good enough yet, and
not yet trustworthy as a *general* number. It comes from a single
photograph in one person's handwriting. Trying to tune this further right
now would mean tuning against a sample of one, which is exactly the
overfitting trap this whole project's approach is built to avoid (see step
1's own repeated lesson above). What's needed next is what step 0 was
always going to need anyway: more real, differently-handwritten photos —
step 2 doesn't get a real accuracy number until then, just a first honest
data point.

`CONFIDENCE_FLOOR` — the number below which a digit gets flagged instead of
trusted — was lowered from stack-reference.md's starting suggestion of 60 to
35, because every correct digit in this one photo landed at 39–41. That's
noted in the code as exactly what it is: a provisional number from one
sample, expected to move once more photos exist.

### The tool

[backend/id_ocr_accuracy.py](backend/id_ocr_accuracy.py) is step 2's
accuracy harness (step.md 2.4) — it runs detection fresh, reads every ID
digit, and reports two numbers against `testset/labels.json`: per-digit
accuracy and whole-ID exact-match rate. Right now it has exactly one real
case to measure (`filled_file.jpeg` — `empty_file.jpeg` has no digits
written in it to check against). Whole-ID exact match is 0/1, which sounds
alarming stated alone — but with only 3 of 7 digits confidently read, that's
the expected, correct result, not a surprise. It'll become a meaningful
number once there's more than one real ID to average over.

### From n=1 to n=8, and a bug the extra data actually surfaced

Step 6/7's phone test session produced seven more real photos
(`backend/debug_uploads/`), and the user confirmed the correct student ID
by hand for all seven — exactly the "more real photos" this step's own
notes said were the actual next move, not more parameter tuning against
one sample. Those seven got copied into `testset/images/` as
`phone_2632711_1.jpg`…`_5.jpg` and `phone_2632700_1.jpg`/`_2.jpg`, with
`student_id` recorded in `testset/labels.json` from what the user reported
directly. Serial and marks were deliberately left blank in those entries —
reading them back myself across supposedly-identical retakes turned up
inconsistencies (one shot's serial cell read as `"107"` where four others
of the same physical script read `"07"`), and inventing ground truth from
an unreliable read would be exactly the mistake this whole project's
"flag, never guess" rule exists to prevent — including when the one doing
the guessing is a step in the build process rather than the app itself.
`id_ocr_accuracy.py` only needs `student_id` to run, so this was enough to
widen the sample without needing to resolve that.

Re-running the harness against 8 real photos (n=1 → n=8) gave the first
number that actually deserves to be called an accuracy number: **21/56
digits correct (37.5%), 0/8 exact match, 0 confidently wrong.** Lower than
the original 3/7 (43%), which is exactly what a bigger, less cherry-picked
sample should do to an n=1 result.

But the breakdown wasn't uniform noise — positions 5, 6, and 7 (the last
three ID digits) were wrong in *every single one* of the 8 photos. That's
a pattern, not scatter, and patterns are worth opening the actual crops
for rather than guessing at blindly. `id_d5.png` (a handwritten "7"),
`id_d6.png` (a "1"), and `id_d7.png` (a "0") all looked perfectly legible
by eye. Running them through `pytesseract.image_to_data` *without* the
digit whitelist — to see what Tesseract's LSTM model actually thought
they were, rather than what the whitelist let through — showed the real
cause:

```
id_d6.png (true digit: "1"), psm 7, no whitelist:  [('l', 90)]
id_d7.png (true digit: "0"), psm 7, no whitelist:  [('D', 86)]
```

Tesseract wasn't uncertain about these at all — it read the "1" as a
lowercase "l" at 90% confidence, and the "0" as a capital "D" at 86%. Both
are classic, well-documented OCR letter/digit look-alikes. The problem was
never the digit's legibility; it was that `tessedit_char_whitelist`
doesn't make the LSTM engine reconsider *within* the digit alphabet once
it's already confident about a letter — it just throws the whole result
away, which is indistinguishable, from the caller's side, from genuine
illegibility. (The "7" crop, by contrast, came back as `"Hh"` at 18%
confidence even without a whitelist — genuinely unclear to the model, not
a discarded-but-correct read. That distinction mattered: it's the
difference between a bug to fix and a real limit to just keep flagging.)

The fix, in [backend/app/id_ocr.py](backend/app/id_ocr.py), is a second
OCR pass that only runs when the first (whitelisted) one finds nothing:

```python
FALLBACK_PSM = 7
FALLBACK_CONFIDENCE_FLOOR = 60.0
DIGIT_LOOKALIKES = {
    "o": "0", "O": "0", "D": "0", "Q": "0",
    "l": "1", "I": "1", "i": "1", "|": "1",
    "z": "2", "Z": "2",
    "s": "5", "S": "5",
    "b": "6", "G": "6",
    "g": "9", "q": "9",
    "B": "8",
}
```

`read_digit()` tries the fast, whitelisted path first — unchanged, and
still what handles anything Tesseract already sees as a digit. Only on a
miss does it run the unconstrained fallback, and even then it only accepts
the result if the character is one of these specific look-alikes *and*
clears a stricter confidence floor (60, not the base 35) — a deliberately
higher bar, since this path is trusting a letter classification to stand
in for a digit one. Only `"D"→"0"` and `"l"→"1"` are backed by a crop
actually measured in this project; the rest of the map is standard,
widely-documented OCR confusion pairs, included on that reputation rather
than direct evidence here — which is exactly why the confidence floor
still applies to them too, rather than trusting the map blindly.

Re-measured after the fix: **33/56 digits correct (58.9%), 0/8 exact
match, still 0 confidently wrong.** Every one of those extra 12 correct
digits was something the old code already had sitting at 86–90%
confidence and threw away — this didn't lower the bar for what counts as
a trustworthy read, it just stopped discarding reads that already cleared
it. All 28 backend tests and a fresh `batch_detect.py` (9/9) still pass,
confirming this touched only `id_ocr.py` and nothing about detection.

Whole-ID exact match is still 0/8, and that's expected, not a sign the fix
didn't work: getting a full 7-digit ID exactly right needs every position
correct in the same photo, and the hardest position (this particular
handwritten "7") is still, correctly, coming back flagged rather than
guessed. That's the "flag, never guess" rule doing exactly its job on the
one digit shape that's genuinely ambiguous — the fix earns back the cases
where the model already knew the answer and was being overruled by its
own whitelist, not the cases where it never had an answer at all.

---

## Step 3 — Serial and marks via Gemini (in progress — built, not yet run live)

**The idea, in one sentence:** send one photo of all the answer cells to
Google's Gemini vision model in a single request, and get back the serial
number and every mark as clean, structured data — but constrained so it
can't return nonsense.

More real photos weren't available to keep working on steps 0/1/2, so work
moved to this step instead — it doesn't need new photos to *build*, only to
fully test. plan.md's own design for this step happens to split cleanly
into "logic that needs no network" and "the one function that makes the
actual API call," which is exactly what made that possible.

The code is in [backend/app/marks.py](backend/app/marks.py).

### Building the composite

Rather than send Gemini seven separate images, all the serial and mark
crops from step 1 get glued into **one image**, side by side, each with a
small caption underneath naming what it is:

```
[ 07 ] [ 3 ] [ 2.5 ] [ 1 ] [ 0 ] [ 4.5 ] [ 11 ]
serial   Q1    Q2     Q3   Q4     Q5     Total
```

(This is a real screenshot of the actual composite built from
`filled_file.jpeg` — every value matches what was written by hand.)

One image means one API call per script instead of seven — cheaper, and
faster against the free tier's request-per-minute limit (plan.md §9).

**The ID never goes anywhere near this.** The function that builds this
composite only ever looks for two specific filenames — `serial.png` and
`marks_r1_c*.png` — it never even looks at an ID crop to begin with. On top
of that, there's a hard `assert` checking the same thing again before the
image is built. Belt and suspenders: even if a future code change
accidentally tried to sneak an ID crop in, the assertion would crash the
program rather than silently send it. This isn't a maybe — plan.md §12 is
explicit that the ID is the one thing that makes a photo personally
identifying, and Google's free tier may train on what it's sent.

### Telling Gemini what a "legal" answer looks like

The prompt doesn't just ask "what's the mark" — it tells the model the
*exact allowed set* per question, derived from that question's own max:

```python
def legal_values(max_mark: float) -> set[float]:
    steps = round(max_mark * 2)
    return {i / 2 for i in range(steps + 1)}
```

For a 5-mark question that's `{0, 0.5, 1, 1.5, ..., 5}` — eleven exact
values, nothing else. This is what makes a smudgy "4.5" reliable: without
constraints, a model might return "45" (missing the decimal point); told
the only legal answers are 0 through 5 in halves, "45" isn't even on the
table, so it has to resolve to something sane.

### Trusting the schema for shape, not for correctness

Gemini is given a strict schema (a `ScanPayload` — serial, a list of
question marks, a total) that forces its reply into the right *shape*: the
right fields, the right types, nothing extra. What the schema **can't**
guarantee is that a returned number is actually one of the legal values —
it just has to be *a* number. A `7` can still come back for a 5-mark
question; the schema doesn't know 7 is out of range, only that it's a
valid number.

That's why `validate_payload` exists as a separate step after the schema
already did its job: it walks every question, checks the value against
`legal_values` for that question's own max, and rejects anything outside
it — same "flag, don't guess" rule as the ID digits. A rejected value comes
back as `None` plus a flag (`low_confidence_fields`), never a number that
might be wrong.

### A response that looks fine but isn't

There's one Gemini-specific trap worth knowing about, because it's easy to
miss: **a blocked or empty response still comes back as a normal, successful
network response.** Nothing raises an error, nothing automatically retries
it — code has to explicitly check for it, or a blocked reply turns into a
confusing crash much later when something tries to read a value that was
never actually there.

`check_blocked` does that check, reading two fields the SDK provides:
`prompt_feedback.block_reason` (was the request itself refused?) and
`candidates[0].finish_reason` (did generation complete normally, i.e.
`STOP`, or stop early for some other reason — hit a safety filter, ran out
of tokens, etc.)? Either one being abnormal means the whole response gets
treated as `model_error` rather than trusted.

### What was actually tested, and what wasn't

Everything above this point is a **pure function** — given some input, it
always produces the same output, with no network call inside it. That
makes it directly testable without an API key or an internet connection,
and [backend/tests/test_marks.py](backend/tests/test_marks.py) does
exactly that: illegal values (`7` on a 5-mark question, `4.25`, `-1`, a
missing value) all get rejected; a real composite, built from a real photo,
is checked to contain zero ID crops; a handful of fabricated
"blocked"/"cut short" responses are fed to `check_blocked` and confirmed to
produce `model_error` rather than crash. All 16 tests in the suite
(including step 1's) pass.

**What was unverified became verified.** A `GEMINI_API_KEY` was added to
`backend/.env`, unblocking the one function that makes a real network call
(`recognize`) — same shape of blocker Tesseract was, one step earlier.

### The model name was already wrong — a real-world thing, not a bug

The very first live call failed immediately with a `404`. Not a bug in this
project's code — Google's own error message explained it directly:
`gemini-2.5-flash` ("This model... is no longer available to new users")
had been retired since stack-reference.md was written, and the error named
its replacement (`gemini-3.6-flash`) directly. Swapped the model constant
to that and moved on. This is exactly the kind of thing stack-reference.md
warned about in its own notes — model names in a fast-moving API are a
starting point, not a fact to build on permanently — and it's a good
reminder that "the code doesn't run" isn't always a code problem.

### The live result

With the model name fixed, the very first real call against
`filled_file.jpeg`'s composite came back **exactly right, on every field**:

| Field | True value | Gemini read |
|---|---|---|
| Serial | `07` | `07` |
| Q1 | 3 | 3.0 |
| Q2 | 2.5 | 2.5 |
| Q3 | 1 | 1.0 |
| Q4 | 0 | 0.0 |
| Q5 | 4.5 | 4.5 |
| Total | 11 | 11.0 |

Nothing was even flagged as low-confidence — Gemini was both correct and
sure of it. Worth being honest about what this does and doesn't prove: one
photo, one clean composite, well-lit conditions — this is the *easy* case,
the same way `empty_file.jpeg` and `filled_file.jpeg` were the easy case for
detection. It's genuine, real evidence the design works (the composite
tiling, the legal-value prompt, the schema), not proof it's production-ready
across messy real conditions.

### Banking the result so it doesn't cost anything twice

Per step.md 3.6's own instruction, this real response is now cached to
[backend/tests/fixtures/filled_file_gemini_response.json](backend/tests/fixtures/filled_file_gemini_response.json)
— a plain JSON file with the exact values Gemini returned. Step 4's tests
(wrapping this in FastAPI) will mock the Gemini call using this fixture
instead of hitting the real API on every test run — free, fast, and
repeatable, and it never touches the account's quota again for this
specific case.

### A local fallback for when Gemini itself is down

The step 6/7 phone session hit a real `rate_limited` response (Gemini's
free-tier daily request cap) mid-way through five otherwise-clean scans.
Before that, a rate-limited scan just failed outright — correctly, per
step 7's "never a dead end" rule, landing on an editable Review screen —
but that still meant retyping serial *and* every mark by hand for any
script caught by it.

The fix is [backend/app/marks_ocr.py](backend/app/marks_ocr.py), reusing
the crop-preprocessing this project already built for the ID
(`id_ocr.py`'s `_prepare`) against the *other* two crop types
`marks.py`'s `build_composite` would have tiled for Gemini — `serial.png`
and each `marks_r1_c*.png`. It only ever runs when `recognize()` (the
Gemini call) has already failed:

```python
if marks_result.status != "ok":
    fallback = recognize_locally(cells_dir, question_maxes)
    if fallback is None:
        return ScanResult(status="failed", failure_reason=marks_result.failure_reason)
    marks_result = fallback
```

This is deliberately *not* the same thing as plan.md's deferred "local
mark classifier" — that item was about a trained model standing in for
Gemini as the primary recognizer. This is a last resort that only ever
fires after Gemini has already failed, and it's honest about being worse:
every field it touches gets flagged low-confidence in the result — even a
value it did manage to read and that passed the legal-value check — not
just the ones it couldn't read at all. Speaking of which: every recovered
value still has to pass that same legal-value check `marks.py`'s
`validate_payload` already runs on Gemini's own output (`value in
legal_values(max_mark)`), so an OCR misread that doesn't land on a real
mark value gets rejected exactly the same way a bad Gemini read would —
never stored as a wrong number, just another blank, flagged field.

One more honesty check: if this fallback can't recover *anything at all*
(every crop unreadable), it returns `None` rather than an all-blank "ok"
result — so the instructor still sees an honest "Scan failed: rate_limited"
banner in that case, not a scan that looks like it succeeded but is
mysteriously empty everywhere.

Run against `filled_file.jpeg`'s real crops (not mocked), it recovered 2 of
7 fields — Q2 (`2.5`) and Q5 (`4.5`) — with the other 5 correctly coming
back blank and flagged rather than wrong. That's the expected shape of
this feature: a weaker recognizer that sometimes saves the instructor a
few fields of retyping, always double-checked, never silently trusted.

---

## Step 4 — Wrapping steps 1–3 in FastAPI

**The idea, in one sentence:** turn three separate Python functions
(detect a grid, read an ID locally, ask Gemini for the rest) into one web
address a phone can upload a photo to — `POST /api/scan`.

Because steps 1–3 were each built and proven as standalone scripts first
(plan.md's whole reasoning for that build order), this step really was what
it promised to be: a thin wrapper, not a rewrite. The code:
[backend/app/main.py](backend/app/main.py) for the endpoint itself,
[backend/app/models.py](backend/app/models.py) for the shapes of data going
in and out.

### The shape of a request

A photo and some settings (how many questions, how many ID digits) need to
travel together in one HTTP request. The natural instinct is "send them
both as JSON" — but a file upload and a JSON body are two different ways of
packaging an HTTP request, and you can't mix them. The settings ride along
as a second, ordinary form field, holding JSON as *text*, which gets parsed
back into real data once it arrives:

```python
quiz = QuizConfig.model_validate_json(config)
```

### Keeping "stateless" honest

plan.md is explicit the backend should hold nothing between requests — no
database, no memory of who scanned what five minutes ago. But `detect()`
(step 1) works by reading and writing actual files (that's what made its
debugging output — `overlay.jpg`, the cell crops — useful while tuning it).
Those two ideas aren't actually in conflict, just easy to *make* conflict
by overreacting to one of them: every request gets its own private,
temporary folder that's automatically deleted the moment the request
finishes:

```python
with tempfile.TemporaryDirectory() as tmp:
    ...  # write the upload, run detect(), read the crops, call Gemini
# everything above is gone the instant this block ends
```

"Nothing written to disk" turns out to mean *nothing that outlives one
request* — not literally "never touch a file," which would have meant
rewriting three already-working, already-tested modules just to avoid a
constraint the plan never actually needed enforced that strictly.

### Wiring the pipeline in the right order, with real exits

The endpoint doesn't call all three steps blindly — it stops early exactly
when plan.md says to:

```python
if det["status"] != "ok":
    return ScanResult(status="failed", failure_reason=det["failure_reason"])
```

If step 1 can't find the table, or the shape doesn't match what the
instructor configured, the function returns immediately — Gemini is never
called. This one `if` is doing two jobs at once: it protects the free-tier
quota (no point spending a request on a photo that's already known-bad),
and it protects the privacy property from step 3 (the ID-crop composite
never even gets built on a failed photo). A test proves this isn't just
believed but true — see below.

### Testing it without spending anything

Steps 1 and 2 (table detection, local ID reading) are fast and run
entirely on this machine — no reason not to let them run for real in a
test. Step 3 (Gemini) is the one thing that costs money and needs a live
key, so it's the *only* thing mocked:

```python
with patch("app.main.recognize") as mock_recognize:
    resp = _post(image_path)
...
mock_recognize.assert_not_called()
```

That last line is the real proof, not just a claim: for a bad photo,
Gemini genuinely never gets invoked — the test would fail loudly if it did.
Three different kinds of bad photo were built to prove this from three
different failure paths: random static (no table at all — `table_not_found`),
a flat blank image (too little detail — `blurry`), and a real, well-formed
grid deliberately drawn with the *wrong number of columns* for what the
config claims (`column_count_mismatch`).

For the success path, a cached, known-correct Gemini answer (from step 3's
real live run) stands in for the network call, so the test can check "did
`main.py` assemble the final answer correctly" without needing a live key
or spending quota every time the suite runs — 21 tests total, all passing,
all offline.

### Then proving it for real, once

Tests with everything mocked prove the *wiring* is correct. They don't
prove the *whole system*, end to end, over a real network, produces the
answer the CLI already proved live. So one more request was sent — no
mocks this time, hitting the real Gemini API through the real HTTP endpoint
— and it matched exactly:

```json
{
  "status": "ok",
  "student_id": "?632???",
  "serial": "07",
  "questions": [3.0, 2.5, 1.0, 0.0, 4.5],
  "total": {"q": 0, "value": 11.0},
  "low_confidence_fields": ["student_id"]
}
```

Notice the ID field: `"?632???"`, flagged low-confidence — not silently
wrong, not hidden, just honestly uncertain, exactly matching step 2's own
already-known 3-out-of-7 result for this same photo. The endpoint didn't
paper over a weaker part of the pipeline; it surfaced it, which is the
entire design principle ("flag, never guess") holding all the way through
the full stack for the first time, not just within one isolated step.

---

## Step 5 — Frontend scaffold and Setup screen

**The idea, in one sentence:** the first screen the instructor actually
sees — type in the quiz's shape once, and have it survive closing the tab.

This is the first step that's *only* frontend — no Python, no image
processing, just a web page. It's also the first step whose "done" state
depends partly on things only a real browser on a real phone can prove,
which matters for how confident to be in what follows.

### Two systems, two different "makes sense on its own" pieces

**`vite.config.ts`** decides how the page gets served during development.
Two requirements collide here in an interesting way: `getUserMedia` (the
camera, needed in step 6) refuses to run at all unless the page is loaded
over HTTPS — and the phone needs to reach this laptop over the local WiFi
network, not just `localhost`. plan.md's own suggestion for HTTPS was
`mkcert`, a tool that creates certificates a browser trusts silently — but
it needs installing as a system program and needs its root certificate
trusted in the OS, both privileged operations this environment can't do
(no passwordless `sudo`, same wall Tesseract hit in step 2). The fallback,
`@vitejs/plugin-basic-ssl`, is a plain npm package: no system install, just
a self-signed certificate generated on the fly. The trade: a browser
doesn't *trust* a self-signed certificate by default, so the phone will
show a "this site isn't secure" warning the first time, that you click
through once. `getUserMedia` doesn't actually care whether a certificate is
*trusted* — only whether the connection is *encrypted* — so the self-signed
cert still unlocks the camera, it just isn't silent about it.

**`db.ts`** decides how the config (and later, every scanned record)
survives a page refresh. This uses IndexedDB — a real, persistent database
built into every browser — through a small helper library (`idb`) that
makes it feel like ordinary async functions instead of the notoriously
clunky raw browser API. Two "stores" are set up: one for the quiz config,
one for student records, each keyed and indexed the way step 7's
correctness checks will eventually need — indexed by both serial number and
student ID, and **deliberately not** marked "unique," because a duplicate
serial is precisely the thing the review screen needs to be able to *catch
and show*, not something the database should silently refuse to save.

### A bug caught by testing, not by reading the code

The first version of `db.ts` opened its database connection once and
reused it — a normal, sensible optimization. It broke the first test run in
a very specific way: a test that expects "nothing saved yet" instead found
a config saved by an *earlier* test, because the cached connection from
test one never noticed that test two had wiped the fake browser storage
out from under it. This is exactly what automated tests are for — the bug
was invisible reading the code, since the caching logic is completely
reasonable in a real browser where nobody's swapping out storage between
function calls. Fixed by not caching the connection at all — opening a
database that already exists is cheap, and simplicity here beats a
micro-optimization that only mattered for a scenario (rapid, isolated test
runs) real usage never hits anyway.

### What automated tests can prove, and what only a phone can

Two kinds of tests exist here, on purpose. `validateConfig.test.ts` checks
pure logic — question count driving the number of max-mark fields, the
total being a genuine sum (not, say, a multiplication, which a sloppier
implementation might accidentally do), zero questions and non-numbers both
correctly rejected. `db.test.ts` checks that saving and loading actually
round-trips, and specifically that two records sharing a serial number
don't clobber each other — a real regression test for the exact design
decision plan.md calls out. All 14 tests pass, plus a clean TypeScript
build and a clean production build with the PWA service worker generated.

**What none of that proves:** whether a real phone, on a real WiFi network,
loads this page and lets you tap "trust anyway" past a certificate warning
without anything going sideways. That's the literal wording of step 5's own
Done-when bar — "the phone loads the app... without a certificate warning"
— and the honest state right now is that basic-ssl's self-signed
certificate means there *will* be a warning to click past, by design, not
by mistake. Confirming the page survives a real hard-refresh in a real
browser, and confirming the phone can actually reach it at all, both need
a person with a phone — that's the one piece of this step that can't be
automated away.

### A real bug, found by actually loading the page

That "a person with a phone" test happened sooner than expected — the page
was loaded over the LAN address in a real browser, and the console showed a
real error: `Failed to register a ServiceWorker... An SSL certificate error
occurred when fetching the script.` The page itself rendered — a plain
page load can be "proceeded past" despite a certificate warning — but the
service worker's own background request to fetch its script failed harder
than that, and didn't inherit the same "the user already agreed to trust
this" leniency.

Reading the actual certificate that got generated explained why:

```
X509v3 Subject Alternative Name:
    DNS:localhost, DNS:[::1], IP Address:127.0.0.1, IP Address:FE80:...
```

A certificate lists every hostname/address it's valid for — and this one
only ever listed `localhost` and `127.0.0.1`. The browser was connecting via
`192.168.0.108` (the LAN address, the whole point of `server: { host: true
}`), which isn't on that list at all. That's a *hostname mismatch*, a
stricter, different kind of problem than "I don't trust who signed this" —
and apparently strict enough that Chrome refuses a service worker
registration over it even after a page load gets clicked through.

The fix follows the same principle already used for the backend's CORS
setup: don't hardcode one specific address, detect it. Node can list this
machine's actual network addresses directly:

```typescript
function lanIPs(): string[] {
  const nets = networkInterfaces()
  const ips: string[] = []
  for (const iface of Object.values(nets)) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}
```

...passed straight into the certificate generator (`basicSsl({ domains:
lanIPs() })`), so the generated certificate now lists *whatever this
machine's actual LAN address is* as a valid hostname too — not a number
typed in once that would silently go stale the next time this runs on a
different WiFi network. Regenerating the cert and re-checking confirmed the
fix directly, two different ways: `openssl s_client -verify_hostname
192.168.0.108` reported only the *expected* self-signed warning and no
hostname mismatch, and the service worker's script itself
(`dev-sw.js`) now returns a plain `200` when fetched over the LAN address
instead of failing at the SSL layer.

A smaller thing worth naming: killing a background dev server started via
`npm run dev` by killing the `npm` process doesn't actually stop the real
`vite` process underneath it — `npm` is a thin wrapper, and the child
survives its parent. Several of these leaked from earlier testing before
being noticed and cleaned up. Worth remembering next time something claims
a port that should be free.

---

## Step 6 — Camera capture and upload queue

**The idea, in one sentence:** point the phone's camera at a script, tap
capture, and see the backend's answer come back — while the camera keeps
working the whole time, never freezing while a photo uploads.

### A second HTTPS gap, found before it could bite

Before writing any camera code, there was a real architecture question
worth settling first: the frontend is HTTPS (step 5), but the backend has
only ever been run over plain HTTP. Browsers enforce a rule called "mixed
content" — a page loaded securely (HTTPS) is not allowed to fetch data from
an insecure (HTTP) address, with one narrow exception: `localhost` and
`127.0.0.1` specifically are trusted regardless. The phone doesn't load the
backend via `localhost`, though — it reaches the laptop over the LAN
address, like `192.168.0.108`, which gets no such exception. Left alone,
this would have meant every single photo upload silently failing the
moment a real phone tried it, for a reason that would have looked nothing
like the actual cause.

The fix mirrors what step 5 already needed for the frontend: generate a
certificate, and don't hardcode which address it's valid for — detect it.
[backend/gen_dev_cert.py](backend/gen_dev_cert.py) finds this machine's own
LAN-facing IP with a small, dependency-free trick (open a socket as if
about to talk to the outside internet, then just ask what local address it
would have used — nothing is actually sent), and hands that address to
`openssl` to bake into a certificate alongside `localhost`. Confirmed twice
independently before trusting it: `openssl x509` shows the LAN IP is really
listed on the certificate that's actually served over the wire (not just
the file sitting on disk, in case something else were reading from a stale
copy), and Python's own strict, standards-following TLS client (the same
category of check a real browser performs) connected to it by that exact
IP and reported the hostname check passing cleanly.

### Splitting "the logic" from "the thing only a phone can do"

The two pieces of this step split cleanly, the same way step 5's Setup form
did:

- `scanQueue.ts` is a small, pure state machine — pure meaning: give it the
  same input twice, get the same output twice, nothing about a camera or a
  network involved. It answers exactly one question: "given everything
  captured so far and whatever just happened (a new capture, a server
  answered, a server failed), what's the queue now?" Because it's pure,
  it's directly testable without a browser at all — seven tests check
  things like "three photos can be mid-upload at once" and "if the middle
  one's request fails, the other two keep going, not the whole queue."
- `Scan.tsx` is the part that actually can't be tested from here: it asks
  the browser for camera access, draws a video frame onto an invisible
  canvas the instant "Capture" is tapped, and turns that into a JPEG to
  upload — while deliberately *not waiting* for that upload to finish
  before the camera is usable again. That "not waiting" is the one-line
  difference between a queue and a blocking spinner:

  ```typescript
  // fire the upload, then immediately return control to the camera
  scanImage(blob, config)
    .then((result) => dispatch({ type: 'resolve', id, result }))
    .catch((err) => dispatch({ type: 'reject', id, error: err.message }));
  ```

### Proof, as close to real as this environment allows

Nothing here can literally hold a phone. What could be done instead: start
the real backend and the real frontend at the same time, on their real
HTTPS ports, and send an HTTP request shaped *exactly* like the one a
phone's browser would send — same cross-origin `Origin` header, same
multipart photo-plus-config body, same address. It came back correct, all
the way through: detection, local ID reading, and a live Gemini call,
returning the identical values already proven correct in step 4. This
confirms the *plumbing* end to end — proving the camera itself, and the
actual experience of tapping "capture" five times in a row without the
preview freezing, is the one thing step 6's own Test section asks for that
only a real device in hand can actually settle.

### One command instead of two terminals

Running the backend and frontend by hand meant two separate terminals, two
`cd`s, two `source venv/bin/activate`s — tedious enough to be worth a single
script, [dev.sh](dev.sh), that starts both and stops both together on
Ctrl+C. "Stops both together" turned out to hide two real, non-obvious bugs,
each only found by actually testing the shutdown, not by reading the script
and assuming it would work.

**Bug one: `kill 0` didn't reach anything.** The first version enabled
"job control" (`set -m`) on the theory that it would help signals propagate
correctly. It did the opposite: job control's whole purpose is to put each
backgrounded command in its *own* separate process group (so you can
suspend or resume one independently of the others) — which means `kill 0`
("send to my own process group") stopped reaching the backend and frontend
entirely, since they were no longer *in* that group. Removing `set -m`
fixed it, because *without* job control, a backgrounded process just
inherits its parent's process group like any ordinary child process would
— which is what `kill 0` actually needs to work.

**Bug two, sneakier: the cleanup function could kill itself before
finishing.** Even with process grouping fixed, one specific process —
uvicorn's `--reload` file-watcher — kept surviving. Tracing it down: this
script's own cleanup function is registered to run when the script
receives a termination signal, and that cleanup function's own first
action is to broadcast that *same kind* of signal to the whole process
group — which includes the script itself. That second, self-inflicted
signal arrived while the cleanup function was still in the middle of
running, and cut it off before it ever reached its last line (a forced,
unconditional kill for anything still stubbornly alive). The fix: the very
first thing cleanup now does is tell the script to *stop reacting* to
further signals of that kind, so the self-inflicted echo can't interrupt
its own cleanup:

```bash
cleanup() {
  trap '' EXIT INT TERM   # stop reacting to our own broadcast, below
  kill -TERM 0 2>/dev/null
  sleep 1
  kill -KILL 0 2>/dev/null  # anything still alive after a graceful moment
}
```

Both fixes were verified the same way — not by reasoning about them and
moving on, but by actually starting both servers, actually killing the
script, and checking `ps` for survivors afterward. Three clean runs in a
row before trusting it.

### The first real phone photos — a two-bug diagnosis that got sorted out by looking, not guessing

The next real test was the actual point of this whole step: photograph the
real grid with a real phone. It came back `table_not_found` every time, and
this needed real detective work, because the backend is stateless by
design (plan.md §9) — normally, once a request finishes, the photo it was
given is gone, with nothing left to look at afterward.

**A temporary, explicit exception.** A few lines were added to save every
uploaded photo to a local folder (`backend/debug_uploads/`, gitignored,
clearly marked in the code as *temporary* — not a quiet, permanent hole in
the statelessness promise). That single change turned "the camera is
broken and nobody knows why" into "here are the three exact photos it
sent," which is what made everything below possible.

**Bug one: the phone hands back a rotated image, with nothing saying so.**
Opening the saved photos showed the table sideways — needing a 90° turn to
read. A normal photo file carries an EXIF tag saying "this camera was
tilted, rotate me before displaying" — but these aren't normal photo
files. They're generated by drawing a video frame onto a canvas
(`Scan.tsx`), which produces a plain image with no such tag at all. On top
of that, this specific phone was found to report its video as
portrait-shaped (right *dimensions*) while the actual picture data inside
stayed in the camera sensor's native, unrotated layout (wrong *content*) —
a real, documented mismatch some Android/browser combinations have.
Fixed with `detect_any_orientation()` — try the photo as given, and only if
that specifically comes back `table_not_found`, try it rotated 90°, 180°,
and 270° before giving up. (Deliberately *not* built into `detect()`
itself, which stays strict on purpose — that strictness is what step 1's
whole tuning process depends on.)

**Bug two, hiding behind the first: a false "second row" from an edge that
was already there.** Even after correcting the rotation, the ID table
still failed — with a very specific, informative shape: it found 1 row
where there should be 1, but somehow *also* thought there were 2. Printing
the raw numbers (not guessing) showed exactly why: the real border line was
detected correctly, 8 pixels short of the table's actual bottom edge — and
a separate piece of code, meant to catch a border that's missing entirely
and add it back in, saw that 8-pixel gap, assumed the real border simply
hadn't been found, and added a *second* one right next to the first. One
real line became two, `row_count` silently became 2 instead of 1, and the
whole table got miscategorized as a second "answer row" table — quietly
bumping the real Serial table out of its slot entirely, with nothing about
the error message hinting that this was the actual cause.

The fix isn't "make the 8px number bigger" (that's the same trap as
guessing a threshold instead of measuring one) — it's a general rule
applied *after* that edge-filling step runs: **if two final boundaries ever
end up closer together than any genuine boundary has ever been measured at
across every real photo so far (190+ pixels, every time), collapse them
into one.** That's a rule grounded in real, repeated measurement, not a
number picked to make one photo pass.

**The result:** two of the three real phone photos now succeed completely,
rotation and all, matching every value already proven correct back in
steps 1–4. The third correctly reports `column_count_mismatch` instead —
some genuine dividers in one section of that specific photo simply weren't
detected (most likely lighting or a lighter pen stroke in that spot, not a
bug), and refusing to guess rather than silently writing a mark into the
wrong column is exactly the behavior plan.md §6 asks for. Not every real
photo is expected to succeed — a system that fails safely on a genuinely
harder photo, instead of guessing wrong, is doing its job.

Both fixes were checked against everything that already worked, not just
the new photos — all 21 backend tests, both existing real testset photos,
and the whole synthetic smoke-test set stayed green. The one thing
deliberately *not* claimed as fixed: a synthetic photo tilted by a mild
15° (not a clean 90° turn) still fails, the same as it always has — that
needs a different, finer-grained fix (measuring and correcting a small
angle, not snapping to 90° multiples), and it's still an open problem, now
distinguished clearly from the "held sideways" problem this session
actually solved.

### Bug three: right shape, upside down — a matched table that reads backwards

Two more real photos, and one still came back wrong — not `table_not_found`
this time, but a genuinely strange result: the app reported success, yet
every single field (ID, serial, all five marks, the total) came back
completely unreadable. That's a different kind of wrong from anything
before it, and it pointed at something upstream of recognition entirely.

Building the exact composite image that would have been sent to Gemini
(rather than guessing) showed it immediately: the tile labelled "Q1" held
the printed *header text* — "Q1(5)" — not the number someone had written
underneath it. Worse, the tiles ran in reverse: Total, then Q5, then Q4...
back to Q1. The detector hadn't failed to find the table. It had found it
completely upside down, and — this is the important part — a table
rotated 180° from correct still has exactly the right number of rows and
columns. Every check the code had for "is this really the table" is
purely a shape check, and an upside-down table is, shape-wise,
indistinguishable from a right-side-up one. It passed every test that
existed and was still completely wrong.

The fix didn't need anything new — it reused a rule that was already
sitting in the plan, for a completely different stated reason. The marks
table's answer row is deliberately taller than its header row (plan.md
§3) — that was chosen to give someone room to write "4.5" clearly.
It turns out that same fact is also a free, content-blind way to check
*which way up* the table is: read top to bottom, the short row must come
first and the tall row second. If it's the other way around, the table is
upside down, full stop, no exceptions — that's not a coincidence to work
around, it's a hard rule built into the paper itself:

```python
marks_candidates = [
    c for c in candidates
    if c.row_count == 2 and (c.row_bounds[2] - c.row_bounds[1]) > (c.row_bounds[1] - c.row_bounds[0])
]
```

A candidate that fails this check is no longer treated as "the marks
table" at all — which sends the whole orientation-retry loop from step 6's
earlier fix back to try the *next* rotation instead of confidently
accepting a shape match that would have read every value backwards.

**Where this landed:** re-checked against everything — all 21 backend
tests, both existing real testset photos, and every real phone photo taken
so far, old and new. Nothing that used to pass stopped passing. **3 of the
4 real phone photos now succeed completely**, matching every real value
exactly; the one that still doesn't has an already-understood, unrelated
cause (a couple of genuine dividers not detected, likely lighting) and
correctly refuses to guess rather than fail in some new, confusing way.

The pattern across all three of today's bugs is the same one, worth naming
directly: **a check that looks at shape alone (row count, column count)
can be fooled by content that's geometrically valid but semantically
wrong** — rotated 90° with the pixels not matching the reported
dimensions, a boundary that's real but positioned oddly, a table that's
flipped 180° and still has the right shape. Every fix added a small piece
of *meaning* the geometry alone couldn't provide — the true range of a
genuine line gap, the fact that answer rows are always taller than header
rows — rather than a bigger, blunter geometric threshold.

### Fixing it at the source, not just guessing better afterward

Every fix so far treated the symptom at the backend: the phone sends
something oddly rotated, and the backend tries to recover by guessing
across four possible orientations after the fact. After the third real
photo hit essentially the same root problem again, the better move was to
stop the bad orientation from ever being sent in the first place.

The insight: the printed grid is *always* physically wider than it is
tall — that's fixed by the template, not by how anyone holds their phone.
So the moment a captured photo comes back portrait-shaped (taller than
wide), that alone is enough to know it needs a quarter turn, no guessing
required. That check now happens in `Scan.tsx`, right at the moment of
capture, before the photo is ever uploaded:

```typescript
const isPortrait = video.videoHeight > video.videoWidth;
...
if (isPortrait) {
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
}
```

Getting the *direction* of that turn right mattered enough to check
directly rather than assume — the exact same rotation math was replicated
against a real saved photo (not a live phone, since that isn't available
from here) and run through actual detection, which came back a clean
match, and the resulting image was also opened and read by eye to confirm
it was genuinely upright, not just "shaped right, matched by luck."

**What this does and doesn't replace.** This doesn't retire the backend's
four-way retry or the upside-down check from bug three — those stay, as a
safety net for whatever a *different* phone or browser might still do
unexpectedly. What it should do is remove the need for that safety net to
fire at all for the device actually being tested against — turning "guess
correctly among four options after the photo already arrived wrong" into
"the photo mostly doesn't arrive wrong to begin with." Whether that holds
up still needs the same thing every fix in this step has needed: an actual
phone, taking an actual picture.

## Step 7 — Review screen

Step 6 built the plumbing: photograph a script, get a raw `ScanResult`
back. Nothing checked whether that result was actually *right*. Step 7 is
the screen where a human looks at what came back and either confirms it or
fixes it before it becomes a permanent record — plan.md §10 calls this
"the main safety net against a silent misread," and it's built as four
separate pieces: three pure functions that don't need a browser to test,
plus the screen component that wires them to editable fields.

### The pure logic lives in `validateMarks.ts`, on purpose

Everything that can be a plain function — no React, no DOM — is one, in
[frontend/src/validateMarks.ts](frontend/src/validateMarks.ts). The reason
is the same one `validateConfig.ts` was already built this way back in
step 5: a function that just takes values in and returns a result can be
tested directly and exhaustively, while anything wrapped in a component
needs a browser-like environment (jsdom) and is slower and fussier to
assert against. step.md's own Test section for this step calls these pure
functions "the heart of the suite."

**The sum check** adds up the question values and compares to the printed
total — recomputed fresh every time, never stored:

```typescript
export function sumCheck(questions: QuestionValue[], total: number | null): SumCheckResult {
  const computedSum = questions.reduce((sum, q) => sum + (q.value ?? 0), 0);
  return {
    computedSum,
    matches: total !== null && Math.abs(computedSum - total) < 1e-9,
  };
}
```

"Never stored" matters here specifically because `Review.tsx` calls this
function directly inside the component body, on every render — so the
moment an instructor edits a mark, the next render calls `sumCheck` again
with the new numbers and the ✓/✗ on screen updates immediately. If the
pass/fail were instead computed once and stashed in state, an edit could
leave a stale ✓ showing next to numbers that no longer actually sum
correctly — exactly the bug CLAUDE.md's "Derive, don't store" rule exists
to rule out.

**The legal-value check** is the same 0.5-step-within-range rule the
backend (`marks.py`) already enforces on Gemini's output, run again here
against a manual edit — a typo while *fixing* a misread shouldn't be able
to introduce a new, illegal one:

```typescript
export function isLegalValue(value: number, max: number): boolean {
  if (!Number.isFinite(value) || value < 0 || value > max) return false;
  const doubled = value * 2;
  return Math.abs(doubled - Math.round(doubled)) < 1e-9;
}
```

Doubling and checking against the nearest whole number, rather than
something like `value % 0.5 === 0`, sidesteps floating-point noise — `2.5
% 0.5` in JavaScript doesn't reliably come out to exactly `0`.

**The cross-check** is plan.md §10's table, translated line for line:

| Situation | Meaning | Action |
|---|---|---|
| Same serial, same ID | Same script scanned twice | Block, offer overwrite |
| Same serial, different ID | One serial was misread | Warn, show both |
| Same ID, different serial | One serial was misread | Warn, show both |
| Both empty | Unusable record | Block |
| Only one filled | Valid but unverified | Allow |

```typescript
export function crossCheck(
  candidate: { studentId: string | null; serial: string | null },
  existingRecords: StudentRecord[],
): CrossCheckResult {
  const candidateSerial = normalizeSerial(candidate.serial);
  const candidateId = candidate.studentId?.trim() || null;

  if (!candidateSerial && !candidateId) {
    return { action: 'block', unverified: false, conflicts: [] };
  }

  const conflicts: CrossCheckConflict[] = [];
  for (const existing of existingRecords) {
    const sameSerial = candidateSerial !== null && normalizeSerial(existing.serial) === candidateSerial;
    const sameId = candidateId !== null && existing.studentId === candidateId;
    if (sameSerial && sameId) conflicts.push({ reason: 'duplicate', record: existing });
    else if (sameSerial) conflicts.push({ reason: 'serial-mismatch', record: existing });
    else if (sameId) conflicts.push({ reason: 'id-mismatch', record: existing });
  }
  // ...then: any 'duplicate' → block; any conflict at all → warn; else → allow
```

This function doesn't fetch anything itself — it's handed a list of
records the caller already looked up. `Review.tsx` does that lookup using
the indexes step 5.2 built (`findRecordsBySerial`, `findRecordsByStudentId`
in `db.ts`), which is why those indexes had to allow duplicates: a
duplicate index entry *is* the two conflicting records this whole check
exists to put side by side.

`normalizeSerial` handles the "02 equals 2" rule the table depends on —
stripped of leading zeros, with one deliberate corner case: an all-zero
serial like `"000"` normalizes to `"0"`, not to nothing, so serial `0`
doesn't accidentally look the same as a blank field.

All of this — 18 cases across the four functions, including all five rows
of the cross-check table as a single parameterized `describe` block — is
tested in `validateMarks.test.ts` with no DOM at all.

### `Review.tsx`: wiring the checks to editable fields

The screen itself ([frontend/src/Review.tsx](frontend/src/Review.tsx))
does four things plan.md §10/§11 are specific about:

1. **Identity first, and large.** The student ID and serial inputs render
   at the top, at `2rem` font size — not styled as ordinary form fields,
   because plan.md is explicit that this is the highest-value check in the
   workflow and the instructor is holding the physical script right then.
2. **Marks next to the photo.** The captured image (passed down as a blob
   URL, reused from the same preview `Scan.tsx` already keeps for its own
   debug view) sits beside the editable Q1…Qn and Total fields.
3. **Low-confidence fields get a visible flag.** The backend's
   `low_confidence_fields` list (`"student_id"`, `"serial"`, `"q1"`,
   `"total"`, …) becomes an amber border on exactly those inputs — nothing
   is silently guessed, per CLAUDE.md's "Flag, never guess" rule.
4. **Save runs the cross-check before anything is written.** `handleConfirm`
   looks the candidate up by serial and by ID, calls `crossCheck`, and only
   calls `saveRecord` immediately if the result is `'allow'`. A `'block'`
   or `'warn'` result instead shows a conflict panel with the competing
   record(s) and lets the instructor pick Overwrite / Save anyway / Cancel
   — the check can *stop* an accidental save, but a human still makes the
   final call, matching plan.md's "Warn, show both" (not "auto-reject").

**Failed scans reuse the exact same screen**, per 7.6 — `Review` doesn't
have a separate branch for `status: 'failed'`. It just seeds every field
as empty instead of populating them from the result, shows a banner with
the failure reason and Retake/Enter-manually buttons, and otherwise it's
the identical editable form a successful scan would show. "Enter manually"
doesn't open some other mode; it just dismisses the banner, because the
fields underneath were always the real, editable ones — there was never a
separate manual-entry path to switch to. This is what keeps a bad photo
from being a dead end: it lands on a screen that can still produce a
correct, saved record.

### Testing this without a phone

Step 6 needed a real phone for almost everything, because the thing being
tested was the camera. Step 7 doesn't have that problem — everything it
does is form logic, so alongside the 18 pure-function tests,
`Review.test.tsx` uses React Testing Library (already a project dependency,
just not exercised by any screen until now) to check the DOM-level
behaviors step.md's Done-when bar actually names: typing into a mark field
recomputes the sum check live without a save, an illegal edit disables
Confirm until it's fixed, and a `status: 'failed'` result really does
render an editable form rather than a dead page. A save test runs against
`fake-indexeddb` (the same fake IndexedDB `db.test.ts` already uses) to
confirm a confirmed record actually lands in the store. None of this
proves the screen looks or feels right in an instructor's hand — that part
still needs step 8 and a real device — but it does mean step 7's specific
Done-when bar (five cross-check rows passing, the sum check recomputing,
a failed scan reaching an editable screen) is met without needing one.

**What's deliberately not built yet.** `Scan.tsx` gained just enough
wiring to open `Review` for a finished capture (a "Review" button per
queue entry, replaced with "Saved ✓" once confirmed) so the screen could
actually be exercised end to end. The tighter loop plan.md and step.md
describe — Confirm advancing straight back to a live camera with no extra
tap, because that tap "gets paid thirty times per class" — is explicitly
step 8's job, not this one, and hasn't been built.

### A real bug the phone found: the frozen camera after Confirm

First real-phone pass of Review surfaced a genuine bug, not a step-8 gap:
after Confirm & next, the app looked stuck — the camera preview stayed
frozen and Capture did nothing.

The cause was in how `Scan.tsx` first opened `Review`. It used an early
`return`, swapping the component's *entire* JSX tree for `<Review />`
whenever a capture was being reviewed:

```typescript
if (reviewingEntry?.result) {
  return <Review ... />;   // replaces everything below, <video> included
}
return (
  <div> ... <video ref={videoRef} ... /> ... </div>
);
```

That unmounts `<video>` — and the camera-setup effect only ever binds the
live stream to the video element once, right when it first resolves:

```typescript
navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS).then((s) => {
  stream = s;
  if (videoRef.current) {
    videoRef.current.srcObject = s;   // runs once, on the very first mount
  }
});
```

`videoRef` is a stable ref *object*, but the DOM node it points at is not
stable — React tears down and recreates the `<video>` element every time
the early return toggles. Closing Review (Retake or a successful Confirm)
brings back a *brand-new* `<video>` node that nothing ever assigns a
`srcObject` to, since the effect that does that assignment already ran and
won't run again. The result: a blank, unresponsive preview, and
`capture()` silently doing nothing because it bails out the moment
`video.videoWidth` is `0`.

The fix keeps `<video>` permanently in the tree and renders `Review` as a
`position: fixed` overlay on top of it instead of swapping trees:

```typescript
{reviewingEntry?.result && (
  <div style={{ position: 'fixed', inset: 0, ... }}>
    <Review ... />
  </div>
)}
<p>Scanned {scannedCount}</p>
<video ref={videoRef} ... />
```

The camera element — and the live stream already attached to it — never
goes away; Review just visually covers it while open. This is a general
lesson worth carrying into step 8's fuller loop wiring: anything holding a
live browser resource (a camera stream, here) needs to stay mounted across
screen transitions, not get torn down and rebuilt by a conditional
`return`.

---

## Steps 2r.0 / 2r / 3r / 3r.6 — Local CNN recognizer (planned — not started, rationale only)

Everything below is **why**, not **what the code does** — nothing in this
section has been built yet (see step.md's Progress table: all three rows
say "not started"). It's here anyway because understanding why a change
this size is planned is part of learning alongside the build, the same as
any finished step's write-up, just aimed at the reasoning instead of the
code. The actual design lives in [plan.md §16](plan.md), the concrete
build order in [step.md](step.md)'s steps 2r.0/2r/3r/3r.6; this section
just explains the reasoning in plain language.

### Why now, not from the start

plan.md §13 always listed "a local digit classifier for marks too" as
something to consider — but explicitly deferred, "only if Gemini accuracy
or quota becomes a real constraint." That was the right call at the time:
building a whole second recognizer before knowing whether the first one
even had a problem would have been solving an imagined issue. The reason
this is happening now is that both halves of that condition stopped being
hypothetical, in this same project, with numbers to point at:

- **Quota**: a real `rate_limited` response came back from Gemini during
  the actual step 6/7 phone test session — not a worst-case estimate, a
  thing that happened mid-scan (see step 3's section above).
- **Accuracy**: id_ocr.py's own measured numbers, after two real rounds of
  tuning against real photos, are 58.9% per-digit and 0-of-8 whole-ID
  exact match (see step 2's section above). That's not "could be better,"
  that's a ceiling that real tuning hit and stopped moving past.

The specific *diagnosis* behind that second number is what actually makes
a CNN the right next move rather than a third round of Tesseract tuning.
Step 2's own write-up above found that Tesseract's LSTM engine was reading
a handwritten `0` as the letter `"D"` at 86% confidence, and a `1` as
`"l"` at 90% — high-confidence, *correct-shape* reads that got thrown away
because Tesseract is fundamentally a text engine, and letters are always
somewhere in its output space competing with the digit it should have
picked. A classifier with only ten possible outputs (0–9) cannot make that
specific mistake, structurally — not because it's a better-tuned version
of the same idea, but because the failure mode doesn't exist in its output
space at all. That's a difference in kind, not degree, and it's the kind
of thing more `PSM`/`OEM` tuning was never going to fix.

### Why beside the existing path, not instead of it

The plan is explicit that nothing gets deleted: `id_ocr.py`, `marks.py`,
and `marks_ocr.py` (the rate-limited fallback built in step 3) all move
behind a shared `Recognizer` interface rather than being torn out, and a
`RECOGNIZER` setting picks which implementation actually runs. A few
reasons that matters, beyond just caution:

- **The existing path is already proven.** It's what every real accuracy
  number in this project so far — the 58.9%, the Gemini exact match, the
  fallback's 2-of-7 recovery — was measured against. Throwing it away
  would also throw away the only yardstick for whether the CNN is
  actually better.
- **A brand-new model is an unknown quantity on real handwriting.** EMNIST
  (the training data) is 1990s American handwriting; local conventions —
  how a `7` gets crossed, how a `4` gets closed, whether a `1` has a base
  serif — differ in exactly the ways that matter, and there's no way to
  know how much that hurts accuracy until it's measured on real crops.
  Keeping the old path live means there's always a working fallback while
  that's being found out.
- **The comparison itself is useful, not just a safety net.** Running both
  recognizers side by side (`RECOGNIZER=both`) and logging every
  disagreement turns the review screen — which the instructor is already
  using to confirm or correct every field — into a source of labelled
  training data almost for free. A disagreement between the two paths is
  exactly the hard case worth learning from; agreement isn't.

### The idea worth understanding before any of it gets built

The single most important design idea in the plan is one this project
already leaned on once, for Gemini: **don't parse free text and validate
it afterward — score every legal answer directly.** Section 9 of plan.md
already does this for Gemini's marks: the prompt states the exact legal
value set per question (0, 0.5, 1, … max), so a smudged `4.5` that could
be misread as `45` never becomes `45` in the first place, because `45`
was never a candidate. `marks.py`'s `validate_payload` is the same idea
applied as a backend safety net, in case the model doesn't respect that.

Plan.md §16 does the same thing for the CNN, one layer earlier. Instead of
running the classifier digit by digit and assembling whatever string comes
out, the decoder is handed every *legal value* for the question — for a
5-mark question, that's only eleven candidates: 0, 0.5, 1, … 5 — and
scores each one directly against the model's own per-digit probabilities,
picking whichever legal value the model was most confident about as a
whole. An illegal reading like `45` on a 5-mark question isn't rejected
after the fact; it was never in the running to begin with, the same way
Gemini's prompt already rules it out for the existing path. This is why
plan.md calls this "what makes local recognition beat the Gemini path
rather than merely match it" — it's not a new idea, it's the same one this
project already validated once, aimed at a second recognizer.

### Why the ID needs no segmentation but serial and marks do

The template (plan.md §3) already gives the ID one printed box per digit
— that's exactly why those boxes are drawn that way, and it's why
`id_ocr.py` could always crop and read seven single-digit cells
independently. Serial and mark cells don't have that — a student writes
`"07"` or `"4.5"` freely inside one cell, so before any digit classifier
can run, something has to first work out *how many glyphs are in this
crop and where each one starts and ends*. That's what plan.md §16 calls
segmentation: find connected ink components, throw out anything too small
to be a real stroke, and — the detail called out as the single most common
failure — merge two components back into one glyph if they're really just
a `4` or `5` written with a pen stroke that didn't fully connect. Miss
that merge rule and a single handwritten `4` gets read as two separate,
wrong digits instead of one right one.

### Why marks and IDs need different training data, from different people

This is the one idea in the plan that isn't really about machine learning
at all, it's about who's actually going to write each field in production.
**Marks are written by one person, always** — whoever is grading — so
training the marks-reading model on that one person's own handwriting
isn't overfitting, it's targeting exactly the distribution it will see
forever. **IDs and serials are written by students** — a different set
every semester, most of whom will never be seen in advance — so the
grading instructor's own handwriting samples are nearly useless for that
field, and what actually helps is collecting from as many *different*
people as possible. Same model architecture, same training procedure,
but the right data to fine-tune each half on is almost the opposite of
the other. Missing this distinction is called out in the plan as a real
risk: fine-tune the ID model on only the instructor's own handwriting
sample sheets, and it gets *worse* at reading actual student handwriting,
not better — the fix is holding out an entirely unseen writer to measure
against, specifically so that mistake would show up as a number instead
of a surprise later.

### What "done" will actually mean here

Per step 2r's own Done-when bar: a real, measured per-digit accuracy
number on the same real photos `id_ocr_accuracy.py` already scores,
materially beating 58.9%, with the confidently-wrong count still at zero.
Not a benchmark number from a paper, not an EMNIST test-set score — the
same kind of "run it against real crops and write down what actually
happened" measurement every other number in this project so far has been.
That's the bar this section will get rewritten against, the same way step
2's own entry above went from "3/7 on one photo" to "58.9% across eight"
as real evidence came in.
