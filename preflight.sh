#!/usr/bin/env bash
# Pre-deploy checks (step 11.6). Creates NOTHING — every check here is a
# read, a local build, or a dry run.
#
# The point is that a deploy should be boring. Anything that would fail
# halfway through `./deploy.sh` — a missing permission, a wrong region, an
# image too large, a stale frontend — fails here instead, before any AWS
# resource exists and before there is anything to half-clean-up.
#
#   ./preflight.sh
#
# Exit code is the number of blocking problems found.
set -uo pipefail   # deliberately NOT -e: every check must run, not just the first

REGION="${AWS_REGION:-us-east-1}"
PROJECT="${PROJECT:-marks-scanner}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BLOCKERS=0
WARNINGS=0

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; BLOCKERS=$((BLOCKERS + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --- Tooling ---------------------------------------------------------------

head_ "Tooling"
for tool in aws docker node npm python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    pass "$tool present"
  else
    fail "$tool missing"
  fi
done

if docker info >/dev/null 2>&1; then
  pass "docker daemon reachable"
else
  fail "docker daemon not running — the image cannot be built"
fi

# --- Identity and permissions ----------------------------------------------

head_ "AWS identity"
if IDENT="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  ACCOUNT="$(echo "$IDENT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Account"])')"
  ARN="$(echo "$IDENT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Arn"])')"
  pass "authenticated as $ARN"
  pass "account $ACCOUNT, region $REGION"
else
  fail "no usable AWS credentials — run 'aws configure'"
  ACCOUNT=""
fi

head_ "Permissions (each is a read-only probe)"
# A probe must test what deploy.sh ACTUALLY calls, on the resource it
# actually touches — otherwise it reports a failure the deploy would never
# hit. The first version probed `iam list-roles`, which deploy.sh never
# calls and which the least-privilege policy deliberately omits (ListRoles
# is account-wide and cannot be resource-scoped). That produced a blocker
# on a policy that was correct.
#
# It also has to tell "you may not do this" apart from "that does not exist
# yet" — on a first deploy nothing exists, so a NotFound is a PASS: the
# call was authorised, it just found nothing.
probe() { # probe <label> <blocking|optional> <aws args...>
  local label="$1" severity="$2"; shift 2
  local out
  if out="$("$@" 2>&1)"; then
    pass "$label"
    return
  fi
  case "$out" in
    *NoSuchEntity*|*NotFoundException*|*ResourceNotFoundException*|*NoSuchBucket*|*404*)
      pass "$label (authorised; resource not created yet)" ;;
    *AccessDenied*|*not\ authorized*|*UnauthorizedOperation*)
      if [ "$severity" = blocking ]; then fail "$label — DENIED"; else warn "$label — DENIED"; fi ;;
    *)
      warn "$label — inconclusive: $(echo "$out" | head -1 | cut -c1-90)" ;;
  esac
}
if [ -n "$ACCOUNT" ]; then
  probe "ecr"        blocking aws ecr describe-repositories --repository-names "$PROJECT" --region "$REGION"
  probe "lambda"     blocking aws lambda get-function --function-name "$PROJECT-api" --region "$REGION"
  probe "s3"         blocking aws s3api list-buckets
  probe "iam role"   blocking aws iam get-role --role-name "$PROJECT-lambda-role"
  probe "cloudfront" optional aws cloudfront list-distributions
fi

# --- What the deploy will create -------------------------------------------

head_ "Names the deploy will use"
if [ -n "$ACCOUNT" ]; then
  for b in "$PROJECT-crops-$ACCOUNT" "$PROJECT-site-$ACCOUNT"; do
    if aws s3api head-bucket --bucket "$b" >/dev/null 2>&1; then
      warn "s3://$b already exists (a re-run will reuse it, not recreate)"
    else
      pass "s3://$b available"
    fi
  done
  if aws lambda get-function --function-name "$PROJECT-api" --region "$REGION" >/dev/null 2>&1; then
    warn "lambda $PROJECT-api already exists (a re-run updates it in place)"
  else
    pass "lambda $PROJECT-api available"
  fi
fi

# --- The artifact ----------------------------------------------------------

head_ "Container image"
if docker build --platform linux/amd64 --provenance=false -q -t "$PROJECT-preflight" "$HERE/backend" >/dev/null 2>&1; then
  pass "builds for linux/amd64"
  SIZE_B="$(docker image inspect "$PROJECT-preflight" --format '{{.Size}}' 2>/dev/null || echo 0)"
  SIZE_MB=$((SIZE_B / 1024 / 1024))
  # Lambda's limit is 10 GB for container images.
  if [ "$SIZE_MB" -lt 10240 ]; then
    pass "image is ${SIZE_MB} MB (Lambda limit 10240 MB)"
  else
    fail "image is ${SIZE_MB} MB — over Lambda's 10 GB limit"
  fi
  # torch is training-only and would add ~700 MB. Its presence means
  # requirements got merged by mistake.
  if docker run --rm "$PROJECT-preflight" python -c "import torch" >/dev/null 2>&1; then
    fail "torch is in the image — it is training-only (requirements-cnn.txt)"
  else
    pass "torch correctly absent"
  fi
  for mod in onnxruntime scipy cv2 boto3; do
    if docker run --rm "$PROJECT-preflight" python -c "import $mod" >/dev/null 2>&1; then
      pass "$mod importable in the image"
    else
      fail "$mod missing from the image"
    fi
  done
  if docker run --rm --entrypoint sh "$PROJECT-preflight" -c "test -f /opt/extensions/lambda-adapter"; then
    pass "Lambda Web Adapter present"
  else
    fail "Lambda Web Adapter missing — Lambda will never route a request"
  fi
  if docker run --rm --entrypoint sh "$PROJECT-preflight" -c "test -f cnn/checkpoints/digit_cnn.onnx"; then
    pass "digit_cnn.onnx baked in (no download at boot)"
  else
    fail "digit_cnn.onnx missing — the CNN recognizer cannot start"
  fi
