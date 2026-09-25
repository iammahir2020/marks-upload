#!/usr/bin/env bash
# Step 11.6 — deploy to AWS. Idempotent: safe to re-run, which matters
# because step 11's own Done-when requires proving harvested crops survive
# a redeploy by actually redeploying.
#
# Deliberately a script and not a list of commands in a doc. A deploy you
# run by copy-pasting is a deploy you do differently each time, and the one
# thing this has to demonstrate is that doing it twice changes nothing.
#
# NOT run automatically by anything. It creates real, public infrastructure
# in a real account and costs real (if tiny) money — invoke it deliberately.
#
#   ./deploy.sh backend     # ECR build+push, Lambda, API Gateway
#   ./deploy.sh frontend    # Vite build, S3 sync, CloudFront invalidate
#   ./deploy.sh all
#
# Prerequisites, none of which this script will do for you:
#   - 11.6.0's billing decision (Paid plan + budget alarm) already made
#   - CloudFront permissions on the calling identity, for `frontend`
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
PROJECT="${PROJECT:-marks-scanner}"
ECR_REPO="${ECR_REPO:-$PROJECT}"
FUNCTION="${FUNCTION:-$PROJECT-api}"
ROLE_NAME="${ROLE_NAME:-$PROJECT-lambda-role}"
MEMORY_MB="${MEMORY_MB:-2048}"
# Generous: a cold start is ~2-4s and a scan ~2s, but the default 3s would
# kill every single request. 60 leaves room for a slow cold start without
# letting a wedged request burn budget.
TIMEOUT_S="${TIMEOUT_S:-60}"

# Resolved BEFORE the first `aws` call below, not after it. Everything
# this preamble sets up — the PATH rescue especially — has to be in place
# before any native tool runs, and `aws sts get-caller-identity` is the
# very first thing this script does.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shell-portability.sh
. "$HERE/shell-portability.sh"
# Windows: docker/aws are often installed but absent from an inherited PATH.
ensure_native_tools_on_path
PY_CMD="$(portable_python)" || { echo "No usable python found on PATH." >&2; exit 1; }
# This script drives docker; container-side paths must not be rewritten.
disable_msys_path_conversion
# aws.exe and docker.exe are native Windows programs and do not understand
# the /g/Dev/... form Git Bash presents, so every HOST path handed to one
# goes through native_path first. No-op on Linux.
HERE_NATIVE="$(native_path "$HERE")"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
# Bucket names are globally unique across all of AWS, so the account id is
# appended rather than hoping "marks-scanner-crops" is free.
CROPS_BUCKET="${CROPS_BUCKET:-$PROJECT-crops-$ACCOUNT}"
SITE_BUCKET="${SITE_BUCKET:-$PROJECT-site-$ACCOUNT}"
ECR_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"


say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { "$@" >/dev/null 2>&1; }

# The function's environment, in ONE place. Built by a function rather than
# written out at each call site because it is set twice — once when the
# function is created or updated, and again by apply_allowed_origins() once
# the CloudFront domain exists — and `update-function-configuration`
# REPLACES the whole environment rather than merging into it. Two hand-kept
# copies of this list would mean the second call silently dropping whatever
# the first one had that it didn't know about.
#   $1 — the site origin, or empty to leave ALLOWED_ORIGINS unset
# --- CloudFront-only access (issues.md N42) --------------------------------
#
# API Gateway's execute-api URL is also CloudFront's origin, so it cannot be
# switched off without a custom domain. Instead CloudFront sends a secret
# X-Origin-Verify header on every request it forwards, and the backend
# (ORIGIN_SECRET) refuses /api/* without it. The secret is created once and
# then READ BACK on every later deploy — from the distribution first, then
# the Lambda — so the two ends never drift apart. Resolved in the parent
# shell before any $(lambda_env) subshell: generated inside one, it would
# be a different secret on every call.
ORIGIN_SECRET=""
resolve_origin_secret() {
  [ -n "$ORIGIN_SECRET" ] && return 0
  local dist
  dist="$(find_distribution)"
  if [ -n "$dist" ]; then
    ORIGIN_SECRET="$(aws cloudfront get-distribution-config --id "$dist" --output json \
      | $PY_CMD "$HERE_NATIVE/aws/origin_header.py" read)"
  fi
  if [ -z "$ORIGIN_SECRET" ]; then
    ORIGIN_SECRET="$(aws lambda get-function-configuration --function-name "$FUNCTION" --region "$REGION" \
      --query 'Environment.Variables.ORIGIN_SECRET' --output text 2>/dev/null | grep -v '^None$' || true)"
  fi
  if [ -z "$ORIGIN_SECRET" ]; then
    # URL-safe alphabet only: no ',' or '=' to break Lambda's Variables={...}.
    ORIGIN_SECRET="$($PY_CMD -c 'import secrets; print(secrets.token_urlsafe(32))')"
    echo "    generated a new CloudFront origin secret"
  fi
}

