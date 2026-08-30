"""
Synthetic exam-script cover-page generator.

Produces handwriting-style photos of script cover pages (boxed student ID,
serial number, per-question marks grid) plus a JSON ground-truth file.
"""

import json
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(SCRIPT_DIR, "fonts")
# The grid itself and every label ("ID", "Serial", "Qn(m)", "Total (nm)")
# are machine-printed on the question paper — only the values someone
# actually filled in (ID digits, serial, marks) are handwritten. Kept in
# its own subfolder, not FONT_DIR itself, so the FONTS glob below (which
# picks a *handwriting* font per photo) never picks this up too.
PRINT_FONT_PATH = os.path.join(FONT_DIR, "print", "LiberationSans-Regular.ttf")
# Deliberately NOT synthetic_scripts/ itself — that's the original 20-image
# set the testset's own labels.json entries already point at (see
# synthetic_script_001.jpg / synthetic_script_004.jpg). Defaulting here
# would silently overwrite it the first time this script runs locally.
OUT_DIR = os.path.join(SCRIPT_DIR, "generated")
IMG_DIR = os.path.join(OUT_DIR, "images")
RECS_DIR = os.path.join(SCRIPT_DIR, "_recs")  # scratch dir between the two build_sheet phases below

SS = 2  # supersampling factor
W, H = 1400, 1050  # final size
CW, CH = W * SS, int(H * SS * 1.05)

FONTS = sorted(f for f in os.listdir(FONT_DIR) if f.endswith(".ttf"))

NOISE_LINES = [
    "Open CV -> computer vision -> defect detection",
    "TCP hand shake -> connection",
    "gradient descent -> loss goes down",
    "index -> B tree -> faster lookup",
    "cache miss -> RAM -> slow path",
    "DNS -> resolver -> IP address",
    "hash map -> O(1) average lookup",
    "kernel -> convolution -> feature map",
    "REST -> stateless -> scalable",
    "deadlock -> circular wait",
    "normalize -> 3NF -> less redundancy",
    "garbage collector -> mark and sweep",
]


# ---------------------------------------------------------------- utilities
def jitter(p, a):
    return (p[0] + random.uniform(-a, a), p[1] + random.uniform(-a, a))


def printed_line(draw, p0, p1, color, width):
    """A perfectly straight machine-printed rule — no wobble, no per-node
    noise. The photo-level effects applied later (perspective, blur, sensor
    noise, JPEG) are what give it a photographed look, same as a real
    printed table would get."""
    draw.line([p0, p1], fill=color, width=width)


def printed_rect(draw, x0, y0, x1, y1, color, width):
    printed_line(draw, (x0, y0), (x1, y0), color, width)
    printed_line(draw, (x1, y0), (x1, y1), color, width)
    printed_line(draw, (x1, y1), (x0, y1), color, width)
    printed_line(draw, (x0, y1), (x0, y0), color, width)


def printed_text(draw, s, font, color, box):
    """Centered, unjittered, unrotated text — a machine-printed label, as
    opposed to hand_text's per-character jitter/rotation for handwritten
    values. Same box-centering math as hand_text, without the jitter loop."""
    x0, y0, x1, y1 = box
    bb = font.getbbox(s)
    w = bb[2] - bb[0]
    x = (x0 + x1) / 2 - w / 2 - bb[0]
    y = (y0 + y1) / 2 - (bb[1] + bb[3]) / 2
    draw.text((x, y), s, font=font, fill=color)


def text_size(font, s):
    b = font.getbbox(s)
    return b[2] - b[0], b[3] - b[1], b[0], b[1]


def hand_text(img, xy, s, font, color, anchor="lt", char_jit=0.0, rot=0.0,
              box=None):
    """
    Draw text with per-character baseline jitter and a small overall rotation.
    `box` = (x0, y0, x1, y1) centers the text inside that box.
    """
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    widths = []
    for ch in s:
        widths.append(d.textlength(ch, font=font))
    total = sum(widths) + max(0, len(s) - 1) * char_jit * 0.15
    bb = font.getbbox(s)
    asc, desc = font.getmetrics()

    if box is not None:
        x0, y0, x1, y1 = box
        x = (x0 + x1) / 2 - total / 2
        y = (y0 + y1) / 2 - (bb[1] + bb[3]) / 2
    else:
        x, y = xy
        if anchor[0] == "m":
            x -= total / 2
        if anchor[1] == "m":
            y -= (bb[1] + bb[3]) / 2

    cx, cy = x + total / 2, y + asc / 2
    for ch, w in zip(s, widths):
        dy = random.uniform(-char_jit, char_jit)
        dx = random.uniform(-char_jit, char_jit) * 0.4
        d.text((x + dx, y + dy), ch, font=font, fill=color)
        x += w + random.uniform(-char_jit, char_jit) * 0.25

    if abs(rot) > 1e-3:
        layer = layer.rotate(rot, resample=Image.BICUBIC, center=(cx, cy))
    img.alpha_composite(layer)
    return total


