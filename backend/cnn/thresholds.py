"""The calibrated decision floors, and nothing else (issues.md N16).

They lived in `cnn/accuracy.py`, and `app/recognizers/local.py` — the
DEFAULT recognizer since step 3r.6e — imported them from there. That put a
CLI tuning harness on the production import path: `accuracy.py` pulls in
argparse, tempfile and `app.detection`, and computes a `TESTSET` path
pointing at a directory the deployed container does not contain, all so the
app could read two floats at Lambda cold-start. Its own docstring says
"Standalone: no `app/recognizers/` import here on purpose" — the dependency
had quietly run the other way.

Nothing here imports anything. Both the harness and the app read the same
numbers from the same place, and neither can drag the other's machinery
along with it.
"""
from __future__ import annotations

# --- ID digits (step 2r.4) ------------------------------------------------
#
# Two signals, per plan.md §16 "Confidence, and when to flag": the top
# class's own probability, and its margin over the runner-up — a near-tie
# is worse than a confident-but-imperfect top score, even at the same max
# probability. Originally calibrated on n=56 real digit reads (one writer,
# 8 photos), where correct and wrong reads fell into two clusters with an
# enormous gap between them (0.586 -> 0.990) — 0.9/0.8 sat safely inside
# that gap. **Recalibrated 2026-08-30 against n=182 real digit reads
# across ~20 different writers** (the real_class_* batch, step.md step 0)
# — with real handwriting diversity, that clean gap doesn't exist anymore:
# correct reads span confidence all the way down to 0.40, and only one
# read in the whole set is both wrong and above 0.75 (a single genuinely
# ambiguous cursive "9", at 0.924/0.887 — no floor below that catches it
# without also flagging a large block of correct reads well above it).
# Measured directly by sweeping candidate floors against raw, pre-floor
# argmax correctness: 0.9/0.8 let through 1 wrong digit but flagged 20
# digits that were actually correct (86.3% pass rate); 0.75/0.6 lets
# through the same single unavoidable wrong digit while recovering 11 of
# those 20 false flags (92.3% pass rate) — same safety, real accuracy
# gain. Going lower than 0.75 confidence starts trading safety for
# recall (3+ wrong digits let through at 0.70). Still provisional in the
# same sense as before — n=182/~20 writers is much better than n=56/1
# writer but still not the full class.
#
# Re-derive with: `python cnn/accuracy.py --calibrate`
CONFIDENCE_FLOOR = 0.75
MARGIN_FLOOR = 0.6

# --- Serial (step 3r) -----------------------------------------------------
#
# Deliberately separate from the ID's floors rather than reusing them: a
# serial is a different field, written under different conditions, and has
# not been recalibrated against the real_class_* batch the way the ID has.
# Genuinely provisional — only one labelled real photo carried ground-truth
# serial values when these were set (testset/labels.json's own documented
# caveat, step.md step 3r.5), so there was no real gap in real data to
# calibrate against. Serial is the weakest field the CNN reads (63.2%), and
# these are the first numbers to revisit when that is addressed.
SERIAL_CONFIDENCE_FLOOR = 0.9
SERIAL_MARGIN_FLOOR = 0.8