# Puts the secret on an EXISTING distribution's API origin and waits for
# CloudFront to finish deploying it — BEFORE the Lambda is told to require
# it. The other order would 403 every real request for the minutes a
# CloudFront change takes to propagate; a header the backend doesn't check
# yet is harmless. A no-op once it's already there.
ensure_origin_header() {
  local dist; dist="$(find_distribution)"
  [ -n "$dist" ] || return 0
  local tmp etag
  tmp="$(mktemp -t "$PROJECT-dist-update.XXXXXX.json")"
  etag="$(aws cloudfront get-distribution-config --id "$dist" --query ETag --output text)"
  if aws cloudfront get-distribution-config --id "$dist" --output json \
      | SECRET="$ORIGIN_SECRET" $PY_CMD "$HERE_NATIVE/aws/origin_header.py" write "$(native_path "$tmp")"; then
    say "CloudFront: adding the origin secret to the API origin (N42)"
    aws cloudfront update-distribution --id "$dist" --if-match "$etag" \
      --distribution-config "file://$(native_path "$tmp")" >/dev/null
    echo "    waiting for CloudFront to deploy it (several minutes) before the backend requires it"
    aws cloudfront wait distribution-deployed --id "$dist"
  fi
  rm -f "$tmp"
}

# HARVEST_PREFIX=unverified (issues.md N40): /api/harvest is reachable by
# anyone with the site's URL, who can send any image with any labels. So
# crops from the hosted site never land in harvested/, the training
# corpus; they go to unverified/, which fetch-crops.sh only downloads with
# `review` and only merges with an explicit `promote` after a look. The
# laptop keeps writing straight to its own trusted harvested/.
lambda_env() {
  [ -n "$ORIGIN_SECRET" ] || { echo "lambda_env: ORIGIN_SECRET not resolved" >&2; exit 1; }
  # CLIENT_IP_SOURCE=cloudfront (N41): the rate limit keys on the address
  # CloudFront writes, trustworthy only because ORIGIN_SECRET makes
  # CloudFront the only way in.
  local vars="RECOGNIZER=cnn,HARVEST_BACKEND=s3,HARVEST_BUCKET=$CROPS_BUCKET,HARVEST_PREFIX=unverified,XRAY_ENABLED=true,CLIENT_IP_SOURCE=cloudfront,ORIGIN_SECRET=$ORIGIN_SECRET"
  [ -n "${1:-}" ] && vars="$vars,ALLOWED_ORIGINS=$1"
  echo "$vars"
}

# --- Backend ---------------------------------------------------------------