# ---------------------------------------------------------------- paper
def make_paper():
    """Low-res illumination model upscaled, plus cheap grain at full res."""
    base = random.randint(198, 240)
    tint = random.choice([(0, 0, 0), (4, 2, -3), (-2, 0, 4), (3, 3, 0), (-3, -2, 0)])
    sw, sh = CW // 8, CH // 8
    arr = np.full((sh, sw), float(base), dtype=np.float32)

    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    gx, gy = random.uniform(-1, 1), random.uniform(-1, 1)
    arr += ((xx / sw - 0.5) * gx + (yy / sh - 0.5) * gy) * random.uniform(12, 34)

    for _ in range(random.randint(2, 4)):
        bx, by = random.uniform(0, sw), random.uniform(0, sh)
        r = random.uniform(sw * 0.25, sw * 0.8)
        amp = random.uniform(-14, 10)
        arr += amp * np.exp(-((xx - bx) ** 2 + (yy - by) ** 2) / (2 * r * r))

    small = np.stack([np.clip(arr + tint[c], 0, 255) for c in range(3)], axis=-1)
    img = Image.fromarray(small.astype(np.uint8), "RGB").resize((CW, CH), Image.BILINEAR)

    grain = np.random.normal(0, random.uniform(2.5, 5.5), (CH // 2 + 1, CW // 2 + 1, 1))
    grain = np.repeat(np.repeat(grain, 2, axis=0), 2, axis=1)[:CH, :CW]
    a = np.asarray(img).astype(np.float32) + grain
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    if random.random() < 0.6:
        img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.4, 1.0)))
    return img.convert("RGBA")


def ink_color():
    style = random.random()
    if style < 0.55:          # black-ish ballpoint
        v = random.randint(18, 55)
        return (v + random.randint(-6, 6), v + random.randint(-6, 6),
                v + random.randint(-4, 10), random.randint(228, 255))
    if style < 0.85:          # blue pen
        return (random.randint(20, 55), random.randint(30, 70),
                random.randint(95, 165), random.randint(225, 255))
    v = random.randint(48, 78)  # faded / light pressure
    return (v, v, v + random.randint(0, 12), random.randint(215, 245))


def perspective(img, amount):
    w, h = img.size
    a = amount
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [(random.uniform(-a, a) * w, random.uniform(-a, a) * h),
           (w + random.uniform(-a, a) * w, random.uniform(-a, a) * h),
           (w + random.uniform(-a, a) * w, h + random.uniform(-a, a) * h),
           (random.uniform(-a, a) * w, h + random.uniform(-a, a) * h)]
    A, B = [], []
    for (xd, yd), (xs, ys) in zip(dst, src):
        A.append([xd, yd, 1, 0, 0, 0, -xs * xd, -xs * yd])
        B.append(xs)
        A.append([0, 0, 0, xd, yd, 1, -ys * xd, -ys * yd])
        B.append(ys)
    coeffs = np.linalg.solve(np.array(A, dtype=np.float64), np.array(B, dtype=np.float64))
    return img.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC,
                         fillcolor=(235, 233, 230, 255))


