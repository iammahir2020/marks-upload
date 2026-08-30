"""The digit CNN architecture (step.md step 2r.1, plan.md §16 "Model and
training"). Deliberately small — this is MNIST-class difficulty, and a
bigger model buys nothing but latency (~150KB as ONNX, sub-millisecond per
batch on CPU is the target).

Shared between train.py (training), export/parity checking, and eventually
app/recognizers/local.py (step 3r.4) — the architecture must match exactly
between training and inference, so it lives in exactly one place.
"""
from __future__ import annotations

import torch
from torch import nn

NUM_CLASSES = 10  # digits 0-9 only — the decimal point is pure geometry,
                   # not a class (plan.md §16), so a standard digit
                   # dataset like EMNIST works with no relabelling.


class DigitCNN(nn.Module):
    """Conv(1->32)x2 -> pool -> Conv(32->64)x2 -> pool -> FC(128) -> FC(10),
    exactly as specified in plan.md §16. Input: (N, 1, 28, 28) float32,
    already MNIST-normalized (see preprocess.py) - this module does no
    preprocessing of its own."""

    def __init__(self) -> None:
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.Conv2d(32, 32, 3, padding=1), nn.BatchNorm2d(32), nn.ReLU(inplace=True),
            nn.MaxPool2d(2), nn.Dropout(0.25),

            nn.Conv2d(32, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            nn.Conv2d(64, 64, 3, padding=1), nn.BatchNorm2d(64), nn.ReLU(inplace=True),
            nn.MaxPool2d(2), nn.Dropout(0.25),
        )
        # 28x28 -> pool -> 14x14 -> pool -> 7x7, 64 channels
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(7 * 7 * 64, 128), nn.BatchNorm1d(128), nn.ReLU(inplace=True),
            nn.Dropout(0.5),
            nn.Linear(128, NUM_CLASSES),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """Returns raw logits — callers apply softmax themselves (train.py
        uses cross_entropy, which does it internally; inference wants the
        actual probability vector for constrained decoding / confidence,
        per plan.md §16's "Confidence, and when to flag")."""
        return self.classifier(self.features(x))