deploy_backend() {
  say "ECR repository"
  have aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$REGION" \
    || aws ecr create-repository --repository-name "$ECR_REPO" --region "$REGION" >/dev/null
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com" >/dev/null

  say "Build and push image"
  # --provenance=false: buildx otherwise pushes a multi-arch manifest list,
  # which Lambda rejects with a genuinely unhelpful error about the image
  # manifest. --platform is explicit rather than implied by this laptop.
  docker build --platform linux/amd64 --provenance=false \
    -t "$ECR_URI:latest" "$HERE_NATIVE/backend"
  docker push "$ECR_URI:latest" >/dev/null
  local digest
  digest="$(aws ecr describe-images --repository-name "$ECR_REPO" --region "$REGION" \
    --image-ids imageTag=latest --query 'imageDetails[0].imageDigest' --output text)"
  echo "    pushed $digest"

  say "Crops bucket (private)"
  have aws s3api head-bucket --bucket "$CROPS_BUCKET" || {
    aws s3 mb "s3://$CROPS_BUCKET" --region "$REGION" >/dev/null
    # Belt and braces: buckets are private by default now, but this is
    # student handwriting and the cost of being explicit is one call.
    aws s3api put-public-access-block --bucket "$CROPS_BUCKET" \
      --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
  }

  # Crops retention (issues.md N8) is deliberately NOT set here.
  #
  # It is one-time bucket configuration, not per-deploy state — the same
  # kind of thing as put-public-access-block above, which is why that one
  # sits inside the create-only block. Automating it here would mean
  # granting this deploy user s3:PutLifecycleConfiguration permanently, and
  # that is effectively a DELAYED DELETE on every harvested crop: whoever
  # holds it can schedule the whole bucket for expiry. aws/README.md claims
  # this user has no delete permissions beyond DeleteObject, and that claim
  # is worth more than the convenience.
  #
  # Set once from an admin profile — aws/README.md has the command.
  # preflight.sh checks the rule exists and warns if it does not, so it
  # cannot be silently forgotten while Setup.tsx promises a year's
  # retention to the instructor.

  say "Execution role"
  if ! have aws iam get-role --role-name "$ROLE_NAME"; then
    aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},
                    "Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  fi
  # Step 11.8 — lets the function write its own trace segments/subsegments
  # to X-Ray. An AWS-managed policy rather than a hand-written inline one:
  # unlike the crops bucket, there is no single ARN to scope this to (an
  # xray:PutTraceSegments call names no resource), so "write-only, one
  # thing" isn't expressible any tighter than this managed policy already
  # is. Outside the create-only block above and safe to re-run every
  # deploy — attaching an already-attached policy is a no-op, which is
  # what makes this the right way to add the capability to a role that
  # already existed before this step, not just a freshly created one.
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess
  # Write-only, to exactly one bucket, and no read. The function never needs
  # to list or fetch a crop — only append — so it cannot be used to
  # exfiltrate what it has already collected (step 11.6.3).
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name crops-write-only \
    --policy-document "{
      \"Version\":\"2012-10-17\",
      \"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"s3:PutObject\"],
                     \"Resource\":\"arn:aws:s3:::$CROPS_BUCKET/*\"}]}"
  local role_arn
  role_arn="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

  # ALLOWED_ORIGINS is set only once the site URL is known, so a first
  # backend-only deploy leaves it unset and the app keeps its LAN regex.
  # apply_allowed_origins() fills it in after the distribution exists.
  resolve_origin_secret
  ensure_origin_header
  local env_vars
  env_vars="$(lambda_env "${SITE_URL:-}")"

  say "Lambda function"
  if have aws lambda get-function --function-name "$FUNCTION" --region "$REGION"; then
    aws lambda update-function-code --function-name "$FUNCTION" --region "$REGION" \
      --image-uri "$ECR_URI:latest" >/dev/null
    # Two updates cannot be in flight at once, so this wait is required
    # between them, not merely tidy.
    aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
      --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" --tracing-config Mode=Active \
      --environment "Variables={$env_vars}" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION"
  else
    # A freshly created role often is not assumable yet — IAM is eventually
    # consistent, and create-function fails outright with "The role defined
    # for the function cannot be assumed by Lambda". Retrying beats a fixed
    # sleep long enough to always work.
    local attempt=0
    until aws lambda create-function --function-name "$FUNCTION" --region "$REGION" \
      --package-type Image --code "ImageUri=$ECR_URI:latest" --role "$role_arn" \
      --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" --architectures x86_64 \
      --tracing-config Mode=Active \
      --environment "Variables={$env_vars}" >/dev/null 2>&1; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 10 ]; then
        echo "    create-function failed 10 times; running it once more for the real error" >&2
        aws lambda create-function --function-name "$FUNCTION" --region "$REGION" \
          --package-type Image --code "ImageUri=$ECR_URI:latest" --role "$role_arn" \
          --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" --architectures x86_64 \
          --tracing-config Mode=Active \
          --environment "Variables={$env_vars}" >/dev/null
        exit 1
      fi
      echo "    waiting for the IAM role to become assumable (attempt $attempt)"
      sleep 6
    done
    # A new function is Pending, not merely "updated" — a container image
    # has to be pulled and unpacked first. function-updated does NOT wait
    # for that, so the smoke test below could fire at a function that
    # cannot serve yet.
    aws lambda wait function-active-v2 --function-name "$FUNCTION" --region "$REGION"
  fi

  say "Log retention"
  # New log groups default to *Never expire*, which is a slow privacy leak
  # as much as a cost one. Created explicitly rather than waiting for the
  # first invocation to create it, so the retention is set before anything
  # is ever written.
  aws logs create-log-group --log-group-name "/aws/lambda/$FUNCTION" \
    --region "$REGION" >/dev/null 2>&1 || true
  aws logs put-retention-policy --log-group-name "/aws/lambda/$FUNCTION" \
    --retention-in-days "${LOG_RETENTION_DAYS:-30}" --region "$REGION" >/dev/null 2>&1 \
    || echo "    could not set retention (needs logs:PutRetentionPolicy)"

  say "API Gateway (HTTP API)"
  # NOT a Lambda Function URL, and not by preference — this account refuses
  # Function URL invocation by anything except an IAM principal. Proven
  # three ways: public (AuthType NONE) with a correct public resource policy
  # returned 403; CloudFront's service principal with a correct OAC grant
  # (right principal, action, FunctionUrlAuthType and a SourceArn matching
  # the distribution) also returned 403; only a directly IAM-signed request
  # succeeded. So OAC-to-Function-URL cannot work here, whatever the docs
  # say, and API Gateway sidesteps Function URL auth entirely.
  #
  # step.md 11.6.2 argued against API Gateway on cost and its 29-30s
  # timeout. Cost is ~$0 at this volume (12-month free tier, then $1/million
  # against ~300 requests/month). The timeout is the real constraint: a 9s
  # cold start plus a scan fits, but not by a wide margin — which is why the
  # warm-up below is wired in rather than left as advice.
  API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
    --query "Items[?Name=='$FUNCTION'].ApiId | [0]" --output text 2>/dev/null | grep -v '^None$' || true)"
  if [ -z "$API_ID" ]; then
    API_ID="$(aws apigatewayv2 create-api --name "$FUNCTION" --protocol-type HTTP \
      --target "arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNCTION" --region "$REGION" \
      --query ApiId --output text)"
    echo "    created $API_ID"
  else
    echo "    reusing $API_ID"
  fi

  # `create-api --target` builds the integration and route but NOT the
  # invoke permission, so a fresh API returns a bare "Internal Server Error"
  # with nothing in CloudWatch — the request never reaches the function.
  # Re-applied every run because it is idempotent and cheap to get wrong.
  aws lambda add-permission --function-name "$FUNCTION" --region "$REGION" \
    --statement-id AllowAPIGatewayInvoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*" >/dev/null 2>&1 \
    || echo "    (invoke permission already present)"

  API_URL="https://$API_ID.execute-api.$REGION.amazonaws.com"

  # issues.md N38 — caps on what an anonymous caller can make this account
  # spend, enforced by AWS itself and account-wide (ratelimit.py's per-IP
  # limit is per container and in memory). The budget alarm is set in the
  # console, outside this script.
  say "Spending caps (N38)"
  # Requests per second across EVERY caller. Real use is ~0.1/s per grading
  # instructor (a scan plus a harvest per script), so 2/s covers a dozen or
  # more grading at once. Above it API Gateway answers 429 without ever
  # invoking — or billing — the function.
  aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' --region "$REGION" \
    --default-route-settings "ThrottlingBurstLimit=${API_BURST_LIMIT:-10},ThrottlingRateLimit=${API_RATE_LIMIT:-2}" \
    >/dev/null
  echo "    API Gateway: ${API_RATE_LIMIT:-2} requests/s, bursts of ${API_BURST_LIMIT:-10}"
  # How many scans may run at once, which bounds compute cost directly.
  # Needs lambda:PutFunctionConcurrency (added to aws/deploy-policy.json
  # 2026-09-25); applying that policy takes an admin profile, so a denial is
  # reported, not fatal. So is an account too small to reserve from (AWS
  # keeps 10 unreserved).
  local conc_err
  if conc_err="$(aws lambda put-function-concurrency --function-name "$FUNCTION" --region "$REGION" \
      --reserved-concurrent-executions "${LAMBDA_MAX_CONCURRENCY:-5}" 2>&1 >/dev/null)"; then
    echo "    Lambda: at most ${LAMBDA_MAX_CONCURRENCY:-5} scans at once"
  elif printf '%s' "$conc_err" | grep -q "UnreservedConcurrentExecution"; then
    # Seen on this account 2026-09-25: its TOTAL Lambda concurrency is the
    # new-account default (~10), and AWS keeps 10 unreserved, so nothing can
    # be reserved — but that small total already caps concurrency, below
    # this script's own number. Revisit only if AWS raises the quota.
    echo "    Lambda: account concurrency is already at AWS's small new-account limit,"
    echo "      which caps concurrent scans by itself; nothing to reserve"
  else
    echo "    ! Lambda concurrency cap NOT set: ${conc_err##*: }"
    echo "      If that is AccessDenied, apply the updated aws/deploy-policy.json from an admin profile."
  fi

  say "Smoke test + warm-up through the real endpoint"
  # 11.6.5's warm-up and a genuine end-to-end check in one. Measured cold
  # start on this function is ~9s (the adapter logs "app is not ready after
  # 8000ms"), not the 2-4s originally estimated from a laptop emulator, so
  # this matters more than expected: without it the first real scan of a
  # class is the slow one.
  # HERE_NATIVE, not HERE: curl is a native program and this script has
  # MSYS path conversion switched off (disable_msys_path_conversion, for
  # docker's container-side paths), so an MSYS `/g/Dev/...` reaches curl
  # verbatim and it cannot open the file — exit 26, CURLE_READ_ERROR.
  # That mattered far more than a bad smoke test: `set -euo pipefail`
  # turned it into an abort INSIDE deploy_backend, so `./deploy.sh all`
  # deployed the backend and then silently stopped, never reaching cdn,
  # frontend or dashboard. The `[ -f ]` guard below does not catch it —
  # bash reads MSYS paths fine; only curl cannot.
  #
  # issues.md N22: this used to skip silently when the photo was missing and
  # never looked at the answer, so a deploy whose only end-to-end check never
  # ran, or failed, looked exactly like one that passed. Both now stop the
  # deploy. $HERE (not HERE_NATIVE) for bash's own -f test.
  local photo="$HERE_NATIVE/testset/images/filled_file.jpeg"
  local smoke_config='{"quizName":"smoke","idDigits":7,"totalMax":25,"questions":[{"q":1,"max":5},{"q":2,"max":5},{"q":3,"max":5},{"q":4,"max":5},{"q":5,"max":5}]}'
  if [ ! -f "$HERE/testset/images/filled_file.jpeg" ]; then
    echo "    ✗ smoke test photo testset/images/filled_file.jpeg is missing — nothing was checked" >&2
    exit 1
  fi
  local reply
  reply="$(curl -s --max-time 90 -X POST "$API_URL/api/scan" -H "X-Origin-Verify: $ORIGIN_SECRET" \
    -F "image=@$photo" -F "config=$smoke_config" || true)"
  echo "    ${reply:0:200}"
  if ! printf '%s' "$reply" | grep -q '"status":"ok"'; then
    echo "    ✗ smoke test FAILED: the deployed backend did not return status ok" >&2
    exit 1
  fi
  echo "    ✓ a real scan succeeds"
  # N42's proof: the same call WITHOUT the secret — what anyone calling the
  # execute-api URL directly would send — must be refused.
  local direct
  direct="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$API_URL/api/scan" \
    -F "image=@$photo" -F "config=$smoke_config" || true)"
  if [ "$direct" != "403" ]; then
    echo "    ✗ a direct call without the CloudFront secret returned $direct, expected 403" >&2
    exit 1
  fi
  echo "    ✓ a direct call without the CloudFront secret is refused (403)"

  echo
  echo "API_URL=$API_URL"
}

