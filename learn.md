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

### A synthetic dataset arrives, gets checked, and the generator gets adopted

Real handwriting samples take time to collect — a printer, real people, a
camera, one photo at a time. The user got a shortcut from a separate
claude.ai conversation: 20 AI-generated photos of script cover pages
(`synthetic_scripts/images/`), a matching `ground_truth.json`, and the
Python script that made them (`generate.py`). Free test data is still data
that needs checking before it's trusted, so before using any of it, three
questions got answered with real checks, not assumptions.

**Is the ground truth actually consistent?** A small script checked all 20
records: every mark inside `[0, max]` on 0.5 steps, every `sum(marks)`
equal to its own `total`, every `max_total` equal to `questions × max`,
every student ID exactly 7 digits. Zero violations — clean data.

**Does the layout match this app's real template?** Yes — an "ID" label
plus 7 one-digit boxes, a "Serial" label plus one value box, a marks table
with a header row and one value row. Structurally the same shape this
project's own detector already expects, not a generic guess at what a
grading grid looks like.

**Does it actually work with the real pipeline?** This is the one that
mattered most, and the only way to answer it was to run all 20 through the
actual `detect_any_orientation()` — same code the app uses, no shortcuts.
Only 9 of 20 passed. Looking at *why* (not just accepting the number)
turned up something specific: the generator draws every ruled line with a
hand-wobble simulation, and that wobble is the same absolute size
regardless of how long the line is. A short vertical divider (one row
tall) barely notices it; a long horizontal rule spanning the whole table
can wobble enough, over its full length, to break apart under this
project's line-detection kernel — which needs a mostly-straight run of
dark pixels to recognize something as "a line" at all. Checked directly on
one failing photo's own `mask_horizontal.jpg`: no continuous horizontal
line survived anywhere, just short fragments, on a photo with no visible
rotation at all.

Two of the original 20 got added as real test cases in `testset/`, with
their ground truth transcribed into `labels.json`: `synthetic_script_001.jpg`
(kept as a known, still-failing case for the wobble problem above — its
label says `expected_success: false` on purpose, so the test suite treats
the failure as *correct*, not broken) and `synthetic_script_004.jpg`,
which turned out to have a much more interesting problem — see the
"fifth real tuning round" in Step 1 below, where fixing what this one photo
exposed replaced a whole piece of the orientation-detection logic.

**Getting the generator running locally** meant undoing three
sandbox-specific assumptions baked into `generate.py`: a font folder path
that only existed inside the claude.ai environment, an output folder on a
volume that doesn't exist here, and a scratch folder for a two-phase build
process (`generate.py 0 20` writes images and per-image records; a second,
no-argument run reads those records back and assembles the final
`ground_truth.json`). None of the 15 named fonts were included, so each
had to be found and downloaded individually — Google's font API will hand
back a raw `.ttf` file if asked with an old-enough browser identity:

```python
css = requests.get(
    "https://fonts.googleapis.com/css2?family=Caveat",
    headers={"User-Agent": "Mozilla/5.0 (Linux; U; Android 2.2)"},
)
# -> src: url(https://fonts.gstatic.com/.../WnznHAc....ttf) format('truetype')
```

A modern browser identity gets served a compressed `.woff2` instead, which
Pillow can't load directly — the old-Android trick sidesteps that. With
the paths fixed and the fonts in place, regenerating all 20 locally
produced 19 byte-for-byte identical images and one that differed only in
its JPEG compressor's exact output bytes (not its content) — about as
strong a confirmation as this kind of check can give that the setup is
exactly right, since the random values are seeded deterministically from
each image's index.

**Then the user asked for a real change to how the images look**, and it's
a good one: the original generator hand-drew *everything* — the ruled
lines, "ID", "Serial", every "Qn(m)" header, all of it, in the same
wobbly handwriting style as the actual filled-in values. But that's not
what a real script cover page looks like. In real use (and in this
project's own `marks-grid-template.docx`), the grid and its labels are
*printed* on the question paper — machine-perfect, dead straight — and
only the values a person fills in by hand are actually handwritten. The
fix was to give the generator two separate vocabularies instead of one:

```python
def printed_line(draw, p0, p1, color, width):
    """A perfectly straight machine-printed rule — no wobble, no per-node
    noise."""
    draw.line([p0, p1], fill=color, width=width)
```

next to the original `hand_text` (still used, unchanged, for every actual
value), and a `printed_text` that centers text in a box with no jitter and
no rotation — the same box-centering math `hand_text` already used, minus
the loop that randomly nudges each character. Labels now render in a real
downloaded print font (Liberation Sans) instead of one of the 15
handwriting fonts, and in a fixed dark color instead of whatever random
pen color the values end up using — a printed label doesn't care what pen
someone later fills the form in with. Once nothing called the old
`hand_line`/`hand_rect` wobble functions anymore, they were deleted rather
than left behind as dead code, along with the `math` import they were the
only user of.

The very next test run showed this wasn't just a cosmetic change. A fresh
image from the new generator, run through the real `/api/scan` pipeline,
got its serial number exactly right for the first time in any test this
project has run on this dataset, and all 8 marks exactly right too. But it
also surfaced something the project hadn't seen happen before: the Total
field — the one value on that page needing *two* handwritten digits read
correctly in a row, not one — came back as `27.5` against a true `21.5`,
a "1" misread as "7" in this particular handwriting font, and nothing
flagged it, because `27.5` is still a perfectly legal number for that
question's maximum. Every safeguard this project has built checks whether
a value is *legal* — in range, on a 0.5 step — not whether it's *correct*.
A confidently wrong answer that happens to land inside the legal range has
no safety net today. That's a real, honestly-reported gap, not yet acted
on — flagged for the user rather than quietly worked around.

### 18 real photos from a real class arrive, and expose two real bugs (2026-08-30)

Every real photo up to this point came from one or two people testing the
app themselves. The user then handed over 18 actual photographed scripts
from a real CSE211L quiz — genuinely 18 different students' handwriting,
with a hand-transcribed answer key (`testset/real_class_info.json`). This
is the first batch big and diverse enough to actually test what "different
handwriting" does to the numbers, not just talk about it.

**Checking the data before trusting it** (the same discipline the
synthetic dataset got above) turned up two things worth knowing before
using it: the 18 photos actually use *three different quiz layouts* — 3
questions, 5 questions, and 8 questions where the last two are worth
double — which meant building a small new file,
[testset/quiz_configs.json](testset/quiz_configs.json), since
`labels.json` itself never had anywhere to record a question's maximum
mark. And one photo (`real_class_08.jpeg`) has a genuinely illegal value
on it: a question capped at 5 marks, marked as a 7. The row still adds up
correctly, so it's not a copying mistake — someone really did write a 7 in
a 5-mark box. Kept on purpose, since it's exactly the kind of real-world
case the "never guess an illegal value" rule exists for.

**Bug one: a stranger's ID row can steal the Serial slot.** Photographing
several separate answer sheets stacked together means each photo shows
slivers of the *neighboring* sheets peeking in at the top and bottom edge
— a new condition, `adjacent_scripts_in_frame`. `app/detection.py` used to
pick the ID and Serial rows by sorting every single-row candidate by how
many columns it has and taking the top two:

```python
single_row_raw = sorted(candidates, key=lambda c: c.col_count, reverse=True)
id_table = single_row[0]
serial_table = single_row[1]
```

That works when there's exactly one 8-column row (ID) and one 2-column row
(Serial) on the page. But a neighboring script's own ID row is *also*
8 columns — so on 4 of the 18 photos, that decoy tied with the real ID row
for "most columns," bumped the real, smaller Serial box down to third
place, and the code confidently read the wrong row as this student's
serial. Nothing about the output looked wrong — `status: "ok"`, a
plausible-looking serial number — it was just quietly the wrong one.

**Bug two, found while fixing bug one:** the first fix tried matching each
role by its *expected* column count instead of by rank. That closed the
serial mix-up, but uncovered something worse on a fifth photo
(`real_class_11.jpeg`): that photo's own ID row had a genuine, unrelated
problem — one faint internal divider wasn't detected, so it measured only
7 columns instead of 8. Matching by expected count means a 7-column row
never counts as a valid ID candidate — so the code fell back to the only
thing that *did* match (the neighboring script's 8-column decoy) and
happily read a different student's ID as if it were correct.

The actual fix doesn't lean on column count at all for *picking* the row
— only the existing mismatch check still uses it, to report an honest
failure when a row's shape really is wrong. Picking uses position instead,
anchored to the marks table, which is reliably unambiguous (its shape has
to match the quiz's real question count exactly):

```python
above_marks = sorted(
    (c for c in single_row if bottom_y(c) <= marks_top),
    key=lambda c: marks_top - bottom_y(c),
)
serial_table = above_marks[0]  # closest above Marks
id_table = above_marks[1]      # next closest
```

The template's own layout guarantees ID sits directly above Serial sits
directly above Marks, tightly grouped, for one script — so "closest above
the marks table" is always this script's own row, no matter how many
same-shaped decoys from other scripts are floating elsewhere in the frame.
Verified by looking at the actual pixel crops, not just the pass/fail
status: `real_class_14.jpeg`'s ID crop used to silently contain a
different student's digits at `status: "ok"`; after the fix it shows its
own digits, and `real_class_11.jpeg` now honestly reports
`column_count_mismatch` on its own genuinely short ID row instead of
quietly substituting someone else's.

**Two smaller, related bugs, found by the same batch:** `id_ocr_accuracy.py`
and `cnn/accuracy.py` both hardcoded "5 questions" when calling `detect()`
— fine when every test photo used one template, but it meant every 3- or
8-question photo in this batch failed detection for an unrelated reason
before its ID was ever read. Fixed to read the real per-photo question
count from `labels.json`, the same way `test_detection_regression.py`
already did. And six of the photos' serial numbers were transcribed as
plain numbers (`7`, `6`, `5`) when the actual page shows them handwritten
with a leading zero (`07`, `06`, `05`) — checked by looking directly at
each photo, then corrected to match this project's own rule that ground
truth records what's literally written, leading zero included.

**The real numbers, after all four fixes, on real multi-writer data:**
detection succeeds on 17 of 18 photos (one is genuinely too blurry); the
CNN reads IDs at 85.7% per-digit and marks at 98.1% per-question, with
zero confidently-wrong reads on any of the new photos; and
`real_class_08`'s illegal 7-in-a-5-mark-box came back correctly flagged
blank, never guessed. All 84 backend tests pass. The full story of what
got measured, and the recalibration that followed, is in Step 2r below.

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

### A third real round: an absolute floor isn't the same as "not an outlier"

The first two tuning rounds above both used an *absolute* floor —
`MIN_LINE_COVERAGE_FRAC`, a fixed 40% of the table's own height/width that
a candidate line has to clear regardless of what else is in the same
table. That works well when the false candidate is dramatically shorter
than a real line (a "1"'s 25% versus a real rule's 66%+), but a user
testing this app on a whiteboard rather than the printed template
produced a case where it wasn't dramatic enough: a stray extra line in a
hand-drawn ID row measured 44.5% coverage — comfortably above the 40%
floor — while its nine genuine neighbors all measured somewhere between
57% and 99%. Nothing about an absolute floor can catch that: 44.5% is a
perfectly respectable number in isolation, and only looks wrong sitting
next to numbers over twice its size.

The fix asks a different question — not "is this line long enough on its
own," but "is this line anywhere near as long as the *other* lines in
this same table":

```python
if len(values) >= 4:
    median_value = float(np.median(values))
    floor = median_value * MIN_RELATIVE_PEAK_FRAC
    centers = [c for c, v in zip(centers, values) if v >= floor]
```

The `len(values) >= 4` guard matters more than it looks. `_cluster_peaks`'s
own docstring already warns that a *purely* relative rule is unsafe on a
short table — a handwritten digit could be the tallest thing around
simply because there's nothing else to compare it to, and "tallest thing
here" isn't the same claim as "as tall as a real rule." Requiring at
least four peers before this check even runs is what keeps the two ideas
from colliding: with nine real dividers to compare against, "this one is
half the length of the rest" is a meaningful, safe signal; with one or
two, it wouldn't be.

Getting the actual ratio right took the same measure-don't-guess approach
as before. A first attempt at 0.5 fixed the ID table outright but left a
second, textbook-familiar bug standing: the exact "tall handwritten `1`
aliasing as a column divider" failure this project had already hit twice
(this section's own second round, and a 0.449-coverage case noted but
left unfixed during step 6) — a `1` in a hand-drawn "197" measured 40.6%
against a median of 79.3%, just barely surviving a 50%-of-median cutoff.
Tightening to 0.55 caught it too, without rejecting anything in the
regression set: all 9 real `testset/images/` photos and all 63 backend
tests stayed green through both the 0.5 and 0.55 versions.

One whiteboard photo now passes end to end, `status: "ok"`, all three
tables, exact column counts — the first time this project's detector has
been tested against anything other than pen on paper. A second whiteboard
photo improved (two of its three tables now correct) but still fails: a
genuine divider for a narrow last column sits only 9px from the table's
true edge and gets swallowed by `_merge_close_bounds`, the safeguard step
6 built for a *different* real bug — a genuine border line detected 8px
short of its true position. Both cases involve the same tiny gap size,
which means gap distance alone cannot tell them apart; whatever fixes
this one will need a different signal (most likely the same
coverage-strength idea used above, since the swallowed divider here has
real, unremarkable coverage — not the mark of a duplicate detection). Left
alone rather than guessed at: there's no photo left in the current
regression set that's known to exercise the original 8px case, so there's
no way to prove a change here doesn't quietly reopen it.

### A fourth real round: coverage measured on the wrong image

The user's next question was about a different kind of risk entirely —
does a photo with other stuff in frame (a notebook's spiral binding,
other handwritten notes on the same page, a second page's corner peeking
in) get mistaken for the grid? Three real test photos, deliberately messy
in exactly that way, answered that part cleanly: none of the clutter in
any of them produced a false table candidate. That's a property of *how*
detection works, not something added for this — a table candidate only
comes from a rectangle of ruled lines surviving the morphology in
`_line_masks`, and ordinary handwriting or a page edge essentially never
does that.

But all three photos failed anyway, and the reason turned out to be new:
several genuine, intended column dividers weren't being recognized as
dividers at all. Measuring the actual pixels made the cause obvious in a
way no amount of threshold-guessing would have: two real ID-row dividers
in one photo scored only 41–43% on `MIN_LINE_COVERAGE_FRAC`'s coverage
metric — comfortably below the 40% floor — while the *same pixels*,
measured directly against the paper around them, were just as dark
(contrast 80–94, on a 0–255 scale) as every divider that did pass
(63–116). The two numbers were describing the same ink and disagreeing
with each other.

The reason they disagreed is what "coverage" had actually been measuring
all along. It was never the line's own darkness — it was how much of a
*binarized, then eroded-and-dilated* mask survived at that position.
`cv2.adaptiveThreshold` and the erode/dilate step in `_line_masks` are
tuned once, for the whole photo, not per-line — so under an uneven angle
or lighting, one single, fully dark, unbroken pen line can come out of
that pipeline as several shorter disconnected fragments. The mask isn't
lying about what survived it; it's just answering a slightly different
question than "is this dark ink" — closer to "did this ink survive being
thresholded and shrunk and grown back."

The fix keeps the mask for what it's actually good at — cheaply finding
*roughly where* a candidate line might be — but moves the accept/reject
decision onto something measured straight off the source photo:

```python
def _contrast_coverage(gray: np.ndarray, axis: str, center: int, margin_frac: float = 0.1) -> float:
    ...
    line_vals = gray[lo:hi, center].astype(int)
    bg_vals = np.maximum(gray[lo:hi, left], gray[lo:hi, right]).astype(int)
    return float(((bg_vals - line_vals) >= CONTRAST_FLOOR).mean())
```

For every position along a candidate line, this samples the paper just to
either side of it (same row, a little left and right) as the local
background, and counts how much of the line is genuinely darker than that
background by at least `CONTRAST_FLOOR = 30`. It's still answering the
exact same question `MIN_LINE_COVERAGE_FRAC` always asked — "does this
line span nearly the whole table" — just off cleaner data. Nothing about
what counts as a real divider changed; only where the darkness number
comes from did.

That alone surfaced a second problem, and it's worth being honest that it
was a real regression, not a hypothetical one: the whiteboard photo from
the third round's stray marker line turned out to be genuinely dark
end-to-end (a marker is more saturated than pen), so on the new contrast
scale it scored 0.562 against its real peers' near-uniform 1.0 — high
enough to slip back past the old `MIN_RELATIVE_PEAK_FRAC=0.55` floor and
reopen the exact bug that floor was built to catch. Measuring the actual
ratios across all three new photos plus the whiteboard photo again — not
guessing a new number — showed every genuine divider clears at least
0.705 relative to its peers, comfortably above the stray line's 0.562.
Moving the floor to 0.65 keeps a real margin on both sides of that gap.

The result was a net gain bigger than the original ask: two of the three
new cluttered photos now pass completely (previously zero of three), and
— unexpectedly — the whiteboard photo's second, previously-open bug (a
genuine narrow column swallowed into the table's edge, flagged in the
third round above as needing "a different signal, most likely the same
coverage-strength idea") turned out to be exactly that: scoring on real
contrast instead of the fragile mask-survival number fixed it as a side
effect, with no separate change needed. The whiteboard photo now passes
`status: "ok"` end to end for the first time.

One case stayed genuinely unfixed, and it's a different kind of gap than
the others — not a threshold problem. The third new photo's ID table is
still short one interior divider, and scanning its expected position
directly shows why: the real contrast there peaks at only around 0.48 at
every point along its length. That's not a fragmented-but-dark line like
the ones this round rescued — it's a line that's actually faint in this
one photo, most likely a lighter pen stroke at that exact spot. No
coverage metric, old or new, should accept that as a divider; the honest
fix is a firmer retake of that one photo, not a lower floor. `main.py`'s
existing `column_count_mismatch` handling already does the right thing
with it — it fails loudly and sends the instructor to retake or enter the
script by hand, rather than silently reading one fewer column than the
config expects.

Full regression after this round: all 9 `testset/images/` photos still
pass, the whiteboard photo passes for the first time, 2 of 3 new
cluttered photos pass (0 of 3 before), and all 63 backend tests pass.

### A fifth real round: the orientation check itself needed replacing

A user on claude.ai generated a 20-photo synthetic dataset of exam script
covers (`synthetic_scripts/`, its own `generate.py`) to help test this
project. One of those, added to the testset as
`synthetic_script_004.jpg`, came back from the full pipeline with
garbage in every field — a wrong 7-digit ID, a wrong 6-digit "serial"
where a 3-digit one belonged, every mark blank. The instinct might be
"the CNN just failed on this font" — but the actual cause was one step
earlier, and a single measurement found it immediately: at this photo's
true, right-side-up orientation, the marks table's *header* row measured
81 pixels tall and its *value* row measured 77 — the header row was
taller, by 4 pixels.

That matters because of a rule from the third round above: the app
treats "is the second row taller than the first" as its signal for
right-side-up versus upside-down, since the real template always draws
the answer row taller by construction. For this one photo, that
assumption was quietly false. The check did exactly what it was built to
do and rejected the true 0° reading as "looks backwards." Then
`detect_any_orientation`'s rotation retry tried 180° instead — and the
same two rows, still 81px and 77px but now swapped top-to-bottom, passed
the identical check for the identical reason, in reverse. The photo got
accepted upside down and mirrored, and every crop handed downstream was
flipped before recognition ever saw it.

Worth sitting with for a second: this is the *third* time this exact
family of bug has shown up. A real phone photo motivated the height
check in the first place. The whiteboard photo above found a case the
check still couldn't resolve (a genuine narrow column, fixed in the
fourth round). Now a synthetic photo shows the check can be defeated by
a margin as thin as 5%. Three different photos, three different routes
to the same underlying weakness, is a pattern — not three unrelated
bugs. That was the cue to replace the signal rather than tighten it
again.

The replacement uses something the row-height check never touched: the
ID and Serial rows' own column 0 is *always* the label ("ID"/"Serial"),
and *always* a multi-letter word — every other column in those rows is
a lone digit or short number, by the template's own construction. A word
reliably breaks into more disconnected ink strokes than a digit does,
almost regardless of how dark the pen is or how the page is lit:

```python
def _label_column_is_backwards(gray, row_bounds, col_bounds) -> bool | None:
    first = _column_component_count(gray, row_bounds[0], row_bounds[1], col_bounds[0], col_bounds[1])
    last = _column_component_count(gray, row_bounds[0], row_bounds[1], col_bounds[-2], col_bounds[-1])
    if first == last:
        return None
    return last > first
```

Before trusting this, it was measured — not assumed — on three real
photos plus the synthetic one, comparing the label column's connected
ink components against the opposite end's:

| Photo | Row | label column | opposite end |
|---|---|---|---|
| synthetic_script_004 | Serial | 8 components | 5 |
| synthetic_script_004 | ID | 5 | 3 |
| filled_file.jpeg (real) | Serial | 11 | 4 |
| filled_file.jpeg (real) | ID | 3 | 2 |
| a real phone photo | Serial | 9 | 6 |
| a real phone photo | ID | 3 | 2 |

Six for six, the label column had strictly more components — and the
`filled_file.jpeg` Serial row is a good reminder of why component count
was chosen over ink darkness: that row's *darkness* measurements came
out almost tied (a 5% difference, the same kind of margin that broke the
height check), while its *component* counts weren't close at all (11 vs
4). Counting distinct strokes turned out to be a sturdier question to
ask than measuring how dark they are.

One more property makes this check do more work than it looks like it
does: a 180-degree flip reverses row order *and* column order together,
as a single transformation — there's no way to flip one without the
other. So resolving left-right order on the ID or Serial row is already
enough, by itself, to know if the *whole page* is upside down, marks
table included. `detect()` now uses it that way: if either single-row
table confirms its label sits where it should, the marks table's own
height check is skipped entirely for that photo — the old check only
still runs as a fallback for the rare case where no ID/Serial signal is
available at all.

The result closes the loop convincingly. `synthetic_script_004.jpg` now
passes detection at its native 0° orientation, no rotation retry needed.
Run through the actual `/api/scan` endpoint afterward:

| Field | Ground truth | Before this fix | After this fix |
|---|---|---|---|
| Student ID | `5257182` | `8??9290` | `5257?82` (6/7 right, 1 flagged) |
| Serial | `195` | `101125` | `null` (flagged, not wrong) |
| Marks Q1–Q7 | `3.5, 0.5, 0.5, 4.5, 3.0, 5.0, 4.5` | all blank | **all seven, exactly** |
| Total | `21.5` | blank | **21.5, exactly** |

Every mark and the total went from blank to exactly right. The ID went
from completely wrong to six of seven digits right with the seventh
correctly flagged instead of guessed. Serial still isn't recovered — but
notice it failed *safe* this time (a flagged blank) rather than
confidently wrong (a 6-digit number where a 3-digit one belonged) —
CLAUDE.md's "flag, never guess" rule holding even when the underlying
read is bad. None of that recognition-side improvement came from
touching the CNN at all; it came entirely from handing it a right-side-up
photo instead of an upside-down one.

Full regression: all 9 original `testset/images/` photos still pass, the
whiteboard photo still passes, 2 of 3 cluttered photos still pass (the
same known unrelated gap), and all 64 backend tests pass (63 plus one
new case for the newly-labelled synthetic photo). One small, unrelated
fix rode along with this: `test_detection_regression.py` had hardcoded
`QUESTIONS = 5` for every photo — true of every real photo so far by
coincidence, since they'd all used a 5-question grid, but false for this
7-question synthetic one. Fixed to read the real count out of
`labels.json` instead of assuming it.

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

### Two small usability fixes from live testing (2026-08-30)

**A retaken scan used to linger forever.** Retake dismisses a failed
scan's entry so `nextToReview` skips it, but the entry itself stayed in
`Scan.tsx`'s queue list underneath the camera, showing "Scan failed:
..." with a live Review button that could reopen a scan the instructor
already threw away. The fix filters it out of what's actually rendered,
not just out of what gets auto-opened:

```typescript
const visibleEntries = entries.filter((e) => !dismissedIds.has(e.id));
```

**Capturing a photo gave no feedback where the instructor is actually
looking.** The only sign a capture had registered was a thumbnail
appearing in the queue list below the camera — easy to miss when your eyes
are on the frame, not scrolled down. The fix adds a spinning ring around
the capture button and disables it while that shot is still uploading and
being recognized:

```tsx
<div className="capture-btn-wrap">
  {capturing && <div className="capture-spinner" aria-hidden="true" />}
  <button className="capture-btn" onClick={capture} disabled={!!cameraError || capturing} />
</div>
```

Worth being honest about the trade-off this makes: step 6.3 originally
built captures to run in parallel on purpose ("the camera never blocks"),
so a queue of several photos could be reviewed together afterward.
Disabling the button while one capture is in flight trades that
throughput for clarity — one shot has to finish before the next can start.
Whether that's the right trade for a real 30-script class session is
exactly the kind of thing only real use can answer, the same way every
other camera-behavior call in this step has been settled.

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

## Step 8 — Scan loop wiring (in progress — code done, real-device sessions run, formal bar not met)

Step 7 built a Review screen that works; step 6 already kept the camera
alive underneath it. What was still missing was the thing step 8 is
actually about: nothing connected them into one loop. Reaching Review
required a manual "Review" click per finished capture, and nothing about
finishing a review fed into starting the next capture. Multiply one extra
tap by thirty scripts a class and it stops being a minor annoyance — hence
CLAUDE.md's own line about this: "anything that adds a tap here gets paid
thirty times per class."

### Picking the next thing to review, as a pure function

The obvious way to auto-open Review — some `useEffect` poking at component
state directly — would have been untestable without a browser. Instead the
decision itself is a plain function in
[frontend/src/scanQueue.ts](frontend/src/scanQueue.ts), next to the queue
reducer that step 6 already built the same way:

```typescript
export function nextToReview(entries: QueueEntry[], handledIds: Set<string>): string | null {
  return entries.find((e) => e.status === 'done' && !handledIds.has(e.id))?.id ?? null;
}
```

"Handled" covers two different reasons an instructor is finished with a
capture: it saved successfully, or they hit Retake and abandoned it. Both
go into the same `handledIds` set passed in from
[frontend/src/Scan.tsx](frontend/src/Scan.tsx) — the function itself
doesn't need to know which:

```typescript
useEffect(() => {
  if (reviewingId != null) return;
  const handled = new Set([...savedIds, ...dismissedIds]);
  const next = nextToReview(entries, handled);
  if (next != null) setReviewingId(next);
}, [entries, reviewingId, savedIds, dismissedIds]);
```

This runs after every capture resolves and after every Review closes.
`reviewingId != null` is the guard against opening a second review on top
of one already open. Once nothing is left to review, `next` comes back
`null` and the effect does nothing — the instructor is looking at a live
camera with nothing covering it, ready for the next capture.

Retake needed its own new state, `dismissedIds`, that didn't exist before.
Without it, closing Review after Retake would immediately re-satisfy
`nextToReview`'s condition — same entry, still `done`, still unhandled —
and the effect would reopen the exact capture the instructor just chose to
walk away from, forever. Marking it dismissed instead removes it from the
auto-loop while leaving its "Review" button in the debug list below, so a
retaken capture isn't actually lost — just no longer offered automatically.

### The running count had to stop being a plain counter

Before this step, `Scan.tsx` tracked a `scannedCount` that incremented once
per capture, held only in React state. That number could never have
survived what step 8.3 requires — reload mid-session and confirm nothing
is lost — because a page refresh wipes component state back to its initial
value regardless of what IndexedDB still holds underneath.

The fix is to stop treating the count as something the component owns and
instead treat it as something derived from the database — the same
principle behind CLAUDE.md's "derive, don't store, the sum check" rule
elsewhere in this project — a count that can drift from the truth is worse
than no count:

```typescript
const [savedCount, setSavedCount] = useState(0);
useEffect(() => {
  getAllRecords().then((records) => setSavedCount(records.length));
}, []);
```

Seeded once from `getAllRecords().length` on mount, then incremented by
exactly one at the moment `onSaved` actually fires — never at capture time,
which is what made the old counter wrong for this purpose in the first
place (a capture that fails, or gets retaken, was never really "scanned"
in the sense the instructor cares about mid-class).

### What isn't proven yet

All of this is exercised by four new Vitest cases for `nextToReview` plus
the existing suite (49/49), a clean `tsc`, and a clean production build —
but per CLAUDE.md's own testing conventions, that only verifies the logic,
not the feel. Step 8's actual Done-when bar — ten scripts end to end
without touching the keyboard except to correct a misread, then a hard
refresh at record six with the first five surviving — is explicitly a
real-device test, and hasn't been run.

> **Updated 2026-08-31.** Real-device sessions have now happened — one on
> the laptop over the LAN, one against the deployed URL on real scripts —
> and they are the source of most of what the last few sections of this file
> describe. Step 8's own bar is still **not** formally met: nobody has run
> ten scripts end to end and hard-refreshed at record six.
>
> One clause of that bar looks unrealistic as written, and it is worth
> noticing why. *"Without touching the keyboard except to correct a
> misread"* assumed misreads would be occasional. Measured over a real
> session, `student_id` was flagged on **five of six** successful scans —
> which matches the 55.2% whole-ID exact-match figure, and means the
> instructor is typing on most scripts. The loop mechanics work; the
> recognition accuracy is what makes the bar hard, and that is a step 3r.6b
> fine-tuning problem rather than a step 8 one.
>
> The sessions also produced timings worth having: **110–265 ms end to end**,
> of which detection is 78–211 ms and recognition 30–45 ms. Whatever is slow
> about this app, it is not the scan.

---

## Step 9 — Results table and Excel export

Every step before this one has been building toward one moment: the
instructor has a folder of confirmed records sitting in IndexedDB, and
needs them as a spreadsheet they can actually hand to someone. This step
is that last hop — a table to review everything at once, and the export
that's the actual point of the whole project.

### Sorting and "unverified" live in their own file, on purpose

[results.ts](frontend/src/results.ts) holds the two pieces of logic this
screen needs that don't touch a DOM: how records are ordered, and which
ones need a second look. That split matters for the same reason
`validateMarks.ts` was built the same way back in step 7 — a plain
function can be tested directly, exhaustively, and fast, while anything
wrapped in a component needs a browser-like environment for even a simple
assertion.

Sorting reuses a function that already existed for a different reason.
`normalizeSerial` was built in step 7 so the identity cross-check could
treat `"2"` and `"02"` as the same student — here it does double duty,
making sure the results table sorts serials as the numbers they are
rather than as strings (where `"10"` would otherwise come before `"2"`):

```typescript
function serialSortKey(serial: string | null): number {
  const normalized = normalizeSerial(serial);
  if (normalized === null) return Infinity;
  const n = Number(normalized);
  return Number.isNaN(n) ? Infinity : n;
}
```

`Infinity` for a missing or unparseable serial is what pushes that row to
the very end of the table — which turns out to be exactly where plan.md
§11's own mockup already puts its one no-serial example row. That wasn't
a coincidence to engineer around; sorting missing data to the end is just
the obvious choice once you're comparing numbers instead of strings, and
it happened to match what the plan had already sketched.

"Unverified" is even simpler once you notice it's not really new logic at
all — step 7's `crossCheck` already computes almost this exact thing at
save time (`unverified: !candidateSerial || !candidateId`), just as a
byproduct of a bigger duplicate-detection check. The results table doesn't
need any of that machinery; a single record, on its own, either has both
identity fields or it doesn't:

```typescript
export function unverifiedReason(record: StudentRecord): string | null {
  if (!record.serial && !record.studentId) return null;
  if (!record.serial) return 'no serial';
  if (!record.studentId) return 'no ID';
  return null;
}
```

Naming *which* field is missing, not just flagging the row, is what lets
the table show "⚠ no serial" the same way plan.md's mockup does, instead
of a generic warning that makes the instructor go looking for what's
actually wrong.

### Inline editing reuses the Review screen's own validation, not a copy of it

`Results.tsx`'s per-row editing calls the exact same `isLegalValue` and
`sumCheck` functions the Review screen already uses. This isn't just
convenient — it's the only way to guarantee a mark typo made *after* the
fact, while scrolling through the results table, gets caught by the same
rule as a typo made during the original review. Two separate
implementations of "is this a legal mark" would eventually drift, and the
first place that would show up is exactly the trust boundary this project
cares about most.

One rule needed enforcing here that didn't exist as a live constraint
before: an edit that would clear *both* the student ID and the serial has
to be rejected, not just flagged. CLAUDE.md's own invariant — "at least
one of studentId/serial must be non-null to save a record" — was already
true at the moment of the *first* save (Review.tsx's `crossCheck` blocks
it), but nothing stopped a later inline edit in the results table from
un-doing that by clearing the one field that made the record valid. The
fix is a plain guard before anything gets written back:

```typescript
if (!trimmedId && !trimmedSerial) {
  setError('Needs a student ID or a serial — edit not saved.');
  return;
}
```

### The export: verified two ways, since a browser test can't fully close this out

The actual `handleExport` function is almost exactly stack-reference.md's
own example — `ws.columns` built from `QuizConfig` so the question
columns always match the current quiz, `writeBuffer()` into a `Blob`, an
object URL, an anchor click. The one deliberate choice worth calling out
is using `null` (never `undefined`, never `0`) for every blank field:

```typescript
r.questions.find((q) => q.q === qc.q)?.value ?? null,
```

Step 9's own Test section names a blank exporting as `0` as *the* worst
possible failure here — it looks exactly like a real mark of zero, and
nothing downstream would ever catch it. `null` is what ExcelJS treats as
a genuinely empty cell.

A component test can click "Download Excel" and confirm a download was
triggered, but it can't confirm the *file itself* is correct — jsdom
doesn't parse `.xlsx` files, and step 9's Test section specifically asks
to open the export in real spreadsheet software. So the exact same
row-building logic was run a second time, standalone, through real
ExcelJS in Node (not the browser, not mocked), against three rows
including a deliberately blank serial, a blank mark, and a blank total.
Reading the file back programmatically confirmed what actually matters:
half marks like `2.5` come back as JavaScript numbers, not strings, and
every blank field comes back genuinely empty rather than `0`.

Real Microsoft Excel isn't available in this environment, so the second
half of "open it in both Excel and LibreOffice" was done with LibreOffice
alone, converting the same file to both PNG and PDF. The PNG on its own
was briefly confusing — the columns looked misaligned, as if a value had
gone missing — until the PDF export revealed why: the sheet had quietly
split across two print pages, and the entire `Total` column had landed on
page two. Once that page was checked directly, the totals were exactly
right, blanks included. Worth remembering for next time: a single-page
raster export of a wide sheet can *look* like a data bug when it's really
just a print-layout artifact — check the second page before concluding
anything is actually wrong.

### A cost noticed and fixed on the way past

Bundling ExcelJS made the production build's single JS bundle jump from
about 210KB to over a megabyte — almost all of it ExcelJS itself, which
only step 9's own Results screen ever needs. Since this is a
camera-heavy PWA where the Setup → Scan → Review loop is what actually
runs thirty times a class, making that loop's own bundle pay for a
library it never touches is exactly the kind of avoidable cost this
project has tried to stay alert to elsewhere. The fix is a single
`React.lazy`:

```typescript
const Results = lazy(() => import('./Results'));
```

The production build confirms it worked: the main bundle is back to its
original size, and `Results` (ExcelJS and all) is now its own separate
chunk that only loads the moment the instructor actually taps "View
results." The PWA's service worker still precaches both chunks up front
for offline use — that part doesn't shrink — but the *initial* page the
instructor spends the most time on no longer has to parse and execute
code it doesn't need yet.

### What isn't proven yet

65 frontend tests pass (`results.ts`'s own 8, `Results.tsx`'s 6, plus the
existing suite), `tsc` is clean, and the production build is clean. What's
still missing is the one thing no test suite can substitute for: a real
class session's worth of records, exported for real, and reconciled by
hand against an actual attendance sheet — the actual scenario step 9's
Done-when bar describes, and the same kind of real-world check steps 6,
8, and 10 already draw a hard line around.

### A way to actually start over (2026-08-30)

Nothing in the app could clear a finished session — once every record was
exported, the same records and quiz config would still be there next time
the app opened. A new `resetAll()` in [db.ts](frontend/src/db.ts) clears
both IndexedDB stores in one call:

```typescript
export async function resetAll(): Promise<void> {
  const db = await getDB();
  await db.clear('records');
  await db.clear('config');
}
```

The Results screen's new "Reset everything" button doesn't call this
directly on click — it opens the same kind of inline warning banner the
Review screen already uses for a serial/ID conflict, asking to confirm
before doing anything irreversible. Only the "Yes, delete everything"
button inside that banner actually wipes the database and hands control
back to `App.tsx`, which — since there's no config anymore — lands the
instructor straight back on Setup for a genuinely clean new session.

---

## Frontend design revamp

Not a numbered step — a cross-cutting pass over every screen built so
far (Setup, Scan, Review, Results), because all four had been using
whatever styling got them working, not what they'd look like shipped.
The starting point made that obvious rather than debatable:
`index.css` was still the untouched Vite scaffold — a bright purple
`--accent: #aa3bff`, a centred marketing-page layout with
`text-align: center` on the whole app, `#social` selectors from a
template landing page that was never even used. `issues.md`'s own design
finding had already named this exact file as worth fixing "before any
real UI polish pass begins" — this was that pass.

### Anchoring to something specific, not "clean and modern"

The `product-ui-design` skill's first rule is to anchor to a real,
named reference rather than inventing values from memory — "roughly
modern and clean" is how every AI output ends up looking the same. This
app's actual constraint pointed at one profile clearly: it's held in one
hand, at arm's length, over a stack of scripts, thirty times a class —
that's a large-hit-area, generous-spacing problem, which is exactly what
the skill's **Apple-airy** profile is for. The one deliberate divergence
from Apple's own system blue is the brand accent — a petrol teal
(`#1f6f64` light, `#47a897` dark), chosen specifically to land nowhere
near the indigo/periwinkle family (`#6366f1` and friends) the skill's own
tell-list names as the single most common AI-generated-UI signature.

### Every color is a token, on purpose

`index.css` now defines semantic variables only —
`--background`/`--foreground`/`--muted`/`--border`/`--primary`, plus
`--success`/`--danger`/`--warning` for status — and grep confirms zero
raw hex codes anywhere in a component file. This matters beyond tidiness:
it's what makes dark mode (already wired via `prefers-color-scheme`, same
mechanism the old scaffold had) a matter of redefining ten variables once
instead of hunting through every component for a color that needs a dark
counterpart.

