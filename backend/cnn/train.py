#!/usr/bin/env python3
"""Train the digit CNN (step.md step 2r.1/2r.3). EMNIST Digits (240k train
samples, considerably more writer variety than MNIST's 60k) through the
architecture in model.py, with rotation/translation/scale/elastic
augmentation. Exports to ONNX and verifies numerical parity against the
PyTorch model on a fixed batch — "it exports without error" is explicitly
not the bar step.md sets for this.

    python cnn/train.py --epochs 10 --out cnn/checkpoints
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
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.datasets import EMNIST

sys.path.insert(0, str(Path(__file__).parent))
from model import DigitCNN  # noqa: E402

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

    train_ds = OrientationFixedEMNIST(train_base, transform=train_transform)
    test_ds = OrientationFixedEMNIST(test_base, transform=eval_transform)
    return train_ds, test_ds


def run_epoch(model, loader, criterion, optimizer, device) -> tuple[float, float]:
    training = optimizer is not None
    model.train(training)

    total_loss, correct, total = 0.0, 0, 0
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
            correct += (logits.argmax(dim=1) == labels).sum().item()
            total += images.size(0)

    return total_loss / total, correct / total


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
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cpu")

    print("loading EMNIST digits...")
    train_ds, test_ds = build_datasets()
    train_loader = DataLoader(
        train_ds, batch_size=args.batch_size, shuffle=True,
        num_workers=args.workers, persistent_workers=args.workers > 0,
    )
    test_loader = DataLoader(
        test_ds, batch_size=args.batch_size, shuffle=False,
        num_workers=args.workers, persistent_workers=args.workers > 0,
    )
    print(f"train={len(train_ds)} test={len(test_ds)}")

    model = DigitCNN().to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    best_acc = 0.0
    best_path = args.out / "digit_cnn_best.pt"

    for epoch in range(1, args.epochs + 1):
        start = time.time()
        train_loss, train_acc = run_epoch(model, train_loader, criterion, optimizer, device)
        val_loss, val_acc = run_epoch(model, test_loader, criterion, None, device)
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

    print(f"\nbest EMNIST test-split accuracy: {best_acc:.4%}")

    model.load_state_dict(torch.load(best_path, map_location=device))
    export_and_verify_onnx(model, args.out / "digit_cnn.onnx", device)

    return 0


if __name__ == "__main__":
    sys.exit(main())