# --- Frontend --------------------------------------------------------------

deploy_frontend() {
  say "Site bucket"
  have aws s3api head-bucket --bucket "$SITE_BUCKET" \
    || aws s3 mb "s3://$SITE_BUCKET" --region "$REGION" >/dev/null
  # Stays private. CloudFront reaches it through Origin Access Control, so
  # the bucket itself is never public — and an S3 website endpoint could
  # not serve HTTPS anyway, which the camera requires (see below).
  aws s3api put-public-access-block --bucket "$SITE_BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

  say "Build frontend for same-origin"
  # VITE_API_BASE="" means SAME ORIGIN — requests become relative
  # (`/api/scan`), which CloudFront routes to the Lambda. No second origin,
  # so no CORS anywhere. See api.ts's apiBase() for why empty is a real
  # value here rather than "unset".
  #
  # VITE_* is inlined at BUILD time, not read at runtime, so this has to
  # happen before the upload and a change means rebuilding.
  ( cd "$HERE/frontend" && VITE_API_BASE="" npm run build )

  say "Upload"
  # Hashed assets are immutable and cached hard; index.html and the service
  # worker must never be, or a redeploy strands clients on the old bundle.
  aws s3 sync "$HERE_NATIVE/frontend/dist" "s3://$SITE_BUCKET" --delete \
    --exclude "index.html" --exclude "sw.js" --exclude "registerSW.js" \
    --cache-control "public,max-age=31536000,immutable"
  aws s3 sync "$HERE_NATIVE/frontend/dist" "s3://$SITE_BUCKET" \
    --exclude "*" --include "index.html" --include "sw.js" --include "registerSW.js" \
    --cache-control "no-cache"

  say "CloudFront"
  if [ -z "${DISTRIBUTION_ID:-}" ]; then
    DISTRIBUTION_ID="$(find_distribution)"
  fi
  if [ -n "$DISTRIBUTION_ID" ]; then
    aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
      --paths "/index.html" "/sw.js" "/registerSW.js" >/dev/null
    echo "    invalidated $DISTRIBUTION_ID"
  else
    echo "    no distribution yet — run './deploy.sh cdn' first"
  fi
}

