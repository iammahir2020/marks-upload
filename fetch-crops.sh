#!/usr/bin/env bash
# Pull harvested crops down into one local training directory (step 3r.6b's
# prerequisite).
#
# Crops end up in three places depending on how the app was run — the
# laptop's own disk, the local MinIO that ./local-stack.sh starts, and a
# real S3 bucket once deployed. The key layout is identical in all three
# ON PURPOSE, so this just merges them and the training code never has to
# know where any given crop came from:
#
#     <source-id>/<field>/<confirmed|corrected>/<value>_<uuid>.png
#
#   ./fetch-crops.sh local                  # from ./local-stack.sh's MinIO
#   ./fetch-crops.sh s3 <bucket> [prefix]   # from a deployed bucket
#   ./fetch-crops.sh merge                  # local disk only, no remote
#
# Sources tagged `test-*` are excluded by default — they are verification
# runs, not real handwriting. INCLUDE_TEST=1 keeps them.
#
# Everything lands in backend/training_data/all/ (gitignored). Re-running
# is safe: `aws s3 sync` only fetches what changed, and the local copy is
# additive. Nothing is ever deleted from the source.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HERE/backend/training_data/all}"
LOCAL_HARVEST="$HERE/backend/training_data/harvested"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# --- Summary ---------------------------------------------------------------

summarise() {
  python3 - "$1" <<'PY'
import collections, pathlib, sys

root = pathlib.Path(sys.argv[1])
crops = list(root.rglob("*.png"))
if not crops:
    print(f"  nothing under {root}")
    raise SystemExit(0)

by_source = collections.Counter()
by_field = collections.Counter()
by_tag = collections.Counter()
labels = collections.defaultdict(collections.Counter)

for c in crops:
    rel = c.relative_to(root).parts
    if len(rel) < 4:
        continue
    source, field, tag = rel[0], rel[1], rel[2]
    by_source[source] += 1
    by_field[field] += 1
    by_tag[tag] += 1
    labels[field][c.name.split("_")[0]] += 1

print(f"  {len(crops)} crops in {root}\n")

print("  by source (this is the held-out-writer axis — plan.md §16):")
for s, n in by_source.most_common():
    print(f"    {s:<40} {n:>6}")

print("\n  by tag:")
for t, n in by_tag.most_common():
    print(f"    {t:<40} {n:>6}")

# The two things most likely to mislead a fine-tuning run, surfaced here
# rather than discovered as a bad model later.
print("\n  ID digit balance:")
digits = labels.get("id_digits", collections.Counter())
if digits:
    lo, hi = min(digits.values()), max(digits.values())
    for d in sorted(digits):
        bar = "#" * max(1, round(digits[d] / max(hi, 1) * 30))
        print(f"    {d}  {digits[d]:>5}  {bar}")
    if lo and hi / lo >= 3:
        print(f"    ! imbalanced: rarest {lo}, commonest {hi} ({hi/lo:.1f}x)")

half = whole = 0
for field, counts in labels.items():
    if not field.startswith("marks"):
        continue
    for value, n in counts.items():
        if "." in value:
            half += n
        else:
            whole += n
if half or whole:
    print(f"\n  marks: {whole} whole, {half} half"
          + (f"  ! half marks are {whole / max(half, 1):.1f}x rarer" if half and whole / max(half, 1) >= 3 else ""))

# issues.md N17. A crop's key is <source>/<field>/<tag>/<value>_<digest>.png
# — the content hash is the SUFFIX, and the label is a path segment ahead of
# it. So re-harvesting the same crop bytes under a different confirmed value
# does not overwrite: it produces a second file, and the corpus ends up
# holding one image with two contradictory labels.
#
# Not fixed at write time on purpose. The Store interface is deliberately
# one method (`put`) with no listing or deleting — widening it to look for
# a conflicting key would be a real design change — and the label has to
# stay in the filename, which is what keeps the corpus self-labelling with
# no annotation file to drift. Detected HERE instead, where crops are
# assembled for training, which is the moment it would matter and the same
# job the balance warnings above already do.
conflicts = collections.defaultdict(set)
for c in crops:
    rel = c.relative_to(root).parts
    if len(rel) < 4:
        continue
    value, _, digest = c.stem.rpartition("_")
    if digest:
        conflicts[(rel[1], digest)].add(value)
contradictory = {k: v for k, v in conflicts.items() if len(v) > 1}
if contradictory:
    print(f"\n  ! {len(contradictory)} crop(s) appear under CONTRADICTORY labels.")
    print("    The same image is in the training set twice, labelled differently —")
    print("    it will teach the model both answers. Decide which is right and")
    print("    delete the other before fine-tuning:")
    for (field, digest), values in list(contradictory.items())[:10]:
        print(f"      {field}/*/{digest[:12]}...  labelled {sorted(values)}")
    if len(contradictory) > 10:
        print(f"      ... and {len(contradictory) - 10} more")

if by_tag.get("corrected", 0) == 0 and by_tag.get("confirmed", 0):
    print("\n  ! every crop is tagged 'confirmed' and none 'corrected'.")
    print("    Still valid labelled data, but NOT a list of the model's failures —")
    print("    harvest_real_photos.py posts original == confirmed, so its whole")
    print("    batch files as confirmed regardless of what the model would have read.")
PY
}

