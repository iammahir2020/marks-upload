"""The model's output classes, and nothing else.

Torch-free on purpose, for the same reason cnn/thresholds.py is: the app
reads these at inference time (app/recognizers/local.py), and model.py —
the other natural home — imports torch, which the running app must never
need.

Classes 0-9 are the digits themselves, so a class index still IS the digit
it names and `probs[d]` keeps meaning "probability this glyph is the digit
d" everywhere it was already used. CROSSED_OUT is appended after them
rather than inserted anywhere, which is what keeps that identity intact.
"""
from __future__ import annotations

NUM_DIGITS = 10

# A glyph the writer struck through or scribbled over — the student's
# abandoned first answer, not a digit to read (plan.md §16, "Crossed-out
# glyphs"). Without this class the model has no way to say "this is not a
# digit": measured on a real page of 164 crossed-out glyphs, the 10-class
# model read 95 of them (58%) as a CONFIDENT digit, most often 8.
CROSSED_OUT = 10

NUM_CLASSES = NUM_DIGITS + 1