# --- CloudFront ------------------------------------------------------------
#
# One distribution, two origins:
#
#   default   -> the S3 site bucket  (cached hard; hashed asset filenames)
#   /api/*    -> the API Gateway HTTP API (NEVER cached; see below)
#
# Serving both from one domain means the frontend and API share an origin,
# so there is no CORS anywhere — which deletes a whole category of bugs this
# project has already paid for more than once. That is the entire benefit
# CloudFront provides for the API, and it is worth being precise about.
#
# WHAT THIS DOES NOT DO: it does not make the backend private. An earlier
# version of this comment said the opposite — that the Lambda stayed on
# AWS_IAM and CloudFront signed each request with OAC, "so nothing can call
# it directly." That was the Function URL design, which does not work on
# this account (see the API Gateway section above). API Gateway is
# PUBLICLY INVOKABLE: https://<api-id>.execute-api.<region>.amazonaws.com
# answers /api/scan directly, bypassing this distribution entirely.
#
# That is accepted rather than overlooked — CloudFront was never adding
# auth here, and ratelimit.py's per-IP limit and the upload cap apply on
# both paths since they live in the app. But do not write code, or a
# threat model, that assumes the CDN is a chokepoint. If the direct URL
# ever needs closing off, the mechanism is a CloudFront-injected secret
# header that the origin checks — not OAC. (issues.md N10.)

# AWS-managed policy ids, stable across accounts.
CACHE_DISABLED=4135ea2d-6df8-44a3-9df3-4b5a84be39ad
CACHE_OPTIMIZED=658327ea-f89d-4fab-a63d-7e88639e58f6
# Forwards everything EXCEPT Host. That exception is load-bearing, though
# not for the reason this comment used to give (a SigV4 mismatch against a
# Function URL's own hostname — that was the abandoned design). With API
# Gateway it is simpler and just as fatal: the API is addressed BY Host
# header, so forwarding the viewer's `d2n2...cloudfront.net` sends a
# request the gateway has no matching API for. The origin must see its own
# execute-api hostname.
ORIGIN_REQ_ALL_EXCEPT_HOST=b689b0a8-53d0-40ab-baf2-68738e2966ac

find_distribution() {
  aws cloudfront list-distributions \
    --query "DistributionList.Items[?Comment=='$PROJECT'].Id | [0]" \
    --output text 2>/dev/null | grep -v '^None$' || true
}

oac_id() { # oac_id <name> <origin-type>
  local existing
  existing="$(aws cloudfront list-origin-access-controls \
    --query "OriginAccessControlList.Items[?Name=='$1'].Id | [0]" --output text 2>/dev/null)"
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then echo "$existing"; return; fi
  aws cloudfront create-origin-access-control --origin-access-control-config \
    "{\"Name\":\"$1\",\"Description\":\"$PROJECT\",\"SigningProtocol\":\"sigv4\",\"SigningBehavior\":\"always\",\"OriginAccessControlOriginType\":\"$2\"}" \
    --query 'OriginAccessControl.Id' --output text
}

ensure_site_bucket() {
  # Lives here as well as in deploy_frontend because the distribution's
  # origin and bucket policy both need it to exist first — an ordering the
  # first version of this script got wrong, creating a distribution that
  # pointed at a bucket that did not exist yet.
  have aws s3api head-bucket --bucket "$SITE_BUCKET" \
    || aws s3 mb "s3://$SITE_BUCKET" --region "$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$SITE_BUCKET" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
}