else
  fail "image does not build"
fi

head_ "Read-only filesystem (reproduces Lambda)"
CID="$(docker run -d --rm -p 9099:8000 --read-only --tmpfs /tmp \
  -e HARVEST_ENABLED=false "$PROJECT-preflight" 2>/dev/null)"
if [ -n "$CID" ]; then
  sleep 6
  PHOTO="$HERE/testset/images/filled_file.jpeg"
  CFG='{"quizName":"preflight","idDigits":7,"totalMax":25,"questions":[{"q":1,"max":5},{"q":2,"max":5},{"q":3,"max":5},{"q":4,"max":5},{"q":5,"max":5}]}'
  BODY="$(curl -s --max-time 90 -X POST http://localhost:9099/api/scan \
    -F "image=@$PHOTO" -F "config=$CFG" 2>/dev/null)"
  case "$BODY" in
    *'"status":"ok"'*) pass "a real scan succeeds on a read-only root" ;;
    *) fail "scan failed on a read-only root: ${BODY:0:120}" ;;
  esac
  docker rm -f "$CID" >/dev/null 2>&1
else
  fail "container would not start"
fi

# --- Frontend --------------------------------------------------------------

head_ "Frontend"
if [ -d "$HERE/frontend/node_modules" ]; then
  pass "node_modules present"
  # Builds into a throwaway directory, NOT dist/. An earlier version wrote
  # to dist/ and left the real build pointing at https://preflight.invalid
  # — so running the safety check quietly broke the thing it was checking,
  # and the next `vite preview` served a frontend that could reach no
  # backend at all.
  PREFLIGHT_DIST="$HERE/frontend/.preflight-dist"
  rm -rf "$PREFLIGHT_DIST"
  if ( cd "$HERE/frontend" \
       && VITE_API_BASE="https://preflight.invalid" \
          npm run build -- --outDir .preflight-dist --emptyOutDir >/dev/null 2>&1 ); then
    DIST_KB="$(du -sk "$PREFLIGHT_DIST" | cut -f1)"
    pass "production build succeeds (${DIST_KB} KB)"
    # VITE_* is inlined at build time; if the override does not appear in
    # the bundle, the hosted frontend would call the wrong host.
    if grep -rq "preflight.invalid" "$PREFLIGHT_DIST/assets" 2>/dev/null; then
      pass "VITE_API_BASE is inlined into the bundle"
    else
      fail "VITE_API_BASE did NOT reach the bundle — the hosted app would call the wrong backend"
    fi
  else
    fail "frontend build fails"
  fi
  rm -rf "$PREFLIGHT_DIST"
else
  fail "frontend/node_modules missing — run npm install"
fi

# --- Tests -----------------------------------------------------------------

head_ "Test suites"
if [ -x "$HERE/backend/venv/bin/pytest" ]; then
  if ( cd "$HERE/backend" && ./venv/bin/pytest -q >/dev/null 2>&1 ); then
    pass "backend tests pass"
  else
    fail "backend tests FAIL — do not deploy"
  fi
else
  warn "backend venv missing; skipped"
fi
if ( cd "$HERE/frontend" && npx vitest run >/dev/null 2>&1 ); then
  pass "frontend tests pass"
else
  fail "frontend tests FAIL — do not deploy"
fi

# --- Things only a human can settle ----------------------------------------

head_ "Decisions this script cannot make for you"
cat <<'EOF'
  - 11.6.0: AWS plan. A Free-plan account CLOSES automatically ~6 months
    after signup (≈18 Feb 2027 here), independent of the credits' 2027
    expiry. Moving to the Paid plan keeps it alive; the workload sits in
    always-free tiers either way, so this is about survival, not cost.
    Console only — no CLI can do it.
  - A budget alarm at ~$5/month, so anything escaping the free tier shows
    up while it is still pennies.
  - CloudFront access, if the probe above said DENIED. It is NOT optional
    for the frontend: an S3 website endpoint is HTTP-only, and the camera
    (getUserMedia) requires HTTPS, so without CloudFront the app cannot
    capture at all.
EOF

# --- Verdict ---------------------------------------------------------------

printf '\n\033[1mVerdict\033[0m\n'
if [ "$BLOCKERS" -eq 0 ]; then
  printf '  \033[32m%s blocker(s)\033[0m, %s warning(s) — ready for ./deploy.sh backend\n' "$BLOCKERS" "$WARNINGS"
else
  printf '  \033[31m%s blocker(s)\033[0m, %s warning(s) — fix these before deploying\n' "$BLOCKERS" "$WARNINGS"
fi
exit "$BLOCKERS"
