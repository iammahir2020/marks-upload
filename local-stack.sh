#!/usr/bin/env bash
# Run the app in its DEPLOYED shape, entirely on this laptop, before any
# AWS resource exists (step 11, phase C dry run).
#
# This is not ./dev.sh. dev.sh runs the laptop workflow: uvicorn --reload
# against source, harvesting to a local directory. This runs the thing that
# will actually be deployed:
#
#   - the real container image, on a READ-ONLY filesystem with only /tmp
#     writable, exactly as Lambda mounts it
#   - HARVEST_BACKEND=s3, against a real S3 API (MinIO, S3-compatible) —
#     so the boto3 path, the key layout and the bucket write are genuinely
#     exercised rather than stubbed
#   - ALLOWED_ORIGINS set, as it will be in production, instead of the
#     localhost/LAN regex
#   - rate limiting and the upload cap on
#   - a production frontend BUILD (not the dev server) pointed at the
#     container via VITE_API_BASE
#
# What it still cannot prove: IAM, API Gateway, CloudFront, and cold
# starts. Everything else that could break in production breaks here first,
# where the feedback loop is seconds.
#
#   ./local-stack.sh up      # start MinIO + backend, build + serve frontend
#   ./local-stack.sh crops   # list what has landed in the bucket
#   ./local-stack.sh logs    # backend request log (gone once containers are removed)
#   ./local-stack.sh down    # stop; collected crops SURVIVE in a named volume
#   ./local-stack.sh reset   # stop and wipe the collected crops too
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET=marks-local
VOLUME=marks-minio-data
BUCKET=marks-crops
API_PORT=8443
WEB_PORT=5173
MINIO_USER=localdev
MINIO_PASS=localdev123

LAN_IP="$(python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect(('8.8.8.8', 80)); print(s.getsockname()[0]); s.close()")"
API_URL="https://$LAN_IP:$API_PORT"
WEB_URL="https://$LAN_IP:$WEB_PORT"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# Every call to the local S3 goes through here, so the endpoint and
# credentials cannot drift between the setup path and the inspection path.
minio_aws() {
  AWS_ACCESS_KEY_ID="$MINIO_USER" AWS_SECRET_ACCESS_KEY="$MINIO_PASS" \
    AWS_DEFAULT_REGION=us-east-1 \
    aws --endpoint-url "http://127.0.0.1:9000" "$@"
}

up() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

  # Rebuild by default. The container is a build artifact, so without this
  # a backend change is invisible here and you spend the session testing
  # the previous version — which is a genuinely confusing way to lose an
  # hour. Layer caching makes this a few seconds when only app/ changed.
  # SKIP_BUILD=1 for a pure frontend iteration.
  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    say "Building backend image"
    docker build -q -t marks-backend "$HERE/backend" >/dev/null
    echo "    built"
  fi

  say "MinIO (a real S3 API, locally)"
  docker rm -f marks-minio >/dev/null 2>&1 || true
  # 9000 is the S3 API, 9001 the console. Publishing only the console (as
  # this first did) makes bucket creation fail from the host while the
  # container itself still reaches MinIO fine over the docker network — so
  # everything looks up and the first harvest dies on NoSuchBucket.
  # The named volume is load-bearing. Without it MinIO's /data lives in the
  # container's writable layer, so `down` (which rm -f's the container)
  # silently destroys every crop collected during testing — which is
  # exactly the evidence you ran the test to look at.
  docker volume inspect "$VOLUME" >/dev/null 2>&1 || docker volume create "$VOLUME" >/dev/null
  docker run -d --name marks-minio --network "$NET" -p 9000:9000 -p 9001:9001 \
    -v "$VOLUME:/data" \
    -e "MINIO_ROOT_USER=$MINIO_USER" -e "MINIO_ROOT_PASSWORD=$MINIO_PASS" \
    quay.io/minio/minio server /data --console-address ":9001" >/dev/null
  sleep 4
  # Not `|| true`: a bucket that fails to create must be loud here, not
  # discovered later as a 500 from the harvest endpoint. Only an
  # already-exists on re-run is acceptable.
  if ! mc_out="$(minio_aws s3 mb "s3://$BUCKET" 2>&1)"; then
    case "$mc_out" in
      *BucketAlreadyOwnedByYou*|*BucketAlreadyExists*) : ;;
      *) echo "failed to create bucket: $mc_out" >&2; exit 1 ;;
    esac
  fi
  echo "    bucket s3://$BUCKET ready"

  # The LAN IP is baked into TWO artifacts, and they go stale independently
  # when you move between networks (office wifi -> phone hotspot -> home):
  #
  #   1. the TLS cert's SAN list  — regenerated here if it no longer matches
  #   2. the frontend bundle      — rebuilt below on every `up`, so it
  #                                 self-heals as long as you re-run this
  #
  # Symptom when (1) is stale: the phone refuses the API with a cert error
  # you may never see, because the failed request is a fetch, not a page
  # load. Symptom when (2) is stale: "Failed to fetch", because the bundle
  # is calling an address that exists on a network you have left.
  if ! openssl x509 -in "$HERE/backend/certs/cert.pem" -noout -text 2>/dev/null \
       | grep -q "IP Address:$LAN_IP"; then
    say "Regenerating TLS cert — it does not cover $LAN_IP"
    ( cd "$HERE/backend" && ./venv/bin/python gen_dev_cert.py )
    echo "    NOTE: the phone must accept the new cert again at $API_URL"
  fi

  say "Backend container, read-only, harvesting to S3"
  docker rm -f marks-api >/dev/null 2>&1 || true
  # --read-only --tmpfs /tmp is the point: it reproduces Lambda's
  # filesystem, so any write path outside /tmp fails here instead of in
  # CloudWatch. The certs are mounted read-only and uvicorn terminates TLS
  # itself; in production CloudFront and API Gateway do that instead, which
  # is the one deliberate difference from the deployed shape (the camera
  # needs HTTPS, and a page served over HTTPS cannot call a plain-HTTP
  # backend).
  docker run -d --name marks-api --network "$NET" -p "$API_PORT:8000" \
    --read-only --tmpfs /tmp \
    -v "$HERE/backend/certs:/certs:ro" \
    -e HARVEST_BACKEND=s3 \
    -e HARVEST_BUCKET="$BUCKET" \
    -e HARVEST_PREFIX=harvested \
    -e AWS_ENDPOINT_URL="http://marks-minio:9000" \
    -e AWS_ACCESS_KEY_ID="$MINIO_USER" \
    -e AWS_SECRET_ACCESS_KEY="$MINIO_PASS" \
    -e AWS_DEFAULT_REGION=us-east-1 \
    -e ALLOWED_ORIGINS="$WEB_URL" \
    marks-backend \
    sh -c "uvicorn app.main:app --host 0.0.0.0 --port 8000 \
           --ssl-keyfile /certs/key.pem --ssl-certfile /certs/cert.pem" >/dev/null
  sleep 6
  docker logs marks-api 2>&1 | tail -3

  say "Frontend production build against $API_URL"
  ( cd "$HERE/frontend" && VITE_API_BASE="$API_URL" npm run build )

  cat <<EOF

$(printf '\033[1mReady.\033[0m')

  Built for LAN IP $LAN_IP. If your phone cannot reach that address,
  you have changed networks since — re-run ./local-stack.sh up.

  1. Serve the built frontend (leave this running):
       cd frontend && npx vite preview --host --port $WEB_PORT

  2. On the phone, open:   $WEB_URL
     Accept the certificate warning TWICE — once for the page at
     $WEB_URL, and once for the API at $API_URL. The second one is easy to
     miss: nothing prompts you, scans just fail. Visit $API_URL/docs
     directly in the phone browser and accept there first.

  3. Run a real scan. Then check a crop actually landed:
       ./local-stack.sh crops

  MinIO console: http://localhost:9001  ($MINIO_USER / $MINIO_PASS)
EOF
}

crops() {
  say "Objects in s3://$BUCKET"
  minio_aws s3 ls "s3://$BUCKET" --recursive | tail -30
  echo
  echo "Key layout should read <source-id>/<field>/<confirmed|corrected>/<value>_<uuid>.png"
  echo "The source id is per-browser (db.ts getSourceId), so it is the same for"
  echo "every crop from one phone and different from another's."
}

down() {
  docker rm -f marks-api marks-minio >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The volume deliberately SURVIVES. Crops collected during a test are
  # the point of running the test; `down` should not throw them away.
  echo "stopped (crops kept in volume $VOLUME — './local-stack.sh reset' to wipe)"
}

reset() {
  down
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  echo "volume $VOLUME removed — all locally collected crops are gone"
}

logs() {
  docker logs marks-api 2>&1 | tail -"${2:-40}"
}

case "${1:-up}" in
  up) up ;;
  crops) crops ;;
  logs) logs "$@" ;;
  down) down ;;
  reset) reset ;;
  *) echo "usage: $0 [up|crops|logs|down|reset]" >&2; exit 2 ;;
esac