grant_cdn_access() { # grant_cdn_access <distribution-arn>
  # Only the S3 bucket policy now. The API origin is API Gateway, which
  # needs no grant from CloudFront.
  local arn="$1"
  say "Bucket policy — CloudFront may read the site bucket, nobody else"
  aws s3api put-bucket-policy --bucket "$SITE_BUCKET" --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Principal\": {\"Service\": \"cloudfront.amazonaws.com\"},
      \"Action\": \"s3:GetObject\",
      \"Resource\": \"arn:aws:s3:::$SITE_BUCKET/*\",
      \"Condition\": {\"StringEquals\": {\"AWS:SourceArn\": \"$arn\"}}
    }]}"

}

# --- Security headers (issues.md N43) --------------------------------------
#
# One CloudFront response headers policy, created or brought up to date on
# every deploy, with its values defined in aws/headers_policy.py. Needs four
# cloudfront:*ResponseHeadersPolic* grants (aws/deploy-policy.json, added
# 2026-09-25); without them this reports and the deploy carries on. The
# page's own script/style CSP ships inside index.html and needs nothing here.
SECURITY_HEADERS_ID=""
ensure_security_headers() {
  local name existing etag tmp err
  name="$($PY_CMD -c 'import sys; sys.path.insert(0, sys.argv[1]); import headers_policy; print(headers_policy.NAME)' "$HERE_NATIVE/aws")"
  tmp="$(mktemp -t "$PROJECT-headers.XXXXXX.json")"
  $PY_CMD "$HERE_NATIVE/aws/headers_policy.py" config > "$tmp"
  if ! existing="$(aws cloudfront list-response-headers-policies --type custom \
      --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='$name'].ResponseHeadersPolicy.Id | [0]" \
      --output text 2>&1)"; then
    echo "    ! security headers NOT applied: ${existing##*: }"
    echo "      Apply the updated aws/deploy-policy.json from an admin profile, then re-run."
    rm -f "$tmp"; return 0
  fi
  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    etag="$(aws cloudfront get-response-headers-policy --id "$existing" --query ETag --output text)"
    aws cloudfront update-response-headers-policy --id "$existing" --if-match "$etag" \
      --response-headers-policy-config "file://$(native_path "$tmp")" >/dev/null
    SECURITY_HEADERS_ID="$existing"
  else
    SECURITY_HEADERS_ID="$(aws cloudfront create-response-headers-policy \
      --response-headers-policy-config "file://$(native_path "$tmp")" \
      --query 'ResponseHeadersPolicy.Id' --output text)"
  fi
  rm -f "$tmp"
  echo "    security headers policy $SECURITY_HEADERS_ID"
}

# Attaches that policy to every behaviour of an EXISTING distribution.
attach_security_headers() {
  local dist="$1" tmp etag
  [ -n "$SECURITY_HEADERS_ID" ] || return 0
  tmp="$(mktemp -t "$PROJECT-dist-headers.XXXXXX.json")"
  etag="$(aws cloudfront get-distribution-config --id "$dist" --query ETag --output text)"
  if aws cloudfront get-distribution-config --id "$dist" --output json \
      | $PY_CMD "$HERE_NATIVE/aws/headers_policy.py" attach "$SECURITY_HEADERS_ID" "$(native_path "$tmp")"; then
    aws cloudfront update-distribution --id "$dist" --if-match "$etag" \
      --distribution-config "file://$(native_path "$tmp")" >/dev/null
    echo "    attached to the site and /api/* (propagates in a few minutes)"
  fi
  rm -f "$tmp"
}