### The tell-scan caught two real things, not zero

Running `scan-tells.py` against the first draft failed, for real:

```
TELL  index.css:77  pure-black box-shadow — tint toward the background hue
TELL  index.css:533  pure black for text/bg — use near-black
```

The dark-mode shadow tokens had been written as plain `rgba(0, 0, 0, …)`,
and the camera view's letterbox background was a literal `#000`. Both
fixed (a warm-tinted near-black for the shadows, `#0a0a08` for the
camera background) and the scan came back clean. Worth noting precisely
because this is what the skill's self-check is *for* — a mechanical
scan that fires at output time, not from the prompt, catching exactly
the kind of thing that's easy to type without noticing.

### Verified in a real browser, not just read

The project's own rule — start the dev server and use the feature before
calling a UI change done — doesn't get a pass just because this is a
camera app that needs real hardware. What doesn't need a camera got a
real headless-Chromium pass anyway (Playwright, driven directly since no
project-specific run skill existed yet): the fresh and saved-config
Setup states, the live Scan screen (Chromium's fake-camera device feed,
which does exercise the real `getUserMedia` path and confirmed the new
shutter-style capture button actually renders over a live stream), and
Results with seeded IndexedDB data. Review needed one extra step — no
backend was running to produce a real `ScanResult` — so it was mounted
through a throwaway Vite entry point that rendered the real component
with real props, screenshotted, then deleted; nothing about that harness
shipped. That pass caught a real layout bug before it ever reached a
screenshot: `.btn-block`'s `width: 100%` doesn't expand a flex item
without `flex: 1` alongside it, which would have left "Confirm & next"
sized to its own text rather than filling the row next to "Retake".

### Existing tests were the actual constraint, not an afterthought

Every button label, banner message, and `getByLabelText('Student ID')`
query the existing test suite depends on had to survive a full markup
rewrite unchanged — restyling is not a license to reword. `grep`-ing
every test file's `getBy*`/`findBy*` calls first turned that from "be
careful" into a concrete checklist: exact strings for `Retake`, `Enter
manually`, `Download Excel`, the `/Confirm & next/`, `/Sum check: … ✓/`,
`/Must be a multiple of 0.5/` patterns, the label association for
`Student ID`. All 65 frontend tests passed after the rewrite without a
single assertion needing to change — the proof that only the *visual*
layer moved.

### A first-run guide, not just a restyle

The other half of this pass was the part with no existing screen to
restyle: `Setup.tsx` now has a "How this works" section — four numbered
steps (set up the quiz, photograph each script, confirm what it read,
export when done) plus a one-line note on what stays local and what gets
flagged rather than guessed. It's a native `<details>`/`<summary>`
disclosure, open by default the first time (no saved config yet) and
collapsed — but still there — once a config exists, so a returning
instructor isn't re-shown the same explanation every session but a
first-time user always lands on it open. No JavaScript needed for the
open/close behaviour at all; the browser already does that natively.

### One thing added beyond the ask, because it was already visible

Bundling ExcelJS (step 9) had already pushed the single production
bundle over a megabyte — not part of today's design brief, but exactly
the kind of cost this pass was already looking at every screen for.
`React.lazy(() => import('./Results'))` split it back down to ~210KB for
the screen that actually runs thirty times a class, with Results (and
ExcelJS) loading only when "View results" is actually tapped.

---

## Step 2r.0 — Extract the recognizer interface

Steps 2 and 3 built two genuinely different ways of reading a handwritten
field — Tesseract for the ID, Gemini for the serial and marks — and
`main.py` called both of them directly, by name, right in the middle of
the request handler. That was the right way to build it: get one working
path proven end to end before worrying about a second one. But it also
meant there was nowhere for a future CNN path to plug in without editing
`main.py` itself and re-deciding, inline, which recognizer should run.
Step 2r.0's whole job is to give it that seam, while changing nothing
about what actually happens on a request today.

### The interface describes the seam, not a rewrite

[app/recognizers/base.py](backend/app/recognizers/base.py) defines what
any recognizer has to be able to do — read an ID, read a serial and some
marks — without saying anything about *how*:

```python
class Recognizer(Protocol):
    name: str

    def read_id(self, cells_dir: Path, id_digits: int) -> IdResult: ...
    def read_marks(self, cells_dir: Path, question_maxes: list[float]) -> MarksResult: ...
```

plan.md §16's own sketch of this interface shows `read_id` taking a list
of already-loaded crop images instead of a directory path. Real code
disagreed. `id_ocr.read_id` and `marks.recognize` are both file-based —
they open `id_d1.png`, `serial.png`, `marks_r1_c0.png` and so on straight
off disk, because that's what `detect_any_orientation` (step 1) actually
hands them, and both were tuned against real photos in that shape. Forcing
the interface to take pre-loaded arrays instead would have meant rewriting
that tuned code to accept images it never expected — exactly the kind of
change 2r.0 is supposed to avoid, since its whole point is "give the CNN a
seam" with *zero behavior change* to what's already working. So the
protocol takes `cells_dir: Path`, matching what the real pipeline actually
has at that point, and the deviation is written directly into
`base.py`'s own docstring so it's not a silent mismatch with the plan.

### Wrapping, not replacing

[app/recognizers/remote.py](backend/app/recognizers/remote.py)'s
`RemoteRecognizer` is the adapter — and it's worth noticing what's *not*
in it. There's no OCR logic, no Gemini call, no prompt building. It just
calls the three existing modules and reshapes their answers:

```python
class RemoteRecognizer:
    name = "remote"

    def read_id(self, cells_dir: Path, id_digits: int) -> IdResult:
        student_id, low_confidence_fields = id_ocr.read_id(cells_dir, id_digits)
        return IdResult(student_id=student_id, low_confidence_fields=low_confidence_fields)

    def read_marks(self, cells_dir: Path, question_maxes: list[float]) -> MarksResult:
        result = marks.recognize(cells_dir, question_maxes)
        if result.status != "ok":
            fallback = marks_ocr.recognize_locally(cells_dir, question_maxes)
            if fallback is not None:
                return fallback
        return result
```

That `if result.status != "ok": try the fallback` block used to live
directly inside `main.py`, straddling two concerns at once: "run the
pipeline" and "decide what remote recognition should do when it fails."
Moving it here means `main.py` doesn't need to know the remote path has a
rate-limit fallback at all — that's now entirely `RemoteRecognizer`'s own
business, which is exactly where step 3's design already said it belonged
("never a replacement for the Gemini path... only after `recognize()`
itself fails").

One small but deliberate choice: `remote.py` calls `id_ocr.read_id(...)`
and `marks.recognize(...)` — going through the module, not importing the
function by name (`from ..id_ocr import read_id`). That's not just style.
It's what keeps the existing tests' mock targets meaningful: patching
`app.id_ocr.read_id` replaces the function everywhere it's looked up
*through the module*, including from inside `remote.py`. Importing the
name directly would have copied a reference into `remote.py`'s own
namespace at import time, and patching `app.id_ocr.read_id` afterward
would have silently missed it.

### `main.py` stops knowing any recognizer's name

Before this step, `main.py` imported `read_id`, `recognize`, and
`recognize_locally` directly and called all three, in the right order,
with its own error handling threaded between them. After:

```python
id_result = recognizer.read_id(cells_dir, quiz.idDigits)
marks_result = recognizer.read_marks(cells_dir, question_maxes)

if marks_result.status != "ok":
    return ScanResult(status="failed", failure_reason=marks_result.failure_reason)
```

`recognizer` is resolved once, at import time, from an environment
variable:

```python
def _resolve_recognizer() -> Recognizer:
    name = os.getenv("RECOGNIZER", "remote")
    if name == "remote":
        return RemoteRecognizer()
    if name in ("cnn", "both"):
        raise NotImplementedError(...)
    raise ValueError(...)