# ---------------------------------------------------------------- one sheet
def build_sheet(idx, rng_seed):
    random.seed(rng_seed)
    np.random.seed(rng_seed % (2 ** 31))

    font_file = FONTS[idx % len(FONTS)]
    fpath = os.path.join(FONT_DIR, font_file)

    scale = random.uniform(0.92, 1.08)
    f_big = ImageFont.truetype(fpath, int(46 * SS * scale))  # handwritten values
    f_lab = ImageFont.truetype(PRINT_FONT_PATH, int(36 * SS * scale))  # printed "ID" / "Serial"
    f_hdr = ImageFont.truetype(PRINT_FONT_PATH, int(31 * SS * scale))  # printed "Qn(m)" / "Total (nm)"
    f_note = ImageFont.truetype(fpath, int(30 * SS * scale))

    # ---- ground truth values
    student_id = "".join(random.choice("0123456789") for _ in range(7))
    serial = random.randint(100, 999)
    n_q = random.randint(3, 8)
    per_max = random.choice([5, 5, 5, 10, 4])
    marks = []
    for _ in range(n_q):
        step = 0.5 if per_max <= 5 else random.choice([0.5, 1.0])
        m = round(random.uniform(0, per_max) / step) * step
        m = min(m, per_max)
        marks.append(round(m, 1))
    total = round(sum(marks), 1)

    # narrow columns need a smaller header so Qn(m) / Total (m) never collide
    hdr_px = int(31 * SS * scale * min(1.0, 6.0 / (n_q + 1)) ** 0.55)
    f_hdr = ImageFont.truetype(PRINT_FONT_PATH, max(int(16 * SS), hdr_px))

    def numfmt(v):
        return str(int(v)) if float(v).is_integer() else str(v)

    paper = make_paper()
    ink = ink_color()  # the pen used only for handwritten values, below
    print_color = (35, 35, 38, 255)  # fixed machine-printed black — the
                                       # grid/labels don't depend on which
                                       # pen the values later get filled in with
    print_lw = max(1, int(random.uniform(1.4, 2.2) * SS))  # thin, uniform
                                                              # printed rule —
                                                              # thinner than a
                                                              # pen stroke
    char_jit = random.uniform(0.6, 2.6) * SS
    tilt = random.uniform(-0.9, 0.9)

    draw = ImageDraw.Draw(paper)
    content = {"bottom": 0.0}

    margin_l = random.uniform(0.06, 0.11) * CW
    margin_r = CW - random.uniform(0.05, 0.10) * CW
    y = random.uniform(0.06, 0.12) * CH

    # ---- ID row -------------------------------------------------------
    row_h = random.uniform(58, 78) * SS
    id_label_w = random.uniform(95, 145) * SS
    n_cells = 7
    grid_w = (margin_r - margin_l - id_label_w)
    cell_w = grid_w / n_cells
    y0, y1 = y, y + row_h

    printed_rect(draw, margin_l, y0, margin_l + id_label_w, y1, print_color, print_lw)
    printed_text(draw, "ID", f_lab, print_color, box=(margin_l, y0, margin_l + id_label_w, y1))

    x = margin_l + id_label_w
    printed_line(draw, (x, y0), (margin_r, y0), print_color, print_lw)
    printed_line(draw, (x, y1), (margin_r, y1), print_color, print_lw)
    for i in range(n_cells + 1):
        cx = x + cell_w * i
        printed_line(draw, (cx, y0), (cx, y1), print_color, print_lw)
    for i, ch in enumerate(student_id):
        hand_text(paper, None, ch, f_big, ink, char_jit=char_jit * 0.5,
                  rot=tilt + random.uniform(-3, 3),
                  box=(x + cell_w * i, y0, x + cell_w * (i + 1), y1))

    # ---- Serial row ---------------------------------------------------
    y = y1 + random.uniform(22, 48) * SS
    row_h2 = random.uniform(54, 74) * SS
    y0, y1 = y, y + row_h2
    ser_lab_w = random.uniform(150, 215) * SS
    ser_val_w = random.uniform(240, 380) * SS
    printed_rect(draw, margin_l, y0, margin_l + ser_lab_w, y1, print_color, print_lw)
    printed_rect(draw, margin_l + ser_lab_w, y0,
              margin_l + ser_lab_w + ser_val_w, y1, print_color, print_lw)
    printed_text(draw, "Serial", f_lab, print_color, box=(margin_l, y0, margin_l + ser_lab_w, y1))
    hand_text(paper, None, str(serial), f_big, ink, char_jit=char_jit * 0.6,
              rot=tilt + random.uniform(-2, 2),
              box=(margin_l + ser_lab_w, y0, margin_l + ser_lab_w + ser_val_w, y1))

    # ---- marks table --------------------------------------------------
    y = y1 + random.uniform(55, 105) * SS
    hdr_h = random.uniform(62, 82) * SS
    val_h = random.uniform(70, 100) * SS
    n_cols = n_q + 1
    tw = margin_r - margin_l
    col_w = tw / n_cols
    ty0 = y
    ty1 = y + hdr_h
    ty2 = ty1 + val_h

    for yy in (ty0, ty1, ty2):
        printed_line(draw, (margin_l, yy), (margin_r, yy), print_color, print_lw)
    for i in range(n_cols + 1):
        cx = margin_l + col_w * i
        printed_line(draw, (cx, ty0), (cx, ty2), print_color, print_lw)

    for i in range(n_q):
        label = "Q%d(%d)" % (i + 1, per_max)
        printed_text(draw, label, f_hdr, print_color,
                      box=(margin_l + col_w * i, ty0, margin_l + col_w * (i + 1), ty1))
    printed_text(draw, "Total (%d)" % (per_max * n_q), f_hdr, print_color,
                  box=(margin_l + col_w * n_q, ty0, margin_r, ty1))

    for i, m in enumerate(marks):
        hand_text(paper, None, numfmt(m), f_big, ink, char_jit=char_jit * 0.5,
                  rot=tilt + random.uniform(-3, 3),
                  box=(margin_l + col_w * i, ty1,
                       margin_l + col_w * (i + 1), ty2))
    hand_text(paper, None, numfmt(total), f_big, ink, char_jit=char_jit * 0.5,
              rot=tilt + random.uniform(-3, 3),
              box=(margin_l + col_w * n_q, ty1, margin_r, ty2))

    y = ty2

    # ---- crop to content, leaving a photographed-page margin ----------
    content["bottom"] = max(content["bottom"], y + 40 * SS)
    top = max(0.0, random.uniform(0.02, 0.09) * CH)
    bot = min(CH, content["bottom"] + random.uniform(30, 130) * SS)
    left = max(0.0, margin_l - random.uniform(30, 110) * SS)
    right = min(CW, margin_r + random.uniform(30, 110) * SS)

    # keep a sane frame but never pad far past the content
    cw_, ch_ = right - left, bot - top
    min_ratio = random.uniform(1.15, 1.55)
    if cw_ / ch_ > min_ratio:
        need = cw_ / min_ratio - ch_
        top = max(0.0, top - need * random.uniform(0.15, 0.4))
        bot = min(CH, bot + need * random.uniform(0.5, 0.85))
    paper = paper.crop((int(left), int(top), int(right), int(bot)))

    # ---- photo effects -------------------------------------------------
    img = paper
    if random.random() < 0.85:
        img = perspective(img, random.uniform(0.004, 0.022))
    img = img.rotate(random.uniform(-2.2, 2.2), resample=Image.BICUBIC,
                     fillcolor=(236, 234, 231, 255), expand=False)

    ow, oh = img.size
    img = img.convert("RGB").resize((W, max(400, int(W * oh / ow))), Image.LANCZOS)

    if random.random() < 0.55:
        img = img.filter(ImageFilter.GaussianBlur(random.uniform(0.3, 0.9)))
    if random.random() < 0.3:
        img = img.filter(ImageFilter.UnsharpMask(2, random.randint(60, 140), 3))

    a = np.asarray(img).astype(np.float32)
    oh2, ow2 = a.shape[0], a.shape[1]
    # vignette
    yy, xx = np.mgrid[0:oh2, 0:ow2].astype(np.float32)
    r = np.sqrt(((xx - ow2 / 2) / (ow2 / 2)) ** 2 + ((yy - oh2 / 2) / (oh2 / 2)) ** 2)
    a *= (1 - random.uniform(0.03, 0.16) * np.clip(r - 0.45, 0, None))[:, :, None]
    # sensor noise + jpeg-ish softness
    a += np.random.normal(0, random.uniform(1.5, 4.5), a.shape)
    a = np.clip(a * random.uniform(0.94, 1.07) + random.uniform(-10, 10), 0, 255)
    img = Image.fromarray(a.astype(np.uint8))

    name = "script_%03d.jpg" % (idx + 1)
    img.save(os.path.join(IMG_DIR, name), "JPEG",
             quality=random.randint(72, 93), subsampling=random.choice([0, 2]))

    return {
        "file_name": name,
        "student_id": student_id,
        "serial": serial,
        "num_questions": n_q,
        "marks_per_question": {"Q%d" % (i + 1): marks[i] for i in range(n_q)},
        "marks_list": marks,
        "total": total,
        "max_per_question": per_max,
        "max_total": per_max * n_q,
        "handwriting_font": font_file.replace(".ttf", ""),
        "width": img.size[0],
        "height": img.size[1],
    }


