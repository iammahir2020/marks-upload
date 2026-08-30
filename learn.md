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

## Step 8 — Scan loop wiring (in progress — code done, phone test pending)

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