recognizer: Recognizer = _resolve_recognizer()
```

The `"cnn"`/`"both"` branch raising instead of quietly returning
`RemoteRecognizer()` anyway is worth pausing on, because the quiet version
would look almost as correct: the app would still start, still work, still
scan scripts. It just wouldn't be running what was asked for, and nothing
would say so — someone would set `RECOGNIZER=cnn` expecting the CNN path,
get the remote one instead, and have no reason to suspect it until the
accuracy numbers looked wrong. Failing loudly at startup turns "quietly
running the wrong thing" into "doesn't start, with a message naming
exactly what's missing and why" — a much shorter path to noticing.

### Proving "zero behavior change" for real, not just by mocked tests

The easy way to check this refactor didn't break anything is running the
test suite and seeing 34 pass. That was done — but a fully mocked suite
can't rule out one specific failure mode: what if the *real* Gemini/
Tesseract call path is subtly different now, and every test happens to
mock right past the difference? So this step also ran a real request
through the actual endpoint, zero mocks, hitting real Gemini and real
Tesseract, the same way step 3 and step 4 each did the first time they
were built:

```
serial: "07", questions: [3.0, 2.5, 1.0, 0.0, 4.5], total: 11.0
```

Identical to step 3's and step 4's own first live runs against the same
photo, `low_confidence_fields: ["student_id"]` included — the same
already-known ID OCR imperfection, not a new one. That match is the real
evidence for "moved, not rewritten," not the passing test count on its
own.

---

## Step 2r — Training the digit CNN

Step 2r.0 gave the CNN a seam to plug into. Step 2r actually builds the
thing that plugs in: a small classifier trained on EMNIST, tuned to
generalize to real photographed handwriting rather than just EMNIST's own
test set. The result, measured against the same real photos and ground
truth `id_ocr_accuracy.py` already uses: **96.4% per-digit accuracy** (0/56
confidently wrong) against Tesseract's measured 58.9%, and a 7-of-8
whole-ID exact match against Tesseract's 0-of-8. Both halves of step 2r's
Done-when bar — materially beats the baseline, confidently-wrong stays at
zero — are met.

### The architecture is exactly what plan.md specifies, nothing added

[cnn/model.py](backend/cnn/model.py)'s `DigitCNN` is plan.md §16's diagram
translated directly into `nn.Module` calls — two conv blocks doubling
32→64 channels, each followed by a pool and dropout, then a small FC head:

```python
self.features = nn.Sequential(
    nn.Conv2d(1, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
    nn.Conv2d(32, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
    nn.MaxPool2d(2), nn.Dropout(0.25),
    nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
    nn.Conv2d(64, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
    nn.MaxPool2d(2), nn.Dropout(0.25),
)
```

No temptation to make it bigger "just in case" — plan.md is explicit that
this is MNIST-class difficulty and a larger model buys nothing but
latency, and the whole point of a local model is that it should cost
nothing to run.

### Preprocessing was checked by eye before any training happened

This is the part step 2r.2 warns about most directly: a model can score
99% on EMNIST's own test images and still perform badly on real photos, if
the path from "photographed digit" to "28×28 tensor" doesn't match how
EMNIST/MNIST were actually built. [cnn/preprocess.py](backend/cnn/preprocess.py)
follows that construction exactly — inset 12% (id_ocr.py's own fix for the
cell border reading as ink), Otsu-threshold and invert to white-ink-on-
black, crop tight to where the ink actually is, scale the longer side to
20px, then paste onto a 28×28 canvas centred by **centre of mass**:

```python
com_y, com_x = ndimage.center_of_mass(resized)
top = int(round(CANVAS_SIZE / 2.0 - com_y))
left = int(round(CANVAS_SIZE / 2.0 - com_x))
```

Centre of mass instead of the bounding box's geometric centre is the
detail plan.md calls out as the single most common way this goes subtly
wrong — it *looks* like the obvious way to centre a glyph, and costs
several points of accuracy specifically because the model's whole training
distribution assumes the other one.

Rather than trust that this was implemented correctly, step 2r.2's own
instruction is to look at the outputs directly — "no training run fixes a
preprocessing bug." Running [cnn/inspect_preprocess.py](backend/cnn/inspect_preprocess.py)
over real `id_d*.png` crops (from `filled_file.jpeg`, ground truth
`2632711`, and a phone photo of the same script) and viewing the results
confirmed it: a correctly-shaped "2", a "6", a "1", and a crossed "7" —
the local convention plan.md's own "Collecting real handwriting samples"
section specifically calls out as differing from EMNIST's American
1990s norm — all cropped, scaled, and centred cleanly, visually not
distinguishable from a real EMNIST sample. If these had come out
smeared, off-centre, or clipped, the right move would have been fixing
this function, not starting a training run and hoping the model
compensates.

### The EMNIST transpose bug, confirmed rather than assumed

step.md step 2r.1 names a specific, well-known trap: EMNIST's raw files
are transposed relative to MNIST's, and torchvision doesn't correct for
it. Rather than adding the fix on the strength of that warning alone, this
was checked directly against this environment's own download — rendering
a raw sample without any correction produced a digit that was rotated and
mirrored, unmistakably wrong; a single transpose fixed it to a normal
upright "8". [cnn/train.py](backend/cnn/train.py)'s `OrientationFixedEMNIST`
wraps the dataset once so every consumer gets the corrected version
automatically:

```python
def __getitem__(self, idx: int):
    img, label = self.base[idx]
    img = img.transpose(Image.TRANSPOSE)
    if self.transform is not None:
        img = self.transform(img)
    return img, label
```

### Augmentation and export

Rotation (±10°), translation (±2px), and scale (0.9–1.1) come straight
from plan.md §16 via `torchvision.transforms.RandomAffine`. The elastic
distortion is also specified there ("slight"), but torchvision's own
default strength (`alpha=50`) is tuned for much larger images — at 28×28
that default visibly mangles digits into unrecognizable shapes. Checking
augmented samples by eye (the same "look at it, don't just trust the
default" instinct as the preprocessing check above) led to a much lighter
`alpha=8.0, sigma=4.0`, closer to the classic Simard-et-al. MNIST elastic
augmentation than to torchvision's own preset.

Export follows step 2r.3's own instruction not to stop at "exports without
error": after `torch.onnx.export`, the script re-loads the ONNX model
through `onnxruntime`, runs the same fixed random batch through both the
PyTorch model and the ONNX session, and asserts the two outputs agree to
within `1e-4`:

```python
max_diff = float(np.abs(torch_out - onnx_out).max())
if max_diff > 1e-4:
    raise RuntimeError(f"ONNX export diverges from the PyTorch model ...")
```

That check earned its place twice over, though not in the way expected.
While the real 8-epoch training run was executing in the background (a
~75-minute job), the idle time was used to smoke-test the export path
against a throwaway, randomly-initialized model with the same
architecture — same idea as checking preprocessing by eye before trusting
it, applied to the export step instead. That surfaced two real problems
before the actual run ever reached its own export call:

1. This torch version's *default* ONNX exporter needs a package
   (`onnxscript`) that wasn't installed — a `ModuleNotFoundError` raised
   only when `torch.onnx.export` actually ran, not at any point earlier.
   Had this not been caught early, the real training run would have
   completed all 8 epochs successfully and then crashed on the very last
   line, with the trained weights sitting in a `.pt` checkpoint but no
   ONNX export at all.
2. Even after installing `onnxscript`, that same default exporter split
   this small model into two files — a tiny `digit_cnn.onnx` plus a
   `digit_cnn.onnx.data` holding the actual weights — rather than one
   self-contained file. Nothing about this model needs that (no dynamic
   control flow, nowhere near the size where ONNX's single-file limit
   matters), so the fix was to pass `dynamo=False` and use the older,
   simpler exporter instead, which embeds everything in one file and
   doesn't need `onnxscript` at all.

The real training run had already started before this fix landed, so its
own export step (using the code as it was when the process launched) hit
exactly bug 2 and produced the two-file version. Rather than re-run 75
minutes of training over a two-line export change, the fix was applied and
the already-trained weights (`digit_cnn_best.pt`) were reloaded and
re-exported through the corrected function directly — training and export
are independent once a checkpoint exists, so only the second part needed
redoing.

### The accuracy harness has to be comparable, not just "an accuracy number"

[cnn/accuracy.py](backend/cnn/accuracy.py) deliberately mirrors
`id_ocr_accuracy.py` line for line in how it counts: the same
`testset/labels.json` ground truth, the same cases, and critically the
same per-digit-accuracy *definition* — a flagged, unread position (`?`)
counts as a miss in the denominator exactly like Tesseract's own `?`
does, via the same string-equality check. Without matching that
definition exactly, "beats 58.9%" would be comparing two differently-
defined numbers that happen to look similar.

On top of that shared definition, the harness adds two things Tesseract's
accuracy script doesn't have, because step 2r's real bar is about them,
not raw accuracy:

- **Test-time augmentation** — plan.md §16's point that inference is so
  cheap (~1ms) that running each crop through a handful of small
  perturbations and averaging the probabilities is free, and helps exactly
  the borderline cases that matter most for a field with no arithmetic
  guard.
- **A separately reported confidently-wrong count** — every crop where the
  model returned an actual digit (not a low-confidence flag) that turned
  out to be wrong. step.md's own Done-when bar for this step is this
  number staying at zero, not the accuracy percentage going up; a model
  that reads fewer digits but is never confidently wrong is a strictly
  better outcome here than one with higher accuracy achieved by guessing.

The confidence and margin floors that decide "flag instead of guess" were
placeholders until the trained model actually existed — calibrated below
from its real output distribution, the same way `id_ocr.py`'s own
`CONFIDENCE_FLOOR` was calibrated from measured data rather than picked in
advance.

### Training, and one buffering surprise worth remembering

Training ran 8 epochs over the full 240,000-image EMNIST Digits training
set, on CPU (no GPU on this machine) — about 9-10 minutes per epoch,
75 minutes end to end, reaching 99.74% accuracy on EMNIST's own held-out
test split. One thing worth remembering for next time: Python's stdout is
*fully* buffered (not line-buffered) when redirected to a file rather than
a terminal, so `train.py`'s own per-epoch print statements didn't actually
appear in the log until the process exited — checking whether training
was progressing had to go by the checkpoint file's modification time
instead of tailing the log, which looked empty the entire time despite
real work happening underneath it.

### Calibration: a clean, stark split in the real data

Running `cnn/accuracy.py --calibrate` against the trained model, over all
56 real digit crops across the 8 labelled photos, showed something cleaner
than expected: 54 of 56 reads landed at confidence ≥0.99 (every one of
them correct), and exactly 2 sat in a separate cluster around 0.58
confidence / 0.4 margin — one of which was wrong (a phone photo's last
digit, a `1` read as a `4`). There was nothing in between; confidence
either landed almost exactly at 1.0 or down around 0.58, with a huge gap
between the two groups. That gap made picking `CONFIDENCE_FLOOR=0.9` and
`MARGIN_FLOOR=0.8` an easy, low-risk choice — well inside the gap rather
than balanced on its edge, so a slightly different photo landing at, say,
0.95 confidence wouldn't suddenly flip from "flagged" to "guessed" or vice
versa.

### The real numbers

Running the harness for real, with those calibrated floors, against every
labelled photo:

```
per-digit accuracy: 54/56 = 96.4%   (id_ocr_accuracy.py baseline: 33/56 = 58.9%)
confidently wrong: 0                (must stay 0 — the bar that matters most)
whole-ID exact match: 7/8 = 87.5%   (id_ocr_accuracy.py baseline: 0/8 = 0.0%)
```

The one miss (`phone_2632711_1.jpg`) isn't a wrong answer — it's the same
borderline digit the calibration step already found, correctly flagged
rather than guessed, exactly the trade the confidence floors exist to
make. Zero confidently-wrong across all 56 real digits is the number that
actually matters most here, per this project's own repeated "flag, never
guess" rule — a model that's occasionally uncertain costs the instructor
one glance at a flagged field; a model that's occasionally confidently
wrong costs a student their actual mark.

The same caveat every earlier accuracy number in this project has carried
still applies: n=8 images, all one person's handwriting. This is a real,
measured result — not an estimate — but it's evidence this recognizer
handles *this* handwriting well, not yet evidence it generalizes across
different students' handwriting the way it will need to for a real class.
That's exactly what step 3r.6's collection-sheet and comparison-run work
exists to test.

### Recalibrating the floors once real diversity arrives (2026-08-30)

The 0.9/0.8 floors above were picked from a clean gap in n=56 digit reads,
all one person's handwriting. Once the 18-photo real-class batch (Step 0
above) widened that to n=182 reads across roughly 20 different writers,
that clean gap disappeared: correct reads now spread all the way down to
0.40 confidence, since different people's handwriting naturally produces
less sharply-peaked predictions even when the model's top guess is right.
Reusing the same 0.9/0.8 floor against this wider sample meant flagging 20
digits as "uncertain" that the model had actually read correctly, for
every 1 digit it was right to block.

Rather than guess at a better number, every candidate floor got checked
directly against the raw prediction (ignoring the current floor entirely)
to see what each choice would actually let through:

```python
for floor in [0.90, 0.85, 0.80, 0.75, 0.70, ...]:
    passed = [r for r in rows if r.confidence >= floor]
    wrong_through = sum(1 for r in passed if not r.correct)
    needlessly_flagged = sum(1 for r in rows if r.confidence < floor and r.correct)
```

0.75 confidence / 0.6 margin turned out to be the sweet spot: it lets
through exactly the same single wrong digit the old floor did (a
genuinely ambiguous cursive "9" that no reasonable floor catches without
also blocking a pile of correct reads above it), while recovering 11 of
those 20 needlessly-flagged correct digits. Since `app/recognizers/local.py`
imports these same two constants for the live ID path, this change reaches
the actual running app, not just the test harness.

```
per-digit accuracy:     85.7% -> 91.8%
whole-ID exact match:   34.5% -> 55.2%
confidently wrong:      1 -> 1     (same case, unchanged — the safety bar held)
```

The lesson worth carrying forward: a threshold calibrated on a thin,
single-writer sample can look perfectly clean and still be badly wrong
once real diversity shows up — not because the model got worse, but
because the *floor* was drawn assuming a gap that only existed by
accident of a small sample size.

---

## Step 3r — Segmentation and constrained decoding

Step 2r's CNN could only read the ID — one printed box per digit, so
there was never any question of *how many* glyphs were in a crop or where
each one started. Serial and mark cells don't have that luxury: a student
writes `"07"` or `"4.5"` freely inside one box, so before the same digit
classifier can run at all, something has to work out how many glyphs are
actually in there and where each one begins and ends. That's
segmentation, and it's the piece that turns step 2r's single-digit reader
into something that can read the fields that actually carry a grade.

### Segmentation: components, a merge rule, and geometry-only decimal detection

[cnn/segment.py](backend/cnn/segment.py)'s `segment_cell` follows plan.md
§16's recipe: Otsu-threshold the cell, find connected ink components, drop
anything too small to be a real stroke, then sort left to right. The one
step worth pausing on is the merge rule:

```python
overlap = min(px1, x1) - max(px0, x0)
narrower_width = min(px1 - px0, x1 - x0)
if narrower_width > 0 and overlap / narrower_width > OVERLAP_MERGE_FRAC:
    merged[-1] = (min(px0, x0), min(py0, y0), max(px1, x1), max(py1, y1))
```

A `4` or `5` written with a pen stroke that didn't fully connect produces
two separate ink components that are really one glyph. Miss this and a
single handwritten `4` gets read as two components — neither of which is
a valid single digit — instead of one correct glyph. This is called out
in plan.md §16 as the single most common segmentation failure, and it's
the one piece of this step verified first, with a synthetic two-blob test
image, before anything else.

The decimal point gets no model at all — just geometry, because there's
no training data for a handwritten decimal point and no need for any: a
component shorter than the surrounding digits and sitting low enough in
the glyph band is a decimal point, everything else is a digit. Blank-cell
detection happens before any of this runs: no components at all means an
empty list back, never a guess (a classifier always outputs *something*,
so feeding it a blank cell would return a confident wrong digit).

### The decoder: scoring candidates, not parsing text

[cnn/decode.py](backend/cnn/decode.py)'s `decode_value` is what actually
makes local recognition beat Gemini rather than merely match it. Instead
of reading digits and validating the result afterward, it scores every
legal value for the question directly against the glyphs' probabilities
and returns whichever scores highest:

```python
for value in legal_values:
    digits, expects_decimal = _digits_of(value)
    if len(digits) != len(glyph_probs):
        continue
    if expects_decimal != (has_decimal_at is not None):
        continue
    score = 1.0
    for digit, probs in zip(digits, glyph_probs):
        score *= float(probs[digit])
    if score > best_score:
        best_value, best_score = value, score
```

A smudged `4.5` that a free-form parser might read as `45` simply can't
come back as `45` — for a 5-mark question, `45` was never a candidate to
begin with.

One real deviation from plan.md's own pseudocode is worth calling out,
because it's the kind of bug that only shows up by actually running the
code against a real value. The plan's illustrative decoder builds each
candidate's digit list with `f"{value}".replace(".", "")` — but Python
renders a whole number like `4.0` as the string `"4.0"`, not `"4"`. Run
through that expression, `4.0` becomes `["4", "0"]` — two digits — when a
real handwritten "4" is one glyph. Copied literally, a whole mark could
never match at all, only ever a "value.0"-shaped two-glyph reading that no
student ever actually writes. `marks.py` already had exactly the right
formatting function, `_fmt`, originally built so the Gemini prompt would
list legal values the way they're actually written (`"4"`, not `"4.0"`);
`decode.py` reuses it instead of the plan's own formatting, and both
recognizers now agree on what a legal value looks like written down.

Serial gets its own, simpler function, `decode_serial`, rather than
reusing `decode_value`. Plan.md §16 describes serial's legal set as
"every integer the class could plausibly use" — for an unconstrained,
independent-per-position digit string, scoring every candidate integer
jointly is mathematically identical to just taking each glyph's own best
digit, since there's no cross-digit constraint the way a 5-mark
question's ~11 legal values provide. So `decode_serial` decodes each
glyph independently through the same confidence/margin mechanism, and
flags the *entire* serial if even one glyph is uncertain — matching how
this project's data model already represents an unreadable field (fully
blank and flagged, never a string with a stray `?` character in the
middle of it).

### Reusing step 2r's inference code without touching its own numbers

Both the ID and the newly-segmented glyphs need the same thing: a
28x28 canvas run through the model with test-time augmentation, averaged
into one probability vector. That logic used to live entirely inside
`cnn/accuracy.py`. It moved to [cnn/id_infer.py](backend/cnn/id_infer.py)
so `app/recognizers/local.py` could reuse it too, and `accuracy.py` now
just calls back into it:

```python
def predict_digit(session, canvas):
    return _predict_digit(session, canvas, CONFIDENCE_FLOOR, MARGIN_FLOOR)
```

Moving already-correct, already-calibrated code and trusting that the
move alone didn't change anything is exactly the kind of claim this
project doesn't take on faith — step 2r.0 re-ran the entire test suite
after its own move for the same reason. Same here: `cnn/accuracy.py` was
re-run immediately after the refactor and produced the identical
96.4%/0/87.5% it had before, byte for byte.

### Wiring it in without touching the default path's dependencies

`app/recognizers/local.py`'s `CNNRecognizer` implements the same
`Recognizer` protocol `RemoteRecognizer` does, and `main.py` resolves
`RECOGNIZER=cnn` to it — but only inside the branch that actually needs
it:

```python
if name == "cnn":
    from .recognizers.local import CNNRecognizer
    return CNNRecognizer()
```

The import is lazy, inside the branch, not at the top of the file — the
default `RECOGNIZER=remote` path must never require onnxruntime just to
import `main.py` at all. This was checked for real, not just by reading
the code: torch, torchvision, onnx, onnxruntime, and scipy were all
*uninstalled* from the venv, and the full 48-test suite still ran clean.
Only then were they reinstalled to actually exercise the CNN path.

`"both"` (run both recognizers and log every disagreement) still raises
`NotImplementedError` — that comparison-logging feature is step 3r.6's
job, not this one's, and a silent fallback to running "cnn" alone under a
flag that's supposed to mean "both" would hide that gap instead of making
it obvious, the same reasoning step 2r.0.3 first established for this
function.

### Two real bugs, found by pointing the pipeline at an actual photo

Both of this step's real defects only showed up once actual segmented
glyphs from a real photo went through the pipeline — nothing about them
was visible from the synthetic unit tests, which is exactly why step 3r.5
(a real accuracy run) is part of the spec and not an afterthought.

**Bug one: double-cropping a glyph that was already tight.**
`preprocess_for_cnn` (step 2r.2) trims 12% off every edge before doing
anything else, because the ID's crops come straight from the template's
own boxed cell and that edge is the cell's ruled border. A segmented
glyph from `segment_cell` is not that — it's already a tight crop of just
the ink, with no border left to trim. Running it through the same 12%
inset a second time clipped real strokes off the edges of a real
handwritten "3", and the model read what was left as a confident, wrong
"2". The fix splits the function in two — `preprocess_for_cnn` (unchanged,
still does the border trim, still gets the ID's own 96.4% number
untouched) and a new `glyph_to_canvas` (no inset, for `segment_cell`'s
output) — sharing one `_to_canvas` core so the actual normalization logic
isn't duplicated.

**Bug two: a noise filter that couldn't tell a small decimal point from a
small speck of noise.** `NOISE_AREA_FRAC=0.01` (1% of the cell's area)
was meant to drop paper-texture specks and scanning artifacts. Measured
against a real "2.5" cell, it also dropped the real decimal point — 58
pixels, about 0.36% of that cell's area, comfortably under the 1% floor.
Lowering the floor to 0.0015 let it through. A second, related issue
showed up in the same measurement: the decimal point's centroid sat at
roughly 60% down the glyph band, and the original rule required the
*lower third* (66%+) — missed by half a pixel of centroid position. A
hand-drawn dot between two digits sits closer to mid-height than a
printed period does; relaxing the rule to "lower half" fixed it. Both
fixes together correctly recovered *both* real half-mark cells (`2.5` and
`4.5`) — at the cost of one whole-mark cell (`3`) that happened to have an
unrelated stray pen mark elsewhere in the box now correctly flagging
instead of accidentally reading right. Net, a real improvement: two more
fields read correctly, zero fields read confidently wrong, before or
after either change.

### The real numbers

The one labelled real photo with actual serial/marks/total ground truth
(`testset/labels.json`'s own documented gap — thinner even than the ID's
n=8 sample), via `cnn/marks_accuracy.py`:

```
per-question accuracy: 4/5 = 80.0%
  whole marks: 2/3 = 66.7%
  half marks:  2/2 = 100.0%
serial accuracy: 1/1 = 100.0%
total accuracy: 1/1 = 100.0%
confidently wrong: 0
```

Both half marks — exactly the discrimination step 3r.5 asks to report
separately, and exactly what the constrained decoder exists to make
reliable — came back correct. The one miss is a flag, not a wrong answer:
zero confidently-wrong across every field, on both the ID and the
marks/serial/total path, is still the number that matters most here. And
the caveat is the same one this project has carried since step 0: n=1 for
this particular measurement is real evidence, not a benchmark — it says
this pipeline handles *this* handwriting and *this* stray mark, not yet
that it generalizes. That's what step 3r.6 exists to actually test.

### That caveat proved itself almost immediately

A user actually running the app on a whiteboard, with `RECOGNIZER=cnn` as
the real default, hit exactly the "not yet generalizing" gap the section
above predicted. Three different marks came back flagged, each for a
genuinely different reason once traced down to the actual segmented
glyphs — and every one of them was a variant of the same root cause: a
whiteboard marker leaves stray marks and thick decimal points that don't
look like the one real photo (pen on paper) this step's heuristics were
calibrated against.

One of the three was cleanly fixable. `segment_cell` decided whether a
component was a decimal point by comparing its height to the *median*
height of everything else in the cell — but a stray, unintended mark
elsewhere in the same cell (not the decimal, not a digit) was short
enough to drag that median down, which made a genuine decimal point look
*too tall* to qualify by comparison. Switching the baseline to the
*tallest* surviving component instead fixes this by construction: the
tallest thing in a cell is always a real digit's own full height, no
matter how many stray marks are floating around it. Re-running
`cnn/marks_accuracy.py` afterward reproduced the exact same 4/5 result
above, byte for byte — a real improvement with zero measured cost.

The other two weren't so clean, and the more interesting one is worth
recording precisely because it was tried and reverted, not just
skipped. A decimal point sitting close enough to a digit to overlap it
horizontally was getting swallowed by the *disconnected-stroke* merge
rule — the same one that correctly reunites a `4` or `5` written with a
lifted pen into one glyph. The natural fix looked obvious: only merge two
overlapping components if they're roughly the same height, since a real
broken-digit-stroke split should produce two similar-sized pieces, while
a tiny decimal point next to a full-height digit obviously shouldn't
count. Implemented and tested against the real photo, it fixed the
decimal — and immediately broke something else: a genuinely disconnected
`5` on the very same whiteboard, whose lifted-pen top flourish was much
taller than its own lower body, got rejected by the exact same
height-ratio check for the exact same reason. Both real cases — "a
decimal beside a digit" and "one digit split into two very
different-sized pieces" — produce components with a similarly lopsided
height ratio and a similar x-overlap. There is no geometry-only signal
tried so far that tells them apart. Rather than trade one real failure
for a different one, the fix was reverted, and the gap was written down
as genuinely open instead of quietly declared fixed.

This is exactly what "n=1" was a warning about, not a hypothetical: with
one real photo to calibrate against, a threshold can look solid and still
be one whiteboard marker away from a case it was never actually tested
on. The fix that held up (tallest-component baseline) is the kind of
change that's robust *because* it doesn't depend on how many stray
components exist — the fix that didn't (the height-ratio merge guard) is
the kind that quietly assumes real-world messiness comes in only one
shape. Both are worth remembering the same way: the first as a pattern to
reach for again, the second as a reminder that a fix which only works on
the one photo that motivated it isn't a fix yet.

### The right signal was position, not size

The reverted height-ratio guard came back once the same whiteboard script
got rescanned and the same two questions kept failing "every time" —
which is exactly what you'd expect from a *deterministic* pipeline reading
a *physically unchanged* whiteboard, not a new bug. The height-ratio idea
had failed because a decimal-beside-a-digit and a genuinely broken
stroke's two pieces can be just as different in height as each other.
But height was never the only geometric fact available — where the
pieces sit matters too. Two fragments of one pen stroke are drawn in
place, so they land roughly stacked, similar x-centre; a decimal point
sits to the side of its digit, offset toward one edge. Measured directly:

```python
prev_center, this_center = (px0 + px1) / 2, (x0 + x1) / 2
wider_width = max(px1 - px0, x1 - x0)
center_offset_frac = abs(prev_center - this_center) / wider_width
```

The real decimal-beside-"2" case measured `0.44`; the real disconnected-
"5" case measured `0.28`. That gap is what the previous attempt never
had with height alone — and unlike that attempt, this one was checked
against *both* real cases before being called a fix, not just the one
that was failing that day. Re-running `cnn/marks_accuracy.py` afterward
confirmed the existing baseline (4/5, both half marks, 0 confidently
wrong) stayed exactly the same while the real Q3 cell that had been
flagged now decodes correctly at 0.999 confidence.

The other failing question on that same photo, Q1, is left alone on
purpose. Its cause isn't a merge problem at all — a genuine stray pen
mark elsewhere in the cell survives the noise floor as its own glyph,
inflating the digit count past anything a legal value could match. That
one has a clean proof of why it *can't* be fixed by adjusting a size
threshold: the stray mark measures 62 pixels, and the real decimal point
calibrated earlier in this same step measured 58 — any single floor that
drops the 62px mark also drops the 58px dot. Two real, physically present
marks on one script, this close together in size, is the clearest
argument yet for why this track needs real handwriting samples at volume
(step 3r.6) rather than more single-photo threshold archaeology.

---

## Step 3r.6 — Collection sheet and comparison run (in progress — infrastructure built, the real run isn't)

This step has a different shape from every one before it. Steps 0–3r
could all be built and verified end to end with code and real photos
already in the repo. This one's actual Done-when bar — the CNN winning a
real comparison run, `RECOGNIZER=cnn` becoming the default — needs real
handwriting from real people and a real quiz session, neither of which
can be simulated or faked into existence. What follows is split into two
honest halves: the infrastructure that's genuinely buildable and testable
without that (built, this session), and the parts that categorically
require the user's own participation (not started, and can't be).

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

### `RECOGNIZER=both`, actually built

[app/recognizers/both.py](backend/app/recognizers/both.py)'s
`BothRecognizer` implements the same `Recognizer` protocol the other two
do, so `main.py` doesn't need to know it exists as anything special — it
just calls both underlying recognizers and compares:

```python
def read_marks(self, cells_dir, question_maxes):
    cnn_result = self._cnn.read_marks(cells_dir, question_maxes)
    remote_result = self._remote.read_marks(cells_dir, question_maxes)
    if remote_result.status == "ok":
        if cnn_result.serial != remote_result.serial:
            _log_disagreement("serial", cnn_result.serial, remote_result.serial)
        # ... same for each question and the total
    return cnn_result
```

One design choice worth explaining: `cnn`/`remote` are constructor
parameters, not instances built directly inside `__init__`. The reason is
testing — `RemoteRecognizer` calls the real Gemini API and `CNNRecognizer`
needs a real trained model on disk, and neither belongs anywhere near the
offline test suite. Accepting them as parameters means the actual new
logic this step adds — *what counts as a disagreement, and does it get
logged correctly* — can be tested against two fake, in-memory
recognizers instead:

```python
cnn = FakeRecognizer(IdResult(student_id="1234567"), ...)
remote = FakeRecognizer(IdResult(student_id="1234561"), ...)
BothRecognizer(cnn=cnn, remote=remote).read_id(Path("."), 7)
# -> logs exactly one disagreement: field "student_id", cnn "1234567", remote "1234561"
```

The trap this almost fell into: `both.py`'s first draft imported
`CNNRecognizer` and `RemoteRecognizer` at the top of the file, the normal
way. That would have meant merely *importing* `both.py` — which is all
the test file above needs to do — required onnxruntime to be installed,
even though the test never actually constructs a real `CNNRecognizer`.
The fix is the same lazy-import pattern `main.py`'s own `_resolve_recognizer`
already uses: import `CNNRecognizer`/`RemoteRecognizer` inside `__init__`,
only in the branch that actually needs to construct a real one. Caught
by literally uninstalling torch and onnxruntime and re-running the full
suite — the same verification discipline steps 2r.0 and 3r already
established, applied here before the mistake could ship rather than
after.

With that fixed, the whole thing was verified live, no mocks, against the
real trained model and a real Gemini call: `RECOGNIZER=both` against
`filled_file.jpeg` returned the CNN's own result end to end (as designed),
and `comparison_log/comparisons.jsonl` picked up exactly two real
disagreements — `student_id` (the CNN got the exact right answer,
`2632711`; Tesseract's read was `?632?1?`) and `q1` (the CNN correctly
flagged it rather than guessing; Gemini got the real answer, `3.0`) — and
correctly logged nothing for the four fields both paths agreed on. That's
not a synthetic example; it's the actual, real disagreement this specific
photo produces, and it's exactly the kind of case step 3r.6's real
comparison run is meant to accumulate many more of.

### Harvesting: built now because retrofitting later loses the pilot's own labels

[app/harvest.py](backend/app/harvest.py) is the other infrastructure
piece, and plan.md §16 is explicit about *why* it has to exist before
anything consumes it: every digit the instructor confirms or corrects on
the review screen (step 7) is a labelled crop of exactly the handwriting
that matters — including student handwriting nobody could collect in
advance — and building this after the pilot means every one of those
labels from the period they matter most is already gone.

The label lives in the filename, not a separate annotation file:

```python
out_dir = harvest_dir / field / tag  # tag: "confirmed" or "corrected"
shutil.copyfile(crop_path, out_dir / f"{value}_{uuid.uuid4().hex}.png")
```

Same self-labelling instinct as the collection sheet below — a filename
can't drift out of sync with the image it names the way a separate JSON
manifest could. A field the original scan flagged (`None`, low-confidence)
that the instructor then fills in gets tagged `"corrected"`, not treated
as a special third case — the model failed to produce a usable answer
there, which is exactly as much a real failure as producing a wrong one.

The harder design question was *where the crops come from*. The backend
is stateless — the temp directory holding a scan's cell crops is deleted
before `/api/scan` even returns a response, long before the instructor
gets to Confirm. Rather than break statelessness to keep crops around
"just in case," the new `POST /api/harvest` endpoint just re-runs
detection on the same photo, which the frontend already has as a `Blob`.
Detection is fast and deterministic, so re-running it costs nothing
that matters and keeps every existing guarantee about the backend intact.

On the frontend, this fires from `Review.tsx`'s `commitSave`, deliberately
not awaited:

```typescript
fetch(imagePreviewUrl)
  .then((r) => r.blob())
  .then((blob) => harvestScan(blob, config, original, confirmed))
  .catch(() => {});
```

Two things matter about that shape. First, it never blocks: step 8's own
rule — nothing may add a tap or a delay to the confirm-to-next-capture
loop, because it runs thirty times a class — applies just as much to a
delay as to a tap, so this runs alongside the save, not before it.
Second, if harvesting fails for any reason (network hiccup, backend
briefly down), the instructor's actual saved record is entirely
unaffected; a `.catch(() => {})` on both the frontend call and inside
`harvestScan` itself means a harvesting failure can never look like or
cause a save failure.

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

### The collection sheet: built, and where it deliberately stops

[generate_collection_sheet.py](backend/generate_collection_sheet.py) is
the other half of step 3r.6a — a `.docx` generator, one row per digit
0–9, a configurable number of empty boxes per row for handwritten
samples. The row position is the label, the same self-labelling idea
harvesting uses, so nobody has to sit down and manually tag 200 cells
after the fact.

One thing worth carrying over from a fix already made once in this
project: `marks-grid-template.docx` (step 0) had a bug where python-docx's
`row.height` was silently ignored by Word because `row.height_rule`
wasn't also set — the row just quietly came out the wrong size, no error,
no warning. Same trap, same fix, applied here from the start instead of
rediscovering it:

```python
row.height = ROW_HEIGHT
row.height_rule = WD_ROW_HEIGHT_RULE.EXACTLY
```

Verified two ways: reading the saved file back and checking every row's
label, height, and cell count programmatically, then rendering it to a
PNG through LibreOffice and looking at it directly — a clean 10×20 grid
with visible ruled borders (needed later so the same kind of detection
this project already relies on can find the cells) and clearly labelled
rows.

This is deliberately as far as 3r.6a goes for now. The other half —
turning an actual photographed, filled-in sheet into
`training_data/<writer>/<digit>/<uuid>.png` crops — isn't built, on
purpose, for the same reason `detect.py` itself (step 1) was never
designed against an imagined photo: there is no real filled sheet yet to
tune a detector against, and guessing at one means building something
that looks plausible and has never actually been tested against reality.
That script gets written once a real photograph of a real filled sheet
exists, not before — the same discipline this project has held itself to
since its very first step.

### What's built, and what genuinely needs you

Everything above — `BothRecognizer`, the harvesting pipeline end to end
(backend and frontend), and the collection-sheet generator — is real,
tested code, not a plan. What's left is not a coding task at all:

- **Collecting real samples** (3r.6a): printing the collection sheet,
  getting at least four different people to actually fill one in by hand,
  and separately collecting the instructor's own handwriting for the
  marks-specific fine-tune. No script substitutes for another person
  picking up a pen.
- **Fine-tuning** (3r.6b): needs the collected and harvested data above to
  exist first.
- **The real comparison run** (3r.6d): running `RECOGNIZER=both` across an
  actual quiz session — the thin, one-photo verification above proves the
  mechanism works, but it is not the comparison run itself, which needs
  real volume across a real class.
- **Flipping the default** (3r.6e): only once that real run shows the CNN
  actually winning.

Both step 2r and step 3r were measured for real (their own sections above
have the numbers) — the same "run it against real crops and write down
what actually happened" standard every other number in this project has
been held to. Step 3r.6's own numbers don't exist yet, and can't, until
the four items above happen — that's not a gap in the code, it's the
actual shape of what's left.

### The 18-photo batch narrows the "collect from real writers" gap (2026-08-30)

The real 18-photo class batch (Step 0's section has the full story) turned
out to double as real progress on 3r.6a's collection goal, without needing
the collection sheet at all — 18 different students' handwriting, with
known-correct values already transcribed, is exactly the kind of real,
labelled variety fine-tuning needs.

A small one-off script, [harvest_real_photos.py](backend/harvest_real_photos.py),
posts each photo to the same `/api/harvest` endpoint the live Review
screen already uses on every Confirm — just with both `original` and
`confirmed` set to the identical transcribed ground truth, since there's
no instructor actually reviewing these on a screen:

```python
resp = client.post(
    "/api/harvest",
    files={"image": (name, f, "image/jpeg")},
    data={
        "config": json.dumps(config),
        "original": json.dumps(fields),
        "confirmed": json.dumps(fields),  # same as original -> everything lands "confirmed"
    },
)
```

16 of the 18 photos (the two that fail detection have no cells to harvest
from) landed real, correctly-labelled crops in `training_data/harvested/`
— spot-checked by opening a few of the saved images directly and
confirming the picture actually matches its filename's digit.

This is real, useful movement on 3r.6a's "collect from real writers" item,
but it's still not fine-tuning (3r.6b) or the real comparison run (3r.6d)
— the model in `cnn/checkpoints/` is exactly the one from step 2r,
unchanged. What this adds is real material for whoever does that
fine-tuning next, collected the easy way (a batch of real photos already
in hand) rather than the hard way (printing a sheet and waiting for four
people to fill it in).

## Step 3r.6e — Making the CNN the default

Everything up to here treated the CNN as the *optional* path. This step
flips it: with `RECOGNIZER` unset, the app now uses the local CNN, and
Gemini + Tesseract become the fallback you opt into. Worth understanding
both what the numbers said and what they didn't, because this decision was
made on partial evidence, deliberately.

### The numbers it was decided on

Two harnesses, both run against the 18-photo real-class batch:

```
python cnn/accuracy.py
  per-digit accuracy: 167/182 = 91.8%   (Tesseract baseline: 33/56 = 58.9%)
  whole-ID exact match: 16/29 = 55.2%   (Tesseract baseline: 0/8 = 0.0%)
  confidently wrong: 1

python cnn/marks_accuracy.py
  per-question accuracy: 103/105 = 98.1%
    whole marks: 91/93 = 97.8%
    half marks:  12/12 = 100.0%
  serial accuracy: 12/19 = 63.2%
  total accuracy: 17/19 = 89.5%
```

On the student ID the CNN wins decisively, and that's a like-for-like
comparison — same photos, same harness shape, against the exact number
Tesseract scored. That part is settled.

### What the numbers did *not* say

Marks and serial were previously read by **Gemini**, not Tesseract, and
there is no Gemini number for this batch. `RECOGNIZER=both` exists exactly
to produce one — it runs both paths and logs disagreements — but that
run never happened, and `comparison_log/` doesn't exist. So "98.1% on
marks" is a good absolute number with nothing to compare it against.

The weak spot is **serial at 63.2%**, the lowest figure in the system. The
likeliest cause is segmentation rather than the classifier: the serial
cell holds two digits that have to be split apart, and `segment.py`'s
merge rule is tuned for one glyph per box. That's a hypothesis to test,
not a diagnosis.

> **Tested later, and mostly wrong** — see "The first live session" at the
> end of this file. The classifier is fine (14 of 17 serials are correct at
> raw argmax) and segmentation is implicated in only one case. The dominant
> cause is neither: `decode_serial` returns `None` for the *whole field* if
> any single glyph misses its floor, so a perfectly-read digit is discarded
> along with an uncertain neighbour. Worth leaving the original guess
> visible — it was a reasonable place to look, and it was not where the
> problem was.

### Why it was flipped anyway

Because accuracy isn't the only axis, and the other axis is one-sided:

- **No quota.** A real `rate_limited` response is what started this whole
  track. The CNN cannot rate-limit itself out of a class.
- **No network.** The laptop doesn't need internet mid-session.
- **No cost.** Every scan is free.
- **Privacy improves.** Nothing leaves the machine at all — the qualifier
  plan.md §12 has to attach to the remote path stops applying.

And the failure mode is safe by construction: a digit the CNN isn't
confident about is *flagged blank*, not guessed, and the instructor
confirms every scan on the review screen anyway. A 63.2% serial mostly
means "more blanks to fill in", not "more wrong numbers stored". Identity
also survives a missing serial on its own, because of the
at-least-one-of-ID-or-serial rule from plan.md §10.

The one genuinely uncomfortable fact: both harnesses report
`confidently wrong: 1`, against this track's own bar of zero. It's a
single ambiguous cursive digit rather than a systematic error, but the bar
isn't met, and pretending otherwise would be exactly the kind of theatre
this project's testing rules exist to prevent.

### The packaging consequence nobody asks about until it breaks

This is the part that's easy to miss. `requirements-cnn.txt` was kept
separate on the principle that *the main app has no dependency on any of
it*. The moment the CNN becomes the default, that principle is false —
the app can't start without `onnxruntime`.

So the split was redrawn along the real line, which is **inference vs
training**, not app vs CNN:

- `requirements.txt` gained `onnxruntime` (runs the `.onnx` file) and
  `scipy` (`segment.py`'s connected-component labelling). The default path
  needs both.
- `requirements-cnn.txt` keeps `torch`, `torchvision`, and `onnx` — used
  only by `train.py` to train and export.

The claim that torch is training-only isn't taken on trust; it's verified
by poisoning the module and building the recognizer anyway:

```python
import sys
sys.modules['torch'] = None       # any real import of torch now explodes
from app.recognizers.local import CNNRecognizer
CNNRecognizer()                   # constructs fine
```

Same trick confirms the default resolves correctly with the environment
variable unset:

```python
os.environ.pop('RECOGNIZER', None)
import app.main as m
type(m.recognizer).__name__       # -> 'CNNRecognizer'
```

### A doc bug this uncovered

`main.py` already read `os.getenv("RECOGNIZER", "cnn")` before this step
— while the docstring directly above it said the default was `"remote"`,
and CLAUDE.md and plan.md §16 said the same. The code had been the real
default for some time and nothing pointed it out. Everything is now
reconciled to say `cnn`, with the caveats attached rather than dropped.

The lesson generalises: a comment asserting behaviour sitting one line
above the code that contradicts it is worse than no comment, because it
gets believed. `RECOGNIZER=remote` still works and is still supported;
it's just no longer what you get by accident.

## Step 11 — Hosting it for other faculty (BUILT AND DEPLOYED)

**All three phases are built, and the app is deployed and live** at
`https://d2n2meq17rr1oi.cloudfront.net`. Each phase has its own entry at
the end of this section — A is the two privacy defects, B is the config
seams, the storage seam and the container, C is hardening, disclosure,
observability and the deploy itself. What remains is only 11.7's
verification *as a user*: a real phone on mobile data, the full loop
through Excel export, and handing the URL to someone who has never seen it.

The deployed architecture is **not** the one the plan specified, for a
reason that could only be discovered by deploying. That story is the last
entry here, and it is the most useful thing in this section.

The sections immediately below are the *reasoning* that produced the plan,
written before any of it existed. They are kept because several of the
conclusions were surprising, and two of them turned out to be real bugs
rather than deployment concerns. Written to the same honesty rule as steps
0 and 1's partial entries: labelled for what it is, so nobody reads the
unbuilt parts as a description of working code.

### The question

Could the app be hosted so other faculty could try it themselves, for free?

### Why the CNN default made this a different question

Step 3r.6e turned out to matter far more for hosting than for accuracy.
On the Gemini path, hosting for several faculty is close to unworkable:
there is one `GEMINI_API_KEY`, so everyone shares one free-tier quota, and
five people scanning would rate-limit each other within minutes. It also
needs the Tesseract binary, which means an `apt` layer in the container.

On the CNN default there is no key, no quota, and no system package. The
container becomes a plain `pip install`, and each user's scans cost nothing
and interfere with nobody. A decision made on accuracy grounds quietly
removed the main obstacle to sharing the thing.

### Measuring before recommending

Three numbers decided the architecture, and all three were measured rather
than assumed:

```
real capture size   166 KB average, 807 KB largest   (from debug_uploads/)
cold init           0.90 s  (0.48 s cv2+scipy+onnxruntime, 0.42 s app+model)
idle memory         124 MB RSS with the model loaded
```

Each cleared a specific risk. The capture size matters because **Lambda
caps a request payload at 6 MB** — had photos been 8 MP phone dumps this
would have been ruled out immediately, but `Scan.tsx` constrains capture to
1920×1080, so real uploads are ~166 KB. Cold init matters because a
multi-second import cost is what makes serverless feel broken; 0.9 s is
fine. And 124 MB fits any free tier's 512 MB.

### The finding that changed the plan

Free hosting has one constraint that outranks everything else: **no
mainstream free tier gives you a persistent disk.** Koyeb excludes volumes
on free instances, Render attaches disks only to paid services, Fly.io
dropped its free tier for new signups, and Hugging Face charges for
persistence.

That matters because `training_data/harvested/` is the whole point of
keeping the harvester running — and on an ephemeral filesystem every
harvested crop disappears on each redeploy and each idle-sleep.

The fix is to stop storing crops on the app host at all and write them to
object storage instead. The app host goes back to being disposable, which
is exactly what free tiers are good at. *(Built in phase B — see the
`Store` seam below.)*

### Two real bugs found by asking a deployment question

This is the part worth remembering. Neither of these is a hosting problem;
hosting just made them visible. **Both are now fixed — phase A, below —
but they are described here as they were found, because how they were
found is the transferable part.**

**1. The backend is not stateless, and says it is.** `main.py` has a block
labelled TEMPORARY that writes every upload to `backend/debug_uploads/`. By
the time it was deleted it had accumulated **605 real photos, 99 MB**.
CLAUDE.md asserts "the backend is stateless — nothing written to disk" a
few lines away from code that writes to disk on every request.

**2. The harvester's UUIDs don't achieve what they were for.** Each crop
gets its own `uuid.uuid4()` precisely so that the seven digits of one
student's ID cannot be reassembled. But they are written in a loop, in
order, within a single request — so sorting `id_digits/` by modification
time reconstructs the ID, in order. The randomised filename hides the link;
the filesystem metadata restores it.

That second one was, at this stage, still a *prediction* from reading the
code. It was later confirmed against this repo's own collected crops before
being fixed — two real student IDs came back verbatim. Prose about a
vulnerability and a demonstration of one are different things, and the
demonstration is what justified also backfilling the ~700 crops already on
disk.

The lesson generalises past this project: an anonymisation scheme has to
account for *everything* the storage layer records, not just the field you
chose to randomise. A one-line constant mtime closes it.

### Why AWS, and why not the credits

The user had $140 in AWS credits, which sounds like the reason to pick AWS
but is actually the weakest one. The design targets AWS's **always-free**
tiers instead — permanent, service-level allowances that have nothing to do
with credits or account age:

| | Always-free allowance | This workload |
|---|---|---|
| Lambda | 1M requests + 400,000 GB-s / month | ~4 GB-s per scan → ~100,000 scans/month |
| CloudFront | 1 TB egress + 10M requests / month | 1.2 MB per page load |

A realistic demo — ten faculty, thirty students each — is 300 scans, or
0.3% of the free allowance. So the credits stay untouched as a safety net,
and the demo does not die when they expire.

### The trap in the credit screen

The credits displayed an expiry of **18 Aug 2027**, which reads like a year
of runway. It isn't. Under AWS's current model a **Free plan account closes
automatically after six months** — around 18 Feb 2027 here — or when
credits are exhausted, whichever comes first. The credits' expiry date and
the account's lifetime are two different clocks, and the shorter one wins.

The fix is to move to the Paid plan and set a budget alarm. That sounds
like the riskier option and is actually the safer one here: the workload
sits inside always-free tiers either way, so the expected bill is $0, and
the Paid plan is what stops the account vanishing mid-semester with other
people relying on it.

### Where Lambda turns advice into enforcement

The nicest part of the target. **Lambda's filesystem is read-only outside
`/tmp`**, so both write paths above don't merely misbehave there — they
raise `OSError: Read-only file system` on the first scan. The deployment
cannot run until the statelessness invariant is literally true.

Documentation asks you to remember an invariant. This target enforces it.
`TemporaryDirectory` in the scan handler is unaffected, since it lands in
`/tmp` — which is why detection and cell-splitting keep working untouched.

### Addendum — a mitigation that existed only on paper

One more finding from the step 11 planning, added because it is the most
transferable lesson in this section.

plan.md §16 lists an open risk: *"Self-collected samples can narrow the
model rather than widen it. Per-writer tagging exists so this is measurable
rather than a surprise: hold out an unseen writer entirely."*

Read that sentence and you would assume per-writer tagging is implemented.
It never was. `harvest.py`'s `_save` writes:

```python
shutil.copyfile(crop_path, out_dir / f"{value}_{uuid.uuid4().hex}.png")
```

A value and a random hex string. No writer, no session, no source. The
mitigation was correctly identified, written down as though it were a
property of the system, and never built — and nothing surfaced the gap
because with a single instructor there was only ever one writer, so the
missing distinction cost nothing.

It only became visible when the question changed to "what happens when ten
faculty pool crops into one bucket", where the answer is that §16's
evaluation method becomes impossible and **cannot be reconstructed
afterwards** — an untagged crop has no way to remember where it came from.

The design that fixes it has one interesting constraint. The obvious
implementation, a per-scan id, would directly undo the privacy work in
11.0.2: give every crop from one request the same tag and you have
regrouped that student's seven ID digits, which is precisely the link the
per-crop UUIDs and the constant mtime exist to break. So the tag has to be
**per-faculty** — coarse enough that one prefix holds an entire class mixed
together and identifies nobody, fine enough to say "hold out faculty B and
measure against them".

Two smaller things fell out of the same review, both worth knowing before
anyone fine-tunes:

- **The `confirmed`/`corrected` split is polluted.** `harvest_real_photos.py`
  posts `original == confirmed`, so its entire batch is filed as
  `confirmed/` whether or not the model would have got it right. Still
  valid labelled data; not a valid list of the model's failures.
- **The classes are imbalanced.** Across the 727 crops collected so far, ID
  digits run from 20 (`4`) to 80 (`2`), and marks are worse — whole numbers
  33–58 each against **half marks at only ~8 each**, six times rarer than
  the values they are hardest to tell apart from.

The general lesson: a documented mitigation is not a mitigation. It is
worth periodically grepping for the thing a risk paragraph claims exists,
because the paragraph will keep reading as true long after the code has
failed to catch up with it.

---

### Phase A (step 11.0) — the two privacy defects, actually fixed

This is the part of step 11 that is **built**, not planned. It shipped on
its own, ahead of any deployment work, because neither item was really
about hosting — they were live defects in the laptop app, and hosting only
made them consequential.

#### 11.0.1 — deleting the thing that stored every script

`main.py` had a block, labelled `TEMPORARY` in its own comment, that saved
every uploaded photo to `backend/debug_uploads/`:

```python
# TEMPORARY — see DEBUG_UPLOADS_DIR comment above.
DEBUG_UPLOADS_DIR.mkdir(exist_ok=True)
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
(DEBUG_UPLOADS_DIR / f"{stamp}.jpg").write_bytes(image_bytes)
```

It was added in step 6 for a good reason: the backend is stateless, so when
phone captures were mysteriously failing there was nothing left to look at
after a request. It did its job — several real detection bugs were found
through it. But "temporary" survived four more steps, and by the time
anyone looked it held **605 photos, 99 MB** of real students' scripts.

Deleting it is three deletions: the constant and its comment, those four
lines in the handler, and the `datetime` import that nothing else was using
any more. Then `rm -rf backend/debug_uploads`. Nothing tracked changed,
because the directory was gitignored the whole time.

One thing worth doing *before* the `rm`, not after: check whether anything
depended on those files. `testset/labels.json` cites `debug_uploads/`
paths in seven of its entries — the `phone_*` captures that widened ID
accuracy measurement from n=1 to n=8. Those had already been **copied**
into `testset/images/`, so the citations are provenance notes, not live
references, and nothing broke. But that was worth five seconds of `ls`
rather than an assumption, because it is not recoverable if wrong.

The `TemporaryDirectory` in the same handler stays. That is the legitimate
per-request working directory — it is deleted before the response returns,
and on Lambda it will live in `/tmp`, the one writable path.

#### 11.0.2 — the anonymisation that wasn't

This is the more interesting one, and it is a good lesson about what
"anonymised" actually requires.

The harvester writes each labelled cell crop under a random filename:

```python
shutil.copyfile(crop_path, out_dir / f"{value}_{uuid.uuid4().hex}.png")
```

The `uuid4` is deliberate. It is there so that the seven crops making up
one student's ID cannot be put back together — each digit becomes a loose,
unlinkable image of a `2` or a `7`, which is all a training set needs.

Except the digits are written **in a loop, in order, within one request**.
So while the *names* are random, the *write times* are not:

```
9_b6b65f56….png   2026-08-30 01:14:52.299164217
9_c37b1a5b….png   2026-08-30 01:00:13.580048141
```

Sort the directory by mtime, read the label off the front of each filename,
and the ID comes back in order. The random filename hides the link; the
filesystem's own metadata restores it.

The fix is one line, in `_save` rather than at each call site so that no
field added later can forget it:

```python
dest = out_dir / f"{value}_{uuid.uuid4().hex}.png"
shutil.copyfile(crop_path, dest)
# Stamped here rather than at each call site, so no field added later
# can forget it — see CONSTANT_MTIME.
os.utime(dest, (CONSTANT_MTIME, CONSTANT_MTIME))
```

`CONSTANT_MTIME` is `0.0` — the value is arbitrary, only its *constancy*
matters — and it carries a comment explaining why, because a hardcoded
1970 timestamp looks exactly like a bug to the next person reading it.

#### Proving the leak instead of believing the write-up

The step described this leak in prose. Prose can be wrong, so it was worth
running the attack against the repo's own data before fixing it: sort every
existing crop in `id_digits/` by mtime, read the labels in order, and see
whether any real student ID falls out.

**Two of the eighteen real class IDs came back verbatim** (`5567890`,
`5678900`). Not all eighteen — the batch harvest wrote its digits with
sub-millisecond gaps so request boundaries blur together, and a student's
digits split across `confirmed/` and `corrected/` when some were
corrections. But two verbatim hits from a crude ten-line script settles the
question: the ordering carries identifying information, and someone trying
harder would get more. After the fix, zero.

#### The part the spec didn't cover

Running the step's own verification turned up something its instructions
missed. `os.utime` in `_save` protects **future** writes. The **727 crops
already collected** still carried 133 distinct real mtimes — and that
existing corpus is precisely what step 11.2 is going to upload to S3. The
fix would have been correct and the leak would have shipped anyway.

So the existing crops were backfilled to the same constant, after checking
that nothing anywhere reads a harvested crop's mtime (a repo-wide grep for
`st_mtime`/`getmtime`/`.stat()` found exactly one hit, and it was a file
*size* in `train.py`):

```
727 crops: 133 distinct mtimes -> 1
```

The general lesson: when you fix a data-handling defect, the fix applies to
new data automatically and to old data never. The data you already have is
usually the data that matters most, because it is real.

#### Writing the test as the attack

The step suggested a regression test, on the grounds that a lone `os.utime`
call is exactly the kind of line a future cleanup deletes as pointless. The
useful choice was *what* to assert. Asserting "`utime` was called" tests the
implementation and would pass even if the mechanism stopped working. So the
test performs the attack instead:

```python
crops = list(harvest_dir.rglob("*.png"))
assert len(crops) == len(digits) + 3  # every field really was written

mtimes = {p.stat().st_mtime for p in crops}
assert mtimes == {CONSTANT_MTIME}, (
    "harvested crops carry distinguishable mtimes, so sorting them by "
    "time reconstructs one student's digits in order"
)
```

Then — the step that is easy to skip — the `os.utime` line was temporarily
replaced with `pass` to confirm the test actually fails. It did, printing
three visibly ordered timestamps a millisecond apart. A privacy test that
has never been seen failing is not evidence of anything.

#### What phase A leaves behind

- 85 backend tests (84 → 85), 31/31 detection regression, 67 frontend.
- A real `/api/scan` returns exactly what it did before
  (`student_id: "2632711"`, `serial: "07"`, `q1` flagged rather than
  guessed) — the point of phase A is that behaviour is unchanged.
- `find backend -name '*.jpg' -mmin -5` after a scan returns nothing. The
  backend genuinely writes nothing under `backend/` now.
- The `harvest.py` write remains, deliberately — that is 11.2's problem,
  and on Lambda it raises `OSError` rather than silently losing data.

---

### Phase B (steps 11.1–11.3) — making it deployable without changing it

Phase B is the odd kind of work where **the goal is that nothing happens.**
Every line of it adds a way for the app to behave differently somewhere
else, while the laptop app stays byte-for-byte what it was. That constraint
is what makes it safe to merge months before any deployment exists.

#### One module for every environment read

The temptation is to sprinkle `os.getenv` wherever a setting is needed. Two
things in this codebase argue against it. `main.py` resolves `RECOGNIZER` at
*import* time, and already needed an explicit `load_dotenv` to do that
reliably — a lesson from the CNN default flip, where making the recognizer
imports lazy nearly broke `.env` selection as a side effect. And every new
setting has to work identically as a shell variable on a laptop and as a
Lambda environment variable in production.

So `app/config.py` loads dotenv exactly once and exposes typed values.
Nothing else in `app/` reads the environment.

The interesting part is the CORS setting, because it has to mean two
different things:

```python
def allowed_origins() -> list[str] | None:
    raw = os.getenv("ALLOWED_ORIGINS")
    if raw is None:
        return None
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    return origins or None
```

`None` and `[]` are *not* the same answer. `None` means "keep the
localhost/LAN regex"; `[]` would mean "allow no origin at all", which
silently breaks every client. So a blank or all-whitespace value falls back
to `None` rather than locking everyone out — a mistake should not be
interpreted as a strict security policy.

#### Testing that nothing changed

The property phase B rests on ("an unset environment is today's app") is
exactly the kind that quietly stops being true. `tests/test_config.py`
asserts it directly, including a copy of the pre-step-11 CORS regex written
out literally rather than imported:

```python
PRE_STEP_11_REGEX = (
    r"^https?://(localhost|127\.0\.0\.1"
    ...
)

def test_cors_regex_is_byte_identical_to_what_shipped_before_step_11():
    assert config.DEFAULT_ALLOWED_ORIGIN_REGEX == PRE_STEP_11_REGEX
```

Importing the constant would make the test tautological — it would pass no
matter what the regex became. Duplicating it is the point.

**A test-isolation bug worth knowing about.** `config` resolves values at
import, so tests that need a different environment reload the module. The
fixture's first version did this:

```python
yield _reload
importlib.reload(config)          # WRONG
```

Every test passed on its own and three unrelated tests failed in the full
suite. The reason is fixture finalisation order: `reloaded` is set up
*after* `monkeypatch`, so its finaliser runs *first* — reloading while the
patched environment was still in place, which baked `HARVEST_BACKEND=s3`
into the module for the rest of the session. The fix is one line, and it
has to be explicit:

```python
monkeypatch.undo()
importlib.reload(config)
```

The general lesson: any fixture that snapshots global state has to undo the
things it depends on *before* it re-snapshots, and pytest's reverse-order
finalisation makes "depends on" mean "was set up before me".

#### The store seam, and why the key is the design

Harvested crops cannot stay on the app host: no free tier offers a
persistent disk, and Lambda's filesystem is read-only outside `/tmp`. So
`_save` stopped touching the filesystem and started handing a key to a
store:

```python
key = f"{source}/{field}/{tag}/{value}_{uuid.uuid4().hex}.png"
store.put(key, crop_path)
```

`LocalStore` writes that key as a relative path; `S3Store` writes it as an
object key under a prefix. Keeping them *identical* is the whole trick —
`aws s3 sync` then reproduces the training layout byte for byte, so the
fine-tuning code never has to know which backend collected the data.

The interface is deliberately one method. Listing, deleting, reading back
would all be inventing requirements: harvesting only ever appends.

#### The source tag is a granularity decision, not a field

This is the part where the obvious implementation is actively harmful.
plan.md §16 needs to hold out an *unseen writer* to measure fine-tuning
honestly. That is impossible once several faculty pool crops into one
bucket with nothing to tell them apart — and it cannot be reconstructed
afterwards, so it had to happen before anyone collects anything.

The obvious tag would be per-scan. **That would undo step 11.0.2
outright**: give every crop from one request the same tag and you have
regrouped that student's seven ID digits, which is exactly the link the
random filenames and constant mtime exist to break.

So the tag is **per-faculty** — coarse enough that one prefix holds a whole
class mixed together and isolates nobody, fine enough to say "hold out
faculty B and measure against them". And it is generated **client-side**,
because step 11 deploys one shared backend behind one URL, so a server-side
constant would label every faculty member identically.

A missing tag files crops under `unknown/` rather than getting one invented
server-side. A gap you can see in the bucket beats a gap papered over.

#### A schema decision that only shows up later

The source id lives in IndexedDB. The obvious place is beside the quiz
config — but `resetAll()` *clears* the config store, and "Reset everything"
is a normal thing to do between classes. Storing it there would hand the
same person a fresh identity every reset, splitting one writer's
handwriting across unrelated prefixes and quietly defeating the evaluation
the tag exists for.

So it goes in a new `meta` store that `resetAll()` deliberately does not
touch, which means a schema version bump — and a guarded upgrade, because
real instructors have real records in a v1 database:

```ts
upgrade(db, oldVersion) {
  if (oldVersion < 1) { /* records + config */ }
  if (oldVersion < 2) { db.createObjectStore('meta'); }
}
```

Without the `oldVersion` guard, opening an existing v1 database throws on
re-creating `records`. That is worth a test, and worth *watching the test
fail*: removing the guard turns the migration test red with a
`ConstraintError`, which is how you know it is testing the migration and
not just the happy path.

#### The container, and the check that actually earns its keep

The Dockerfile has no `apt` layer at all. That is not tidiness — it is
step 3r.6e's CNN default cashing out. The remote path needed the Tesseract
binary; the default path needs nothing outside pip.

One deviation from the step's plan, made for a concrete reason. The step
suggested the `public.ecr.aws/lambda/python` base image *and* the Lambda
Web Adapter. Those pull in opposite directions: the adapter is what speaks
the Lambda Runtime API, so the base image's runtime interface client is
redundant — and keeping it means the container answers Lambda's
`/2015-03-31/functions/function/invocations` envelope instead of a plain
`POST /api/scan`. That would break the local verification the whole step
exists for. The step's own test command curls `/api/scan` directly, so a
plain slim base plus the adapter is what makes the tested thing and the
shipped thing the same thing.

Then the check that pays for the entire phase:

```bash
docker run --read-only --tmpfs /tmp marks-backend
```

`--read-only` reproduces Lambda's filesystem on a laptop. A real scan
through that container returned the identical result the laptop gives
(`student_id: "2632711"`, `serial: "07"`, `q1` flagged). And harvesting,
left on its local default, failed exactly as predicted:

```
OSError: [Errno 30] Read-only file system: '/var/task/training_data'
```

That is a *success*. It is the failure this step was written to prevent,
surfaced in about a second instead of through CloudWatch logs after a
deploy. Switching to `HARVEST_BACKEND=s3` moved the failure to
`InvalidAccessKeyId` — the filesystem is no longer in the path at all, and
the only thing left is a real bucket.

#### What running the container found that no test would have

`S3Store` imports `boto3`, and AWS documentation says boto3 ships in the
Lambda runtime. That is true of the **managed** Python runtime and the
Lambda base image. This deploys a **custom container on a plain slim
base**, where nothing is provided:

```
ModuleNotFoundError: No module named 'boto3'
```

Every unit test passed throughout, because they stub `boto3` — correctly,
since the point of those tests is the key construction. Only building and
running the actual image caught it. It now lives in a new
`requirements-deploy.txt`, following the same split the project already
uses for `requirements-cnn.txt`: the laptop should not install what it will
never import.

The lesson is narrow and worth keeping: a stubbed dependency proves your
code calls it correctly, never that it will be there.

#### The corpus had to move too

Same shape of problem as 11.0.2's backfill. The new key puts the source
first, but the 727 crops already collected sat at the old top level, so the
corpus would have had two layouts. They were moved under a single
`pilot-legacy/` prefix with a README explaining what it is — deliberately
not a more specific name, because those crops mix the instructor's own
review-screen Confirms with the 18-photo real-class batch and can no longer
be told apart. Accurate as a *writer* prefix (one faculty member collected
all of it); not a claim about whose handwriting is inside.

---

### Steps 11.4 and 11.5 — hardening, and a claim that had quietly gone false

These are phase C's two code-only substeps, done ahead of the deploy on
purpose: neither needs an AWS account, and doing them first means the AWS
session is infrastructure work rather than debugging.

#### The rate limiter, and being honest about what it's worth

There is no auth on this API and deliberately won't be for a demo, so a
size cap and a per-IP limit are what stands in for it.

The easy version of this section would claim the endpoint is now
protected. It isn't, quite, and the reason is worth understanding. The
counter lives in **this process's memory**. On Lambda that means per
*container instance*, and concurrent invocations get separate containers —
so an attacker spreading requests across many cold starts is limited far
less than "30 per minute" suggests. Making it exact needs Redis or
DynamoDB: real infrastructure, real cost, and a shared-state dependency on
every request, for a free demo whose documented answer to sustained abuse
is "take the URL down".

So what it actually buys is: accidental hammering, a stuck retry loop, and
casual abuse. That is worth having. Pretending it were more would be worse
than the limit itself. (This is also why no new dependency — `slowapi`
carries the identical per-instance limitation, so it buys nothing here.)

**Two small design choices that matter more than they look.**

A *sliding* window rather than a fixed calendar-minute bucket:

```python
cutoff = now - self.window_seconds
while hits and hits[0] <= cutoff:
    hits.popleft()
```

A fixed bucket lets a caller spend the whole budget at 11:59:59 and the
whole budget again at 12:00:00 — twice the intended rate, at exactly the
moment a retry storm is most likely.

And an over-limit request is **not recorded**:

```python
if len(hits) >= self.max_requests:
    return max(0.0, hits[0] + self.window_seconds - now)
hits.append(now)   # only reached when allowed
```

Record the rejected ones and a client that keeps hammering keeps pushing
its own window forward, staying locked out indefinitely — a limiter that
punishes retrying harder than the original burst.

#### Why the size check is middleware and not a dependency

FastAPI dependencies are the natural place for this kind of guard, and
they are the wrong place here. A dependency runs *after* FastAPI has
parsed the multipart form — by which point the oversized upload is already
in memory and the cap has accomplished nothing. It has to run before the
body is read, which means middleware.

There are then two checks, not one. `Content-Length` is a claim, not a
fact — it can be absent or a lie — but rejecting on it is free and catches
the honest case. The real enforcement is after the read, where the actual
bytes are known.

#### Numbers chosen against measurements, not roundness

`MAX_UPLOAD_BYTES` is **4 MB** because real captures measured **166 KB on
average and 807 KB at the largest**, so 4 MB is generous by a wide margin
while still refusing a body that could only be abuse or a mistake.

4 MB and not 5, and the reason is easy to get wrong: Lambda's 6 MB request
limit applies to the **base64-encoded event payload**, not to the raw
bytes. The body gets base64'd on the way in, which inflates it by 4/3 — so
a 5 MB image becomes a 6.7 MB payload and is rejected by the platform with
an opaque error, which is precisely what this cap exists to prevent. 4 MB
raw is ~5.3 MB encoded, leaving headroom for the multipart and JSON
envelope. Measured, not assumed: a real 67 KB capture produced an 89 KB
payload through the runtime emulator.

*(This paragraph said 5 MB until 2026-08-31. The code was changed to 4 MB
with the reasoning above; this file and `backend/.env.example` both kept
recommending the value the code's own comment argues against — issues.md
N28. Fixed in all three places.)*

`RATE_LIMIT_REQUESTS` is 30/minute for three reasons at once, and the
third is the one that isn't obvious:

1. An instructor scanning a class does roughly 3 a minute. 10x headroom.
2. Several faculty behind **one institutional NAT** share an apparent IP.
   Five people scanning hard is ~15/min — still inside it. A tighter limit
   would lock out a whole department for looking like one person.
3. A single IP sustaining the full 30/min for a month is ~43,000 scans,
   still within Lambda's always-free tier. So even a hostile-but-slow
   caller cannot generate a bill.

#### Two browser behaviours that are easy to get silently wrong

**Preflights must not count.** Browsers send `OPTIONS` automatically before
a cross-origin POST. They cost nothing to answer, and counting them would
quietly halve an instructor's real budget.

**A 429 must still carry CORS headers.** Without them the browser reports
an opaque CORS failure rather than the real status, so the frontend can
never tell the user to slow down — the error becomes indistinguishable
from the backend being down. Whether this works depends on
`CORSMiddleware` *wrapping* the `guard` middleware, which is a consequence
of registration order rather than anything visible at the call site. That
makes it exactly the sort of thing a later refactor breaks without
noticing, so there's a test pinning it.

#### The header we key on is spoofable, on purpose

Behind API Gateway and CloudFront, `request.client.host` is the
*proxy* — every caller would share one bucket and the per-IP limit would
silently become a global one. So the key comes from `X-Forwarded-For`.

Anyone can send that header, so an attacker can evade the limit by varying
it. That trade is taken deliberately and written down in the code: keying
on the proxy is a **guaranteed outage** for legitimate users, versus a
**possible evasion** by an attacker the threat model already concedes it
cannot stop. Choosing the guaranteed harm to prevent a conceded one would
be the worse trade.

#### 11.5 — the app had been overstating its privacy for two steps

This was meant to be "add a disclosure". It turned out to be a
**correction**.

`Setup.tsx` had said this since step 5:

> Everything stays on this device until you export it — there's no
> account, no upload of student marks anywhere they don't need to go…

And `/api/harvest` has been saving labelled cell crops to the backend
since step 3r.6c. The sentence was written when it was true and nobody
revisited it when the harvester landed — so the app had been telling
faculty something false for two steps.

The replacement states both halves, because only stating the reassuring
one would repeat the original mistake:

- the **photograph** is never stored (true since 11.0.1), and
- **individual cells** — one digit or mark each — are kept with the value
  the instructor confirmed, and used to train and tune recognition,
  carrying no name, nothing linking back to a student, and no way to
  reassemble a whole ID.

**Where it goes matters as much as what it says.** The "How this works"
section is a `<details open={!saved}>` — expanded on first use, collapsed
once a quiz config exists. Putting the disclosure only in there means the
person on their tenth session never sees it again, and that is precisely
the person whose students' handwriting is being collected. So a one-line
summary also renders outside it, always visible, and `Setup.test.tsx`
asserts that:

```tsx
const note = await screen.findByText(/used to train and tune handwriting recognition/i);
expect(note.closest('details')).toBeNull();
```

Testing UI copy is usually a waste — wording should be free to change.
This is the exception: it is a promise made to users about their students'
data, and the test guards its *existence and placement*, not its phrasing.

The general lesson is the one this project keeps re-learning in different
forms: a true sentence about a system's behaviour stops being true when
the behaviour changes, and nothing about the sentence announces that. It
is worth periodically re-reading the claims a UI makes and asking whether
the code still supports them.

---

### Resetting the training corpus (2026-08-31)

Sometimes the right move is to throw the data away. This is a short account
of how we decided that, because the reasoning transfers.

#### The corpus was describing testing, not handwriting

`fetch-crops.sh` reported a digit histogram: `2` appearing 82 times, `4`
only 20. That reads like natural class imbalance until you notice which
digits. The two scripts used during step 6/7 phone testing had IDs
`2632711` and `2632700` — both 2-heavy — and they were re-photographed
dozens of times while debugging, with every Confirm harvesting again.

So the "imbalance" was mostly an artifact of one person testing the camera.
Fine-tuning on it would have taught the model that `2` is four times more
likely than `4`, which is true of nothing except that afternoon.

Three other problems sat alongside it:

- **`pilot-legacy` mixed two collections that could not be separated** —
  the phone-test Confirms and the 18-photo real class batch — so
  plan.md §16's held-out evaluation was impossible on it.
- **The `confirmed`/`corrected` split was a lie.** `harvest_real_photos.py`
  posted `original == confirmed`, so all 16 real photos filed as "the model
  got this right" when the model had never been asked.
- **Verification crops shared a namespace with real ones**, with no way to
  tell them apart afterwards.

#### The thing that made the decision easy

The valuable half was **regenerable**. The 18-photo batch came from a
script, and the photos plus ground truth still live in `testset/`. So the
choice was never "discard hard-won data" — it was "drop the contamination
and rebuild the good part cleanly".

And 229 crops is nowhere near enough to fine-tune on regardless (EMNIST has
240,000). The corpus had no training value yet, which is exactly why
resetting cost nothing. **The cheapest moment to fix a data-hygiene problem
is while the data is still worthless.**

#### Fix 1: make test data structurally separate

A convention ("remember not to harvest while testing") is the thing that
already failed. `TEST_SOURCE_PREFIX = "test-"` is now reserved, and
`fetch-crops.sh` drops those sources unless `INCLUDE_TEST=1`. Structure
cannot be forgotten the way a habit can.

#### Fix 2: stop asserting what the model did

`harvest_real_photos.py` now runs a real `/api/scan` first and uses that as
`original`:

```python
scan = _post(client, "/api/scan", files=..., data={"config": ...})
original = _fields_from_scan(scan.json(), len(config["questions"]))
```

One extra request per photo, and the `corrected` tag starts meaning
something. After the re-harvest: 211 confirmed, **18 corrected** — 18 crops
that are genuinely the model's failures, and those are the ones worth
weighting most.

A failed scan yields all-None, which is correct rather than a special case:
the model produced nothing usable, so every field the ground truth supplies
is a correction.

#### Fix 3: content-addressed keys

The duplication problem has a neat fix — make the filename a hash of the
crop's own bytes instead of a uuid4:

```python
digest = hashlib.sha256(crop_path.read_bytes()).hexdigest()[:32]
return f"{source}/{field}/{tag}/{value}_{digest}.png"
```

Re-confirming the same script now produces the same key and overwrites.
Duplication becomes structurally impossible rather than something to
remember.

It keeps the property the uuid4 was there for: two different digits from
one student hash differently, so nothing groups a student's crops. The
trade — a content-addressed store lets someone holding a candidate crop
test whether it is in the corpus — is far smaller than the duplication it
prevents, and is written down in the code rather than glossed.

Two tests pin both halves, and the second matters as much as the first:

- re-harvesting the same crop five times leaves one file
- **two different students' `7`s both survive** — dedupe must be by
  content, never by label, or the corpus loses exactly the variation it
  exists to capture

Fixing this also broke a test fixture in an instructive way. `_make_cells`
wrote identical bytes to every placeholder, so under content addressing
they all collapsed into one file. The fixture was unrealistic — real crops
of different cells are never byte-identical — so the fix was to make the
placeholders distinct, not to weaken the dedupe.

#### What the clean baseline looks like

```
by source:  pilot-real-class 229
by tag:     confirmed 211, corrected 18
ID digits:  rarest 2, commonest 26   (13x)
marks:      101 whole, 0 half
```

Two things worth reading honestly rather than as a win:

**The imbalance looks worse (13x, up from 4.1x).** It isn't. The old 4.1x
was flattened by hundreds of duplicates of two IDs; 13x across 16 real
students is what a small honest sample looks like. It will even out.

**There is now zero half-mark data.** This class awarded none. Half marks
are the hardest values for the model to read, and there is nothing to learn
from — which is precisely what step 3r.6a's blank collection sheet
generator was built for, and it remains unused.

#### The rate limiter caught its own author

The re-harvest crashed partway through with a 429. The script makes two
requests per photo — 36 for 18 photos — against the 30/min budget added in
step 11.4.

That is the limiter working, on the first real workload that ever exercised
it. The fix was on the client side, where it belonged: honour `Retry-After`
rather than fall over. It also means the script keeps working if it is ever
pointed at the deployed URL.

---

### Getting ready to deploy (step 11.6 preparation)

No AWS resource exists yet. This is everything done to make the deploy
boring when it happens.

#### Running the deployed shape before deploying

`local-stack.sh` runs the real container on a read-only filesystem with
only `/tmp` writable — exactly how Lambda mounts it — harvesting over a
real S3 API (MinIO), with `ALLOWED_ORIGINS` set and rate limiting on. It is
not `dev.sh`; it is the artifact that ships.

Its value showed up immediately, in the S3 ordering leak described earlier:
a *real* S3 implementation stamping *real* `LastModified` timestamps
reconstructed a student ID exactly. No stubbed test could have found that,
because the stub had no timestamps to stamp.

Two bugs in the script itself, both worth knowing because both are the same
shape — **a thing that looks fine while quietly destroying evidence**:

- **MinIO had no volume.** Its data lived in the container's writable
  layer, so `down` (which `rm -f`s the container) deleted every crop
  collected during testing — the exact evidence the test existed to
  produce. Now a named volume that `down` deliberately spares, with a
  separate `reset` for wiping on purpose.
- **A `|| true` swallowed a real failure.** Bucket creation failed because
  I published MinIO's console port but not its API port; the `|| true` hid
  it, so everything looked healthy until the first harvest died on
  `NoSuchBucket`. Only "already exists" is tolerated now.

#### The LAN IP is baked into two artifacts, and they go stale separately

A "Failed to fetch" on the phone turned out to be neither a code nor a CORS
problem. The frontend had been built while tethered to a phone hotspot
(`172.20.10.6`) and was then used on home wifi (`192.168.0.108`).
`VITE_API_BASE` is inlined at **build** time, so the bundle kept calling a
host that no longer existed. A fetch to an unreachable host fails before
any HTTP status, which is why the error is so shapeless.

The TLS cert has the same problem independently — its SAN list pins the IP
too. `local-stack.sh` already rebuilt the frontend on every `up`, so that
half self-healed; it now also regenerates the cert when the SANs no longer
cover the current IP, and prints the address it built for:

```
Built for LAN IP 192.168.0.108. If your phone cannot reach that address,
you have changed networks since — re-run ./local-stack.sh up.
```

That line is the whole diagnosis next time.

#### Verifying the Lambda adapter without Lambda

The one component that had never actually run was the Lambda Web Adapter —
it activates only inside a Lambda execution environment, so every local
test had been exercising plain uvicorn with the adapter sitting inert.

The AWS Runtime Interface Emulator closes that gap. Running the image under
RIE and invoking it with a real Function-URL-shaped event:

```
INIT REPORT durationMs: 1258
INVOKE START ... "GET /openapi.json HTTP/1.1" 200 OK
```

Then a full multipart scan through the same path returned the identical
result the laptop gives. That is as close to a real invocation as it is
possible to get without deploying.

It also surfaced a sizing error in my own work. Watch the numbers:

```
multipart body: 67 KB, base64 payload: 89 KB
```

Lambda's 6 MB request limit applies to the **base64-encoded event**, not
the raw bytes — base64 inflates by 4/3. The 5 MB upload cap I had set
meant a max-size image became a 6.7 MB payload and would be rejected by the
platform with an opaque error, which is precisely what the cap existed to
prevent. Now 4 MB, with the test asserting the *encoded* size rather than
the raw one.

While inspecting the image, one more: the adapter reads `AWS_LWA_PORT`,
with bare `PORT` only a legacy alias. The Dockerfile now sets both. A
mismatch there is invisible locally (the adapter is inert) and shows up in
production as a hang.

#### Two bugs in deploy.sh, found by reading rather than running

**The Lambda waiter was wrong.** After `create-function`, a container-image
function is `Pending` while the image is pulled and unpacked.
`function-updated` does not wait for that — it watches `LastUpdateStatus` —
so the smoke test could fire at a function that cannot serve yet, and fail
for a reason that looks like a code problem. `function-active-v2` after
create; `function-updated-v2` between the two update calls, where it is
*required* because two updates cannot be in flight at once.

**IAM eventual consistency was papered over with `sleep 12`.** A fresh role
often is not assumable yet, and `create-function` fails outright. A retry
loop is both faster in the common case and correct in the slow one — and it
re-runs the failing call unredirected on the last attempt, so you see the
real error instead of a silent exit.

#### Least privilege, and the probe that punished it

The deploy user's policy is derived from the API calls `deploy.sh` actually
makes, scoped to one ECR repo, one function, one role, two buckets.

Two grants are wider than the rest, and both are documented as deliberate:

- **`iam:PassRole`** is the dangerous one — unscoped it is close to
  privilege escalation. Here it is pinned to a single role ARN *and*
  conditioned on `iam:PassedToService: lambda.amazonaws.com`.
- **CloudFront cannot be resource-scoped on create**, because a
  distribution's ARN does not exist until it exists. That is an AWS
  limitation, and it is the strongest argument for a dedicated user.

Then the least-privilege design tripped my own checker. `preflight.sh`
probed `aws iam list-roles` — an account-wide action the policy
deliberately omits and `deploy.sh` never calls — and reported a blocker on
a correct policy.

The tempting fix is to add `iam:ListRoles`. That would be **loosening a
correct policy to satisfy a bad test**, and it is worth naming as a trap
because it looks like progress. The real fix was to probe the role
`deploy.sh` actually touches.

That exposed a second flaw in the same code: the probes could not tell
*"you may not do this"* from *"that does not exist yet."* Before a first
deploy nothing exists, so `NoSuchEntity` is a **pass** — the call was
authorised and found nothing. All three resources returned exactly that.

#### A check that broke what it was checking

`preflight.sh` built the frontend with a throwaway
`VITE_API_BASE=https://preflight.invalid` — into `dist/`. So running the
safety check left the real build pointing at a host that does not exist,
and the next `vite preview` served a frontend that could reach no backend
at all.

It builds into a temp directory now. The general lesson: a verification
step must not have side effects on the thing it verifies, and "it only
writes to the build output" is not an exemption when the build output is
what you are about to serve.

#### A verification command that verified nothing

Related, and worse. I had been running `npx tsc --noEmit` in `frontend/`
as a check for several sessions. The root `tsconfig.json` is a solution
file — `"files": []` plus references — so that command typechecks
**nothing** and passes cheerfully on genuinely broken code. It was hiding
two real type errors.

`npm run build` (which runs `tsc -b`) does catch them, and that was being
run too, so coverage was real — but the extra command was theatre. If a
check has never once failed, that is worth being suspicious about rather
than reassured by.

---

### The deploy (step 11.6) — and why the architecture changed

This is the entry worth reading, because almost none of it went to plan.

#### First: the app had to be able to say anything

CloudWatch can only show what a program emits, and this backend emitted
nothing but uvicorn's request lines. So observability came before the
deploy.

`app/observability.py` writes one JSON object per line to stdout. Lambda
captures stdout with no agent and no configuration, and Logs Insights
parses the fields natively because they are real JSON rather than a
formatted sentence:

```json
{"event":"scan","status":"ok","recognizer":"cnn","image_kb":66,
 "ms_detect":85,"ms_read_id":13,"ms_read_marks":27,"ms_total":126,
 "flagged_count":1,"flagged":["q1"]}
```

The per-stage timings are the point. "Scans are slow" is unactionable;
"detection is 2.1 s and recognition is 0.2 s" points at the cause.

**The privacy constraint shaped the design.** Step 11.7.3 requires that no
recognised student ID reaches CloudWatch, and logging is the easiest way in
the whole codebase to break that — one `logger.info(result)` while
debugging and every ID sits in a log group for a month. Logs also outlive
the request, which is what the rest of this backend is built to avoid.

So it is structural: a key denylist drops `student_id`, `serial`, `total`,
`value` whatever is passed, and a scrubber redacts any run of 4+ digits
inside a string — catching an ID smuggled through a message or an exception
string. `flagged` carries field *names*, which is the useful signal and
none of the sensitive one.

**Verifying it taught something.** The test runs a real scan, asserts the
ID was genuinely recognised, then asserts it appears nowhere in the output.
To check the test wasn't vacuous I leaked the ID into a log call — **and it
still passed**, because the scrubber redacted it. That is defence in depth
working, but it meant the check proved nothing about the test. Only
disabling the scrubber *and* leaking made it fail. When you verify a test,
make sure you have disabled every layer that could mask the thing you are
trying to trigger.

#### Then the deploy, which failed in a way no local test could catch

The backend went up cleanly: ECR image, Lambda Active, crops bucket,
execution role, Function URL. The smoke test returned:

```
{"Message":"Forbidden. For troubleshooting Function URL authorization issues..."}
```

What followed was hours of proving a correct configuration was correct.
The resource policy was textbook — `Principal: "*"`, `lambda:InvokeFunctionUrl`,
condition `FunctionUrlAuthType: NONE`. I ruled out, one at a time: an
Organizations SCP (the account is not in an org), permission ordering
(deleted and recreated the URL *after* the permission existed — same 403),
propagation, and function state.

Then a decisive experiment. Same URL, same function, only the auth type
changed:

| Caller | Result |
|---|---|
| Public (`NONE`) + correct public policy | 403 |
| CloudFront service principal + correct OAC grant | 403 |
| An IAM user with a signed request | **200** |

**This account refuses Lambda Function URL invocation by anything except an
IAM principal.** Not documented anywhere I could find, not visible in any
setting, and it blocks both routes the plan depended on.

#### A second bug that disguised the first

Along the way, multipart POSTs through CloudFront failed with a *signature
mismatch* while bodyless GETs failed with an *authorization* error. Two
different errors that looked like one problem.

The signature one is real and documented: CloudFront's OAC does not include
the request body in its SigV4 signature, while Lambda Function URLs verify
a payload hash. The fix is a CloudFront Function setting
`x-amz-content-sha256: UNSIGNED-PAYLOAD`.

I built it. It changed nothing — because the body was never the blocker.
That only became clear when I tested a **bodyless GET** and it failed too.

The lesson is about diagnosis, not CloudFront: when two symptoms look
related, find the simplest request that still fails. The GET took thirty
seconds and would have saved an hour if I had run it first.

#### What actually works

API Gateway HTTP API, which does not use Function URL auth at all. It
worked on the first try after one trap:

> `aws apigatewayv2 create-api --target <lambda-arn>` builds the
> integration and the route but **not** the Lambda invoke permission.

The symptom is a bare `Internal Server Error` with **nothing in
CloudWatch** — and that absence is the diagnosis. If the request had
reached the function there would be a log line, so silence means it died
upstream.

I had dismissed API Gateway earlier on cost and its 29–30 s timeout, and
the cost half was wrong: ~300 requests/month against $1/million is
$0.0003/month. The timeout is the real constraint, and it is a live one —
a 9 s cold start plus a scan fits inside 30 s, but not by much. That is why
the warm-up is now wired into the deploy rather than left as advice.

#### A bug I introduced, of a shape this project keeps meeting

The first distribution had the usual SPA fallback: 403 → `/index.html`,
status 200. CloudFront applies `CustomErrorResponses` **distribution-wide**,
not per cache behaviour — so it was silently rewriting API errors into an
HTML page with a **success** status. The failing POST looked like a working
endpoint returning gibberish.

The app has no client-side routing, so the fallback was never needed. But
note the shape: *something that looks fine while hiding the real failure*.
That is the third time in this project — the MinIO volume that deleted the
evidence, the `|| true` that swallowed a bucket error, the `tsc --noEmit`
that checked nothing. It is worth actively looking for.

#### The measurements that corrected earlier guesses

- **Cold start ~9 s**, not the 2–4 s extrapolated from a laptop runtime
  emulator. The adapter logs `app is not ready after 8000ms`. Lambda's
  slower vCPU plus the image pull is the difference.
- **Peak memory 201 MB of 2048 MB.** Tempting to cut, but memory is CPU on
  Lambda and startup is already the slow part, so reducing it would make
  cold starts worse.
- **Cost is ~$0.10/month, not $0.** ECR image storage dominates: 705 MB
  against a 500 MB free tier that is *12-month*, not always-free. S3's is
  12-month too. Only Lambda and CloudFront are permanently free.

The account is on the AWS Free plan, which **cannot be billed** — spend is
bounded by credits and the account closes rather than charging. So the risk
was never a surprise bill; it is credit drain ending the demo mid-semester.
Which also means a plain cost budget is useless here: it reads $0.00
forever because credits absorb everything. The budget has to **exclude
credits** from its calculation to measure anything at all.

---

## The audit (2026-08-31) — what a full read-through found that the tests did not

This section is not a step. It is what happened when, with the app deployed
and every step's Done-when bar met, every source file in the repo was read
straight through looking for defects.

**Read it as a snapshot of what was *found*.** Everything below describes
the code as it stood at that moment, in the present tense, because that is
when it was written. The next section covers fixing it — 38 of the 49
findings are closed, including every one described here. Where a passage
says "is not sanitized" or "has no equivalent", it now means *was*.

The headline is worth sitting with before any individual finding:

> **148 backend tests and 79 frontend tests all pass. The audit found 43
> open defects.**

Not because the tests are bad — they are good, and several are unusually
thoughtful (the mtime-ordering test is written as *the attack*, not as the
implementation). The point is narrower and more useful: **a test suite tells
you the things you thought to check are still true.** It cannot tell you
about the things you did not think of. Those need a different activity, and
the different activity is reading the code with an adversarial question in
mind rather than a confirming one.

### The near-miss that is the best lesson in the whole audit

`harvest.py` builds the storage path for a crop like this:

```python
def _key(field: str, tag: str, value: str, source: str, crop_path: Path) -> str:
    digest = hashlib.sha256(crop_path.read_bytes()).hexdigest()[:32]
    return f"{source}/{field}/{tag}/{value}_{digest}.png"
```

`source` arrives from the client. Somebody thought carefully about that and
wrote a sanitizer, with a docstring that names the exact threat:

```python
def _sanitize_source(source: str | None) -> str:
    """The source id becomes a path/key segment, so it is never
    interpolated raw. ... `/api/harvest` is a public endpoint and this
    arrives in a form field — a `../..` here would otherwise escape the
    harvest root."""
```

Then they wrote a test for it — `test_a_hostile_source_cannot_escape_the_harvest_root`
— and it passes.

Look at the f-string again. `value` also arrives from the client, on the
same request, in the same function, one variable along. It is
`HarvestFields.serial`, an unconstrained `str | None` straight off the
wire. It was not sanitized.

```
harvest(..., confirmed_serial="../../../../escaped/PWNED", store=LocalStore(root))
→ escaped/PWNED_73bf48fb3c46eb87f38779f251eb6cfc.png     # written OUTSIDE root
→ harvested/                                              # empty
```

That is a real arbitrary-file-write on a publicly deployed endpoint, and it
was verified by running it, not by reasoning about it.

Three things to take from this, in increasing order of usefulness:

1. **Reasoning correctly about a threat is not the same as being protected
   from it.** The threat model here was *right*. It was applied to one
   field.
2. **A passing test can make a gap invisible.** Anyone scanning the test
   names sees "hostile source cannot escape the harvest root", concludes
   path traversal is handled, and moves on. The test covers one *instance*
   of the bug class and reads like coverage of the *class*.
3. **Put the guard where the class of bug lives, not where the instance
   was found.** The fix is not "also sanitize `value`" — the next field
   added has the same problem. The fix is to sanitize inside `_key`, so no
   future field can forget, *and* assert in `LocalStore.put` that
   `dest.resolve()` is under `self.root.resolve()`. That second one is the
   invariant that actually matters, and it should not depend on every
   caller getting its own escaping right.

### "Reasonable input" stops being a thing the moment the URL is public

```python
def legal_values(max_mark: float) -> set[float]:
    steps = round(max_mark * 2)
    return {i / 2 for i in range(steps + 1)}
```

This is fine. It has been fine for the entire project, because `max_mark`
came from a form the instructor filled in about their own quiz, and quizzes
are marked out of 5 or 10.

`QuestionConfig.max` is a bare `float` with no bound. `legal_values(1e9)`
asks Python for a set of two billion floats.

Nothing changed in this function. What changed is that in step 11 the thing
calling it stopped being *the instructor's own browser on their own laptop*
and became *anyone on the internet*. Every implicit assumption about input
that was load-bearing and invisible became a hole on the day the URL went
public — and no test failed, because no test was ever going to guess `1e9`.

The general shape: **deploying does not change your code, it changes who
your callers are.** Worth re-reading input handling with that specific
question — "what if this value is hostile rather than merely wrong?" —
every time the audience widens.

### Fixing one thing broke another, and the tests could not see it

Step 6 got a genuinely good improvement on 2026-08-30: the capture button
now shows a spinner and disables itself while a shot is in flight, so the
instructor gets feedback where they are actually looking. The trade-off
recorded at the time was throughput — captures no longer run in parallel.

The trade-off *not* recorded is the one that matters:

```ts
const capturing = inFlightCount(entries) > 0;   // counts entries with status 'pending'
disabled={!!cameraError || capturing}
```

An entry leaves `'pending'` only when its `fetch` settles. `scanImage` has
no timeout and no `AbortSignal`. So a request that never settles at all —
a dropped wifi association mid-upload, which is *the* likely failure on a
phone-over-LAN setup — leaves one entry pending forever, which keeps
`capturing` true forever, which disables the capture button **for the rest
of the session**, recoverable only by reloading the page.

Before the change this was survivable: captures raced independently, so a
stuck one was just a stuck row in a list. The improvement is what made it
fatal. And it compounds an *older* finding — an errored entry has no
dismiss button — so the queue cannot drain either way.

This is the most instructive frontend finding because nothing about it is
sloppy. The change was well-motivated, correctly scoped, and its main
trade-off was written down. The failure mode is simply one that does not
occur on a fast local network, which is where all the testing happened.

### Writing an invariant down does not enforce it

CLAUDE.md has a section titled "Conventions and invariants" that opens with
"Breaking one is a defect, not a style difference." The audit checked them.
**Four are currently broken:**

- *"Serial comparison strips leading zeros"* — `Review.tsx` queries the
  by-serial index with the raw typed serial, so a saved `"007"` and a
  rescanned `"7"` are never even compared. `crossCheck` normalizes
  correctly; it just never receives the record. Worse, `types.ts` documents
  `StudentRecord.serial` as "normalized: leading zeros stripped", which
  describes the fix rather than the code.
- *"Never store a wrong number"* — the Total field has no legal-value check
  on **either** the Review or the Results screen. It is a plain text input,
  so `"abc"` is typeable, `Number("abc")` is `NaN`, and IndexedDB's
  structured clone stores `NaN` faithfully on a `confirmed: true` record.
- *"Flag, never guess"* — an ID still containing `?` (which both
  recognizers produce by contract for an unreadable digit) saves as
  confirmed, shows no badge, and exports to Excel as a literal `12?4567`.
- *"A failed scan is never a dead end"* — a transport-level failure renders
  as static text with no Retake, no Review, and no dismiss.

The privacy invariants, notably, **do** hold — ID never reaches Gemini,
nothing persists per-request, the harvest write-order and constant-mtime
defences both work. The difference is instructive: those are enforced by
`assert` statements and tests written as attacks. The four broken ones are
enforced by prose.

### The drift class, and why it is worth a pass of its own

Separately from bugs, a lot of comments had quietly stopped being true:

- `backend/.env.example` recommended `MAX_UPLOAD_BYTES=5242880` and called
  it "the 5 MB default". `config.py` uses 4 MB, with a long comment
  explaining precisely why 5 is wrong (base64 inflates by 4/3 against
  Lambda's 6 MB payload ceiling). The example file was recommending the
  exact value the code's own comment argues against — and so was this file,
  a few sections up.
- `frontend/.env.example` described the backend as a Lambda Function URL
  and gave a `lambda-url.us-east-1.on.aws` example. The deployed build uses
  `VITE_API_BASE=""` — same origin — so anyone following it would build a
  frontend pointing at a host that does not exist.
- `deploy.sh`'s CloudFront comment block claimed the API was reachable only
  through the CDN via OAC. Ninety lines below, the code says the opposite
  and is correct: API Gateway is publicly invokable.
- `.gitignore` still told the reader to "remove the save code in
  app/main.py" — deleted in step 11.0.1.
- `requirements.txt` said scipy was for `segment.py`'s connected-component
  labelling. `segment.py` uses OpenCV for that and needs no scipy; the real
  consumer is `preprocess.py`'s `ndimage.center_of_mass`, which is
  load-bearing for MNIST-matched centering.

None of these breaks anything today. All of them are the mechanism by which
something breaks later, because the comment is what the next person trusts
instead of re-deriving. All are now fixed, with the correction stated rather
than silently overwritten — a comment that says "this used to say X, and X
was wrong because Y" is worth more than one that was simply always right.

### The part of an audit worth writing down explicitly

`issues.md` ends with a section titled **"What this audit did NOT cover."**
It names the files that were never opened: `local-stack.sh` beyond its
header, the accuracy harnesses, the test bodies, the specs.

That section exists because of a specific failure mode. An audit document
with 43 findings *looks* exhaustive. If someone later asks "did anyone check
`marks_accuracy.py`?", the honest answer is no — and without that section,
the file's silence on the subject reads as "checked, nothing found."

Which matters here more than usual: `accuracy.py` and `marks_accuracy.py`
produce the 91.8% / 55.2% / 98.1% numbers that the entire decision to make
the CNN the default rests on. A bug in either would not be an app defect;
it would mean the *measurements are wrong*, which is a worse and much
harder-to-notice class of problem than anything in the findings list.

### One finding that was wrong, and the correction

The first draft of the audit recorded, as its highest-severity item, that 25
real student scripts and 24 plaintext student IDs were committed and pushed
to GitHub. It laid out the contrast at length: the codebase goes to
extraordinary lengths to make harvested crops unlinkable, while whole
un-anonymized photographs sat in git.

The premise was wrong. The IDs, serials and marks in those photos are
**fabricated** — real handwriting, made-up values — which is exactly why
they can live in the repo at all.

Two things worth keeping from that:

1. **State the correction in the document, do not quietly delete the
   finding.** `issues.md` now says what it claimed, that it was wrong, and
   why. A reader who saw the earlier version needs to know it was
   withdrawn, and a reader who did not still benefits from knowing the
   question was asked and answered.
2. **The forward-looking half survived and was worth having.** The pilot
   has not run yet. When it does, `handleExport` downloads an `.xlsx`
   containing every student's ID, serial and marks — and the Results screen
   explicitly tells the instructor to check it against their attendance
   sheet, which is precisely how that file ends up sitting next to the
   repo. Nothing ignored `*.xlsx`. That rule is now in `.gitignore`,
   deliberately added *before* the pilot rather than after, because it is
   the one item on the whole list whose cost changes character with time:
   a `.gitignore` edit today, a history rewrite once a real class's export
   has been committed.

---

## Fixing the audit — five passes, and what each one taught

38 of the 49 findings are closed. The interesting part is not the count, it
is that grouping the work by **what a fix actually touches** kept producing
better decisions than working down the list by severity would have.

### Pass 1: the frontend (12 findings)

The ones fixable without the backend. Four of them were violations of rules
CLAUDE.md already stated as load-bearing, which is the lesson from the
previous section made concrete.

Two are worth reading the code for.

**The serial fix needed a database migration, and nearly did not get one.**
Normalizing on write is one line:

```ts
await db.put('records', { ...record, serial: normalizeSerial(record.serial) });
```

But records saved *before* that line existed still held `"007"`. Half the
index normalized and half not is arguably worse than neither, because the
lookup now misses exactly the older records a returning instructor most
needs matched. So the fix is really three things — normalize on write, query
normalized, and a **DB v3 migration** that rewrites what is already there:

```ts
if (oldVersion < 3) {
  const store = transaction.objectStore('records');
  store.openCursor().then(function migrate(cursor) {
    if (!cursor) return;
    const normalized = normalizeSerial(cursor.value.serial);
    if (normalized !== cursor.value.serial) {
      cursor.update({ ...cursor.value, serial: normalized });
    }
    return cursor.continue().then(migrate);
  });
}
```

**An existing test had to change, and that was the signal it was right.**
`Review.test.tsx` asserted a saved serial of `'07'`. It had been *pinning
the bug*. When a fix breaks a test, the first question is which of the two
is wrong — here the test was encoding the defective behaviour as expected.

**The blob-URL fix has a trap in it worth knowing about.** The obvious
version — release each preview as soon as its scan is saved — silently
breaks harvesting, because `Review.commitSave` re-fetches that same blob URL
to send the crop *after* `onSaved` returns. So `releasePreview` is called on
Retake and dismiss, never on save. A cleanup that frees a resource someone
else is about to read is worse than the leak.

### Pass 2: pairs (11 findings) — and the technique worth stealing

These were the findings whose fix spans both sides of the wire. Doing one
half is sometimes *worse* than doing neither, because it creates the
appearance of a fix.

The clearest case: bounding the quiz config. The frontend half went in
during pass 1 (`MAX_QUESTIONS` and friends in `validateConfig.ts`), which
makes the form unable to *produce* a bad config — while the endpoint still
*accepted* one from any caller. Anyone reading the frontend would conclude
the problem was solved.

Fixing the backend half means the same three numbers exist in two languages,
which is a drift waiting to happen. They cannot be shared. So:

```python
def _ts_const(name: str) -> float:
    """Pull `export const NAME = <number>;` out of the TypeScript source."""
    source = VALIDATE_CONFIG_TS.read_text()
    match = re.search(rf"export const {name}\s*=\s*([0-9.]+)\s*;", source)
    assert match, f"{name} not found in {VALIDATE_CONFIG_TS.name} — was it renamed?"
    return float(match.group(1))
```

**A Python test that reads the TypeScript file and fails if the numbers
disagree.** Verified by changing one side alone and watching it go red. It
is slightly odd-looking, and it is the only thing that actually prevents the
drift — a comment saying "keep these in sync" prevents nothing.

The same shape showed up in `deploy.sh`. The `ALLOWED_ORIGINS` fix means the
Lambda's environment is set *twice* — once at create/update, once after
CloudFront exists — and `update-function-configuration` **replaces** the
environment rather than merging into it. Two hand-maintained copies of that
variable list would mean the second call silently dropping whatever the
first knew about. So there is one `lambda_env()` function and the list
appears exactly once in the file. The fix would otherwise have introduced
the very class of bug it was fixing.

**Where the audit's own suggestion was wrong.** The finding for the path
traversal said to sanitize the `value`. That fixes the instance. The fix
that survives the next field being added is to sanitize inside `add()` —
the single funnel every field passes through — *and* to assert containment
in the store:

```python
root = self.root.resolve()
if not dest.resolve().is_relative_to(root):
    raise ValueError(f"harvest key escapes the store root: {key!r}")
```

Because "no crop is written outside the root" is the property that matters,
and it should not depend on every present and future caller escaping its
own strings correctly. The original bug was *exactly* a caller forgetting.

### Pass 3: the hot path (2 findings) — demonstrate, don't reason

`read_id` classified blank cells. The reasoning was sound: `_to_canvas`
thresholds with `THRESH_OTSU`, Otsu always splits a histogram including a
unimodal one, so blank paper produces "ink" that gets classified.

Sound reasoning is not evidence. So I ran the real blank grid through the
recognizer with the new gate bypassed:

```
WITHOUT the gate: student_id='??????4'   ← a fabricated 4, from paper noise
WITH the gate:    student_id='???????'
```

That `4` cleared **both** the 0.75 confidence floor and the 0.6 margin
floor. On the one field with no arithmetic check behind it. Two minutes of
work, and it turns "this could happen" into "this does happen", which is a
completely different sentence to put in a commit message.

**Calibrating the gate went wrong first, and a test caught it.** The first
version measured *total ink* — separated 168 filled cells from 7 blank ones
perfectly — and still let a drawn speck through, because total ink sums
scattered noise. Counting the **largest connected component** instead fixes
that and asks the same question `segment_cell` already asks of a mark cell.

Two smaller things from the same pass, both found by my own tests rather
than by reading:

- `has_ink` returned a **numpy** bool, so `assert has_ink(x) is True`
  failed. `np.bool_` works in an `if`, which is why it survived until an
  identity check.
- A test I wrote asserted a speck is not a digit. It failed, and the test
  was wrong: every real blank cell in the set scores 0.0–0.00041, so a
  13-pixel ink blob at full contrast simply does not occur on blank paper. I
  had invented the case. The rewritten test documents the real boundary
  instead — a cell with ink in it is not empty, and whether that ink is a
  *digit* is the classifier's question.

**And a harness that measured the wrong thing.** `cnn/accuracy.py` called
`predict_digit` directly, so it did not run the new gate. An accuracy
harness that evaluates a different code path than production is how a
measurement stops meaning what its number says. It runs the gate now; the
numbers are unchanged (91.8% / 55.2%), which is itself the evidence that the
gate costs nothing on real data.

### Pass 4: the cnn path (4 findings) — and one fix deliberately not made

`decode_value` compared whether a decimal point *existed*, discarding its
index. Fixing it exposed a wrong test: `has_decimal_at=0` for `4.5`, an
input the real pipeline never produces. I verified against an actual
`segment_cell` run before touching it — `[digit, decimal, digit]` yields
index 1 — rather than trusting my reading. **When your change breaks a test,
check the test against reality before you change either one.**

The interesting decision was **N17, which I chose not to fix in the code**.
Re-harvesting the same crop under a different label leaves both labels in
the corpus. The obvious fix is to look for a conflicting key before writing.
That requires widening `Store` beyond its single `put` method — and the
narrowness is deliberate, because a store that can list and delete invites
code that lists and deletes.

So: I checked the real corpus first (229 crops, 229 distinct
`(field, digest)`, **zero conflicts**), and put the detection in
`fetch-crops.sh`, where crops are assembled for training — the moment it
would actually matter, alongside the balance warnings already there.

**Not every finding's fix belongs in the code that has the bug.** Sometimes
it belongs where the consequence lands.

### Pass 5: the "dormant" four — a priority inversion worth internalising

Four findings only fire on `RECOGNIZER=remote` or `=both`. On severity they
were the lowest-priority group in the register. They were the most urgent
work on the list, and the reason is a dependency nobody had written down:

**step 3r.6's outstanding comparison run *is* `RECOGNIZER=both`.**

So all four activate the moment that run starts, and two of them damage it:

- The Tesseract fallback discarded correctly-read digits (its acceptance
  check tested membership in a map whose keys are all letters). Run the
  comparison with that in place and the CNN is measured against an
  **artificially depressed baseline** — and the result would have looked
  entirely convincing.
- `comparison_log/` wrote both recognizers' full student IDs, in scan order,
  with timestamps. That run is meant to happen *during a real class*.

The second is now logged as a *difference* rather than a value:

```python
if field == ID_FIELD:
    entry["difference"] = _id_difference(cnn_value, remote_value)
else:
    entry["cnn"], entry["remote"] = cnn_value, remote_value
```

Positions and counts, never the digits. Serial and marks still log values —
they identify nobody without the attendance sheet, and on that path they
have already gone to Gemini. That is plan.md §12's line, applied.

**Severity ranks how bad a finding is. It does not rank when to fix it.**
What you are about to do next changes the order.

---

## Deploying it — and a document that could never have worked

Redeploying with all of the above was mostly uneventful, which is the point
of `deploy.sh` existing. Three things are worth keeping.

### Proving the deploy actually shipped your code

Every Docker layer reported `CACHED`, including `COPY app/` and `COPY cnn/`
— after a session that changed most of `app/`. That looks exactly like the
failure where the new code does not ship.

It was fine: `preflight.sh` builds the same image from the same context
minutes earlier, so the cache was populated with the current source. But
"it's probably fine" is not verification, and the smoke test cannot help —
**old code returns a valid scan too.**

So verify with something only the new code does. The config validators are
perfect for it, because their whole job is rejecting what the old code
accepted:

```
totalMax mismatch  → 400  "totalMax (25.0) must equal the sum of question maxima (10.0)"
out-of-order q     → 400  "questions must be numbered 1..2 in order, got [2, 1]"
max: 1e9           → 400  "Input should be less than or equal to 100"
```

A 200 or a 500 on any of those means the old image is still serving. **Pick
a behaviour that differs, not a behaviour that works.**

### The permission that looked like a one-line change

The crops-retention fix put an S3 lifecycle call in `deploy.sh`. It needs
`s3:PutLifecycleConfiguration`, which the least-privilege deploy policy does
not grant, so the reflex is to add it.

That reflex is wrong here, and the reason is worth sitting with:
**`PutLifecycleConfiguration` is a delayed delete.** Whoever holds it can
schedule every harvested crop for expiry. `aws/README.md` states this user
has no delete permissions beyond `DeleteObject` — adding the grant would
have quietly made that false, on a key that exists to be used routinely.

And the call did not need to be there at all. A lifecycle rule is *one-time
bucket configuration*, not per-deploy state — the same kind of thing as
`put-public-access-block`, which is why that one already sits inside
`deploy.sh`'s create-only block. So the rule is set once by an admin, the
policy grants only the **read**, and `preflight.sh` checks it:

```
Crops retention
  ✓ crops expire after 365 days
```

That check is not decoration. `Setup.tsx` tells the instructor their
students' crops are *"deleted automatically after a year"*. A manual step
can be forgotten; forgetting this one means the app makes a promise the
infrastructure does not keep — the same shape of defect step 11.5 already
corrected once. **When you move something out of automation for a good
reason, add the check that catches you forgetting it.**

### Documentation that had never been executed

Applying the policy change failed:

```
LimitExceeded: Maximum policy size of 2048 bytes exceeded
```

`aws/README.md` documented `aws iam put-user-policy`. An **inline** user
policy caps at 2048 bytes; this policy is ~3.8 KB compact. **The documented
setup could never have worked for a policy this size** — and the policy has
only grown.

Nothing was broken. The real account had been set up with a *managed*
policy all along; the document and the account had simply never been
reconciled. It surfaces only when someone follows the instructions, and that
happens once, at the beginning, by the person who already knows what they
meant.

That is the whole lesson. Code you don't run is untested; **documentation
you don't execute is untested in exactly the same way, and setup
documentation is executed once, ever.** Corrected to
`create-policy` + `attach-user-policy`, plus the three traps in updating one
that the original had no reason to know about: a new version does nothing
without `--set-as-default`, AWS allows only five versions, and IAM is
eventually consistent — the permission check immediately after publishing
still returned `AccessDenied`, and passed about ten seconds later.

---

## The first live session — what only real use could find

Grading real scripts on the deployed URL produced four findings in one
sitting, after two desk audits had read every file in the repo. None of them
could have been found by reading.

### The reported cause was not the cause

> "Identification of numbers with preceding 0 like 02, 04 not working in
> most cases."

Entirely plausible: a `0` next to another digit, maybe merging in
segmentation. The obvious response is to go tune segmentation, or lower the
serial confidence floors.

Measuring first says something different:

```
true=07   0(c=1.00,m=1.00)  7(c=0.78,m=0.67)  -> WHOLE FIELD BLANKED
true=02   0(c=1.00,m=1.00)  2(c=1.00,m=1.00)  -> ok
true=05   0(c=1.00,m=1.00)  5(c=1.00,m=1.00)  -> ok
```

**The leading zero is the most reliable glyph in the field** — 1.00
confidence in six of seven cases. What fails is `decode_serial`'s rule that
*any* uncertain glyph returns `None` for the whole field. In `07`, a
perfectly-read zero was discarded because its partner scored 0.78.

The instructor sees an empty box where a `0`-leading serial should be and
concludes the zero failed. The report was an accurate description of the
symptom and a wrong description of the cause — which is the normal case for
a bug report, and the reason to reproduce before fixing.

Note the contrast with the ID, which handles this correctly: `read_id`
returns `12?4567` and you fix one character. The serial vanishes entirely.
Same project, same model, two different answers to "what do we do with
partial confidence" — and the field that degrades gracefully is much nicer
to use.

### The fix that felt obvious and was wrong

If correct reads are being flagged away, lower the floors. Swept against the
same data:

| floors | reads | correct | **confidently wrong** | correct-but-flagged |
|---|---|---|---|---|
| 0.90 / 0.80 (current) | 11 | 11 | **0** | 3 |
| 0.75 / 0.60 (the ID's) | 14 | 13 | **1** | 1 |

Two extra reads, at the cost of the zero-confidently-wrong bar this field
currently *meets*. A wrong serial silently mislabels a script's position and
corrupts the identity cross-check; a blank one is flagged and retyped in two
seconds.

So the floors stay. I had written in `cnn/thresholds.py` that they were
"the first numbers to revisit" — the measurement says that note is wrong,
and it is recorded as needing correction. **A hypothesis written into a
comment is still a hypothesis.**

### The workaround that poisons the training data

A student writes `7` where the maximum is 5. Verified end to end:

- `decode_value` scores only *legal* values, so nothing matches and it
  returns `None` — blank plus a flag. Correct.
- Review refuses `7`: `isLegalValue(7, 5)` is false, Confirm is blocked.
- Leave it blank and `harvest()` skips the crop entirely. Also correct.

Now the third path. To get past the block, the instructor types a legal
value — say `5`. The crop of a handwritten **7 is harvested labelled `5`**.
`harvest()` labels with the confirmed value and cannot know the ink
disagrees.

Three individually correct behaviours composing into corpus poisoning. And
it is **self-selecting for the worst cases**: it fires exactly where a
student produced something unusual, which is what a fine-tuning run weights
most heavily.

The fix is not to allow `7` — an out-of-range mark is a grading error, and
surfacing it is right. It is that `decode_value` already knows the
difference between "blank cell" and "glyphs present, no legal value
matches", and throws that distinction away by returning `None` for both.
Keep it, and you can both tell the instructor what happened *and* refuse to
harvest a crop whose ink corresponds to no legal label.

### The failure you cannot debug

`table_not_found` fired several times during live scanning. Detector tuning
is step 1's job and needs real photos — and there are none, because the
backend is stateless by design and the log deliberately records facts rather
than content. A live failure leaves a log line and no image.

This is a genuine tension rather than an oversight. `debug_uploads/` was
deleted in step 11.0.1 precisely because retaining whole scripts is the
thing this project will not do, and that decision stands. So the cheap
honest answer is out-of-band: save the failing photos off the phone by hand
and add them to `testset/`. Anything automated means storing whole scripts
server-side and needs its own disclosure — **do not build it as a
convenience.**

### The pattern across all four

Two desk audits read every file and found 45 things. One person grading real
scripts for twenty minutes found four more, two of them High, and one of
them (the harvest poisoning) a composition of three behaviours that are each
individually correct — which is precisely the kind of defect reading cannot
find, because no single file is wrong.

Reading finds broken parts. Using finds broken systems.

---

## Step 12 — Class-list workbook round trip (all four phases done)

Everything above this point is the app reading a script and producing
marks. This step is the first time the app reads something *from* the
instructor rather than just a photo — an optional upload of their own
semester marksheet, so results land in the file that already has the class
list and every earlier quiz in it, instead of a new standalone `.xlsx`
each time.

It started from a feature note (`File Upload.md`) written in a separate
claude.ai conversation and brought into the repo, plus a real file:
`Course CSE211L  Section 1 Marksheet.xlsx`, 16 students, gitignored,
never committed. The note got most of the shape right — content-based
sheet detection instead of trusting a name or tab position, never silently
overwriting, sanitising a sheet name before writing it — but several of
its specifics were wrong for this codebase, and two of its own design
choices turned out to be unsafe once combined with a decision made *after*
the note was written. Both are worth reading as a pair, because the second
one is a genuinely instructive bug that got caught before any code existed
for it.

### What "the roster" actually looks like

Before designing anything, the real file got opened with the exact library
this app already ships (ExcelJS 4.4.0), not assumed from the note's own
snippets:

```javascript
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(fs.readFileSync('Course CSE211L  Section 1 Marksheet.xlsx'));
// one sheet, "data"; header on row 1: SL | STUDENT ID | STUDENT NAME
// 16 students, IDs stored as TEXT ("1722112"), no formulas, no styling
```

Two things from this shaped everything downstream. First, the header sits
on row 1 in this file, but nothing should assume that — a title row above
the real header is a completely normal thing for a workbook to have, so
the header is found by *scanning*, not by reading row 1 directly:

```typescript
// roster.ts
export function findRosterHeaderRow(ws: Worksheet, maxRows = HEADER_SCAN_ROWS): HeaderMatch | null {
  const limit = Math.min(maxRows, ws.rowCount);
  for (let r = 1; r <= limit; r++) {
    const columns = new Map<string, number>();
    ws.getRow(r).eachCell((cell, colNumber) => {
      const key = canonicalKey(cell.value);
      if (key) columns.set(key, colNumber);
    });
    if (columns.has('STUDENTID') && columns.has('STUDENTNAME')) {
      return { row: r, columns };
    }
  }
  return null;
}
```

Second, IDs are stored as text in *this* file, but a quick test proved
Excel doesn't guarantee that — typing `212345` into a numerically-formatted
column stores the number `212345`, silently dropping a leading zero a
student actually has. `roster.ts` recovers it for *comparison only*,
never for what gets written back:

```typescript
export function normalizeIdForMatch(raw: unknown, idDigits: number): string | null {
  const text = cellText(raw).trim();
  if (text === '') return null;
  if (/^\d+$/.test(text) && text.length < idDigits) {
    return text.padStart(idDigits, '0');
  }
  return text;
}
```

`212345` (6 digits, idDigits=7) normalizes to `0212345` for matching, but
the roster's own `studentId` field stays `212345` — whatever the
instructor's file actually contains is what gets written back, verbatim,
everywhere. Normalizing a value you're about to store instead of one
you're about to compare is the same category of mistake as storing a
computed sum instead of deriving it (step 9's own rule) — the two
representations drift the moment either side is edited independently.

### The bug caught before any code existed for it

The hardest design question was: given a workbook that could look like
almost anything, which sheet is the class list? Position can't be trusted
— a dragged tab shouldn't change the answer. Content can't be trusted
alone either, because the exam sheets *this app itself writes* also carry
`STUDENT NAME` (a deliberate choice — see Phase B below), so a written
exam sheet is itself a valid-looking roster.

The first draft of the rule read like this: *prefer the first visible
sheet, if it independently has a `STUDENT ID` + `STUDENT NAME` header;
otherwise fall back to content, excluding anything that also has the full
exam-sheet shape (`Total` + a `Q<n>` column + `Serial`, together)*. Written
down, in that order, it reads reasonably — try the instructor's own
convention first, fall back to a smarter check second.

It's wrong, and the way to see why is to actually build the adversarial
case rather than reason about it in the abstract: take a workbook with the
real roster plus one exam sheet already written into it (with a name on
it, per the Phase B decision below), and drag that exam sheet's tab to the
front.

```javascript
// reproduced directly, before writing roster.ts for real
const wb = rosterWorkbook();
addExamSheet(wb, 'Quiz 1');  // has STUDENT ID + STUDENT NAME + Total + Q1 + Serial
// ...rewrite the workbook's own <sheets> XML order so "Quiz 1" comes first...
console.log(back.worksheets[0].name); // "Quiz 1" — confirmed, the reorder worked
```

Under the first draft's rule, "prefer the first visible sheet if it
independently passes the header test" runs *before* the exam-sheet
exclusion ever gets a chance to fire — "Quiz 1" has `STUDENT ID` +
`STUDENT NAME`, so it passes the header test, so it wins the position
check, full stop. The exclusion is never consulted, because the first
check already returned an answer. That's the exact bug this whole design
exists to prevent: a written exam sheet silently mistaken for the class
list.

The fix inverts which check is unconditional:

```typescript
// roster.ts — analyzeWorkbook, the corrected order
const rosterShaped = allCandidates.filter((c) => !c.looksLikeExamSheet); // EXCLUDE FIRST, always

if (rosterShaped.length === 1) {
  return { candidates: rosterShaped, ambiguous: false, chosenSheetName: rosterShaped[0].sheetName };
}
// position only breaks a tie AMONG SURVIVORS, never bypasses the exclusion above
const firstVisibleName = workbook.worksheets.find((w) => (w.state ?? 'visible') === 'visible')?.name;
const preferred = rosterShaped.find((c) => c.sheetName === firstVisibleName);
```

Exclusion runs first, unconditionally, on every candidate. Position is
only ever a tiebreaker among whatever survives it — it can never resurrect
something the exclusion already threw out. Re-running the same dragged-tab
scenario against this version resolves to `data`, correctly, regardless of
where "Quiz 1" sits in the tab order. That test is now permanent
(`roster.test.ts`'s "still excludes the exam sheet after its tab is
dragged to the front"), specifically so nobody "cleans up" the ordering
back to the more intuitive-looking first draft later.

The general lesson, and it's the same one step 3r.6's confidence floors
and step 1's orientation check both already taught in their own ways:
**an order-dependent rule is a hidden design decision, and the only way to
know if you picked the right order is to build the case where it
matters.** Prose describing "exclude, then prefer" and prose describing
"prefer, then exclude, with an exception" read almost identically. Only
one of them survives contact with a dragged tab.

There's still a third layer on top of both, and it's not decoration: even
the *corrected* rule is a heuristic, not a proof, so every pick — however
confident — is shown to the instructor before it's trusted: "Class list:
`data` — 16 students · Change." Deliberately, no marker is written into
the workbook to skip that confirmation on a later upload; four mechanisms
that would have survived a re-save (a defined name, a hidden sheet, a
print-footer string, workbook properties) were all verified working and
declined anyway, because the goal was "confirmed every time," not "right
often enough to stop checking."

### Phase A — reading the roster in

`Setup.tsx` gained a mode toggle — Plain download (unchanged) or Use my
class marksheet — and everything below it only exists in the second mode.
Getting ExcelJS there without slowing down the screen every instructor
sees first (unlike Results, which is already lazy-loaded as a whole
screen) meant a dynamic import triggered by the file input itself, not by
the component mounting:

```typescript
async function handleWorkbookFile(file: File) {
  const buffer = await file.arrayBuffer();
  const ExcelJS = (await import('exceljs')).default;   // only loaded once a file is actually chosen
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const analysis = analyzeWorkbook(workbook);
  // ...
}
```

Checked at the build level rather than trusted: `vite build` puts
`exceljs.min-*.js` in its own 929 KB chunk, shared with Results' existing
lazy-load, and it is entirely absent from the 225 KB main bundle Setup
itself ships in. A claim about what does or doesn't load is only worth as
much as the build artifact that backs it.

Re-parsing is reactive to `idDigits`, not one-shot at upload — since
`normalizeIdForMatch` depends on it, changing the digit count after
uploading re-derives the match keys against the *already-loaded* workbook
rather than requiring a second upload:

```typescript
const parsedRoster = useMemo(() => {
  if (!workbookState || !effectiveSheetName) return null;
  return parseRosterSheet(workbookState.workbook, effectiveSheetName, idDigits);
}, [workbookState, effectiveSheetName, idDigits]);
```

Before trusting any of this against a synthetic test shape, it ran once
against the real file directly, through the actual shipped functions:

```
candidates: [{"sheetName":"data", ..., "studentCount":16}]
chosenSheetName: data | ambiguous: false
student count: 16
duplicateIds: []
first 3: Monem Tazwar, Salman Noor, Sadikun Nahin Prova
```

16 students, correctly and unambiguously identified, names and IDs intact.
The file was never committed and never became a test fixture — the 30
cases in `roster.test.ts` build workbooks in memory with ExcelJS the same
way this verification did, so the suite proves the *logic* without ever
needing a real person's data in git history.

### Phase B — writing the sheet back out

The exam sheet itself is `examSheet.ts`, and it's deliberately pure — no
ExcelJS at all, just roster + records + config in, rows out. Matching is
on student ID only, using the *same* `normalizeIdForMatch` roster parsing
already uses, so a record and a roster row agree on what counts as "the
same ID" without the rule being written twice:

```typescript
const key = record.studentId ? normalizeIdForMatch(record.studentId, config.idDigits) : null;
if (key && rosterKeys.has(key)) {
  // matched — this record belongs to a roster row
} else {
  // no studentId at all, or an ID matching nobody — surfaced, never dropped
}
```

A roster student nobody scanned gets a row with genuinely blank cells,
never `0` — the exact same worst-case-failure rule step 9 already
enforced for the plain export, now extended to a second writer rather than
reinvented for it. A script that *was* scanned but matches nobody on the
roster is appended below the roster block instead of silently vanishing.
And two records matching one roster student are detected and reported
(`.duplicates`) even though nothing acts on that report yet — the row
still needs *something* in it today (the most recently confirmed record
wins), and step 12.12's own future job is to block the export over this
rather than silently pick one. Recording the fact now, even unused, means
that later step doesn't need to rebuild the matching pass to get it.

The ExcelJS-touching half, `workbookExport.ts`, exists mainly because
Excel's own sheet-naming rules turned out to be stricter — and different
— from what the source note assumed. Rather than write a sanitiser from
documentation, the actual library was made to throw:

```javascript
wb.addWorksheet("Quiz:1")   // throws: cannot include : \ / ? * [ ]
wb.addWorksheet("'Quiz'")   // throws: first/last char can't be a single quote
wb.addWorksheet("DATA")     // throws: already exists — checked CASE-INSENSITIVELY
```

The note's own sanitiser handled the character list but missed the
apostrophe rule and compared collisions case-sensitively — both would have
let a name through that ExcelJS itself then rejects, turning a full export
attempt into an unhandled exception on the one screen where that matters
most. `findSheetCollision` compares names the same way ExcelJS does:

```typescript
function sheetNameExists(workbook: Workbook, name: string): boolean {
  return workbook.worksheets.some((ws) => ws.name.toUpperCase() === name.toUpperCase());
}
```

One collision case gets a stricter rule than the rest: if the *class-list
sheet itself* is what collides, Overwrite is never offered, full stop —
only Rename or Cancel. Losing 16 students' names to a mis-tap because a
quiz happened to be named the same as the roster sheet has to not be
reachable, not just unlikely.

**Idempotency — exporting the same quiz twice producing one sheet, not
two — needed no special-case code at all**, once one thing was gotten
right: every export reloads a *fresh* `ExcelJS.Workbook` from
`rosterUpload.workbookBytes`, the original upload, untouched, rather than
reusing a workbook instance kept around in component state between
clicks:

```typescript
async function handleWorkbookExportClick() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(rosterUpload.workbookBytes);  // fresh, every single time
  // ...
}
```

Two exports in one session are two independent builds from the same
starting point, each producing its own downloaded file with exactly one
`Quiz 1` sheet in it. The "idempotent" property isn't a rule enforced
somewhere — it falls out of never mutating the one piece of state that
would otherwise accumulate.

### Proving it outside the test suite

Both roster.test.ts and workbookExport.test.ts build workbooks in memory
and pass comfortably — 51 new cases between them. But a synthetic
workbook only ever tests the shapes someone thought to construct. Before
calling Phase B done, the actual production code ran once against the real
file, then that *output* was piped through a real `soffice --headless
--convert-to xlsx` — not a library simulating LibreOffice, the actual
program — and reloaded to check what survived:

```
$ soffice --headless --convert-to xlsx --outdir out/ phase-b-export.xlsx
convert phase-b-export.xlsx -> out/phase-b-export.xlsx using filter: Calc Office Open XML
```

```typescript
expect(wb.worksheets.map((w) => w.name)).toEqual(['data', 'Quiz 1']);
expect(wb.getWorksheet('data')!.rowCount).toBe(17); // untouched: header + 16 real students
expect(qs.getRow(3).getCell(4).value).toBeNull();   // unscanned student — still genuinely blank
```

Both sheets present, the class list's 16 rows exactly as they were, and an
unscanned student's marks still `null` rather than `0` after a real
external program opened and re-saved the file. This is the same
discipline the harvest-mtime fix used back in step 11 ("proving the leak
instead of believing the write-up") applied to a different question: a
library round trip proves the library behaves; only a real application
opening the real output proves the *file* is actually fine. The
verification script itself was never committed — the point was the
evidence, not a permanent fixture built on a real person's data.

### Phase C — the ID field asking a different question than "is it legible"

Phases A and B answer questions about a *file*: which sheet is the class
list, what should the exam sheet contain. Phase C answers a question about
a *value* being typed or corrected right now: does this student ID belong
to anyone on the list, and — the harder part — if it doesn't, is there
exactly one person it's plausibly a misread of?

That "exactly one" is doing all the work, and it's worth being precise
about why. A recognizer's confidence already tells the instructor *this
digit might be wrong*; a class list can additionally tell them *and here's
what it probably should have been* — but only when there is one candidate,
never the closest of several. Suggesting the nearer of two equally-plausible
students would be swapping a visible uncertainty (a flagged digit) for an
invisible one (a suggestion that looks like a fact). So `rosterMatch.ts`
returns a suggestion only when filtering the roster down leaves exactly one
name, for two different filters that turned out to be the same idea in two
guises:

```typescript
// one full ID, one digit different from a real student's — Hamming
// distance, not edit distance, because a scanned ID is always a FIXED
// width (the recognizer never inserts or drops a position)
function hammingDistanceIsOne(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let differences = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) differences += 1;
    if (differences > 1) return false;
  }
  return differences === 1;
}

// a PARTIAL read — "1722112" scanned as "172211?" — where '?' is a
// wildcard rather than a wrong digit; every real recognizer path already
// produces exactly this shape for a position it couldn't read at all
function matchesWildcardPattern(pattern: string, key: string): boolean {
  if (pattern.length !== key.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '?' && pattern[i] !== key[i]) return false;
  }
  return true;
}
```

Both filters, then the same rule on the result: `candidates.length === 1
? candidates[0] : null`. A fully-wrong ID and a partially-unread one look
like different problems from the recognizer's side, but from the roster's
side they're the same question — "how many students are consistent with
what I do know" — asked with two different shapes of "what I do know."

Two-student test rosters can't actually prove the "unique" part means
anything, though — with only two names, almost anything looks unique by
default. Before trusting this, it ran against the real 16-student roster
directly:

```
misread candidate: {"status":"not-on-list","suggestion":{"studentId":"1722112","studentName":"Monem Tazwar"}}
bogus candidate:   {"status":"not-on-list","suggestion":null}
partial candidate: {"status":"not-on-list","suggestion":{"studentId":"1722112","studentName":"Monem Tazwar"}}
```

A real single-digit misread and a real partial read both resolved to the
correct, unique student; a genuinely made-up ID got no suggestion at all,
confirming that none of the other 15 real IDs happened to sit one digit
away and produce a false positive. The *ambiguous* case — two roster
students each one digit from the same wrong reading, or each consistent
with the same partial one — is still only reachable by construction (a
16-name class is unlikely to contain it by chance), so it's covered by a
deliberately-built test rather than left to hope:

```typescript
it('offers no suggestion when two roster students are each one digit away', () => {
  const twoClose = /* 1111111 and 1111112 */;
  const result = matchAgainstRoster('1111110', 7, twoClose); // one digit from BOTH
  expect(result).toEqual({ status: 'not-on-list', suggestion: null });
});
```

Wiring this in touched three screens without touching their tests. Every
new prop — `roster` on `Scan`/`Review`, the already-existing `rosterUpload`
on `Results` — is optional and defaults to `null`, so the 36 pre-existing
render calls across `Scan`/`Review`/`Results` tests needed no edits at all;
plain mode is what happens when nothing was ever passed, not a separate
code path that has to be kept in sync with the roster-aware one. The
suggestion itself is applied through the exact same `editIdentity` helper
every manual correction already goes through:

```typescript
<button onClick={() => editIdentity(setStudentId, rosterMatch.suggestion!.studentId)}>
  Use this
</button>
```

which matters for a reason that isn't about the ID field at all: `editIdentity`
also clears a pending duplicate-conflict banner, because a corrected ID can
change which existing record it conflicts with. Accepting a roster suggestion
is, mechanically, exactly the same action as retyping the field by hand — so
it gets that same correctness for free, rather than needing its own version
of the same fix.

### A privacy sentence colliding with a validation sentence

Extending Setup's disclosure for the new roster feature surfaced a small,
very literal bug: the new paragraph's wording — "upload your class
marksheet" — overlapped the *existing* blocking-error message ("Upload
your class marksheet, or switch to a plain download."). `Setup.test.tsx`
finds text by regex, and a regex that used to match one element now matched
two, which `findByText` treats as a failure rather than picking one:

```
TestingLibraryElementError: Found multiple elements with the text: /upload your class marksheet/i
```

Nothing about the *logic* was wrong — both sentences were individually
correct. Two people (or two features, both correct on their own) had
written adjacent sentences that happened to share five words, and only the
test noticed, on the first run, before either one shipped. The fix was
just rewording the newer sentence ("using your own class-list workbook"
instead), but the reason it's worth writing down is the general shape:
prose written for a human to read and text matched by a test are the same
string, and a codebase with enough of both eventually needs one sentence
to avoid echoing another on purpose, not by luck.

### Phase D — the bug that only showed up once something actually wrote back

Phase D is reconciliation: tell the instructor who's missing before they
export, refuse to export at all over a duplicate, and — the one genuinely
new capability — let a quiz's totals land as a column in the class list
itself, not just in its own sheet. That last piece is what turned a latent
design gap into a real bug, caught before it ever shipped.

`RosterStudent` — the shape `roster.ts` hands back for every student on the
list — carried `sl`, `studentId`, `studentIdKey`, `studentName`. Nothing
about *which row of the actual spreadsheet* that student sits on. Nothing
needed it before Phase D: Phases A through C only ever read the roster,
never wrote back into it. The natural-looking way to write a totals column
would be `headerRow + 1 + i` for the i-th student — and that's exactly
right, provided every row between the header and that student has a
student on it.

It doesn't hold the moment there's a gap. `collectStudentRows` (the same
function that turns worksheet rows into `RosterStudent`s) already skips any
row with a blank `STUDENT ID` cell — a row a teaching assistant might
leave for a withdrawn student, say. Skip one row, and every student below
it is one row higher in the array than they are in the actual file. Write
a totals column by position and the third student's total lands next to
the fourth student's name.

Caught by asking the same question this project keeps coming back to:
*what does this look like as an actual test, not a description?*

```typescript
it("carries each student's REAL sheet row, surviving a skipped blank row in between", async () => {
  const wb = rosterWorkbook([
    ['SL', 'STUDENT ID', 'STUDENT NAME'],
    [1, '1722112', 'A'],       // row 2
    [2, '', 'skip me'],        // row 3 — blank, skipped
    [3, '2130643', 'B'],       // row 4, NOT row 3
  ]);
  const result = parseRosterSheet(await roundTrip(wb), 'data', 7);
  expect(result.students.map((s) => s.row)).toEqual([2, 4]);
});
```

The fix is a field, `RosterStudent.row`, set once during parsing from the
row `collectStudentRows` was already iterating, and used everywhere a
totals write needs to target a real cell:

```typescript
// workbookExport.ts — writeTotalsColumn
result.rosterRows.forEach((row, i) => {
  ws.getRow(roster.students[i].row).getCell(col).value = row.total;
});
```

`i` still indexes into the array — `result.rosterRows[i]` really does
correspond to `roster.students[i]`, because `buildExamSheet` builds both by
mapping the same array in the same order. What changed is that the *sheet
row* comes from the student's own recorded position, never from doing
arithmetic on `i`. Adding this one field cost nothing else — every
existing test comparing a `RosterStudent` literal needed one extra
property, mechanically, and nothing about the matching or exam-sheet logic
changed at all.

The test above guards the parsing layer. A second one guards the point
where the bug would have actually done damage — writing to the wrong cell
in a real worksheet:

```typescript
it('writes to each student\'s real sheet row, surviving a gap earlier in the roster', async () => {
  // ...a workbook with the same gap, header row 1, Monem row 2, a real
  // blank row 3, Salman row 4...
  writeTotalsColumn(wb, gappyRoster, 'Quiz 1', 20, result);
  expect(ws.getCell('D2').value).toBe(9.5);   // Monem's own row
  expect(ws.getCell('D4').value).toBeNull();  // Salman's own row — not D3
});
```

Two tests, two different failure modes of the same root cause: one proves
the *data* survives the gap, the other proves the *write* does too. Either
alone would have missed a bug the other one catches — a `row` field that
parses correctly but gets ignored by the writer is just as broken as one
that never existed.

### Always confirming, never guessing which case applies

Before Phase D, clicking "Export into class marksheet" would sometimes
show a confirm banner (a renamed or colliding sheet) and sometimes just
download straight away — matching this project's general instinct that a
routine action shouldn't need a tap when nothing needs deciding. Phase D's
own requirement — "list who is missing before the download" — means
there's now *always* at least one fact worth showing, so the shortcut had
to go rather than live alongside a second, inconsistent path:

```typescript
// no more "if nothing to confirm, write immediately" branch —
// handleWorkbookExportClick always ends by setting pendingWorkbookExport
setPendingWorkbookExport({ workbook, sanitizedName, nameChanged, collision, result });
```

The panel itself reads as three priority-ordered cases, and the ordering
is deliberate: a duplicate always wins, because writing one student's
marks into another's row is worse than any naming question. Only once
there are zero duplicates does the panel move on to a collision, or —
failing that — a plain confirmation:

```typescript
if (result.duplicates.length > 0) {
  // banner-danger. Names every conflict. Only "Cancel" — no Overwrite,
  // no Continue. The plain "Download Excel" button stays enabled the
  // whole time, exactly as the escape hatch plan.md §17 describes.
}
```

The blocking case has no path forward inside this component at all — the
only way through is to go fix the duplicate in the Results table above
(already editable) and try again. That's a deliberate refusal to offer a
"proceed anyway," the same shape as `crossCheck`'s own block/warn split
from step 7: some conflicts get a choice, and some don't.

### A store that has to remember to forget itself

Persistence (12.14) sounds like it only needs a `save` and a `load`. It
actually needs a third operation, and finding that out came from asking
what happens to last quiz's roster when *this* quiz doesn't have one.

Setup already saves the roster upload the moment a workbook-mode quiz
starts, mirroring how `config` is already saved:

```typescript
if (rosterUpload) {
  await saveRosterUpload(rosterUpload);
} else {
  await clearRosterUpload();
}
```

The `else` branch is the part that isn't obvious from the words "save the
roster when there is one." Picture the actual sequence: Quiz 1 uses a
class-marksheet upload, which gets persisted. Quiz 2, same session, same
browser, instructor picks Plain download instead — nothing in that flow
naturally *removes* Quiz 1's roster from IndexedDB, because nothing ever
called anything that would. It just sits there. Then the browser reloads
mid-way through Quiz 2 (a real phone, a real class — this happens), and
the saved-config quick-start path faithfully restores whatever's in that
store: Quiz 1's workbook, attached to a session the instructor explicitly
chose not to use one for.

`clearRosterUpload()` exists because "skip saving" and "actively remove
what was there before" are different operations, and only one of them
prevents this. The same asymmetry already existed one layer up —
`resetAll()` clears the roster store for the *same* reason `meta`'s source
id survives it, just pointed the opposite way: a class list belongs to one
session, so both "start a genuinely new class" (`resetAll`) and "this
particular quiz doesn't use one" (`clearRosterUpload`) have to actively
say so, not merely fail to say otherwise.

The other place restoration had to be threaded through consistently was
easy to miss for the opposite reason — it looked done already. `onStart`
had carried the roster since Phase A. `onViewResults` (the "View" button
on the saved-session notice, for jumping straight to Results without
scanning anything more) had always hardcoded `null`, because when it was
written there was nothing to restore. Once 12.14 added persistence, that
hardcoded `null` became a second entry point into the same session quietly
disagreeing with the first about whether a roster exists:

```typescript
// App.tsx — before: two entry points into one session, two different answers
onViewResults={(saved) => { setConfig(saved); setRosterUpload(null); ... }}
// after: the same question, answered the same way, from the same source
onViewResults={(saved, upload) => { setConfig(saved); setRosterUpload(upload); ... }}
```

Neither change is complicated. Both are the kind of gap that a feature
built in one pass, by one line of reasoning, tends to leave: the thing
that's obviously needed gets built, and the thing that's needed to *undo*
it, or to reach it a second way, waits for someone to ask "what happens to
the old one" or "what about the other button that does something similar."

### A writer has to survive its own reader

All four phases were marked done, then a person actually used the thing on
a phone and found five more things — three small (a button overflowing a
narrow screen, a file input lying about what was selected, column headers
with no max mark shown), and one that's worth its own telling, because it
almost undid a piece of correctness this whole feature was built around.

The request was simple: show a column's max mark next to its header, the
same way Review already does — `"Total"` becomes `"Total (20)"`. Applying
it to the on-screen table and the plain export is genuinely just that
simple. Applying it to the *exam sheet* — the one this app writes into the
instructor's own workbook, then may need to recognize again on a future
upload — is not, and the reason why is a pattern worth naming: **a piece
of code that both writes a label and later reads that same label back has
to survive its own writing, not just its reading.**

`hasExamSignature` is what decides whether a sheet looks like something
this app already produced — the same check that stops a dragged exam-sheet
tab from being mistaken for the class list, discussed above. It looks for
an exact `TOTAL` key among a sheet's canonicalized headers:

```typescript
if (!columns.has('TOTAL') || !columns.has('SERIAL')) return false;
```

Canonicalizing strips everything but letters and digits and uppercases the
rest. `"Total"` becomes `"TOTAL"` — an exact match. `"Total (20)"` becomes
`"TOTAL20"` — not a match, not even close as far as `===` is concerned.
Ship the header change without touching this check, and the very next
time a workbook this app wrote gets re-uploaded — which is the *normal*
way this feature gets used across a semester, not an edge case — its own
exam sheet would stop registering as exam-shaped. Since exam sheets carry
`STUDENT NAME` by design (step 3r.6's own decision), an unrecognized one
looks exactly like a second, spurious class list: the exact ambiguity the
whole `analyzeWorkbook`/`hasExamSignature` mechanism exists to prevent,
reopened by a change that had nothing to do with roster detection at all.

The two changes don't look related. One is "add text to a header for
readability." The other is "how do I recognize a sheet I wrote." They only
touch because the first one changes what the second one is looking *at*.
Nothing about reading the header-annotation request in isolation would
surface that connection — it only shows up if you ask, specifically,
*what happens when this app re-reads what it just wrote*. That's a
different question from "does this look right on screen," and it's the
one that matters here because the exam sheet is the one output in this
whole feature designed to be consumed by this app itself, later.

The fix is the same shape as the one place this codebase had already hit
this exact problem — the `Q<n>` column pattern already tolerates trailing
noise for an identical reason:

```typescript
// was: columns.has('TOTAL')
// now: tolerates "TOTAL" followed by nothing, or by digits from a
// stripped "(20)" — same reasoning /^Q\d+$/ already uses for "Q1 (5)"
const hasTotal = [...columns.keys()].some((key) => /^TOTAL\d*$/.test(key));
```

Verified two ways, matching this project's own standard for anything
touching detection: a fabricated adversarial case (`"Total Marks Trend"`
canonicalizes to `"TOTALMARKSTREND"`, still correctly fails the pattern),
and the real thing — writing an exam sheet into the actual 16-student
file, then feeding that exact output back through `analyzeWorkbook` and
confirming `data` still comes back as the class list, not the sheet just
written into it.

### What this leaves behind

- Frontend suite: 119 → 238 — 234 across all four phases, plus 4 more from
  the live-phone round above (two for `hasExamSignature`'s widened match,
  one for the file-input display fix, one for a same-name-different-max
  totals column). Four new pure-logic files (`roster.ts`, `examSheet.ts`,
  `workbookExport.ts`, `rosterMatch.ts`, each fully covered on its own),
  plus additions to `db.test.ts` for persistence and to
  `Setup`/`Review`/`Results`' existing component suites for everything
  each phase wired into the screens themselves. Every adversarial case
  discussed across all four phases and the live-testing round — the
  dragged tab, an accumulated `Q1`/`Q2`/`Mid`/`Total` roster, a real
  collision, an ambiguous one-digit-away suggestion, a roster with a
  genuine gap, a workbook re-reading its own annotated headers — is a
  permanent test, not a comment.
- `RosterUpload`/`roster` now threads `Setup.tsx` → `App.tsx` → both
  `Results.tsx` and `Scan.tsx` → `Review.tsx`, survives a page reload via
  IndexedDB, and reaches Results through *either* entry point
  (`onStart`/`onViewResults`) consistently. Plain mode is provably
  unchanged throughout: Phase B's `handleExport` extraction passed its
  existing test unmodified, every new prop across every phase is optional
  with a `null` default, and starting a new quiz in plain mode explicitly
  clears what a previous one may have left in storage rather than leaving
  it to resurface later.
- All four phases have now been checked against the real 16-student
  roster directly, not only synthetic shapes — including, for Phase D
  specifically, a real duplicate and real gaps in coverage, with the
  totals column landing on the exact right row for every one of the 16
  real students. What's left is the one item that has been open since
  Phase A and can't be closed from here: the phone's own file picker and
  download, tried by a person, on a real device — same category as
  camera/PWA verification everywhere else in this project.

## The cleared number field — one character of coercion

Not a step. A bug found the same way step 12's five fixes were: by using
the app on a real phone, after everything was marked done.

**What happened.** On the Setup screen, clear the "Number of questions"
box — it has `5` in it, you delete the 5 — and a `0` appears. Type `10`
after that and you get `010`.

**Why.** One line, in each of three places:

```tsx
onChange={(e) => setIdDigits(Number(e.target.value))}
```

When you delete the last character of an `<input>`, the browser reports
its value as the empty string. And `Number('')` is `0` — not `NaN`, which
is what most people expect, and which would have made this visible
immediately. So the moment the box went empty, React wrote a `0` straight
back into it. The caret was sitting *before* that leftover zero, so the
next digits typed landed after it.

This is a specific hazard of **controlled inputs**. The box does not hold
its own value; React holds it, and re-renders the box from state on every
keystroke. That is normally the point — one source of truth — but it means
any lossy transform in the `onChange` handler is applied to what the user
typed *before they can finish typing it*. `Number()` is lossy for exactly
one input, and it happens to be the one you produce every time you clear a
field.

**The fix** is to let the state say "empty" as a distinct thing from
"zero":

```tsx
type NumField = number | '';

function toNumField(raw: string): NumField {
  return raw === '' ? '' : Number(raw);
}

const [idDigits, setIdDigits] = useState<NumField>(7);
```

`value={idDigits}` renders `''` as an empty box, which is exactly what the
user asked for by pressing backspace.

The interesting half is what happens at the other end. Something
eventually needs a real number, and the temptation is to substitute a
default there — `idDigits || 7`. That would be a quiet lie: a field the
instructor deliberately emptied would validate as though they had typed
something. So the conversion is deliberately to `NaN`:

```tsx
function asNumber(value: NumField): number {
  return value === '' ? NaN : value;
}
```

and nothing else changed, because `validateConfig` was already written to
reject it:

```ts
if (!Number.isInteger(input.idDigits) || input.idDigits < 1) {
  errors.push('Student ID digits must be a positive whole number.');
}
```

`Number.isInteger(NaN)` is `false`. An empty box gets the same message a
`0` or a `2.5` gets. No validation rule was touched — which matters more
than it looks, because those bounds are one half of a pinned pair:
`backend/tests/test_models.py` reads `validateConfig.ts` and fails if
either side moves alone.

**Two knock-ons, handled rather than found later.** Both are places that
already existed and would have broken quietly under the new `''` value:

```tsx
setQuestionCount(next);
if (next === '' || !Number.isInteger(next) || next < 1 || next > MAX_QUESTIONS) return;
```

The `next === ''` comes first on purpose. The guard after it is issues.md
#1's crash protection — `copy.length = 5.5` throws `RangeError`, and
`while (copy.length < 99999999999) copy.push(5)` hangs the tab — and an
empty string would have slipped past `Number.isInteger` into neither
branch cleanly. And:

```tsx
parseRosterSheet(workbookState.workbook, effectiveSheetName, idDigits === '' ? 0 : idDigits)
```

`0` is not a fallback invented here; it is precisely what that function
already received back when clearing the field produced a `0`. Passing
`NaN` into roster ID normalization would have been a new behaviour smuggled
in under a bug fix.

**What the tests can and cannot show.** Three cases went into
`Setup.test.tsx`. Only one of them fails against the old code — the one
asserting a cleared box is still empty:

```tsx
fireEvent.change(count, { target: { value: '' } });
expect(count.value).toBe('');
```

The other two pin the resize behaviour and the empty-field validation, and
both would have passed before the fix. That is worth being explicit about
rather than letting three green checkmarks imply three caught bugs: jsdom
has no caret, so the exact `010` the user saw cannot be reproduced in a
test at all. The comment in the test file says so. What the suite pins is
the cause; the symptom needed a phone.

Frontend suite: 238 → 241.

## Fixing the two HIGH findings from the first live session — N31, N32, N33

The four findings the first real grading session surfaced (issues.md's
"Start here") sat behind a decision: fix them before step 13, or after.
The answer was before — more sections graded per semester means more
serial reads hitting N32's bug, and a longer collection window for N31 to
quietly poison the training corpus before anyone would notice. Asked how
to handle the fourth (N34), the user chose to defer it rather than pick a
fix direction — recorded as a decision, not an oversight.

### N32 — the serial field was throwing away its best glyph

Reported as "serials with a leading zero mostly don't work." The actual
measurement said something different: a leading zero was the single most
*reliable* glyph in the whole field — 1.00 confidence in six of seven
cases — and it was being discarded anyway, because of its neighbour.

`cnn/decode.py`'s `decode_serial` decoded each glyph independently (there's
no cross-digit constraint for a serial the way there is for a mark's
~11 legal values) and then did this:

```python
for probs in glyph_probs:
    digit, confidence, margin = decide_digit(probs, confidence_floor, margin_floor)
    if digit is None:
        return None, min(min_confidence, confidence)   # <- the whole field, gone
    digits.append(str(digit))
```

One uncertain glyph anywhere in the serial threw the entire read away —
including a `0` at 1.00 confidence sitting right next to it. Measured over
every labelled real serial: 14 of 17 were correct at raw argmax, but only
11 of 17 survived this rule.

The fix is almost embarrassingly small once you see it, because
`app/id_ocr.py`'s `read_id` already solved the identical problem for the
student ID, months earlier:

```python
digits.append(str(digit) if digit is not None else "?")
```

Never discard the field — mark the position and keep going. `"12?4567"`
was already a normal thing for this app to produce and for the instructor
to fix by hand; a serial like `"0?"` is exactly the same shape. That's why
this shipped with **zero frontend changes**: `validateMarks.ts`'s
`isValidSerial` already rejected any string containing `?`, for the same
reason `isCompleteId` already rejected a partial ID — the rule existed,
just nothing on the backend ever produced the value it was written for.

One number that looks tempting and isn't: lowering
`SERIAL_CONFIDENCE_FLOOR`/`MARGIN_FLOOR` from 0.9/0.8 to the ID's own
0.75/0.6 recovers 3 more reads. It also lets a confidently-wrong digit
through, against a bar this field currently meets at zero. The floors
were never the bug — the all-or-nothing rule was — and
`cnn/thresholds.py`'s own comment calling them "the first numbers to
revisit" was itself wrong, corrected in place rather than acted on.

### N31 and N33 — one collapsed distinction, two symptoms

These were specced together because they share a root cause. A student
writes `7` on a question out of 5. `decode_value` scores only legal
values, finds no match, and returns `None` — which is *correct*, and which
`app/recognizers/local.py`'s `_decode_value_cell` had always produced
identically for a cell with nothing written in it at all:

```python
def _decode_value_cell(self, path, legal_vals):
    crop = read_cell(path)
    if crop is None:
        return None                    # missing file
    glyphs = segment_cell(crop)
    if not glyphs:
        return None                    # genuinely blank — nothing to mislabel
    ...
    value, _score = decode_value(probs, decimal_index, legal_vals, DECODE_FLOOR)
    return value                       # ink present, but nothing matched — SAME None
```

Three different situations, one output. The instructor sees an
unexplained blank box (N33) either way, and a Confirm button that refuses
the true value `7` no matter how many times they type it — pushing them
toward typing a *different*, legal value (`5`) just to get past
validation. `harvest()` then labels the crop of a handwritten `7` with the
string `"5"` (N31), and does so invisibly: nothing about that write looks
different from a genuine confirmation.

Why not distinguish "genuinely out of range" from "illegible in-range
smudge" and word the message precisely? Because the decode score can't
tell them apart. Both look identical from inside `decode_value` — ink
that scored below the floor against every legal candidate, for a reason
the function has no way to know. Rather than assert a certainty it didn't
have, the fix returns which case it's *not*:

```python
def _decode_value_cell(self, path, legal_vals):
    crop = read_cell(path)
    if crop is None:
        return None, False
    glyphs = segment_cell(crop)
    if not glyphs:
        return None, False             # blank — not the dangerous case
    ...
    value, _score = decode_value(probs, decimal_index, legal_vals, DECODE_FLOOR)
    return value, value is None        # had ink, nothing matched
```

`had_ink` is the one new bit of information this needed. `read_marks`
collects it into `MarksResult.unmatched_fields` — a strict subset of the
existing `low_confidence_fields` — and that one list does both jobs at
once:

- **N31**: `app/harvest.py`'s `harvest()` takes the set and refuses to
  write any crop whose name is in it, no matter what the instructor
  confirmed:

  ```python
  if f"q{i + 1}" in unmatched_fields:
      continue
  ```

  This is deliberately unconditional — it doesn't check whether the
  confirmed value differs from the original. We already know the ink
  matches *no* legal label, so there is no confirmed value that could be
  trusted to describe it, including one that happens to match what the
  model's argmax would have guessed.

- **N33**: `Review.tsx` shows a message on exactly the fields in that set,
  and only while they're still blank:

  ```tsx
  {!markErrors[qc.q] && !marks[qc.q] && unmatched.has(`q${qc.q}`) && (
    <span className="warning-text">Couldn't match this to a legal value — check the script.</span>
  )}
  ```

  It disappears the instant anything is typed — legal or not — because at
  that point either `markErrors` or a real value takes over, the same as
  every other flagged field on this screen. It never blocks Confirm on its
  own; a blank field was already valid-but-unverified before this existed.

### A monkeypatch that silently patched the wrong module

Testing the `had_ink` distinction directly needed the real trained model
(the whole point was proving the app's actual decode path, not a
reimplementation of it), plus a way to force "ink present, nothing legal
matches" deterministically rather than hoping a hand-drawn rectangle
confuses the classifier the right way. The trick: pass `legal_vals=set()`
directly to `_decode_value_cell` — with no candidates to score against,
`decode_value` can never return anything but `None`, regardless of what
the model reads.

One level up, testing `read_marks` itself needed the same trick applied
to the `legal_values()` call *inside* the method, which meant
monkeypatching a module-level name:

```python
monkeypatch.setattr(local_module, "legal_values", lambda max_mark: set())
```

This passed in isolation and failed only when run after the full suite —
specifically, only after `test_cnn_preprocess.py`'s own N16 regression
test, which pops `app.recognizers.local` out of `sys.modules` and
re-imports it fresh, to prove the app doesn't accidentally pull in the CLI
tuning harness at import time. That test's reload leaves
`sys.modules['app.recognizers.local']` pointing at a *different* module
object than the one this file's `CNNRecognizer` class — imported at the
top of the file, before any test has run — actually belongs to. Patching
`import app.recognizers.local as local_module` by name patches the new
one; the method executing belongs to the old one. Two module objects,
same dotted name, silently disagreeing.

The fix sidesteps `sys.modules` entirely:

```python
monkeypatch.setitem(CNNRecognizer.read_marks.__globals__, "legal_values", lambda max_mark: set())
```

`__globals__` is the actual namespace dict a function's code runs against
— not a lookup by name, the dict itself. It's correct regardless of which
module object `sys.modules` currently associates with that name, which is
exactly the property this situation needed. Found by the full suite
failing where the file alone passed — a reminder that "passes in
isolation" and "passes in the suite" are different claims, and a
reload-based test elsewhere in the codebase is precisely the kind of
thing that can make them diverge.

Backend suite: 246 → 256. Frontend suite: 241 → 245.

## N35 — a mark written with a leading zero could never decode

Raised as a direct question, not found by an audit: "why can't the
detector read 03, 05?" Worth walking through because the answer isn't a
confidence-floor tuning problem — it's a structural one, and the same
shape of bug `decode_serial` already had fixed once (N32, above), just
hitting a different function that has its own, separate fix.

[`cnn/decode.py`](backend/cnn/decode.py)'s `decode_value` doesn't parse
freeform digits and validate the result afterward — it scores every
*legal* value's own digit rendering directly against the glyphs, and
picks whichever scores highest:

```python
def _digits_of(value: float) -> tuple[list[int], int | None]:
    s = _fmt(value)
    decimal_at = s.index(".") if "." in s else None
    digits = [int(c) for c in s if c != "."]
    return digits, decimal_at
```

`_fmt(3)` is `"3"` — one digit, always, for any whole-number mark. That's
the right rendering for the *canonical* way to write a 3, but it's also
the *only* rendering `decode_value` ever tried. A student who writes "03"
segments into two glyphs. For every legal value in the question's set,
`decode_value` checks `len(digits) != len(glyph_probs)` and skips the
candidate on a length mismatch — and no legal value's canonical digit
count is ever 2 for a single-digit mark. Not one candidate at any
confidence could ever match. This is different from every other flagged
case in this codebase: a smudged "4" that scores 0.4 confidence still has
a *chance* to clear the floor; a "03" reading had no chance at all,
because there was no candidate shaped like it to compare against.

The fix generates a second candidate per legal value, not just the
canonical one:

```python
def _digit_candidates(value: float) -> list[tuple[list[int], int | None]]:
    digits, decimal_at = _digits_of(value)
    padded_decimal_at = None if decimal_at is None else decimal_at + 1
    return [(digits, decimal_at), ([0, *digits], padded_decimal_at)]
```

`decode_value`'s loop now tries both shapes for every legal value. The
padded candidate for `3` is `[0, 3]` — and it still has to *win on
score*, the same way any candidate does: the leading glyph is scored
against the classifier's actual probability of it being a `0`, just like
every other digit. Write "13" instead, and the leading glyph reads
confidently as a `1`, not a `0` — the padded-`3` candidate scores near
zero on that position and loses to nothing, so the cell correctly flags
rather than silently reading "13" as "3". `test_leading_zero_padding_
does_not_invent_a_false_match` pins exactly that case: this is a new
*candidate*, not a lowered bar.

The `padded_decimal_at = decimal_at + 1` line matters more than it looks:
without shifting the expected decimal position along with the extra
leading digit, a padded half-mark like "01.5" would fail the position
check even though its digit count now matches. Worth noting because it's
the second time this exact kind of bookkeeping has bitten this file — N24
(issues.md, and the "Fixing the audit" section above) was a different bug
in the same neighborhood: comparing *whether* a decimal existed instead
of *where*. Both bugs are examples of the same lesson: when a
comparison has more than one dimension (length AND position; presence
AND position), checking only one of them looks correct until a case
comes along that needed the other.

One thing worth checking rather than assuming: were half marks (0.5,
1.5, 2.5, …) *also* broken? No — `_fmt(1.5)` is `"1.5"`, already two
digits with a decimal point, which is exactly the shape `decode_value`
already scored correctly; `test_decoder_returns_the_legal_value_its_
glyphs_encode` already pinned the 4.5 case before this fix existed. The
leading-zero bug only ever affected whole numbers, because only a whole
number's canonical rendering is short enough for padding to matter.

4 new `test_cnn_decode.py` cases. Backend suite: 256 → 259.

## Step 13 — Multi-course, multi-section persistence (all four phases done)

Everything up to this point assumed one quiz at a time. Setup.tsx held
exactly one `QuizConfig`, `records` was one flat pile with nothing saying
which quiz a record belonged to, and "Reset everything" was the only way
between sessions. That was correct for the pilot — one instructor, one
class, one sitting — and wrong the moment a real semester showed up: one
section of CSE100, one of CSE200, two of CSE203, taught at once. Grading
the second CSE203 section meant deleting the first's marks first.

This step replaces the single `config` with two durable things: a
**Section** (course code, label, semester, ID digits, an optional class
list) and an **Assessment** (one quiz's question config, scoped to a
section). Phases A and B — the schema, the new screens, and moving the
roster onto the section — are built. What follows is the interesting
parts, not a restatement of step.md's own task list.

### The migration has to run inside someone else's browser, once

The riskiest code in this step isn't the new screens — it's the
`upgrade()` callback in `db.ts`, because it runs on a real instructor's
device, once, automatically, the moment they load the new build. If it's
wrong, there's no "try again": whatever it drops is gone.

The hard part isn't reading the old data — it's that IndexedDB's
versioned-upgrade transaction has a lifetime, and everything has to
happen inside it:

```javascript
if (db.objectStoreNames.contains('config')) {
  const configStore = transaction.objectStore('config');
  const rosterStore = db.objectStoreNames.contains('rosterUpload')
    ? transaction.objectStore('rosterUpload')
    : null;

  Promise.all([
    configStore.get(OLD_CONFIG_KEY),
    rosterStore ? rosterStore.get(OLD_ROSTER_UPLOAD_KEY) : Promise.resolve(undefined),
    records.getAll(),
  ]).then(async ([oldConfig, oldRosterUpload, existingRecords]) => {
    if (oldConfig) {
      // ...build one Section + one Assessment, stamp every existing
      // record with the new assessmentId...
    }
    db.deleteObjectStore('config');
    if (db.objectStoreNames.contains('rosterUpload')) {
      db.deleteObjectStore('rosterUpload');
    }
  });
}
```

`db.deleteObjectStore()` isn't a request — it's a synchronous structural
change — but it has to run while the versionchange transaction is still
*active*, and a transaction goes inactive the moment nothing is keeping it
busy. The chain of `await`ed `put()` calls inside that `.then()` is what
keeps it alive long enough to reach the `deleteObjectStore` calls at the
end. This isn't a new trick invented for this step — `db.ts`'s existing
v3 migration (the one that normalizes old un-normalized serials) already
proved the pattern, recursively chaining `cursor.continue().then(migrate)`
through the same kind of transaction. Step 13's migration just chains
through `Promise.all` and a `for` loop instead of a cursor.

None of this is trustworthy from reading it, so `db.test.ts` runs it for
real: a genuine `openDB('marks', 1, ...)` with real `config`/`records`
data, then opens at v5 and checks what came out the other side. Three
cases, each written as the thing that must not happen rather than the
happy path: a populated v1 database folds into one Section + one
Assessment with every record preserved; an empty one produces nothing;
a v4 database's persisted roster survives into the migrated Section's
`roster`/`workbook` fields. All three genuinely exercise the transaction
lifetime question above — if the chaining were wrong, `deleteObjectStore`
would throw `InvalidStateError` on a closed transaction, and the test
would fail loudly rather than silently losing data.

### Setup.tsx doesn't get a replacement screen — it gets three

The natural instinct is to keep `Setup.tsx` and just add a picker in
front of it. That's not what happened: `Setup.tsx` is deleted outright,
and its one job splits into three files that map onto the two new
entities:

- **`Library.tsx`** — the new first screen. Semester → course → sections
  → assessments. It also inherited two things that had nowhere else
  sensible to live once Setup.tsx was gone: the "How this works"
  disclosure, and "Reset everything."
- **`SectionForm.tsx`** — the durable half: course code, label, semester,
  ID digits, plus (Phase B) the class-list upload.
- **`AssessmentForm.tsx`** — the per-quiz half: name, question count,
  maxes. `idDigits` isn't asked here at all — it's inherited from the
  section.

One consequence of the split is a real simplification worth calling out.
Setup.tsx had a "plain download" vs. "use my class marksheet" toggle,
because the roster was a *per-quiz* choice — every quiz asked the
instructor to pick a file, or not. Once the roster moved onto the
section, that choice stopped being per-quiz. `SectionForm.tsx` just has
an optional upload field, always visible, no toggle:

```tsx
<div className="field">
  <span className="field-label">Class-list workbook (optional)</span>
  ...
  <input id="rosterFile" type="file" accept=".xlsx" onChange={...} />
</div>
```

A section either has `section.roster`/`section.workbook` set or it
doesn't, and `Results.tsx` decides what to show from that alone — the
same `section.roster && section.workbook &&` guard that used to be
`rosterUpload &&`.

### `assessmentConfig` is the one seam that kept everything else unchanged

The biggest risk in a change like this is that it ripples into every
screen. It mostly didn't, because of one small function:

```typescript
// idDigits comes from the SECTION, never copied onto the Assessment —
// a copy is exactly how the two would drift.
export function assessmentConfig(assessment: Assessment, section: Section): QuizConfig {
  return {
    quizName: assessment.quizName,
    idDigits: section.idDigits,
    questions: assessment.questions,
    totalMax: assessment.totalMax,
  };
}
```

`Scan.tsx`, `Review.tsx` and `Results.tsx` all still take a plain
`config: QuizConfig` prop, exactly as before step 13. `App.tsx` is the
only place that knows about `Section`/`Assessment` at all — it calls
`assessmentConfig()` once per render and hands the result down. That's
why `roster.ts`, `examSheet.ts`, `workbookExport.ts`, `rosterMatch.ts`,
`validateConfig.ts` and `scanQueue.ts` needed **zero** changes for this
step: none of them ever knew a `Section` existed.

### Proving the re-cache actually works, not just that a field changed

Step 12's export always reloaded the class-list workbook from the
original upload's bytes. That was correct when there was one quiz per
upload. It becomes a real bug the moment a section holds several quizzes:
Quiz 2's export would reload the pristine original file — without Quiz
1's sheet in it — and silently produce a download that lost Quiz 1
entirely.

The fix is to re-cache the bytes the app just wrote:

```typescript
const updatedSection: Section = {
  ...section,
  workbook: {
    fileName: section.workbook.fileName,
    bytes: buffer as ArrayBuffer,
    capturedAt: new Date().toISOString(),
    source: 'exported',
  },
};
await saveSection(updatedSection);
onSectionUpdated(updatedSection);
```

`onSectionUpdated` threads back up to `App.tsx`, which updates the
`activeSection` it's holding — so the *next* export in this section
starts from the file that already has the earlier quiz's sheet in it.

A test that only checks `updated.workbook.source === 'exported'` would
pass even if the re-cached bytes were garbage. The test that actually
matters exports Quiz 1, takes the resulting `Section` (exactly what
`onSectionUpdated` produced), re-renders `Results` with it and a Quiz 2
`Assessment`, exports again, and — instead of trusting the mocked
`URL.createObjectURL` — captures the real `Blob`, reloads it as a genuine
ExcelJS workbook, and checks the actual sheet names:

```typescript
const finalWorkbook = new ExcelJS.Workbook();
await finalWorkbook.xlsx.load(finalBytes);
const sheetNames = finalWorkbook.worksheets.map((ws) => ws.name);

expect(sheetNames).toContain('data');   // the class list itself
expect(sheetNames).toContain('Quiz 1');
expect(sheetNames).toContain('Quiz 2');
```

This is the one test in the whole step that would have caught the actual
bug the step exists to prevent, and it does so by round-tripping real
bytes through a real library rather than asserting on a mock.

### A submit button that looked enabled but wasn't ready

`SectionForm.tsx` fetches every existing section on mount, to check for
a duplicate course/section/semester combination on submit:

```typescript
const [existingSections, setExistingSections] = useState<Section[] | null>(null);
useEffect(() => {
  getAllSections().then(setExistingSections);
}, []);
```

`handleSubmit` bails out if that fetch hasn't resolved yet — correct,
since submitting before it resolves would mean the duplicate check ran
against an empty list. The submit button, though, had no `disabled` state
tied to that at all; it just always looked clickable. A test that
clicked it immediately after `render()` would sometimes pass anyway
(IndexedDB reads are fast) and sometimes silently do nothing, because the
click landed inside the guarded no-op window — a real race, not a test
artifact, that a fast enough real device could hit too.

The fix is one line, and it's the same fix in both directions — give the
button a real, meaningful disabled state, which happens to also make the
test's `waitFor(() => expect(button).toBeEnabled())` mean something:

```tsx
<button type="submit" className="btn btn-primary flex-1" disabled={existingSections === null}>
```

Two tests had been passing by luck (their `waitFor` was checking a
condition — "enabled" — that was already permanently true, so it resolved
instantly without actually waiting for the fetch). They failed the moment
the full suite ran with different scheduling than the file did in
isolation, which is exactly the "passes alone, fails in the suite" shape
worth remembering from earlier in this project's own audits: a race
that's rare enough to not show up until something else changes the
timing around it.

### Where the context header still had a blind spot

Scan.tsx's header shows the section and quiz name — "CSE203-2 · Quiz 1"
— always visible, so grading two sections back to back doesn't rely on
memory. But Review.tsx renders as a `position: fixed` overlay that
covers Scan's entire screen, header included (that's deliberate — see
step 7's own account of why Review can't unmount the camera). The
consequence: at the exact moment the instructor is looking at a script
and deciding whether to tap Confirm, the one piece of context that would
catch a wrong-section mistake was invisible.

The fix is small once spotted — an optional prop and a bare CSS rule
(`.eyebrow` used to only exist scoped to `.app-header .eyebrow`, so it
needed its own unscoped declaration to render standalone inside Review's
overlay) — but the bug itself is a reminder that "the header shows it"
isn't the same claim as "the screen you're looking at when it matters
shows it."

Frontend suite: 245 → 282, three consecutive full `vitest run` passes
confirming no flakiness left. Backend: untouched — this step is entirely
a frontend concern, exactly as its own rule 2 required.

### Phase C — closing what Phase B's own context header left open

Phase B built the header that shows "which section am I in." Phase C is
the three things underneath it: the identity check that actually fires
(or doesn't) when a script is saved, the prompt that catches an old
assessment reopened by mistake, and the filename that carries the
identity into the file itself. All three are done as of the same day.

### Scoping without a new index

`findRecordsBySerial` used to query one IndexedDB index (`by-serial`) and
return everything that matched, globally. Scoping it to one assessment
didn't need a second, compound index — the records it returns already
carry `assessmentId`, so a plain filter after the index lookup does it:

```typescript
export async function findRecordsBySerial(serial: string, assessmentId: string): Promise<StudentRecord[]> {
  const db = await getDB();
  const normalized = normalizeSerial(serial);
  if (normalized === null) return [];
  const matches = await db.getAllFromIndex('records', 'by-serial', normalized);
  return matches.filter((r) => r.assessmentId === assessmentId);
}
```

The interesting part isn't the code — it's the test that proves the fix
didn't just move the bug sideways. A scoping change is easy to get half
right: stop the false conflict, but also accidentally stop the real one.
So `Review.test.tsx` pins both outcomes as separate cases — a record
sharing a serial in a DIFFERENT assessment raises nothing, and the exact
same setup with the record in the SAME assessment still raises the
conflict banner:

```typescript
it('raises no conflict against a record with the same serial in a different assessment', async () => { ... });
it('still raises the conflict against a record in the SAME assessment', async () => { ... });
```

Without the second test, a change that accidentally scoped too broadly
(say, filtering by `studentId` instead of `assessmentId`, or forgetting
the filter on one of the two functions) could pass the first test while
quietly breaking the actual cross-check plan.md §2 calls the highest-
value screen in the app.

### A derived field instead of a new one

Resume confirmation needs to know "was this assessment last touched
before today." The tempting shortcut is a `lastActivityAt` field on
`Assessment`, updated every time a record is saved. That's a second copy
of information the database already has — every record already carries
its own `capturedAt` — and a second copy is one more place for the two to
quietly disagree, the same drift concern this whole step keeps avoiding
elsewhere (idDigits living on the Section and not the Assessment, for the
same reason).

So it's derived instead, from data `Library.tsx` was already fetching to
show each assessment's scanned count:

```typescript
export function lastActivityAt(capturedAtValues: string[]): string | null {
  if (capturedAtValues.length === 0) return null;
  return capturedAtValues.reduce((latest, v) => (v > latest ? v : latest));
}
```

String comparison works here specifically because every `capturedAt` in
this codebase comes from `new Date().toISOString()`, which always
produces the same fixed-width UTC format — lexicographic order and
chronological order agree for that one format. It would silently break
the moment any code stored a differently-formatted timestamp.

### A test that was wrong on this machine, correctly

The comparison itself is deliberately "local calendar day," not "24 hours
ago" — an assessment scanned at 11pm and reopened at 7am the next morning
is a different session, even though less than 24 hours passed:

```typescript
export function needsResumeConfirmation(lastActivityAt: string | null, now: Date = new Date()): boolean {
  if (lastActivityAt === null) return false;
  const last = new Date(lastActivityAt);
  return last.toDateString() !== now.toDateString();
}
```

The first version of the test for "confirms an assessment last touched
yesterday" used a hand-picked timestamp: `now` at `2026-09-09T15:00:00Z`,
"yesterday" at `2026-09-08T23:59:00Z` — one minute before UTC midnight.
It failed. Not because the function was wrong, but because the test
machine's own local timezone is ahead of UTC: `23:59 UTC` on the 8th
lands after local midnight, on the 9th — the SAME calendar day as `now`,
by the exact rule the function is deliberately using. The fixture had
picked a moment that was "yesterday" in UTC but "today" locally, in a
function whose entire point is to compare locally.

The fix wasn't to special-case the test's timezone — it was to stop
hardcoding a timestamp near a UTC boundary at all, and derive every
fixture from `now` with plain arithmetic instead:

```typescript
const DAY_MS = 24 * 60 * 60 * 1000;
const twoDaysAgo = new Date(now.getTime() - 2 * DAY_MS);
```

Two days is far enough from any midnight boundary, in any timezone, that
the test means the same thing everywhere it runs. This is worth
remembering as a general shape: a date/time test that hardcodes a
timestamp close to a day boundary is testing "does this pass in my
timezone," not "is the function correct" — and the failure here was the
test doing its job, not a flake to route around.

### The filename, and what it's actually proving

`exportFilename` changed from taking a quiz name to taking a `Section`
and a quiz name, producing `CSE203-2_Quiz-1_2026-09-09.xlsx`. The
temptation with a test for this is to call the function directly and
check the string it returns — which would pass even if `Results.tsx`
never actually used the return value. The test that was written instead
goes through the real download path:

```typescript
const clickSpy = vi
  .spyOn(HTMLAnchorElement.prototype, 'click')
  .mockImplementation(function (this: HTMLAnchorElement) {
    capturedFilename = this.download;
  });
```

`triggerDownload` builds a real `<a>` element, sets its `download`
attribute, and calls `.click()` on it. Intercepting `click()` and reading
`this.download` at that exact moment captures what the browser would
actually have offered to save the file as — proving the filename change
reaches the one place it has to, not just that the function computes the
right string in isolation.

Frontend suite: 282 → 301, four consecutive full `vitest run` passes.
Backend: untouched again — every substep in Phase C, like A and B before
it, is entirely a frontend concern.

### Phase D — the purge, and the two questions it had to answer without cheating

Phase D is one feature — delete a whole semester's data — but building it
honestly meant answering two questions the earlier phases had deliberately
left open, rather than quietly picking convenient defaults.

**Question one: when should the purge even be offered?** The tempting
shortcut is "whenever the library has more than one semester with data" —
computed fresh every time `Library.tsx` loads. That's simple, but it's
also naggy: an instructor deliberately grading Fall and Spring side by
side for a week would see the offer every single visit until they
purged, whether they wanted to or not.

The spec's own words point at something narrower: "offered when a section
is created under a new semester label." That's an *event*, not a
*state* — it should fire once, right after the moment a genuinely new
semester's first section is saved, and never again on an unrelated later
visit. Events don't fit naturally inside a component that fetches its own
data on mount the way `Library.tsx` already does, so the detection has to
happen one level up, in `App.tsx`, which is the only place that sees the
actual save happen:

```typescript
onSave={async (section) => {
  const isNewSection = editingSection === null;
  const priorSections = isNewSection ? await getAllSections() : [];

  await saveSection(section);

  const isNewSemester =
    isNewSection &&
    priorSections.length > 0 &&
    !priorSections.some((s) => s.semester === section.semester);

  if (sectionFormReturnsTo === 'library' && isNewSemester) {
    setPendingSemesterOffer(section.semester);
    setScreen('library');
  } else {
    returnFromSectionForm();
  }
}}
```

Two details earn their own line. `editingSection === null` — this only
fires for a genuine creation, never an edit, matching "creating" in the
spec's own wording exactly rather than the broader "a section's semester
field changed." And `priorSections.length > 0` — the very first section
ever created introduces a "new" semester by definition, but there is
nothing to purge yet, so it must not trigger anything.

The prop this produces, `pendingSemesterOffer`, only means anything for
one `Library` mount. Every OTHER way back to the library — Cancel, "All
sections," a normal Edit-and-save — routes through functions that
explicitly clear it first:

```typescript
function toLibrary() {
  setPendingSemesterOffer(null);
  setScreen('library');
}
```

Without that, a stale `true` from three navigations ago could resurface
the offer on a visit that has nothing to do with any new semester.

**Question two: how do you compare semester labels without pretending you
know the answer to a question this project already flagged as open?**
Plan.md §18 names semester-label drift as an unresolved risk: `Fall 2026`,
`fall 2026` and `F26` might all mean the same thing to the instructor and
look like three different things to the app. The obvious move when
building the purge would be to normalize labels before comparing them —
lowercase, trim, maybe strip punctuation — so all three fold into one
purge candidate. That would be quietly *deciding* the open question by
picking the most convenient answer, right inside the one feature that
permanently deletes data.

The purge does the opposite on purpose:

```typescript
export function otherSemesters(sections: Section[], currentSemester: string): string[] {
  return [...new Set(sections.map((s) => s.semester))].filter((s) => s !== currentSemester);
}
```

Exact string equality. If a semester is split across two spellings, both
spellings show up as their own separate purge candidate, with their own
counts, their own Review button, and their own unexported-assessment
check. The drift becomes visible — two small cards instead of one — right
at the moment it would otherwise cause the most damage: about to delete
something. The real question (should the library treat these as one
semester day to day?) stays exactly as open as it was; the purge simply
declines to guess an answer to it.

### The block-then-confirm shape, reused rather than reinvented

`PurgeReviewPanel` has two branches, and the choice of which one to show
follows a pattern the codebase already had, in `Results.tsx`'s duplicate-
export panel: a hard block wins over a soft confirm, always, and a block
offers no way past it except fixing the underlying problem — here, that
means exporting the missing work first:

```tsx
if (preview.blockedBy.length > 0) {
  return (
    <div className="stack-sm">
      <p>Can't purge <strong>{preview.semester}</strong> — ...</p>
      <ul>{preview.blockedBy.map(({ section, assessment }) => (
        <li key={assessment.id}>{sectionDisplayLabel(section)} · {assessment.quizName}</li>
      ))}</ul>
      <div className="banner-actions">
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
```

No "purge anyway" button exists in this branch, on purpose — the same
reasoning `Results.tsx` already applies to two scripts matching one
student: a block that can be talked past by one more tap isn't really a
block, and an unexported assessment is unrecovered work, not a detail to
override.

Frontend suite: 301 → 322, five consecutive full `vitest run` passes.
Backend: untouched — the fourth and final phase of this step, like the
three before it, never touched anything outside the frontend.

### The follow-up (13.22) — closing the two things Phase D left open on purpose

Phase D's purge (above) deliberately declined to answer two questions
rather than guess at them: whether semester labels should be free text or
a picker, and whether the app should open on the library or jump straight
into the last active assessment. Both got answered directly by the user
the same week, which is the difference between "unsettled" and "not yet
asked" — the purge's exact-string comparison was never a stand-in for a
decision, just a way to avoid needing one before the real answer existed.

**The picker is three buttons and a number field, not a dropdown, and
that's a real choice, not a default.** Three terms — Spring, Summer,
Autumn — because that's the actual calendar this pilot institution runs,
not a generic four-season assumption with an unused Winter sitting in it.
`sections.ts` gained the whole round trip as pure functions, the same
shape `formatSemesterLabel`'s own comment insists on:

```typescript
export function formatSemesterLabel(season: SemesterSeason, year: number): string {
  return `${season} ${year}`;
}

const SEMESTER_LABEL_RE = /^(Spring|Summer|Autumn) (\d{4})$/;

export function parseSemesterLabel(label: string): { season: SemesterSeason; year: number } | null {
  const match = SEMESTER_LABEL_RE.exec(label.trim());
  if (!match) return null;
  return { season: match[1] as SemesterSeason, year: Number(match[2]) };
}
```

`formatSemesterLabel` is the *only* place a season and a year become the
plain string every other function in this module — `groupSections`,
`otherSemesters`, `purgePreview` — already operates on. Nothing downstream
of it had to change at all: the purge still compares by exact string, the
grouping still keys off the raw label, because a picker-produced value is
just a string that happens to always be well-formed now.

**The interesting part is what happens when it isn't.** A section created
before the picker existed has a `semester` like `"Fall 2026"` or `"F26"` —
neither matches `SEMESTER_LABEL_RE`, so `parseSemesterLabel` returns
`null`. `SectionForm.tsx` has to pre-fill the picker from *something* when
editing that section, and "throw" or "leave it blank" are both worse than
just picking a reasonable default:

```tsx
function initialSeason(editing: Section | null): SemesterSeason {
  return (editing && parseSemesterLabel(editing.semester)?.season) ?? currentSemesterSeason();
}
function initialYear(editing: Section | null): number {
  return (editing && parseSemesterLabel(editing.semester)?.year) ?? new Date().getFullYear();
}
```

`currentSemesterSeason()` is today's own season — not "the section's
season," which for `"F26"` this code has no reliable way to recover
anyway. This is safe specifically *because* nothing about a section
changes just by opening its edit form: the picker shows a plausible
starting point, but the stored `semester` string stays exactly `"F26"`
until the instructor actually taps Save. Worst case, they don't notice
and re-save "Autumn 2026" over a label that meant something slightly
different to them — one wrong tap to correct, not silent data loss, and
covered by its own test (`SectionForm.test.tsx`, "falls back to the
CURRENT season/year when editing a section with an unparseable
semester") alongside the mirror case — a section the picker itself
produced round-trips back through the picker exactly, pre-filling both
the right button and the right year.

**Why the purge's exact-string comparison didn't get "fixed" now that a
picker exists.** It would be tempting to declare label drift solved and
simplify `otherSemesters`/`purgePreview` back to something normalized,
now that new sections can't produce a case-mismatched label. But the
purge has to work over data that's *already there* — a section saved
last month as `"fall 2026"` doesn't retroactively become `"Autumn 2026"`
just because the form that created it now behaves differently. The exact-
string comparison was always doing double duty: guarding against drift
the picker now prevents going forward, and drift that already happened
and needs to stay visible rather than get silently merged during a
delete. Only the first job went away.

**The second question — where does the app open — turned out to already
be answered.** `App.tsx`'s default screen state and its final fallback
render both already resolved to `Library` from Phase A onward; nothing
needed to change in code. What changed was that plan.md §18's "left for
a real session to judge" language could finally be replaced with an
actual decision, once asked directly rather than inferred.

Frontend suite: 322 → 333 (6 new `sections.ts` cases for the picker's
format/parse/current-season functions, 5 new `SectionForm.test.tsx` cases
for the picker UI itself and its two fallback/round-trip behaviors), three
consecutive full `vitest run` passes. Backend: untouched, same as every
phase of this step before it.

### 13.23 — deleting one wrongly-created section

A section can be created by mistake — a typo'd course code caught too
late, a section made under the wrong semester before the picker existed
to prevent that kind of thing. Before this, the only way to remove it was
either the semester purge (13.18, which takes the whole semester with it)
or "Reset everything" (which takes the whole device with it). Both work,
and both are wildly disproportionate to deleting one section.

The store-level primitive already existed — `db.ts`'s `deleteSection()`
was built ahead of Phase D specifically so the purge could reuse it
(13.1's own comment says so directly), and it already cascades correctly:

```typescript
export async function deleteSection(sectionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['sections', 'assessments', 'records'], 'readwrite');
  const assessments = await tx.objectStore('assessments').getAll();
  const toDelete = assessments.filter((a) => a.sectionId === sectionId);
  for (const assessment of toDelete) {
    const records = await tx.objectStore('records').index('by-assessment').getAllKeys(assessment.id);
    for (const key of records) {
      await tx.objectStore('records').delete(key);
    }
    await tx.objectStore('assessments').delete(assessment.id);
  }
  await tx.objectStore('sections').delete(sectionId);
  await tx.done;
}
```

So the actual work here isn't storage — it's exposing this one primitive
through a UI that treats it with the same seriousness the semester purge
already does. `sections.ts` gained `sectionDeletePreview`, which is
`purgePreview` narrowed from "every section under a semester" to "one
section":

```typescript
export function sectionDeletePreview(
  section: Section,
  assessments: Assessment[],
  recordCounts: Record<string, number>,
): SectionDeletePreview {
  const sectionAssessments = assessments.filter((a) => a.sectionId === section.id);
  const recordCount = sectionAssessments.reduce((sum, a) => sum + (recordCounts[a.id] ?? 0), 0);
  const blockedBy = sectionAssessments.filter((a) => a.exportedAt === null);
  return { section, assessmentCount: sectionAssessments.length, recordCount, blockedBy };
}
```

The interesting design question wasn't the code — it was whether a
single-section delete should carry the same unexported-assessment guard
the semester purge has. The user's own stated case ("if someone cleared a
section wrongly") is usually a section with nothing in it yet, where the
guard never fires anyway. But "usually" isn't "always": a section can
also be created correctly, quizzed for a while, and then deleted by
mistake — and at that point it's exactly as unrecoverable as a semester
purge hitting ungraded work. There's no principled reason a smaller
blast radius should come with a weaker safety property, so
`SectionDeleteReviewPanel` reuses `Library.tsx`'s existing block-then-
confirm shape verbatim — an unexported assessment blocks the delete
outright, named, Cancel only; otherwise a plain confirm stating exactly
what would go, no undo:

```tsx
{deletingSection?.id === section.id && (
  <SectionDeleteReviewPanel
    preview={sectionDeletePreview(section, assessments, counts)}
    onCancel={() => setDeletingSection(null)}
    onConfirm={handleDeleteSection}
  />
)}
```

Nothing about `deleteSection()` itself changed — this section is entirely
new UI wrapped around a primitive and a preview-computation pattern that
already existed, which is exactly why it shipped same-day rather than
needing its own migration or schema thought.

6 new `Library.test.tsx` cases: an empty section deleting immediately
once confirmed, the confirm step alone adding no deletion, Cancel leaving
it untouched, the cascade actually reaching assessments and records, a
sibling section surviving, and the unexported guard naming the blocking
quiz with Cancel only. Frontend suite: 333 → 339, three consecutive full
`vitest run` passes. Backend: untouched.

### 13.24 — deleting one wrongly-added quiz, and typing to confirm

Two related asks landed together: an assessment deserves the same
targeted delete a section just got, and both deletes should make the
instructor actually type the name of what they're removing rather than
trust one tap on a button they may not have read.

**The assessment half is almost entirely repetition, on purpose.**
`db.ts` gained `deleteAssessment()`, which is `deleteSection()` with one
layer of cascade removed — no section, no sibling assessments, just this
quiz and its own records:

```typescript
export async function deleteAssessment(assessmentId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['assessments', 'records'], 'readwrite');
  const records = await tx.objectStore('records').index('by-assessment').getAllKeys(assessmentId);
  for (const key of records) {
    await tx.objectStore('records').delete(key);
  }
  await tx.objectStore('assessments').delete(assessmentId);
  await tx.done;
}
```

`sections.ts` gained `assessmentDeletePreview` to match — `sectionDelete
Preview` narrowed one level further, same idea as `purgePreview` /
`sectionDeletePreview` before it. Three functions now share one shape:
semester, section, assessment, each one level narrower than the last,
each answering the same question ("what would this delete, and is any
of it real unrecovered work") at a smaller scope.

**Building that third, narrowest one is what surfaced a bug in the two
that already existed.** `sectionDeletePreview` and `purgePreview` both
blocked on this condition:

```typescript
const blockedBy = sectionAssessments.filter((a) => a.exportedAt === null);
```

Read literally: block if the assessment has never been exported. That
was fine as long as "never exported" and "has real work worth
protecting" happened to line up — which they always had, until this
step gave someone a reason to delete a quiz the moment after creating
it. A brand-new assessment is *always* unexported; it was created ten
seconds ago. Under the rule above, a section holding even one empty,
just-created, wrongly-added assessment could never be deleted — the
exact case 13.23 exists to handle, blocked by a guard meant to protect
something else entirely.

The guard's *reasoning* was correct — plan.md §18 is explicit that
"deleting unrecovered work silently is the one outcome this feature must
never produce" — it was just checking the wrong proxy for "unrecovered
work." Unexported and empty is not unrecovered work; unexported and
holding real records is. The fix is one small function, used everywhere
the guard fires:

```typescript
function isBlocking(assessment: Assessment, recordCounts: Record<string, number>): boolean {
  return assessment.exportedAt === null && (recordCounts[assessment.id] ?? 0) > 0;
}
```

`purgePreview`, `sectionDeletePreview`, and `assessmentDeletePreview` all
route through it now — one rule, three scopes, instead of one rule that
happened to be wrong at two of the three. Worth noticing why this test
had to be rewritten rather than just supplemented: `Library.test.tsx`'s
own "blocks the purge on an unexported assessment" case had always built
its fixture with zero records — passing by coincidence under the old
rule, then silently stopping to test the guard at all under the new one
if left unchanged. Updated to give that fixture a real record, and a new
sibling test pins the other direction directly: an empty, unexported
assessment does **not** block.

**The typed-confirm half is a genuinely new UI pattern for this app**,
introduced once, shared twice:

```tsx
function TypedDeleteConfirm({ expected, itemLabel, confirmLabel, onConfirm, onCancel }: TypedDeleteConfirmProps) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === expected;

  return (
    <div className="stack-sm">
      <label className="field">
        <span className="field-label">
          Type the {itemLabel}’s name, <strong>{expected}</strong>, to confirm
        </span>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={expected} />
      </label>
      <div className="banner-actions">
        <button className="btn btn-danger-solid btn-sm" disabled={!matches} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
```

`SectionDeleteReviewPanel` passes `expected={sectionDisplayLabel(...)}`
("CSE100-1"); `AssessmentDeleteReviewPanel` passes `expected={quizName}`
("Quiz 1"). Neither semester purge nor "Reset everything" got this —
only the two flows actually asked for, so a full-device wipe still reads
its own long warning paragraph rather than gaining a new field nobody
requested for it. State (`typed`) lives inside the shared component, not
the parent — each panel only mounts while its own `deletingSection` /
`deletingAssessment` state is non-null, so a fresh mount (and therefore a
cleared input) happens automatically every time a delete flow reopens,
with no explicit reset needed.

19 new tests: `db.test.ts` (+1, `deleteAssessment`'s own cascade),
`sections.test.ts` (+9 — direct coverage for `sectionDeletePreview` and
`assessmentDeletePreview`, which had only ever been tested indirectly
through `Library.test.tsx` before, plus the empty-assessment boundary
case for both), `Library.test.tsx` (+9 net — the disabled-until-typed
gate itself, and the assessment-delete describe block mirroring
section-delete's own tests). Frontend suite: 339 → 358, three
consecutive full `vitest run` passes. Backend: untouched.

## Step 14 — Landing page (all three phases code-done; real-device verification still needed)

**Honestly labelled**: all three phases are code-done — the page exists,
reads correctly, can be reached and left, ships prerendered with zero
runtime JS of its own, and now animates the "How it works" section
through five scroll-linked states. What's genuinely not done yet is
checking any of that animation's timing and layout on a real phone —
jsdom can't simulate scrolling or scroll-driven CSS animations at all, so
that verification is still outstanding, exactly as the spec itself says
it must be checked.

### The problem this solves, and the one thing worth understanding first

Every screen before this one assumes the reader already knows why
they'd want a section. `Library.tsx`'s "Your sections" is a genuinely
good screen for that reader — but the very first thing anyone sees when
they open the link is someone who doesn't yet know that. Step 14 exists
to answer three questions in order, before the tool ever asks anyone to
do anything: what is this, how does it work, what does it refuse to do.

### Why the tokens live in their own file, and why they can't touch `:root`

`landing.css` is deliberately a separate file from `index.css`, and
every custom property in it is declared under `.landing`, never on
`:root`:

```css
.landing {
  color-scheme: dark;
  --lp-bg: #0f0f0d; /* == index.css's dark --background */
  --lp-surface: #181815; /* == index.css's dark --surface */
  ...
}
```

The reason isn't tidiness. `index.css` already has a `--background` that
means something specific — the app's *current* theme, light or dark,
depending on the reader's OS setting. If `landing.css` had redefined
`--background` at `:root`, it would have silently changed what every
other screen in the app renders with, the moment `Landing.tsx` mounted.
Scoping under `.landing` makes that structurally impossible: nothing
outside a `.landing` subtree can see an `--lp-*` value, by CSS's own
cascade rules, not by a rule anyone has to remember to follow.

The actual color values were chosen to match, though — `--lp-bg` equals
the app's *own* dark `--background` value, copied by hand rather than
invented. The landing page is dark unconditionally (decision 2), the app
is dark only sometimes; making the landing page's dark look identical to
the app's own dark, rather than a different dark, is what makes the
hand-off from one to the other feel like one product instead of two.

### The button problem that wasn't in the spec

Buttons on this page needed to reuse `.btn`/`.btn-primary` — rebuilding
pill-button geometry from scratch for one page would be exactly the kind
of premature duplication this project avoids everywhere else. But
`.btn-primary` in `index.css` is:

```css
.btn-primary {
  background: var(--primary);
  color: var(--primary-foreground);
}
```

`--primary` is theme-aware. On a reader's light-mode system, that
resolves to the light teal, not the dark one — wrong on a page that's
supposed to be dark no matter what the reader's OS thinks. The fix isn't
to stop using `.btn-primary`; it's to let `.btn` supply everything that
isn't color (the 44px hit target, the pill shape, the hover/active
transitions) and override *only* color, scoped the same way the tokens
are:

```css
.landing .btn-primary {
  background: var(--lp-primary);
  color: var(--lp-primary-foreground);
}
```

One button system, two color sources depending on which subtree you're
standing in. The alternative — a whole parallel `.lp-btn-primary` class
with its own copy of the geometry — would have worked too, and would
have been the first place this page's buttons quietly drifted from the
app's own the next time someone tuned a hover state in one file and
forgot the other.

### Why the entry check is `localStorage`, not the database everything else uses

This app already has a place it remembers things across visits — the
`meta` IndexedDB store, which is where `getSourceId()` lives. It would
have been natural to reach for that here too. It's wrong for this one
specific question, and the reason is worth sitting with: IndexedDB reads
are asynchronous. If `App.tsx` decided which screen to show first by
awaiting an IndexedDB read, the sequence would be: render nothing (or
render the landing page) → the read resolves → maybe re-render into the
library. On a slow device that's a visible flash — the landing page
appearing and then vanishing a beat later, which is a worse experience
than either committing to it or skipping it outright.

`localStorage.getItem` is synchronous. `App.tsx` can call it *inside*
`useState`'s initializer, before the very first render happens:

```typescript
const [screen, setScreen] = useState<Screen>(() => (hasSeenLanding() ? 'library' : 'landing'));
```

That's the entire mechanism. No effect, no loading state, no flash —
because there's no async gap for a flash to happen in.

### Fail toward the safe side, not toward a crash

`landing.ts`'s two functions both wrap their storage call in `try/catch`:

```typescript
export function hasSeenLanding(): boolean {
  try {
    return localStorage.getItem(LANDING_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}
```

`localStorage` isn't guaranteed to just work. Safari in private browsing
mode doesn't disable it — it sets the quota to zero, so every write
throws `QuotaExceededError`, and some embedded webviews block the API
outright and throw on the first touch. Whichever function is asked, the
failure mode is chosen deliberately: `hasSeenLanding` fails toward
`false`, meaning *worst case, a returning visitor sees the landing page
again* — mildly annoying, never broken. `markLandingSeen` fails toward
doing nothing — the flag just doesn't get set, same outcome. Neither
failure can crash the transition into the app, which is the one thing
that would actually be bad here.

### Why the way back is optional, not required

`Library.tsx`'s `onShowLanding` prop is typed `?: () => void`, not
`: () => void`. That's not laziness — every existing call site and every
existing test in `Library.test.tsx` had no reason to know this feature
exists, and making the prop required would have meant touching all of
them just to pass a callback irrelevant to what they're actually
testing. The button itself is conditional on the prop being there:

```tsx
{onShowLanding && (
  <button type="button" className="btn btn-quiet btn-sm" onClick={onShowLanding}>
    Read the full story
  </button>
)}
```

`App.tsx` is the one place that actually cares, and it's the one place
that passes it.

### `ScanGraphic` is built for the animation it doesn't have yet

The hero visual ships in Phase A as a static SVG — an ID row, four mark
cells, one of them a small flag instead of a number. It could have been
one flat `<path>` drawn to look right and nothing more. It isn't: the ID
digits, each mark cell, and the flagged cell are separate SVG groups,
each with its own transform, specifically so that when Phase C adds
scroll-linked CSS to animate through the five states in plan.md §19, it
can target these existing groups directly instead of redrawing the whole
graphic from scratch. Building the static version and the animated
version as two unrelated efforts would have meant designing the same
grid twice.

Frontend suite: 358 → 383 (`landing.ts` 6, `Landing.tsx` 13, `App.tsx` 4,
`Library.tsx` 2). Three consecutive full `vitest run` passes stable.
`npm run build`, the TypeScript project check and the AI-tell scanner all
clean. Backend untouched — no API change, no new dependency, exactly as
this step's own rule 1 requires.

**What Phase A did NOT yet do, on purpose**: the built bundle actually
grew (CSS +3.6KB, main JS +7.6KB raw), because `Landing.tsx` still shipped
as an ordinary screen inside the normal React tree, eagerly imported like
every other screen. §19's weight budget — under ~10KB gzipped for a
complete first paint — was a claim about the *prerendered, zero-runtime-
JS* shape Phase B produces, not about that intermediate state. Phase B is
what actually delivers it, and this section is about how.

### Phase B — the page becomes bytes of HTML, and Landing.tsx becomes a build-time input

The goal, stated plainly: someone who opens the link on a cold connection
should get the whole landing page in the SAME round trip that fetches
`index.html` — no waiting on 244KB of JS to download, parse, and mount
React before anything appears. And a returning instructor's visit should
cost nothing extra: the page they actually want is behind that HTML the
instant it loads, with no landing-page code shipped at all to get in the
way.

**Reusing Vite instead of reaching for a new tool.** The obvious way to
turn a React component into an HTML string is `react-dom/server`'s
`renderToStaticMarkup` — already a dependency, no new package needed. The
less obvious problem: that function needs plain JavaScript, and
`Landing.tsx` is JSX plus TypeScript plus a CSS import. Something has to
transform it first. Rather than adding a second toolchain (`tsx`,
`esbuild` called directly, a hand-written loader), `scripts/prerender-
landing.mjs` calls Vite's own `build()` function — the exact same
bundler already doing this transform for the real app — in SSR mode,
pointed at one tiny new file:

```typescript
// src/prerenderEntry.tsx
export function renderLandingMarkup(): string {
  return renderToStaticMarkup(<Landing onOpenApp={() => {}} />);
}
export { APP_VISIBLE_CLASS, LANDING_SEEN_KEY };
```

Vite bundles this to plain `.mjs`, its CSS import silently dropped (an
SSR build has no browser to hand a stylesheet to, so it just no-ops) —
which turns out to be exactly what's wanted, since `landing.css` gets
read separately, as raw text, to become this page's *critical* CSS
rather than part of the app's bundled stylesheet. The Node script then
imports that bundle and calls the one function it needs. No new
dependency anywhere in this chain — the rule step.md sets for this step
holds because Vite was already there to reuse.

**What gets stitched into `dist/index.html`, and where.** Three things,
all inside the document Vite already built, none of them touching
`#root`:

```html
<style id="lp-critical-css">/* landing.css's full text */</style>
<script id="lp-bootstrap">/* ~15 lines, shown below */</script>
...
<div id="landing-root"><div class="landing">...</div></div>
<div id="root"></div>
```

The landing markup sits as a sibling of `#root`, not inside it — React
never mounts into `#landing-root`, never touches it, never re-renders it.
It is just HTML the browser parses and paints, the same as any other tag
on the page.

**The bootstrap script is the only JS this page ships**, and it's short
enough to read in full:

```javascript
(function () {
  var KEY = "msLandingSeen", CLS = "ms-app-visible", html = document.documentElement;
  try { if (localStorage.getItem(KEY) === '1') html.classList.add(CLS); }
  catch (e) { html.classList.add(CLS); }
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-open-app]');
    if (!t) return;
    try { localStorage.setItem(KEY, '1'); } catch (e2) {}
    html.classList.add(CLS);
  });
})();
```

Two things worth noticing about it. First, it fails toward *showing the
app*, not toward a blank page — if `localStorage` throws (Safari private
browsing, some embedded webviews), the `catch` branch still adds the
visible class, on the theory that an instructor who's already used the
app once should never get stuck behind a landing page they can't dismiss
just because storage misbehaved. Second, the click handler is attached to
`document` itself, using `closest('[data-open-app]')` — event
delegation, not a listener on each button. That matters because this
script runs from `<head>`, before the buttons in `<body>` exist yet; a
direct `querySelectorAll(...).forEach(el => el.addEventListener(...))`
would have found nothing. Delegating to `document` sidesteps the whole
question of *when* the buttons show up.

**The CSS trick that avoids fighting the app's own layout.** The obvious
way to show/hide `#root` is two rules with opposite `display` values:

```css
html.ms-app-visible #root { display: block; }
html:not(.ms-app-visible) #root { display: none; }
```

The first line is a bug waiting to ship. `index.css` already declares
`#root { display: flex; flex-direction: column; }` — the app's real
top-level layout. A same-specificity `#root { display: block }`
overriding rule can lose to it in some orderings and win in others
depending on which stylesheet loads last, and if it wins, it silently
flattens the app's flex layout the moment the visible class is added.
`landing.css` only declares the *hide* rule:

```css
html:not(.ms-app-visible) #root { display: none; }
```

When the class is present, this selector simply doesn't match — nothing
here says anything about what `#root`'s display should be, so
`index.css`'s own `flex` rule is the only one left standing. Hiding
something explicitly, and staying silent about what showing it means, is
the way to add a visibility toggle without ever having an opinion about
a layout that already belongs to someone else.

**The "way back" doesn't need a client-rendered `<Landing>` any more.**
Phase A's `Library.tsx` → `App.tsx` → `<Landing>` round trip depended on
React owning a `'landing'` screen. Since Phase B moves the landing markup
outside `#root` and leaves it sitting in the DOM permanently (just
hidden), there's nothing to re-render to go back — only a class to
remove:

```typescript
// landing.ts
export function showLandingOverlay(): void {
  document.documentElement.classList.remove(APP_VISIBLE_CLASS);
}
```

`Library.tsx` itself didn't need to change at all — its `onShowLanding`
prop was already just `() => void`, and `App.tsx` now passes
`showLandingOverlay` directly instead of a screen-switching closure. The
same static markup the bootstrap script showed on the very first visit is
what reappears; nothing new gets built, imported, or rendered for it.

**What this retired.** `App.tsx`'s `Screen` union drops `'landing'`
entirely — the app now always starts on the library, because the
pre-load decision isn't React's job any more. Phase A's
`hasSeenLanding`/`markLandingSeen` functions go with it: nothing calls
them, since the bootstrap script above *is* that check now, written as
plain JS because it has to exist before there's a bundle to import
TypeScript from. What stays is `LANDING_SEEN_KEY` and `APP_VISIBLE_CLASS`
— re-exported through `prerenderEntry.tsx` so the Node script embeds the
exact same literals the rest of the app would use, rather than a second,
hand-typed copy that could quietly drift.

**Guarding the failure mode this step itself names.** plan.md §19 calls
out the obvious risk directly: a prerender step can silently stop
injecting anything, and every *component*-level test would keep passing,
because `Landing.tsx` itself never changed. `prerender.test.ts` is built
specifically to not be fooled by that — it runs the real `npm run build`
(the one expensive test in this suite, on purpose) and then reads the
actual `dist/index.html` it produced, checking that the markup, the
bootstrap script, and the critical CSS are really there, keyed to the
real `LANDING_SEEN_KEY`/`APP_VISIBLE_CLASS` values rather than hardcoded
strings that could drift from them unnoticed. The same file measures the
weight budget the identical way — gzip-compressing the actual injected
markup plus CSS plus script, sliced out of the real build output, not a
number anyone typed in and hoped stayed true.

**The numbers**. Before Phase B, Phase A's build had grown the main CSS
to 14.05KB/3.59KB gzip and the main JS to 252.26KB/77.70KB gzip. After
Phase B, both are back down near their pre-step-14 baseline (10.42KB/
2.89KB CSS, 244.95KB/75.74KB JS) — `landing.css` and `Landing.tsx` no
longer sit in the app's own import graph at all, so nothing bundles them
in. The actual first-paint cost — the injected markup, critical CSS, and
bootstrap script together, gzip-measured — comes to roughly 5.7KB,
comfortably under the ~10KB budget. Frontend suite: 383 → 385 (net: two
Phase-A App.test.tsx cases and two landing.test.ts cases retired along
with the client-rendered landing screen they tested; five new
`prerender.test.ts` cases and one new `landing.test.ts` drift-guard case
added). `npm run build`, `npx vitest run`, and the AI-tell scanner all
clean; backend `pytest` re-run as a sanity check (259, unaffected — no
backend changes, per this step's own rule 1).

### Phase C — the scan animation, and why "code done" isn't the same as "done"

Phase C's job is the fourth section of §19's story: not just claiming
"the table is found and straightened" and "each cell is read," but
*showing* it happening, as the reader scrolls. Five states, one pinned
graphic, driven entirely by scroll position — no JavaScript computing
anything, because §19 rules that out for weight up front.

**Reusing the app's own step list instead of inventing a new one.**
`ScanAnimation.tsx` takes the exact same `HOW_IT_WORKS` array
`Landing.tsx` already had, and renders its captions with the exact same
`.lp-step`/`.lp-list` markup Phase A already used for that section:

```tsx
<ol className="lp-list lp-scan-captions">
  {steps.map((step, i) => (
    <li key={step.title} className="lp-step">
      <span className="lp-step-number" aria-hidden="true">{i + 1}</span>
      <span className="lp-step-text">
        <strong>{step.title}</strong>
        <span className="lp-body">{step.detail}</span>
      </span>
    </li>
  ))}
</ol>
```

The payoff shows up somewhere unexpected: `Landing.test.tsx` had a
pre-existing assertion counting exactly five `<li class="lp-step">`
elements. Because the captions are the *same* markup, not a redesigned
one, that test kept passing without being touched at all — a small,
concrete case of "don't invent a second way to do something the codebase
already does."

**Why the illustration is `aria-hidden`.** At any given scroll position,
the SVG is genuinely *between* two of its five states — a screen reader
has no good way to describe "40% faded from cells-separated into
digits-resolved." Rather than attempt that, the whole pin is hidden from
assistive tech:

```tsx
<div className="lp-scan-pin" aria-hidden="true">
  <svg viewBox="0 0 360 232" ...>...</svg>
</div>
```

This isn't a shortcut around accessibility — it's the correct call
because the *captions right next to it* already say, in plain text
exactly what each state means ("Anything uncertain is flagged, never
guessed"). Hiding a decorative illustration whose content is fully
covered elsewhere in real text is the standard pattern, not a gap.

**The CSS mechanism, and the trap it has to avoid.** Scroll-driven CSS
animation works by naming a timeline on the tall wrapper, then pointing
each state's own `animation-timeline` at it:

```css
.lp-scan-scroller {
  view-timeline-name: --scan-progress;
  view-timeline-axis: block;
}
.scan-state {
  animation-timeline: --scan-progress;
  ...
}
```

The wrapper doesn't need a manually-picked height like `400vh` — its
natural height is just however tall its own children (the pin, the
captions) make it, and the browser tracks how *that whole box* moves
through the viewport as the page scrolls. Each state then gets its own
`@keyframes` spreading five overlapping opacity windows across that one
0–100% timeline, so exactly one state (or a brief crossfade between two)
is visible at any scroll position.

**The layout trap, found by reasoning about the CSS, not by seeing it
break.** The phone layout stacks the pin above the captions in a column;
the wide layout puts them side by side in a row. A naive version of the
row layout would write just `flex-direction: row` and stop there — and
that would silently break the pinning. Flexbox's default
`align-items: stretch` makes every item in a row match the tallest
item's height. The captions column is tall on purpose (each caption
needs real scroll room); if the pin were stretched to match it, it would
become just as tall as the captions — and `position: sticky` has nothing
left to do, because a sticky element only "sticks" by staying put while
its *own* box is shorter than the space it has to move around in. The
fix is one line:

```css
@media (min-width: 64em) {
  .lp-scan-scroller {
    flex-direction: row;
    align-items: flex-start; /* keeps the pin its own natural height */
  }
}
```

This is the kind of bug that's easy to miss because it doesn't produce an
error, a warning, or even obviously wrong-looking output in a quick
glance — the sticky element just quietly stops sticking, and everything
still "renders." It was caught here by working through what `stretch`
actually does to a short item beside a tall one, not by seeing it happen
on a real screen — which is exactly why this step's Done-when bar still
requires an actual device check before trusting the pin behaves as
described.

**Progressive enhancement doing double duty for two different
requirements.** 14.8's rule is "a reader who's asked for less motion gets
the final state, statically." Separately, some real browsers (older
Firefox, Safari before version 26) don't support `animation-timeline` at
all yet. Rather than write two fallbacks, one guard handles both:

```css
.scan-state { opacity: 0; }
.scan-state-5 { opacity: 1; }

@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    /* the real crossfade lives here */
  }
}
```

Outside that `@supports`/`@media` pair — whether because the browser
can't do scroll-driven animation, or because the reader has asked for
less motion, or both — every state defaults to invisible except state 5,
the settled export view. That default isn't a special "fallback mode"
built separately from the main design; it's just what the CSS says before
the enhancement is layered on, which is the actual definition of
progressive enhancement working correctly.

**Extending the grid without touching the hero's own copy.** §19 says the
phone-reduced grid needs "the ID row, the serial, and three or four
question columns" — but Phase A's `ScanGraphic.tsx` (the hero's static
peek) never had a serial row; it only shows the ID row and four marks.
Rather than retrofit the hero graphic to match Phase C's requirement
(risking regressions in an already-shipped, already-tested static
illustration for no real benefit — the hero doesn't need to demonstrate
the serial field), `ScanAnimation.tsx` defines its own serial row,
independent of `ScanGraphic.tsx`. The two components share a visual
language — same card, same cell style, same flagged-mark treatment — but
are two separate drawings, because they are answering two different
questions: one is a two-second peek above the fold, the other is a
five-state walkthrough.

**What "done" doesn't mean here.** Every test that runs in this repo's
suite passes: the five states exist with real content, the reduced-motion
fallback is wired to the actual class names it needs to be wired to, the
built `dist/index.html` genuinely contains all five states. None of that
can check whether the crossfade *feels* right while actually scrolling a
real phone, whether the pin ever visually overlaps its own caption at
320px, or whether an underpowered Android on 3G renders this smoothly.
jsdom has no scrollbar and no rendering engine — it can confirm the CSS
is well-formed and targets the right elements, not that scrolling through
it looks like five *stages*, rather than a flicker. That gap is named
directly in plan.md §19 and step.md's own Test section, and it's why this
step's write-up says "code done," not "done."

### 14.9 — two bugs that every automated test missed, because of what they were actually testing

Reported directly, in one sentence: "when we move past the landing page
we cannot go there anymore." Two separate, real bugs turned out to be
behind it, and the reason neither had been caught yet is worth sitting
with, because it's a specific, nameable gap rather than bad luck.

**What every test up to this point actually checked.**
`Landing.test.tsx` renders `<Landing>` directly with Testing Library —
it never touches `index.html` at all. `prerender.test.ts` runs a real
`npm run build` and reads the real `dist/index.html` — but only the
*build* output. Between those two, there's a third way this app actually
gets used that nothing was checking: `npm run dev` (what `./dev.sh`
starts), which serves `index.html` from source, with none of the
build-time steps applied. Phase B's whole design — prerendering the
landing page at build time — means "at build time" is a real, narrow
window, and nothing before 14.9 asked what happens outside it.

**Bug 1, traced to that exact gap.** `scripts/prerender-landing.mjs`
only ever runs as part of `npm run build`. `vite dev` never calls it, so
the dev server's `index.html` never got `#landing-root`, the bootstrap
`<script>`, or the critical CSS — nothing. Combined with Phase B having
removed `App.tsx`'s client-rendered `'landing'` screen (the whole point
of 14.6: ship zero runtime JS for this page), there was no fallback
either. The practical effect: open `npm run dev` fresh, and the landing
page simply never appears, not once, regardless of `localStorage`.

The fix reuses the exact same injection code for both paths, rather than
writing a second implementation that could quietly drift from the first:

```javascript
// vite.config.ts
export function landingShellDevPlugin(): Plugin {
  return {
    name: 'landing-shell-dev',
    apply: 'serve', // never runs during `vite build`
    async transformIndexHtml(html, ctx) {
      const mod = await ctx.server!.ssrLoadModule('/src/prerenderEntry.tsx')
      const landingHtml = mod.renderLandingMarkup()
      const landingCss = await readFile(/* .../landing.css */, 'utf8')
      return injectLandingShell(html, {
        landingHtml, landingCss,
        landingSeenKey: mod.LANDING_SEEN_KEY,
        appVisibleClass: mod.APP_VISIBLE_CLASS,
      })
    },
  }
}
```

`server.ssrLoadModule` is the part worth noticing: it's Vite's own,
already-supported way to run a piece of application source (JSX, TS,
imports and all) through the exact same transform pipeline the dev
server uses for everything else — which is why this cost no new
dependency and no second build tool. `injectLandingShell` itself moved
out of `prerender-landing.mjs` into a new shared `scripts/landing-shell.mjs`,
so the dev plugin and the real build call the identical function. Two
copies of "how to inject the landing shell" would have been exactly the
kind of thing that quietly drifts apart the next time either one gets
edited — the same reasoning this project already applies to
`QuizConfig`'s bounds existing in two languages (`app/models.py` and
`validateConfig.ts`, pinned together by a test that reads both files).

**Bug 2, once the shell actually existed.** `Library.tsx`'s way back to
the landing page was a button inside:

```tsx
<details className="disclosure" open={sections.length === 0}>
  <summary>How this works</summary>
  ...
  <button onClick={onShowLanding}>Read the full story</button>
</details>
```

`open={sections.length === 0}` was written for a different purpose
entirely (show the "how this works" explainer by default to a first-time
user, collapse it once there's real data) — but it means the disclosure,
and everything inside it, is collapsed the moment a single section
exists. For any Library actually being used for real grading, that's
always. The button existed, worked correctly when clicked, and was
functionally invisible. Moved to an always-visible "About" button
alongside "+ New section" in the header, which is never inside anything
collapsible.

**Why neither showed up sooner.** Both are real instances of a pattern
this project has hit before (its own words, from step 14's mobile-first
rules: "three desktop-fine/phone-broken layouts already"): a thing that
is provably correct at the unit level — the component renders, the build
output contains the right markup — can still be functionally absent in
the one context nobody happened to open. `prerender.test.ts` proved the
*build* worked; nothing proved *dev mode* did, because dev mode isn't
what any existing test exercises. `Library.test.tsx` proved the button
called `onShowLanding` when clicked; nothing proved it was still in the
document once real data existed, because the original test rendered an
empty library. The fix for both, structurally, was the same: write the
test that actually exercises the missing context — a real Vite dev
server in middleware mode (`landingShellDev.test.ts`), and a Library
pre-loaded with a saved section (`Library.test.tsx`'s new case) — rather
than trusting that passing tests in a different context implied these
also passed.

Frontend suite: 394 → 397. Verified by hand two ways: curling the actual
`vite dev` server's served HTML directly, and rebuilding
`./local-stack.sh`'s real production frontend (with its required
`VITE_API_BASE` reapplied) and confirming the same markup there too.

### Bug 3 — a one-line CSS rule that broke `position: sticky` for the whole app, hiding in plain sight since Phase A

Reported with screenshots: scrolling through "How it works," the pinned
graphic showed up correctly next to step 1, then vanished for steps 2
through 5 — no graphic, just a huge blank gap where it should have
stayed pinned beside each caption. That symptom (works once, then
silently stops) is exactly what a broken `position: sticky` looks like,
and it turned out `.lp-topbar` — the "Open the app" bar that's supposed
to stay pinned at the top *at every scroll position*, decision 1 from
the very first day of this step — had the identical problem, just
harder to notice because a topbar quietly failing to stick reads as "the
page doesn't have a topbar," not as an obvious visual gap.

**The CSS rule that caused it is one most people would never think twice
about:**

```css
body {
  overflow-x: hidden;
}
```

This exists for a completely reasonable, unrelated reason: guaranteeing
no horizontal scrollbar ever appears, which step 14's own mobile-first
rules require at 320px. The trap is in what the browser does when you
set only ONE of `overflow-x`/`overflow-y`: per the CSS Overflow spec, if
one axis is anything other than `visible` and the other is left at its
default `visible`, the browser is required to change the OTHER axis's
*computed* value to `auto` too. So `overflow-x: hidden` silently becomes,
as far as layout is concerned, `overflow-x: hidden; overflow-y: auto`.
Nobody wrote that second half — the browser adds it.

**Why that breaks `position: sticky` even though nothing ever actually
scrolls inside `body`.** A sticky element sticks relative to its nearest
ancestor that's a "scroll container" — and having a non-`visible`
overflow value is *itself* what makes something a scroll container, in
the browser's eyes, whether or not it ever actually needs to scroll.
`body` never has its own separate scrollbar in this app (the whole page
just scrolls normally), but the moment its computed `overflow-y` became
`auto`, it started acting as *if* it might, and every sticky descendant
now sticks relative to `body`'s own box instead of the real, visible
viewport. Since `body`'s box is exactly as tall as all its content
(nothing constrains its height), there's no actual "scrolling" happening
inside it from the browser's point of view — which meant the sticky
elements just... didn't stick. They behaved like ordinary, non-sticky
elements, scrolling away with everything around them.

`.landing` had the exact same line, for the exact same
belt-and-suspenders reason, which meant the bug applied twice over to
anything on the landing page.

**Proving it, rather than trusting the theory.** jsdom — what every
other test in this repo runs against — doesn't have a layout engine at
all. It can't compute `getComputedStyle`'s real values the way a browser
does, and it doesn't know what `position: sticky` even means visually.
So this had to be checked with an actual browser. Playwright happened to
already be cached on this machine (a `~/.cache/ms-playwright` directory
from unrelated prior use), which made it possible to drive real Chromium
headlessly:

```javascript
const pin = document.querySelector('.lp-scan-pin');
console.log(pin.getBoundingClientRect().top, window.scrollY);
```

Before the fix, scrolling 800px moved `pin`'s `top` from `0.25` to
`-799.75` — moving in exact lockstep with the scroll, proof it wasn't
sticking at all. After swapping in the fix below, `top` held steady at
`80` (its actual `top: 80px` CSS value) through 2000px of real scrolling.
That's the difference between "this should work" and "this does work" —
and it's exactly the gap step 14's own Test section names when it says
real-device verification, not jsdom, is where layout claims actually get
checked.

**The fix, and why it's not just "remove the line."** Simply deleting
`overflow-x: hidden` would bring back the original problem it was
solving — a real horizontal-scroll risk at 320px, one of this project's
own hard rules. The fix keeps the clipping behavior but avoids the
axis-coupling that breaks sticky:

```css
body {
  overflow: clip visible;
}
```

`overflow: clip` clips content the same way `hidden` does, but — unlike
`hidden` — it never gets paired with an implicit `auto` on the other
axis, because `clip` isn't a scrolling value at all; there's nothing for
the browser to couple. Writing `visible` for the Y axis explicitly, even
though it's already the default, makes that immune to any future
sibling rule accidentally changing it. `overflow: clip` needs a
reasonably modern browser (Chrome 90+, Firefox 97+, Safari 16+) — well
behind what this same page already assumes for its scroll-driven
animation CSS (Safari 26).

**The part that generalizes beyond this one page.** `index.css`'s
`.data-table thead th` — the Results screen's sticky column header, a
real feature described in this project's own design-system notes — sits
directly under `body` with nothing else providing a separate scroll
container. Since it depends on the exact same `body` rule this bug was
in, it was very likely never actually sticking either, on any real
device, for as long as it's existed — simply because nothing before now
had a reason to scroll through a long Results table on a real browser
and notice. Fixing the rule at `body` fixes that too, for free, without
touching `Results.tsx` at all.

### Bug 4 (14.10) — technically correct, and still broken: why "the CSS works" wasn't the same question as "does this work on a phone"

The very next report, with screenshots: on a real phone, the pinned
graphic showed up correctly next to the first caption — then just
disappeared for every caption after it. Long stretches of plain black
where the graphic should have stayed pinned. Given 14.9 had just fixed
`position: sticky` for the whole page, the obvious first guess was that
the same bug had resurfaced somewhere. It hadn't.

**Checking the obvious guess first, properly, with a real phone
viewport.** Rather than assume, this got the same Playwright treatment
14.9 used — this time with Playwright's built-in `devices['iPhone 13']`
profile, which sets the real viewport size (390×844), pixel ratio, and
touch flags a phone actually reports. Reading the pin's position and the
five states' opacity values across a real scroll on that viewport showed
something specific: `position: sticky` *was* holding correctly (the
pin's `top` offset stayed put exactly like the desktop check confirmed),
and the five states *were* crossfading in the right order, on schedule.
The mechanism 14.9 fixed was working. Something else was wrong.

**What a screenshot shows that a position readout doesn't.** Only after
confirming the mechanics did looking at an actual rendered screenshot
make the real problem obvious: `.lp-scan-captions .lp-step { min-height:
55vh }` — giving each caption enough scroll room to sit under the pin
for a while — makes complete sense in the two-column desktop layout,
where the *other* column is that tall anyway because it holds a tall
graphic. On a phone, there's only one column. A caption that's two or
three sentences long, sitting inside a box more than half the *screen's
own height*, leaves most of that box empty. Multiply by five captions
and the "How it works" section becomes several consecutive screens of
almost nothing — which reads as "this is broken" long before a reader
gets far enough to notice it's actually still scrolling somewhere.

This is worth sitting with as its own lesson, separate from 14.9's:
**a component can be provably correct at the mechanism level and still
fail at the experience level**, and nothing that checks the mechanism —
reading `getComputedStyle`, asserting a class is applied, confirming an
opacity value — will ever catch the second kind of failure. Only looking
at what it actually produces does.

**The fix takes the permission it was given, but doesn't take the
cheapest version of it.** Told plainly that dropping the captions on
phone was an acceptable option if needed, the actual fix keeps them —
just not as scroll-driven, screen-tall spacers:

```css
/* phone: a plain, self-looping animation, no scroll dependency */
@media (prefers-reduced-motion: no-preference) {
  .scan-state {
    animation-timing-function: linear;
    animation-iteration-count: infinite;
    animation-duration: 10s;
    opacity: 0;
  }
  .scan-state-1 { animation-name: scanState1; }
  /* ...same five keyframes the scroll-linked version already defines */
}
```

No `@supports` check, no `animation-timeline` at all — a plain looping
`animation` runs on the browser's default clock, which has worked
everywhere for over a decade. That's a deliberate choice, not just a
simpler one: it sidesteps the whole question of whether a specific real
phone's browser supports scroll-driven animations as robustly as
desktop Chrome does, rather than trying to answer it. The captions
underneath just become an ordinary compact list — the same
`.lp-step`/`.lp-list` markup used everywhere else in this app, with no
special spacing rule applied on phone at all.

**Why the captions stayed, rather than being cut.** `ScanAnimation`'s
graphic is `aria-hidden="true"` — deliberately, since a screen reader
has no good way to describe an illustration that's mid-crossfade between
two of five states at any given moment. The captions are what actually
carry this section's content in accessible text. Removing them on phone
to fix a layout bug would have solved that bug by introducing a
different one: a phone user relying on a screen reader would reach "How
it works" and find nothing there at all. The option to drop them
outright was offered directly and deliberately not taken, once that
trade became clear.

**Confirming the fix the same way the bug was found.** Re-ran the same
Playwright check against the same iPhone 13 profile: the five states now
cycle on their own, with no scrolling, over about ten seconds; the whole
"How it works" section's height dropped from roughly 2197px to 914px —
not a small tweak, closer to a third of its former size — and a
full-page screenshot showed the section finally reading at the same
visual density as the rest of the page around it. Then re-ran the
*original* desktop check too, to make sure fixing phone hadn't quietly
broken the thing 14.9 had just gotten working: the scroll-linked
crossfade and the sticky pin both still behaved exactly as before,
because the wide-screen CSS rules were untouched — only gated more
precisely (`@supports (...) and (min-width: 64em) and
(prefers-reduced-motion: no-preference)`) so they only apply where a
second column actually exists to make the scroll-runway make sense.

## Step 15 — Crossed-out glyphs (code-done; real-scan verification still needed)

It started with a photo. Q1 read "~~6~~ 5": the grader wrote 6, struck it
out, and wrote 5 beside it. Q2 was "~~4~~ 3". The app flagged both as
blank, which was safe but not useful. Here is why, and what changed.

### Why the old model couldn't handle it

The digit CNN had exactly ten outputs, one per digit. Whatever you feed a
classifier, it has to pick one of its classes, so a scribble came back as
*some* digit. On Q1 the struck 6 read as "6" at 0.91 confidence. Across a
practice page of 164 crossed-out glyphs, the old model called 95 of them
a confident digit, most often 8.

On a mark cell the constrained decoder rescued it by accident: "6 5"
isn't a legal mark out of 5, so the cell was flagged. On an ID box
nothing rescues it. A struck digit just became a wrong digit.

### An 11th class

[`cnn/classes.py`](backend/cnn/classes.py) adds `CROSSED_OUT = 10`,
**after** the digits, so `probs[7]` still means "probability this is a
7" everywhere that was already written.

A model needs examples of the new class, and there were almost none. They
came from two places:

- **Practice pages.** You wrote digits in rows on plain paper: some pages
  clean, one page all crossed out. [`cnn/pages.py`](backend/cnn/pages.py)
  cuts a page into glyphs and takes each glyph's label from its row, as
  written in `training_data/pages/pages.json`. A row of scribbles labels
  itself, because the digit under a scribble doesn't matter.
- **Synthetic strikes.** [`cnn/strikes.py`](backend/cnn/strikes.py) draws
  slashes, hatching, zigzags and looping scribble over EMNIST digits.

The synthetic part had two traps, and both are worth knowing.

**Trap 1: the model can learn the wrong thing.** Real crops at inference
go through `_to_canvas`, which binarizes them. Raw EMNIST is soft grey.
If only the struck samples had gone through `_to_canvas`, "binarized"
would have meant "crossed out", and the model could score perfectly on
that shortcut without ever looking at a stroke. So clean EMNIST digits go
through the exact same render:

```python
def render_clean(digit28, digit, rng):
    img = _photo_space(digit28, _thinning(rng))
    ...
    return _to_canvas(img)
```

**Trap 2: some "crossed-out" digits are real digits.** One straight line
through a 1 *is* a 7, or a 4, or a plus sign. So a 1 or 7 never gets a
single line (`SINGLE_LINE_AMBIGUOUS`). That still wasn't enough. The
first trained model called a real student's continental 7 (a 7 with a
bar through the stem) crossed out at 0.79. EMNIST is American
handwriting and has almost no barred 7s, so the model had only ever seen
"7 with a line through it" labelled as crossed out. The fix was to teach
it the barred 7 *as a 7* (`_crossbar`, `BARRED_SEVEN_FRACTION`), which
dropped that glyph to 0.58. Raising the threshold instead would only
have hidden the problem.

### Training without starting over

Training from scratch takes hours on this CPU. `train.py --init-from`
loads the old 10-class weights into the 11-class model instead
(`load_widened`). The ten digit rows of the last layer are copied over
unchanged, and only the new row starts from nothing. Two short runs, about
35 minutes in total.

### Measuring it honestly

[`cnn/crossed_accuracy.py`](backend/cnn/crossed_accuracy.py) reports two
numbers on purpose, because they cost different things:

- **Caught:** crossed-out glyphs from rows held out of training. Missing
  one is the old behaviour: flagged, no worse than before.
- **False calls:** clean digits from `testset/` (about 20 writers, never
  trained on) called crossed out. This is the expensive mistake, because
  it drops a real digit from a cell.

With `--sweep` it prints both at several thresholds. At the chosen 0.8:
33 of 36 caught, 1 of 328 false calls. That one false call is a serial
"99" whose two 9s touch, so the segmenter hands the model one blob. That
cell was going to be wrong regardless.

### What the app does with it

In [`app/recognizers/local.py`](backend/app/recognizers/local.py), each
glyph goes through the model once, and the same probability vector serves
both the crossed-out check and the decoder:

```python
crossed = {i: is_crossed_out(p, CROSSED_OUT_FLOOR) for i, p in probs.items()}
```

- **ID box:** a crossed-out glyph gives `?`. If the section has a class
  list, the existing one-candidate match (`rosterMatch.ts`) can still
  suggest the student.
- **Mark, total, serial:** the value is left **blank**. The struck glyphs
  are dropped and the rest is decoded against the same legal values. The
  result goes in `suggestions`, never in the value.

That last point is the project's "flag, never guess" rule. On Review a
crossed-out field shows **Crossed out** and, if something decoded, a
**Use 5** button. The field stays empty until you tap it.

Harvesting refuses every crossed-out cell (`crossed_out_fields`, the same
mechanism as N31). The crop still holds the struck-out answer, and
labelling it with your correction would teach the model that a scribble
is a 5.

### What it did to the old numbers

Adding your real handwriting helped the ordinary digits too: ID per digit
went from 91.8% to 93.4%, serial from 63.2% to 68.4%, total from 89.5% to
94.7%, and marks read confidently wrong from 1 to 0. Nothing went down.

### Still open

- Every crossed-out example is from one writer. For marks that's the
  right writer, since you write the marks. For IDs and serials, which
  students write, it isn't.
- If the correction touches its crossing-out (Q3 in the original photo),
  the segmenter returns one blob. That cell is flagged crossed out with
  no suggestion, and splitting it is a separate problem.
- It hasn't been used in a real scanning session on the phone yet.

### Follow-ups after the first live test (2026-09-24)

**"The scan is missing half marks now."** It was worth measuring before
changing anything. I built 120 half marks like "2.5" out of your own
practice-page digits and ran them through both models:

| Dot | Old model right | New model right | Old model *wrong number filled in* |
|---|---|---|---|
| Clear dot | 114 | 116 | — |
| Tiny dot | 3 | 3 | — |
| Dot touching a digit | 17 | 17 | 78 |

The new model didn't break half marks. When the dot touched a digit, the
old one quietly wrote "2" for 2.5, which looks like it worked. The new
one leaves the cell blank instead. The real weakness in both is the
segmenter: a tiny dot falls under the noise floor, and a touching dot
merges into its digit, so the decoder sees "2 5" with no point.

`_missing_point` in [`local.py`](backend/app/recognizers/local.py)
handles the first case safely. If a cell failed to decode, no point was
found, and putting one before the last glyph gives a legal value, that
value is offered as **Use 2.5**. It is never filled in. With a tiny dot,
correct results went from 3 to 93 out of 120, and there were no wrong
suggestions.

**Deleting a section or quiz no longer needs an export first.** It still
asks you to type the name. If something was never exported it now says
so ("Never exported — these marks exist only on this device") instead of
refusing. The semester purge still refuses, because the app offers it
unprompted and it removes every section at once.

**Review's messages.** A mark field is 4.5rem wide, and a sentence under
it wrapped into five lines. Now each field gets one word (`Invalid`,
`Unclear`, `Crossed out`) and a Use button when there is a reading to
offer. The sentence appears once, at the top of the card. One rule,
`fieldStatus`, decides the word for every field, so the questions, total
and serial can't drift apart.

## Step 16 — A second paper layout, no Serial box (both phases code-done; real-paper check still needed)

You wanted to print papers two ways: the layout we already have (ID,
Serial, Marks), and a new one with a `Name | Section` table on top, then
the ID row, then the marks, and **no Serial box at all**. The one hard
rule was that the current flow must not break.

Phase A is the backend half, Phase B the frontend. Both are built; the
Phase B part is further down.

### How the scanner tells the two layouts apart

It doesn't guess. Each quiz carries a setting, `hasSerial`, and the scan
request sends it. On the backend it's one new field on `QuizConfig` in
[`models.py`](backend/app/models.py):

```python
hasSerial: bool = True
```

The `= True` is what protects the old flow: a request that doesn't
mention the field, like every request today, is treated exactly as
before.

The detector already found the ID and Serial by position. It took the box
closest above the marks table as the Serial and the next one up as the
ID. With the setting off, it takes the closest box as the ID and ignores
everything higher, which is where the Name/Section table sits. That's
the whole change in [`detection.py`](backend/app/detection.py):

```python
if has_serial:
    serial_table = above_marks[0] if len(above_marks) >= 1 else None
    id_table = above_marks[1] if len(above_marks) >= 2 else None
else:
    serial_table = None
    id_table = above_marks[0] if len(above_marks) >= 1 else None
```

The old two lines are still there, untouched, inside `if has_serial:`.

### Why a wrong setting can't cause a silent misread

This is the reason for an explicit setting rather than a guess. The two
layouts put a different number of columns where the other one expects a
box:

- Setting **on** but paper **B**: the closest box is the ID row
  (8 columns), which the detector expects to be the Serial (2 columns).
  It fails with `column_count_mismatch`.
- Setting **off** but paper **A**: the closest box is the Serial box
  (2 columns), which it now expects to be the ID (8 columns). The same
  failure.

Either way you get a failed scan, never a wrong ID. Tests pin both.

### Everything else just skips the serial

The same `has_serial` value (defaulting to `True`) is passed down to
everything that touches the serial:

- The CNN recogniser ([`local.py`](backend/app/recognizers/local.py))
  doesn't read one, and doesn't flag it as unclear, because there's
  nothing to be unsure about.
- The Gemini path ([`marks.py`](backend/app/marks.py)) leaves the serial
  tile out of the picture it sends and the serial line out of the
  prompt, and discards any serial that comes back anyway.
- The local OCR fallback ([`marks_ocr.py`](backend/app/marks_ocr.py))
  skips it too.
- Harvesting never saves a serial crop for a no-serial quiz, even if one
  is sent ([`main.py`](backend/app/main.py)).
- `detect.py` and `batch_detect.py` take `--no-serial`.

### How "nothing broke" was checked

Reasoning about the diff wasn't enough, so before the first edit I
captured everything Phase A could change, for all 30 test photos:
`detect()`'s result, `detect_any_orientation()`'s result, a hash of every
cell crop both of them wrote, and the full `/api/scan` response through
the real app. I ran it twice first to confirm it's deterministic, since
two identical runs had to match before a difference could mean anything.
After the changes, the same capture was **byte-identical**. The 285
existing tests pass unchanged too.

### The layout B test photos are real photos

Drawing fake handwriting would test the wrong thing. Instead,
[`make_layout_b.py`](backend/tests/fixtures/layout_b/make_layout_b.py)
takes four real class photos (3, 5 and 8 questions), inpaints just the
Serial box's ink away so the paper texture stays, and draws a
Name/Section table above the ID row. The ID and marks cells are still the
original pixels. So the test is strict: a layout B scan has to read
**exactly** what the original photo read as layout A. It does, on all
four, including two IDs with an unreadable `?` digit.

One of them also has a neighbouring script's tables at the top and
bottom edges of the frame, and those are still ignored.

### One thing the new tests exposed

The backend has a rate limit of 30 scans a minute per client, and in
tests it's one shared counter for the whole run. The new tests make
about 17 real scans, so the observability tests that ran right after
them got `429 Too Many Requests`. Nothing was wrong with the code. The
new test file now turns the limiter off for its own tests only. Worth
knowing: any future test file that makes lots of real requests will hit
the same thing.

### Phase B: what you'll see

**On the new-quiz form** there's a tick box, "Serial box on paper". It
starts ticked, or matches whatever the section's last quiz used. Untick
it for a Name/Section paper. If the section has no class list, a warning
appears, because with no serial and no list nothing can catch a misread
ID. It doesn't stop you.

**The section form no longer asks for ID digits.** IUB IDs are always 7.
The input is commented out in
[`SectionForm.tsx`](frontend/src/SectionForm.tsx), not deleted, and a new
section still saves 7.

**On Review**, a no-serial quiz has no Serial field, and Confirm needs an
ID. If a scan fails with `column_count_mismatch`, Review now says which
way round the Serial setting is and what to change, on both kinds of
quiz, since a wrong setting is the likeliest cause.

**On Results**, there's no Serial column, and a record is "verified" when
its ID is on the class list. Without a class list every record is
flagged "no class list", which is honest: nothing checked it.

### How old quizzes are kept exactly the same

One small function in [`sections.ts`](frontend/src/sections.ts) decides
the setting for every screen:

```ts
export function hasSerialBox(assessment) {
  return assessment.hasSerial !== false;
}
```

A quiz saved before today has no `hasSerial` at all, which is not
`false`, so it has a Serial box. No database upgrade was needed, and the
config sent to the backend for an old quiz is exactly the same object as
before: `hasSerial: false` is only added when it's actually false.

### Two things I changed from the plan, and why

**The class-list workbook keeps a blank Serial column.** The plan said to
drop it. But when you re-pick or re-upload your workbook, the app finds
the class list by ruling out the sheets it wrote itself, and it
recognises those by their Serial column
([`roster.ts`](frontend/src/roster.ts), `hasExamSignature`). A no-serial
exam sheet also has STUDENT ID and STUDENT NAME, so without that column it
could be mistaken for your class list. The plain download does drop it;
it has no names in it, so it can never be taken for a class list.

**The same ID scanned twice is treated as a duplicate.** On a normal quiz,
same ID with a different serial is a warning: one of them was misread.
With no serial, a second record with the same ID is almost certainly the
same script scanned twice, so you get "Overwrite earlier record" or
"Cancel". If the ID was actually misread, fix it and the block goes away.

### Real-browser tests: Playwright

The Vitest tests run in jsdom, a pretend browser with no layout and no
camera. So "does the new tick box look right on a phone" and "does the
capture flow still work" couldn't be checked there. Playwright is now part
of the project for exactly that: `npm run test:e2e` starts the app,
opens it in a real Chromium sized like a Pixel 7, with a fake camera, and
clicks through it like a person would. The backend's answer is faked
(`page.route`), so it needs no Python.

The first run found a real miss in the Phase B work: on the Scan screen,
every capture on a no-serial quiz was listed as "ID 1912345 · **Serial ?**
· Total 7", which looks like a failed read. Fixed in
[`Scan.tsx`](frontend/src/Scan.tsx). The screenshots also showed the new
"no class list" badge made the Results table wider than the phone, so the
badges now say "no list" and "not on list".

One thing it measured that step 16 didn't cause: the Results table was
already wider than a phone screen, even with two questions, and scrolls
sideways. That's how it's always been; it's written down, not changed.

### What's left

The real check, which only you can do: print a layout B page, fill it in,
photograph it and scan it. Also scan one normal (layout A) page the same
day, to see the old flow still works end to end on your phone.

## Grid detection: partial scans, grid repair, and Save photo (2026-09-25)

Written after this work was done and tested. The same test photos pass as
before, and one that used to fail now reads. The new Save photo button still
needs a real phone.

### Why "column count mismatch" was so annoying

The detector finds three printed tables on each script: the ID row, the
Serial box and the marks table. Before today, if **any one** of them had the
wrong number of columns, the whole scan failed. One faint line in the ID row
meant typing the serial and every mark by hand as well, even though those
tables were read fine.

### Finding the real cause first

A small diagnostic ran every labelled photo through the detector with its
correct quiz setup. Only one failed: `real_class_11`, whose ID row came out
with 7 columns instead of 8. Tracing every candidate line in that row showed
exactly what happened:

```
x= 183  coverage 0.55  DROPPED (too weak next to its neighbours)
x= 371  coverage 0.61  kept
...                    up to 1.00 on the right
cell widths = [371, 192, 191, 190, 189, 189, 190]
```

"Coverage" is how much of a line's length is dark enough to count as ink.
The lighting fades toward the left of that photo, so every line on the left
looks weaker. The missing line passed the normal bar (0.40). A second filter
then threw it away, because it was under 65% of the *typical* line in the
table. That filter exists for a whiteboard photo with a stray line. The
widths give the mistake away: the first cell is 371px, which is exactly two
190px cells stuck together.

### Fix A — a partial scan instead of a failed one

[`detection.py`](backend/app/detection.py) now writes **no crop images** for
a table whose column count is wrong:

```python
if cand.col_count != expected[name]:
    continue   # no id_d1.png ... for a miscounted ID row
```

That line is what makes the rest safe. With 7 columns instead of 8, files
`id_d1`..`id_d6` would exist and hold the wrong boxes. Now they simply
don't exist, so nothing can read them.

[`main.py`](backend/app/main.py) then reads only the tables that matched. The
result says `status: "ok"`, plus a `table_mismatches` list like
`[{"table": "id", "found": 7, "expected": 8}]`, and the unread fields come
back blank and flagged. On the `remote` path, Gemini is only called when the
marks table itself matched.

Two cases still fail the whole scan, on purpose:

- **Every table is wrong.** There is nothing left to read.
- **The "Serial box on paper" setting doesn't match the paper.** The ID is
  picked by *position* (second box above the marks, or first when there's
  no serial). A wrong setting shifts that pick onto a different box, such as
  the Name/Section table. If that box happened to have 8 columns, it would
  be read as a student ID. So `_is_partial` spots the signature (the box
  taken as the Serial looks like an ID row, or the reverse) and fails
  loudly. That's a per-quiz mistake, so it should be fixed once, not typed
  around on every script.

On the phone, [`Review.tsx`](frontend/src/Review.tsx) shows a warning such as
"Student ID row: found 6 digit boxes, expected 7". The backend counts the
"ID" label as a column; the message counts only the boxes a person sees.

### Fix B — repairing a grid when the evidence is clear

`_repair_columns` fixes a table that is off by **exactly one**:

- **One too few (ID or marks):** put back a line that the detector really
  saw, that clears the normal 0.40 coverage bar, and that makes the boxes
  evenly spaced. Nothing is ever drawn by dividing a width by a count.
- **One too many (ID only):** remove a divider when it has split one box in
  two.

If two different changes would both work, that's ambiguous, and it fails
the old way.

Writing the tests found a real bug in the first version. On a paper with
**8** digit boxes under a 7-digit setting, removing the line between the
"ID" label and the first digit left the digit boxes perfectly even, because
the label isn't part of that evenness check. It would have hidden the first
digit inside the label and read every other digit one box off. So the rules
also check the cells right next to the change:

- a removal needs **both** neighbouring cells to be too narrow (a split box)
- a restore needs **both** new halves to be one box wide, the label side
  included. real_class_11's halves are 183 and 188 against a 190px box.

Most of [`test_grid_repair.py`](backend/tests/test_grid_repair.py) is these
refusals.

### How "nothing broke" was checked

- Before any code changed, every photo was run 99 ways (correct setup,
  default setup, Serial on and off, and the layout B fixtures), hashing the
  detector's full output.
- After the changes, every run that passed before is **byte-identical**. The
  only status change is `real_class_11` going from failed to ok.
- The overlay shows the restored line on the printed one. The CNN reads
  `5?7890?` against the true `5678900`: two digits flagged, none wrong. Its
  8 marks, serial and total are all right.
- ID accuracy rose from 170/182 to 175/189 correct digits; marks from
  103/105 to 111/113. Confidently wrong reads are unchanged: 1 on the ID
  (the same old case) and 0 on marks.

### Save photo

The failure banner and the partial-scan banner both have **Save photo**. It
downloads the exact capture the backend saw, keeps it on the phone, and
names it by reason and time (`scan-partial-2026-09-25-14-30-12.jpg`), never
by anything read off the script. The backend still stores nothing.

These are real scripts with real student IDs, so they go in
`testset/private/` (gitignored), never `testset/images/`.

### One test-suite bug this exposed

The backend's rate limiter (30 requests a minute) was a single object shared
by the whole test run. The new endpoint tests pushed the run over 30, so an
unrelated logging test got a 429 and failed. It looked like a logging bug.
[`tests/conftest.py`](backend/tests/conftest.py) now empties the limiter
before each test.

### What's left

- Real phone checks: does Save photo land somewhere you can find it (Files
  or Downloads on Android; iOS Safari asks first), and does a real partial
  scan feel right?
- Collect the failed photos into `testset/private/`. One case isn't enough
  to judge the parked idea (fix C: comparing each line with its neighbours
  instead of the whole table's median).

## Half marks: finding the decimal point (2026-09-25, "option 2")

Written after the work was done and measured. Needs a real scan to confirm
on paper; everything below was measured on real handwriting.

### How a half mark is read

Nothing reads "2.5" as a whole. [`cnn/segment.py`](backend/cnn/segment.py)
cuts a mark cell into blobs of ink. A blob that is small and low down is
the decimal point, decided by geometry alone. The digit model reads the
others. [`cnn/decode.py`](backend/cnn/decode.py) then tries every allowed
mark for that question and keeps the best fit. So everything depends on
finding the dot.

### What your practice page showed

You wrote 15 rows of half marks on plain paper.
[`cnn/half_marks_accuracy.py`](backend/cnn/half_marks_accuracy.py) cuts that
page into single values, crops each one like a mark cell, and reads it
exactly as a real scan would. It also re-reads all 493 harvested mark cells.
Those are about 90% whole marks, which is what catches a looser dot rule
inventing a dot on a "15".

Before any change, 121 of your values read like this: 102 right, 7 offered
as a one-tap choice, 10 blank, and **2 wrong values stored without a flag**.
The misses had three causes:

1. **Mid-height dots** (your point). Seven clear dots sat 37–49% of the way
   down. The rule required at least 50%, so each dot went to the digit
   model as a "digit", and the value came back blank.
2. **Dots below the speck filter.** A pen dot of 0.13–0.15% of the cell,
   just under the 0.15% floor, was thrown away. That's how both wrong reads
   happened: "2.5" became a confident **25**.
3. **Touching digits.** In "20.5" the 2 and 0 touched, so they became one
   wide blob. The model read it as "2", and the value became a confident
   **2.5**.

### What changed

The old rule is untouched and still gives a **strong** point. New rules add
a **weak** point:

- A round blob (neither side more than 2× the other), **between two
  digits**, anywhere below the top quarter of the writing.
- A blob under the speck floor, if it's round, between two digits, and at
  least 2% of a digit's own ink. Specks of paper are under 1%.

The decoder in [`app/recognizers/local.py`](backend/app/recognizers/local.py)
(`_resolve`) treats a weak point with suspicion. It reads the cell **with
and without** it:

```
"2" weak-dot "5", out of 5   ->  2.5 is allowed, 25 isn't   ->  value 2.5
"2" weak-dot "5", out of 25  ->  both are allowed           ->  choices [2.5, 25]
"1" weak-dot "0", out of 10  ->  "1.0" is never written     ->  value 10
```

Two more rules only ever add choices, never a value:

- **Ink between the digits that isn't a dot** (a smudge): "15" might be
  "1.5", so on a Total where both are allowed you get [1.5, 15].
- **A glyph as wide as two digits**: cut it at a few positions and read the
  best cut. If that gives a *different* allowed value, both are offered.
  Width alone proves nothing: students write "2" up to twice as wide as
  tall, and a width-only rule turned 27 of 430 harvested whole marks into
  choices before it was narrowed to this.

Review shows each choice as its own **Use** button, and nothing is filled
in until you tap one. A tied field is also "unmatched", so harvesting never
saves its crop with a guessed label.

### The numbers

| | Correct | Choice | Blank | Wrong |
|---|---|---|---|---|
| Your page, 121 half marks, before | 102 | 7 | 10 | **2** |
| Your page, after | **111** | 7 | 3 | **0** |
| Harvested half marks (63), before → after | 54 → 56 | 2 → 0 | 4 → 4 | 3 → 3 |
| Harvested whole marks (430), before → after | 424 → 423 | 0 → 1 | 3 → 3 | 3 → 3 |

- The one whole mark that became a choice is a Total "15" with a faint grey
  smudge just after the "1". It now offers 1.5 or 15, which is fair.
- The 3 + 3 harvested wrong reads are all cells the instructor had already
  corrected by hand. They're old misreads, unchanged.
- Your "20.5" that used to read 2.5 now offers **2.5 or 20.5**. The harness
  skips it by default, since the merged "20" looks like one digit; run
  `--all-crops` to see it.
- The real test photos haven't moved: 111/113 marks, 0 wrong. The ID and
  crossed-out checks are unchanged too.

### Two bugs caught while building it

- The first version stored the "ink between digits" flag on the recognizer
  object. That object serves several scans at once from the backend's
  thread pool, so two scans could swap flags. It's now passed back through
  the function call.
- The rescue rule first compared a dot's ink against a digit's *bounding
  box*, two different measures. It now compares ink to ink, so pen weight
  cancels out. That alone lifted your page from 107 to 111 correct.

### What's left

- Scan real half marks on the printed grid, including tiny dots and dots
  touching a digit. This page was plain paper, cropped by a script.
- ~~A dot touching a digit is still not split off.~~ Done later the same
  day; see "Dots tucked inside a digit" below.

### Dots tucked inside a digit, and harvesting partial scans (2026-09-25, later)

**The "touching" dots mostly weren't touching.** Looking at the remaining
misses showed something else: the dot sat *inside a digit's outline*. It
might be under a 7's top bar, or under the long base of a 2. Two rules
missed it:

- **The pen-lift rule.** It re-joins a digit written in two strokes, and it
  folded the dot into the 7.
- **"Between two digits".** It wanted a digit *wholly* to the dot's left,
  and a 2's base reaches past the dot.

A thickness test was tried first and dropped. The idea: a filled pen dot
is thicker than a pen stroke. But 43 of 60 two-digit whole marks have
thick spots anyway (stroke junctions, pen pressure), so it would have
invented dots everywhere. Measured, not guessed.

What [`segment.py`](backend/cnn/segment.py) does now:

- **"Between" uses digit centres, not edges.** A dot counts if one digit's
  middle is to its left and another's is to its right.
- **The merge remembers which pieces it joined** (`_merge_with_members`).
  A piece that's small, round, below the top quarter and between digit
  centres is taken back out as a weak point, and its pixels are blanked
  from the digit the model reads. If no piece qualifies, the merge stands
  exactly as before, so a two-stroke 4 is still one 4.

Result: your page went from 111 to 114 of 121 correct, and harvested half
marks from 56 to 58 of 63. Whole marks and wrong reads didn't change.

**Partial scans now feed the training data too.** On Confirm,
`/api/harvest` re-runs detection. It used to give up on any mismatch,
throwing away the tables that were read fine. Now it accepts the same
partial result `/api/scan` does. There's no risk of labelling a wrong box:
a miscounted table has no crop images at all, and harvesting only saves
images that exist. So an ID you typed by hand for a miscounted ID row has
nothing to be attached to. A wrong "Serial box on paper" setting is still
refused completely.

### Still open

- Your page is at 114/121. Of the rest, 4 are the intended ties (2.5 or 25,
  where both are allowed). The others are a harness crop that caught a
  sliver of the next value, the touching "20.5", and one "5.5" whose last
  5 reads like a 9.
- A point written as a short **dash** is found only when it sits in the
  lower half, because the round-blob rule excludes dashes on purpose. On
  your page the dash was low enough; a dash at mid-height would be missed.

### One folder for every question's crops

Harvesting used to file each question separately: `marks_q1/`, `marks_q2/`,
and so on. That told the model nothing. The position doesn't even say what
the question was out of, since Q1 is out of 5 in one quiz and out of 10 in
another. It also scattered one kind of data across up to eight folders.

Now [`harvest.py`](backend/app/harvest.py) puts every question's crop in
`marks_questions/`. The Total keeps its own `marks_total/`, because it's a
different kind of value (two digits, up to 50).

Older crops still sit under `marks_q1/`... in the S3 bucket and MinIO. Those
weren't rewritten, because that would be a change to live data.
[`fetch-crops.sh`](fetch-crops.sh) instead folds them into `marks_questions/`
every time it builds the training set. It uses `mv`, which keeps each
crop's fixed timestamp (the one that stops a student's digits being put
back in order by date). A run with nothing left to fold says nothing. The
two local folders were folded once: 105 and 408 crops moved, totals
unchanged.

### Crops from the hosted site are held apart (issues.md N40, N45)

When you tap Confirm, the app sends the photo and the values you confirmed
to `/api/harvest`, and the backend saves each cell labelled with that value.
On the laptop, only you can send those requests. On the hosted site, anyone
with the URL can send one straight to the server, with any picture and any
labels they like. A crop labelled "7" that actually shows a "3" would
quietly teach a future model the wrong thing, and nothing would tell it
apart from a real one.

So the hosted site now files its crops under **`unverified/`** in the S3
bucket instead of `harvested/`. It's the same layout, one folder per
browser (source), just in a place no training step reads. When you want
them:

```bash
# Download them into a separate folder, with a count per source:
AWS_PROFILE=marks-scanner ./fetch-crops.sh review marks-scanner-crops-105322541848

# Look through backend/training_data/unverified/<source-id>/. Each filename
# starts with its label, so "7_ab12....png" should show a 7. Then:
./fetch-crops.sh promote <source-id>
```

`promote` copies one source into the training set, and only that one, so a
browser whose crops look wrong can simply be left out. It refuses anything
that isn't a plain source id (a name like `../etc` is rejected), and it
keeps each crop's fixed timestamp.

Separately, the Library screen has a **"Share anonymised cells to help
improve recognition"** switch, on by default. Turned off, Confirm sends
nothing to `/api/harvest` at all. The choice is saved on the device and
survives "Reset everything", so clearing marks can't quietly turn sharing
back on.

### Security headers (issues.md N43)

Security headers are instructions a site gives the browser about itself:
"only ever reach me over HTTPS", "don't let another site put me inside a
frame", "only run scripts that came from me". The app sent none.

They now come in two halves:

- **Which scripts and styles may run** goes inside the page, as a `<meta>`
  tag written at build time by
  [`frontend/scripts/csp.mjs`](frontend/scripts/csp.mjs). The landing page
  has one small inline script and one inline stylesheet, and the policy
  names exactly those two by their SHA-256 fingerprint, so anything else
  inline would be refused. Because the fingerprints are written into the
  same file they describe, they can't get out of date: change the landing
  CSS and the next build writes a new fingerprint with it. `blob:` is
  allowed for the two things that use it: the photo preview, and Confirm
  re-reading that photo to send it for harvesting.
- **Everything a `<meta>` can't do** comes from CloudFront as real headers
  ([`aws/headers_policy.py`](aws/headers_policy.py)):
  - HTTPS only
  - never inside another site's frame (so no one can overlay invisible
    buttons on the app)
  - no guessing file types
  - the camera allowed for this site only

The proof is a browser test against the real production build
(`npm run test:e2e:prod`). It opens the landing page, lets the offline cache
register, scans with a fake camera, confirms, opens Results and downloads
the Excel file, and fails if the browser reports a single blocked thing.
To check that it can fail, `blob:` was removed from the policy once: the
Confirm step was blocked and the test went red.

One trap for later: a `style="..."` attribute added to the landing page's
markup would be blocked in production but work fine in `npm run dev`, which
has no policy. `npm run test:e2e:prod` is what catches it.

### The laptop is private unless you ask (issues.md N44)

For the phone to reach the laptop, the laptop's two servers used to listen
on the whole Wi-Fi network, every time. On campus Wi-Fi that's everyone on
campus: anyone could send the laptop scans, write crops with any labels
into its trusted `harvested/` folder, or poke at the Vite dev server.

You grade on the deployed site, and use the laptop with the phone only to
test. So the default flipped:

```bash
./dev.sh            # this machine only — the phone can't connect
./dev.sh --lan      # a phone testing session: the whole network, until Ctrl+C
```

(`.\dev.ps1` and `.\dev.ps1 -Lan` on Windows.)

A `--lan` session also sends its crops to `training_data/unverified/`, like
the hosted site's, so test scans never feed the training set by accident.
Checked by running both scripts and asking Windows what each server was
listening on: `127.0.0.1` by default, every interface with `-Lan`. A test
harvest during a `-Lan` session landed 14 crops in `unverified/` and none in
`harvested/`.

## Lighting: the blur check that was really measuring darkness (2026-09-25)

You saw scans failing as "blurry" until the room lights went on. The server
logs agreed: 10 "blurry" failures in five minutes, then mostly successes.

**Why it happened.** The blur check measured how strong the edges in the
photo were. But a dim photo has weaker edges everywhere just because there's
less difference between the white paper and the black ink. So a perfectly
sharp photo taken in a dim room looked "blurry". An experiment on the real
test photos, darkened to half brightness, showed 18 of 28 rejected as blurry,
while the grid reader could read all 28.

**The fix.** [`detection.py`](backend/app/detection.py)'s `_sharpness` divides
the edge strength by the photo's own overall contrast, so dimming cancels
out. The limit (0.115) sits between the good test photos (all 0.134 or more)
and the one genuinely blurry photo (0.101). Darker photos now score higher,
not lower. Every photo that passed before gives exactly the same result.

**Saying why.** When a scan fails or is partial, the backend now also
measures:

- **how white the paper came out** (the 90th-percentile grey; normal photos
  are about 178). Under 70 it reports `too_dark`.
- **how even the light is**: the page is cut into a 4×4 grid, and the darkest
  square's paper level is divided by the brightest's. Under 0.6 it reports
  `uneven`, meaning a shadow.

Review turns that into a sentence ("The photo looks too dark. Turn on a light
(or tap Light on the camera), then retake.").

**Before you tap.** [`lighting.ts`](frontend/src/lighting.ts) takes a tiny
160×90 copy of the part of the viewfinder inside the dashed guide, 2–3 times
a second, and applies the same two measures. If two readings in a row agree,
a hint appears: "Too dark" or "Shadow on the page". It never stops you
capturing.

**The Light button.** Phones' browsers can switch on the camera's torch (a
steady light; there's no flash for a web page). The button only appears if
your camera says it has one, and the app never turns it on by itself.

**How it was tested.** Besides ordinary tests, a real browser was given fake
camera videos: an evenly lit page, a dark one, and one with a shadow over
half of it. It showed the right hint each time. A fourth test pretended the
camera had a torch and checked that it only switched on when the button was
tapped.