def main():
    import sys
    os.makedirs(IMG_DIR, exist_ok=True)
    os.makedirs(RECS_DIR, exist_ok=True)
    if len(sys.argv) == 3:
        lo, hi = int(sys.argv[1]), int(sys.argv[2])
        for i in range(lo, hi):
            r = build_sheet(i, 1000 + i * 37)
            json.dump(r, open(os.path.join(RECS_DIR, "%03d.json" % i), "w"))
        print("done", lo, hi)
        return
    records = [json.load(open(os.path.join(RECS_DIR, "%03d.json" % i))) for i in range(20)]

    meta = {
        "dataset": "synthetic_exam_script_covers",
        "generated_on": "2026-08-29",
        "image_dir": "images",
        "image_width": W,
        "count": len(records),
        "schema": {
            "file_name": "image filename inside image_dir",
            "student_id": "7-digit ID, one digit per box in the ID row",
            "serial": "integer in the Serial box",
            "num_questions": "number of question columns (excludes Total)",
            "marks_per_question": "Qn -> mark written in that column",
            "marks_list": "same marks in column order",
            "total": "value written in the Total column (equals sum of marks_list)",
            "max_per_question": "the (n) printed in each Qn(n) header",
            "max_total": "the (n) printed in the Total header",
            "handwriting_font": "font used, for stratifying train/val splits",
        },
        "images": records,
    }
    with open(os.path.join(OUT_DIR, "ground_truth.json"), "w") as f:
        json.dump(meta, f, indent=2)

    for r in records:
        assert abs(sum(r["marks_list"]) - r["total"]) < 1e-6
        assert len(r["student_id"]) == 7
    print("ok", len(records))


if __name__ == "__main__":
    main()