# --- Sources ---------------------------------------------------------------

copy_local() {
  if [ -d "$LOCAL_HARVEST" ]; then
    say "Local disk ($LOCAL_HARVEST)"
    mkdir -p "$OUT"
    # -a preserves the constant mtime from step 11.0.2. Not cosmetic: see
    # app/stores.py CONSTANT_MTIME.
    cp -a "$LOCAL_HARVEST/." "$OUT/"
    echo "    merged"
  fi
}

from_minio() {
  say "MinIO (./local-stack.sh)"
  # The crops live in a docker volume that outlives the container, so they
  # are still there when the stack is down — but nothing can read them
  # until MinIO is serving. Say so, rather than surfacing a connection
  # error that reads like the data is gone.
  if ! curl -sf --max-time 3 http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
    echo "    MinIO is not running — start it with ./local-stack.sh up"
    echo "    (your crops are safe in the marks-minio-data volume meanwhile)"
    return 0
  fi
  AWS_ACCESS_KEY_ID=localdev AWS_SECRET_ACCESS_KEY=localdev123 AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url http://127.0.0.1:9000 \
    s3 sync "s3://marks-crops/harvested" "$OUT" --only-show-errors
}

from_s3() {
  local bucket="$1" prefix="${2:-harvested}"
  say "s3://$bucket/$prefix"
  aws s3 sync "s3://$bucket/$prefix" "$OUT" --only-show-errors
}

# --- Main ------------------------------------------------------------------

mkdir -p "$OUT"
case "${1:-merge}" in
  local) copy_local; from_minio ;;
  s3)    : "${2:?usage: $0 s3 <bucket> [prefix]}"; copy_local; from_s3 "$2" "${3:-harvested}" ;;
  merge) copy_local ;;
  *) echo "usage: $0 [local|s3 <bucket> [prefix]|merge]" >&2; exit 2 ;;
esac

# Fix #1 (2026-08-31): anything collected while verifying the system is
# tagged `test-*` and dropped here. The previous corpus had to be thrown
# away precisely because verification crops shared a namespace with real
# ones and could not be separated afterwards. Pass INCLUDE_TEST=1 to keep
# them.
if [ "${INCLUDE_TEST:-0}" != "1" ]; then
  removed=0
  for d in "$OUT"/test-*; do
    [ -d "$d" ] || continue
    removed=$((removed + $(find "$d" -name '*.png' | wc -l)))
    rm -rf "$d"
  done
  [ "$removed" -gt 0 ] && say "Excluded $removed crop(s) from test-* sources (INCLUDE_TEST=1 to keep)"
fi

say "Training set"
summarise "$OUT"

cat <<EOF

  Layout: <source-id>/<field>/<confirmed|corrected>/<value>_<uuid>.png
  The label is the filename up to the first underscore. Nothing else needs
  parsing, and there is no annotation file that can drift out of sync.

  NOTE: fine-tuning itself (step 3r.6b) is not built. This gets the data
  into one place with an honest picture of what is in it; what to do with
  it — which head to fine-tune, how to hold out a source, how to weight
  corrected over confirmed — is still an open decision in plan.md §16.
EOF
