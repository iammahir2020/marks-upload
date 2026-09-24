#!/usr/bin/env python3
"""Train the digit CNN (step.md step 2r.1/2r.3). EMNIST Digits (240k train
samples, considerably more writer variety than MNIST's 60k) through the
architecture in model.py, with rotation/translation/scale/elastic
augmentation. Exports to ONNX and verifies numerical parity against the
PyTorch model on a fixed batch — "it exports without error" is explicitly
not the bar step.md sets for this.

Since step 15 the model has an 11th class, CROSSED_OUT (classes.py). Its
examples come from two places: EMNIST digits with a synthetic strike drawn
over them (strikes.py), and real crossed-out glyphs from photographed
practice pages (pages.py). The practice pages' clean rows train the digit
classes too — real ballpoint handwriting, which EMNIST alone lacks.

    python cnn/train.py --epochs 10 --out cnn/checkpoints
    # warm start from the existing model — minutes, not hours:
    python cnn/train.py --init-from cnn/checkpoints/digit_cnn_best.pt \
        --epochs 4 --samples-per-epoch 80000 --lr 3e-4
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime
import torch
from PIL import Image
from torch import nn
from torch.utils.data import ConcatDataset, DataLoader, Dataset, RandomSampler
from torchvision import transforms
from torchvision.datasets import EMNIST

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))
from model import DigitCNN  # noqa: E402

from cnn.classes import CROSSED_OUT, NUM_CLASSES, NUM_DIGITS  # noqa: E402
from cnn.pages import load_pages  # noqa: E402
from cnn.preprocess import glyph_to_canvas  # noqa: E402
from cnn.strikes import render_clean, render_struck  # noqa: E402

# One in NUM_CLASSES EMNIST samples is struck, so CROSSED_OUT is about as
# common as any single digit — neither a rare class the model learns to
# ignore nor a dominant one it learns to over-predict.
STRUCK_FRACTION = 1 / NUM_CLASSES

# Each real practice-page glyph is seen this many times per epoch (with
# fresh augmentation each time). ~450 glyphs x 20 is ~9k samples — enough
# to count, still a small minority next to EMNIST, so one writer's style
# cannot take over the digit classes.
PAGE_REPEATS = 20

# Standard MNIST-family normalization constants. EMNIST is built by the
# same NIST collection/format pipeline as MNIST, just with more writers —
# these apply unchanged, and reusing them (rather than recomputing from
# this one download) keeps the normalization independent of any one
# dataset snapshot.
MNIST_MEAN, MNIST_STD = 0.1307, 0.3081

DATA_ROOT = Path(__file__).parent / "data"


class OrientationFixedEMNIST(Dataset):
    """EMNIST ships transposed relative to MNIST — confirmed directly
    against this environment's own download (see learn.md step 2r.1): a
    raw sample renders as a rotated/mirrored digit, and a single transpose
    fixes it. torchvision does not apply this correction itself, which is
    exactly the trap step.md step 2r.1 names. Wrapping the dataset here
    means every consumer (train and val loaders alike) gets the fix
    automatically rather than depending on every call site remembering
    it."""

    def __init__(self, base: EMNIST, transform=None):
        self.base = base
        self.transform = transform

    def __len__(self) -> int:
        return len(self.base)

    def __getitem__(self, idx: int):
        img, label = self.base[idx]
        img = img.transpose(Image.TRANSPOSE)
        if self.transform is not None:
            img = self.transform(img)
        return img, label


class StruckEMNIST(Dataset):
    """EMNIST, rendered the way inference sees a real crop (strikes.py),
    with STRUCK_FRACTION of samples struck and relabelled CROSSED_OUT.

    Clean samples go through the same render too — see strikes.py's
    docstring for the shortcut that prevents. `deterministic` fixes the
    per-sample randomness (which samples are struck, and how) so the
    validation set is the same set every epoch."""

    def __init__(self, base: OrientationFixedEMNIST, transform, deterministic: bool = False):
        self.base = base
        self.transform = transform
        self.deterministic = deterministic

    def __len__(self) -> int:
        return len(self.base)

    def __getitem__(self, idx: int):
        img, label = self.base[idx]
        digit28 = np.array(img)
        # Seeded from torch's per-worker, per-epoch seed so every worker
        # and every epoch draws different strikes; fixed per index for
        # validation.
        seed = idx if self.deterministic else [torch.initial_seed() % 2**32, idx]
        rng = np.random.default_rng(seed)
        if rng.random() < STRUCK_FRACTION:
            canvas, label = render_struck(digit28, label, rng), CROSSED_OUT
        else:
            canvas = render_clean(digit28, label, rng)
        return self.transform(Image.fromarray(canvas)), label


class PageGlyphs(Dataset):
    """Practice-page glyphs (pages.py), preprocessed once with the same
    `glyph_to_canvas` a segmented glyph gets at inference time."""

    def __init__(self, glyphs, transform, repeats: int = 1):
        self.canvases = [glyph_to_canvas(g.image) for g in glyphs]
        self.labels = [g.label for g in glyphs]
        self.transform = transform
        self.repeats = repeats

    def __len__(self) -> int:
        return len(self.canvases) * self.repeats

    def __getitem__(self, idx: int):
        i = idx % len(self.canvases)
        return self.transform(Image.fromarray(self.canvases[i])), self.labels[i]


def build_datasets():
    train_base = EMNIST(root=DATA_ROOT, split="digits", train=True, download=True)
    test_base = EMNIST(root=DATA_ROOT, split="digits", train=False, download=True)

    # Rotation +-10deg, translation +-2px (2/28 as a fraction), scale
    # 0.9-1.1, slight elastic distortion (plan.md §16) — real photographed
    # digits have residual skew deskewing doesn't fully remove. alpha/sigma
    # are deliberately mild relative to torchvision's own defaults (alpha
    # 50) since those are tuned for much larger images than 28x28; checked
    # by eye against a sample grid before committing to these values (see
    # learn.md step 2r.1) rather than assumed.
    train_transform = transforms.Compose([
        transforms.RandomAffine(degrees=10, translate=(2 / 28, 2 / 28), scale=(0.9, 1.1)),
        transforms.ElasticTransform(alpha=8.0, sigma=4.0),
        transforms.ToTensor(),
        transforms.Normalize((MNIST_MEAN,), (MNIST_STD,)),
    ])
    eval_transform = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize((MNIST_MEAN,), (MNIST_STD,)),
    ])

    pages = load_pages()
    page_train = [g for g in pages if not g.holdout]
    page_holdout = [g for g in pages if g.holdout]
    print(
        f"practice pages: {len(page_train)} training glyphs "
        f"({sum(g.label == CROSSED_OUT for g in page_train)} crossed out), "
        f"{len(page_holdout)} held out"
    )

    train_parts = [StruckEMNIST(OrientationFixedEMNIST(train_base), train_transform)]
    if page_train:
        train_parts.append(PageGlyphs(page_train, train_transform, repeats=PAGE_REPEATS))
    train_ds = ConcatDataset(train_parts)
    test_ds = StruckEMNIST(OrientationFixedEMNIST(test_base), eval_transform, deterministic=True)
    holdout_ds = PageGlyphs(page_holdout, eval_transform) if page_holdout else None
    return train_ds, test_ds, holdout_ds


def run_epoch(model, loader, criterion, optimizer, device) -> tuple[float, float, dict]:
    """Returns (loss, overall accuracy, breakdown). The breakdown separates
    what a single accuracy number hides: how well digits are read, how many
    crossed-out glyphs are caught, and — the costly error — how many real
    digits get called crossed out."""
    training = optimizer is not None
    model.train(training)

    total_loss, correct, total = 0.0, 0, 0
    digit_n = digit_ok = digit_called_crossed = crossed_n = crossed_ok = 0
    context = torch.enable_grad() if training else torch.no_grad()
    with context:
        for images, labels in loader:
            images, labels = images.to(device), labels.to(device)
            if training:
                optimizer.zero_grad()
            logits = model(images)
            loss = criterion(logits, labels)
            if training:
                loss.backward()
                optimizer.step()

            total_loss += loss.item() * images.size(0)
            pred = logits.argmax(dim=1)
            correct += (pred == labels).sum().item()
            total += images.size(0)

            is_digit = labels < NUM_DIGITS
            digit_n += is_digit.sum().item()
            digit_ok += (pred[is_digit] == labels[is_digit]).sum().item()
            digit_called_crossed += (pred[is_digit] == CROSSED_OUT).sum().item()
            crossed_n += (~is_digit).sum().item()
            crossed_ok += (pred[~is_digit] == CROSSED_OUT).sum().item()

    breakdown = {
        "digit_acc": digit_ok / max(digit_n, 1),
        "digit_false_crossed": digit_called_crossed / max(digit_n, 1),
        "crossed_recall": crossed_ok / max(crossed_n, 1),
        "crossed_n": crossed_n,
    }
    return total_loss / total, correct / total, breakdown


def load_widened(model: nn.Module, path: Path, device) -> None:
    """Load a state dict into `model`, widening a 10-class output layer to
    NUM_CLASSES: the ten digit rows are copied as they are and the new
    CROSSED_OUT row keeps its fresh initialisation. Everything the old
    model learned about digits survives; only the new class starts cold."""
    state = torch.load(path, map_location=device)
    own = model.state_dict()
    for key, value in state.items():
        if key in own and own[key].shape != value.shape:
            widened = own[key].clone()
            widened[: value.shape[0]] = value
            state[key] = widened
            print(f"widened {key}: {tuple(value.shape)} -> {tuple(widened.shape)}")
    model.load_state_dict(state)


def export_and_verify_onnx(model: nn.Module, out_path: Path, device) -> None:
    """Step 2r.3: export, then check the ONNX runtime's output matches the
    PyTorch model's on a fixed batch — a numerical parity check, not just
    confirmation that export didn't raise."""
    model.eval()
    fixed_batch = torch.randn(8, 1, 28, 28, device=device)

    # dynamo=False forces the legacy TorchScript-based exporter rather
    # than this torch version's new default (torch.export-based, needs
    # the onnxscript package). Deliberate, not just "avoid a new
    # dependency": the dynamo exporter also split this tiny model's
    # weights into a companion `.onnx.data` file rather than one
    # self-contained `.onnx` (confirmed by a smoke test — see learn.md
    # step 2r) — an unnecessary complication for a small, fully static
    # graph with no control flow, where the legacy exporter's only
    # downside (no dynamic-control-flow support) never applies.
    torch.onnx.export(
        model, fixed_batch, str(out_path),
        input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17, dynamo=False,
    )

    onnx_model = onnx.load(str(out_path))
    onnx.checker.check_model(onnx_model)

    with torch.no_grad():
        torch_out = model(fixed_batch).cpu().numpy()

    session = onnxruntime.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    onnx_out = session.run(None, {"input": fixed_batch.cpu().numpy()})[0]

    max_diff = float(np.abs(torch_out - onnx_out).max())
    print(f"ONNX/PyTorch parity: max abs diff = {max_diff:.2e}")
    if max_diff > 1e-4:
        raise RuntimeError(
            f"ONNX export diverges from the PyTorch model (max diff {max_diff:.2e} > 1e-4) "
            "— do not trust this export."
        )
    print(f"parity check passed, exported to {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "checkpoints")
    parser.add_argument(
        "--init-from", type=Path, default=None,
        help="warm start from a saved state dict; a 10-class checkpoint "
             "is widened to NUM_CLASSES by keeping its digit rows",
    )
    parser.add_argument(
        "--samples-per-epoch", type=int, default=None,
        help="draw this many training samples per epoch instead of the "
             "whole set (a warm start does not need 240k per epoch)",
    )
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cpu")

    print("loading EMNIST digits...")
    train_ds, test_ds, holdout_ds = build_datasets()
    sampler = RandomSampler(train_ds, num_samples=args.samples_per_epoch)
    train_loader = DataLoader(
        train_ds, batch_size=args.batch_size, sampler=sampler,
        num_workers=args.workers, persistent_workers=args.workers > 0,
    )
    test_loader = DataLoader(
        test_ds, batch_size=args.batch_size, shuffle=False,
        num_workers=args.workers, persistent_workers=args.workers > 0,
    )
    print(f"train={len(train_ds)} test={len(test_ds)}")

    model = DigitCNN().to(device)
    if args.init_from:
        load_widened(model, args.init_from, device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    best_acc = 0.0
    best_path = args.out / "digit_cnn_best.pt"

    holdout_loader = (
        DataLoader(holdout_ds, batch_size=args.batch_size, shuffle=False)
        if holdout_ds is not None else None
    )

    for epoch in range(1, args.epochs + 1):
        start = time.time()
        train_loss, train_acc, _ = run_epoch(model, train_loader, criterion, optimizer, device)
        val_loss, val_acc, val = run_epoch(model, test_loader, criterion, None, device)
        scheduler.step()
        elapsed = time.time() - start

        marker = ""
        if val_acc > best_acc:
            best_acc = val_acc
            torch.save(model.state_dict(), best_path)
            marker = " (best, saved)"

        print(
            f"epoch {epoch}/{args.epochs} [{elapsed:.0f}s] "
            f"train_loss={train_loss:.4f} train_acc={train_acc:.4f} "
            f"val_loss={val_loss:.4f} val_acc={val_acc:.4f}{marker}"
        )
        print(
            f"    EMNIST test: digits {val['digit_acc']:.4f}, "
            f"digits called crossed out {val['digit_false_crossed']:.4%}, "
            f"synthetic strikes caught {val['crossed_recall']:.4f} (n={val['crossed_n']})"
        )
        if holdout_loader is not None:
            _, _, ho = run_epoch(model, holdout_loader, criterion, None, device)
            print(
                f"    held-out practice-page crossings caught: "
                f"{ho['crossed_recall']:.4f} (n={ho['crossed_n']})"
            )

    print(f"\nbest EMNIST test-split accuracy: {best_acc:.4%}")

    model.load_state_dict(torch.load(best_path, map_location=device))
    export_and_verify_onnx(model, args.out / "digit_cnn.onnx", device)

    return 0


if __name__ == "__main__":
    sys.exit(main())
