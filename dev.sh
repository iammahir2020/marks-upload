#!/usr/bin/env bash
# Run the backend and frontend dev servers together. Ctrl+C stops both.
#
# Assumes backend/venv and frontend/node_modules already exist (see
# CLAUDE.md for first-time setup).
#
# RECOGNIZER defaults to "cnn" (step 3r.6e) — fully local, so no
# GEMINI_API_KEY and no Tesseract binary are needed for a normal run. Set
# RECOGNIZER=remote before invoking this script to use Gemini+Tesseract
# instead; that path does need backend/.env to carry a real key.
#   RECOGNIZER=remote ./dev.sh
#
# issues.md N44 — by default both servers listen on THIS machine only.
# To test with the phone, start a LAN session explicitly:
#   ./dev.sh --lan
# That binds both servers to every interface (on campus Wi-Fi that is
# everyone on it), and sends harvested crops to training_data/unverified/
# instead of the trusted harvested/ — review/promote them with
# fetch-crops.sh like the hosted site's.
set -e

LAN=0
for arg in "$@"; do
  case "$arg" in
    --lan) LAN=1 ;;
    *) echo "usage: $0 [--lan]" >&2; exit 2 ;;
  esac
done
# Deliberately NOT `set -m`: job control puts each backgrounded job in its
# own process group, which would mean `kill 0` below (send to *this*
# process group) never reaches uvicorn/npm at all. Without job control,
# background children inherit this script's process group like any normal
# fork — which is what makes `kill 0` actually reach all of them, uvicorn's
# --reload worker and npm's real vite child included. Verified directly:
# with `set -m` here, Ctrl+C left every server running; without it, all of
# them die (see learn.md).

cd "$(dirname "$0")"

# A venv keeps its programs in bin/ on Linux and Scripts/ on Windows, so
# the path is resolved rather than written out. On Windows this script
# runs under Git Bash; note that dev.ps1 is the better entry point there,
# because the `kill 0` cleanup below has no real equivalent in MSYS —
# see that file's own header.
. ./shell-portability.sh

if [ ! -f backend/certs/cert.pem ]; then
  echo "No backend dev cert found — generating one (gen_dev_cert.py)..."
  (cd backend && venv_activate venv && python gen_dev_cert.py)
fi

cleanup() {
  # This script is itself in the process group `kill 0` broadcasts to, so
  # without this, its own TERM/EXIT trap would re-enter partway through
  # cleanup — cutting it short before reaching the force-kill below.
  # Verified directly: without this line, the frontend died but the
  # backend's reloader was still alive several seconds later (see learn.md).
  trap '' EXIT INT TERM
  kill -TERM 0 2>/dev/null
  # uvicorn --reload's watcher subprocess doesn't reliably exit on SIGTERM
  # alone even when it's correctly in this process group. Give everything a
  # moment to exit cleanly, then force anything still standing.
  sleep 1
  kill -KILL 0 2>/dev/null
}
trap cleanup EXIT INT TERM

BACKEND_HOST=127.0.0.1
if [ "$LAN" = 1 ]; then
  BACKEND_HOST=0.0.0.0
  export MARKS_LAN=1
  mkdir -p backend/training_data/unverified
  export HARVEST_DIR="$(native_path "$PWD/backend/training_data/unverified")"
  echo "LAN session: reachable by every device on this network until Ctrl+C."
  echo "Crops from it go to backend/training_data/unverified/ (review, then promote)."
else
  echo "Local only (this machine). For the phone: ./dev.sh --lan"
fi

(
  cd backend
  venv_activate venv
  exec uvicorn app.main:app --reload --host "$BACKEND_HOST" \
    --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
) &

(
  cd frontend
  exec npm run dev
) &

wait