deploy_cdn() {
  say "Site bucket"
  ensure_site_bucket

  local existing arn domain
  existing="$(find_distribution)"
  if [ -n "$existing" ]; then
    DISTRIBUTION_ID="$existing"
    arn="$(aws cloudfront get-distribution --id "$existing" --query 'Distribution.ARN' --output text)"
    domain="$(aws cloudfront get-distribution --id "$existing" --query 'Distribution.DomainName' --output text)"
    echo "    reusing distribution $existing"
    # Deliberately NOT returning early: the bucket policy and the Lambda
    # permission below are idempotent, and re-applying them is how a
    # partially-failed first run repairs itself.
    grant_cdn_access "$arn"
    say "Security headers (N43)"
    ensure_security_headers
    attach_security_headers "$existing"
    echo
    echo "CDN_URL=https://$domain"
    echo "DISTRIBUTION_ID=$DISTRIBUTION_ID"
    return
  fi

  : "${API_URL:?set API_URL (run ./deploy.sh backend first)}"
  resolve_origin_secret
  local api_host; api_host="${API_URL#https://}"; api_host="${api_host%/}"

  say "Origin access control (S3 only)"
  # Only the S3 origin needs one. API Gateway is publicly invokable, so the
  # API origin takes no OAC and no request signing — which is exactly the
  # machinery that could not be made to work against a Function URL here.
  local s3_oac
  s3_oac="$(oac_id "$PROJECT-s3" s3)"
  echo "    s3=$s3_oac"

  say "Security headers (N43)"
  ensure_security_headers
  local rhp=""
  [ -n "$SECURITY_HEADERS_ID" ] && rhp="\"ResponseHeadersPolicyId\": \"$SECURITY_HEADERS_ID\","

  say "Creating distribution (this takes several minutes to propagate)"
  local dist_config
  # mktemp, not a hardcoded /tmp path: on Windows /tmp is an MSYS
  # fiction that aws.exe cannot open, so the file:// URL below has to
  # name a real one. native_path turns it into a form aws understands.
  dist_config="$(mktemp -t "$PROJECT-dist.XXXXXX.json")"
  cat > "$dist_config" <<JSON
{
  "CallerReference": "$PROJECT-$(date +%s)",
  "Comment": "$PROJECT",
  "Enabled": true,
  "DefaultRootObject": "index.html",
  "Origins": {"Quantity": 2, "Items": [
    {"Id": "site", "DomainName": "$SITE_BUCKET.s3.$REGION.amazonaws.com",
     "OriginAccessControlId": "$s3_oac",
     "S3OriginConfig": {"OriginAccessIdentity": ""}},
    {"Id": "api", "DomainName": "$api_host",
     "CustomHeaders": {"Quantity": 1, "Items": [
       {"HeaderName": "X-Origin-Verify", "HeaderValue": "$ORIGIN_SECRET"}]},
     "CustomOriginConfig": {"HTTPPort": 80, "HTTPSPort": 443,
       "OriginProtocolPolicy": "https-only",
       "OriginSslProtocols": {"Quantity": 1, "Items": ["TLSv1.2"]},
       "OriginReadTimeout": 60}}
  ]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "site",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
    "CachePolicyId": "$CACHE_OPTIMIZED",
    $rhp
    "Compress": true
  },
  "CacheBehaviors": {"Quantity": 1, "Items": [
    {"PathPattern": "/api/*", "TargetOriginId": "api",
     "ViewerProtocolPolicy": "https-only",
     "AllowedMethods": {"Quantity": 7,
       "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
       "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
     "CachePolicyId": "$CACHE_DISABLED",
     "OriginRequestPolicyId": "$ORIGIN_REQ_ALL_EXCEPT_HOST",
     $rhp
     "Compress": false}
  ]},
  "//": "NO CustomErrorResponses on purpose. The usual SPA fallback (403 -> /index.html, 200) applies DISTRIBUTION-WIDE, not per behaviour, so it silently rewrites API errors into an HTML page with a 200 status - a failed scan would look like a successful one returning gibberish. This app has no client-side routing and no deep links, so it needs no fallback at all.",
  "PriceClass": "PriceClass_100"
}
JSON

  local out
  out="$(aws cloudfront create-distribution --distribution-config "file://$(native_path "$dist_config")" \
    --query '{Id:Distribution.Id,Domain:Distribution.DomainName,Arn:Distribution.ARN}' --output json)"
  DISTRIBUTION_ID="$(echo "$out" | $PY_CMD -c 'import json,sys; print(json.load(sys.stdin)["Id"])')"
  local domain arn
  domain="$(echo "$out" | $PY_CMD -c 'import json,sys; print(json.load(sys.stdin)["Domain"])')"
  arn="$(echo "$out" | $PY_CMD -c 'import json,sys; print(json.load(sys.stdin)["Arn"])')"
  echo "    $DISTRIBUTION_ID  https://$domain"

  grant_cdn_access "$arn"

  echo
  echo "CDN_URL=https://$domain"
  echo "DISTRIBUTION_ID=$DISTRIBUTION_ID"
}

# Applies ALLOWED_ORIGINS once the CloudFront domain is known (issues.md
# N13). deploy_backend has to run first — the distribution needs an origin
# to point at — so on a first `all` run the function is created before its
# own public URL exists, and the env var it was given is therefore the
# unset default. Nothing ever went back to fix that, so the deployed
# function kept the localhost/LAN regex step 11.1.1 built ALLOWED_ORIGINS
# specifically to replace.
#
# Harmless today only because the frontend is same-origin behind CloudFront,
# so no CORS check ever runs — which means the seam was untested in
# production and would have surprised whoever first split the origins.
apply_allowed_origins() {
  local domain
  domain="$(aws cloudfront get-distribution --id "${DISTRIBUTION_ID:-}" \
    --query 'Distribution.DomainName' --output text 2>/dev/null || true)"
  if [ -z "$domain" ] || [ "$domain" = "None" ]; then
    echo "    no distribution domain yet — ALLOWED_ORIGINS left unset"
    return 0
  fi

  resolve_origin_secret
  say "ALLOWED_ORIGINS=https://$domain"
  aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
    --environment "Variables={$(lambda_env "https://$domain")}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION"
}

# --- Monitoring (step 11.8) -------------------------------------------------

