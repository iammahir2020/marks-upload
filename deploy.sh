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

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
# Bucket names are globally unique across all of AWS, so the account id is
# appended rather than hoping "marks-scanner-crops" is free.
CROPS_BUCKET="${CROPS_BUCKET:-$PROJECT-crops-$ACCOUNT}"
SITE_BUCKET="${SITE_BUCKET:-$PROJECT-site-$ACCOUNT}"
ECR_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { "$@" >/dev/null 2>&1; }

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
    -t "$ECR_URI:latest" "$HERE/backend"
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

  say "Execution role"
  if ! have aws iam get-role --role-name "$ROLE_NAME"; then
    aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document '{
      "Version":"2012-10-17",
      "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},
                    "Action":"sts:AssumeRole"}]}' >/dev/null
    aws iam attach-role-policy --role-name "$ROLE_NAME" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  fi
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
  local env_vars="RECOGNIZER=cnn,HARVEST_BACKEND=s3,HARVEST_BUCKET=$CROPS_BUCKET,HARVEST_PREFIX=harvested"
  if [ -n "${SITE_URL:-}" ]; then env_vars="$env_vars,ALLOWED_ORIGINS=$SITE_URL"; fi

  say "Lambda function"
  if have aws lambda get-function --function-name "$FUNCTION" --region "$REGION"; then
    aws lambda update-function-code --function-name "$FUNCTION" --region "$REGION" \
      --image-uri "$ECR_URI:latest" >/dev/null
    # Two updates cannot be in flight at once, so this wait is required
    # between them, not merely tidy.
    aws lambda wait function-updated-v2 --function-name "$FUNCTION" --region "$REGION"
    aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
      --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" \
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
      --environment "Variables={$env_vars}" >/dev/null 2>&1; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 10 ]; then
        echo "    create-function failed 10 times; running it once more for the real error" >&2
        aws lambda create-function --function-name "$FUNCTION" --region "$REGION" \
          --package-type Image --code "ImageUri=$ECR_URI:latest" --role "$role_arn" \
          --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" --architectures x86_64 \
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

  say "Smoke test + warm-up through the real endpoint"
  # 11.6.5's warm-up and a genuine end-to-end check in one. Measured cold
  # start on this function is ~9s (the adapter logs "app is not ready after
  # 8000ms"), not the 2-4s originally estimated from a laptop emulator, so
  # this matters more than expected: without it the first real scan of a
  # class is the slow one.
  local photo="$HERE/testset/images/filled_file.jpeg"
  if [ -f "$photo" ]; then
    curl -s --max-time 90 -X POST "$API_URL/api/scan" \
      -F "image=@$photo" \
      -F 'config={"quizName":"smoke","idDigits":7,"totalMax":25,"questions":[{"q":1,"max":5},{"q":2,"max":5},{"q":3,"max":5},{"q":4,"max":5},{"q":5,"max":5}]}' \
      | head -c 200; echo
  fi

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
  aws s3 sync "$HERE/frontend/dist" "s3://$SITE_BUCKET" --delete \
    --exclude "index.html" --exclude "sw.js" --exclude "registerSW.js" \
    --cache-control "public,max-age=31536000,immutable"
  aws s3 sync "$HERE/frontend/dist" "s3://$SITE_BUCKET" \
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
    echo
    echo "CDN_URL=https://$domain"
    echo "DISTRIBUTION_ID=$DISTRIBUTION_ID"
    return
  fi

  : "${API_URL:?set API_URL (run ./deploy.sh backend first)}"
  local api_host; api_host="${API_URL#https://}"; api_host="${api_host%/}"

  say "Origin access control (S3 only)"
  # Only the S3 origin needs one. API Gateway is publicly invokable, so the
  # API origin takes no OAC and no request signing — which is exactly the
  # machinery that could not be made to work against a Function URL here.
  local s3_oac
  s3_oac="$(oac_id "$PROJECT-s3" s3)"
  echo "    s3=$s3_oac"

  say "Creating distribution (this takes several minutes to propagate)"
  cat > /tmp/$PROJECT-dist.json <<JSON
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
     "Compress": false}
  ]},
  "//": "NO CustomErrorResponses on purpose. The usual SPA fallback (403 -> /index.html, 200) applies DISTRIBUTION-WIDE, not per behaviour, so it silently rewrites API errors into an HTML page with a 200 status - a failed scan would look like a successful one returning gibberish. This app has no client-side routing and no deep links, so it needs no fallback at all.",
  "PriceClass": "PriceClass_100"
}
JSON

  local out
  out="$(aws cloudfront create-distribution --distribution-config "file:///tmp/$PROJECT-dist.json" \
    --query '{Id:Distribution.Id,Domain:Distribution.DomainName,Arn:Distribution.ARN}' --output json)"
  DISTRIBUTION_ID="$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Id"])')"
  local domain arn
  domain="$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Domain"])')"
  arn="$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Arn"])')"
  echo "    $DISTRIBUTION_ID  https://$domain"

  grant_cdn_access "$arn"

  echo
  echo "CDN_URL=https://$domain"
  echo "DISTRIBUTION_ID=$DISTRIBUTION_ID"
}

case "${1:-all}" in
  backend)  deploy_backend ;;
  cdn)      deploy_cdn ;;
  frontend) deploy_frontend ;;
  all)      deploy_backend; deploy_cdn; deploy_frontend ;;
  *) echo "usage: $0 [backend|cdn|frontend|all]" >&2; exit 2 ;;
esac