# One CloudWatch Dashboard, private (AWS Console only — no public URL, no
# new auth to build, matching how every other part of this app is watched
# today). It is NOT the whole picture on purpose: CloudWatch dashboards
# have no widget type that embeds an X-Ray trace map (confirmed against
# AWS's own Dashboard Body Structure docs — valid types are metric, text,
# log, alarm, explorer, chart, full stop), so the live Lambda<->S3 node
# graph lives on its own page in the X-Ray console, one click away via the
# link widget below, rather than inside this dashboard's grid. What DOES
# fit here: frontend hits (CloudFront), backend hits (API Gateway, which
# X-Ray can never show at all — HTTP APIs don't support tracing, only
# REST APIs do), Lambda's own health metrics, and the existing success-
# rate query from aws/MONITORING.md, all on one page instead of four
# separate console tabs.
deploy_dashboard() {
  say "Monitoring dashboard"

  # Re-derived rather than assumed set: `./deploy.sh dashboard` on its own
  # (no prior `backend`/`cdn` in this same process) needs both looked up
  # fresh, the same idempotent queries deploy_backend/find_distribution
  # already use.
  local api_id="${API_ID:-}"
  if [ -z "$api_id" ]; then
    api_id="$(aws apigatewayv2 get-apis --region "$REGION" \
      --query "Items[?Name=='$FUNCTION'].ApiId | [0]" --output text 2>/dev/null | grep -v '^None$' || true)"
  fi
  local distribution_id="${DISTRIBUTION_ID:-}"
  if [ -z "$distribution_id" ]; then
    distribution_id="$(find_distribution)"
  fi

  local dashboard_config
  dashboard_config="$(mktemp -t "$PROJECT-dashboard.XXXXXX.json")"

  # CloudFront's own CloudWatch metrics publish ONLY to us-east-1 — a
  # genuine AWS constant, true regardless of $REGION, not a value that
  # changes per deployment the way every other region reference here does.
  # Hardcoded on purpose; do not replace with $REGION.
  # NOTE: this heredoc is deliberately UNQUOTED, because the widget bodies
  # need $PROJECT/$REGION/$FUNCTION and the two derived ids expanded. The
  # cost is that backticks and $(...) inside it are still live shell
  # syntax — a markdown `code span` in the text widget below will be run
  # as a command, not printed. (Found exactly that way: a backticked
  # "/api/scan" became "No such file or directory" and shipped an empty
  # string into the dashboard.) Keep the markdown backtick-free.
  cat > "$dashboard_config" <<JSON
{
  "widgets": [
    {
      "type": "text", "x": 0, "y": 0, "width": 24, "height": 2,
      "properties": {
        "markdown": "**$PROJECT** — frontend and backend hit counts below. The live request-flow graph (Lambda -> S3) is a separate page, not a widget: [X-Ray trace map](https://$REGION.console.aws.amazon.com/cloudwatch/home?region=$REGION#xray:traces/map). If that link ever moves, the documented route is the CloudWatch left nav: **X-Ray traces -> Trace Map**. A scan shows just the Lambda box; a harvest also lights up the S3 edge."
      }
    },
    {
      "type": "metric", "x": 0, "y": 2, "width": 8, "height": 6,
      "properties": {
        "title": "Frontend hits (CloudFront requests)",
        "view": "timeSeries", "stacked": false, "region": "us-east-1",
        "metrics": [["AWS/CloudFront", "Requests", "DistributionId", "${distribution_id:-none}", "Region", "Global", {"stat": "Sum"}]]
      }
    },
    {
      "type": "metric", "x": 8, "y": 2, "width": 8, "height": 6,
      "properties": {
        "title": "Backend hits (API Gateway requests)",
        "view": "timeSeries", "stacked": false, "region": "$REGION",
        "metrics": [["AWS/ApiGateway", "Count", "ApiId", "${api_id:-none}", {"stat": "Sum"}]]
      }
    },
    {
      "type": "metric", "x": 16, "y": 2, "width": 8, "height": 6,
      "properties": {
        "title": "Lambda health",
        "view": "timeSeries", "stacked": false, "region": "$REGION",
        "metrics": [
          ["AWS/Lambda", "Invocations", "FunctionName", "$FUNCTION", {"stat": "Sum"}],
          ["AWS/Lambda", "Errors", "FunctionName", "$FUNCTION", {"stat": "Sum"}]
        ]
      }
    },
    {
      "type": "log", "x": 0, "y": 8, "width": 24, "height": 6,
      "properties": {
        "title": "Scan success rate, by hour (aws/MONITORING.md)",
        "region": "$REGION", "view": "table",
        "query": "SOURCE '/aws/lambda/$FUNCTION' | fields @timestamp\n| filter event = \"scan\"\n| stats count() as scans, sum(status = \"failed\") as failed, sum(status = \"failed\") * 100 / count() as pct_failed by bin(1h)"
      }
    }
  ]
}
JSON

  aws cloudwatch put-dashboard --dashboard-name "$PROJECT" --region "$REGION" \
    --dashboard-body "file://$(native_path "$dashboard_config")" >/dev/null
  rm -f "$dashboard_config"
  echo "    https://$REGION.console.aws.amazon.com/cloudwatch/home?region=$REGION#dashboards:name=$PROJECT"
  if [ -z "$api_id" ] || [ -z "$distribution_id" ]; then
    echo "    (backend and/or cdn not deployed yet — that widget will show no data until they are)"
  fi
}

case "${1:-all}" in
  backend)   deploy_backend ;;
  cdn)       deploy_cdn ;;
  frontend)  deploy_frontend ;;
  dashboard) deploy_dashboard ;;
  all)       deploy_backend; deploy_cdn; apply_allowed_origins; deploy_frontend; deploy_dashboard ;;
  *) echo "usage: $0 [backend|cdn|frontend|dashboard|all]" >&2; exit 2 ;;
esac
