#!/usr/bin/env bash
# Run the backend and frontend dev servers together. Ctrl+C stops both.
#
# Assumes backend/venv and frontend/node_modules already exist (see
# CLAUDE.md for first-time setup) and backend/.env has GEMINI_API_KEY.
set -e
# Deliberately NOT `set -m`: job control puts each backgrounded job in its
# own process group, which would mean `kill 0` below (send to *this*
# process group) never reaches uvicorn/npm at all. Without job control,
# background children inherit this script's process group like any normal
# fork — which is what makes `kill 0` actually reach all of them, uvicorn's
# --reload worker and npm's real vite child included. Verified directly:
# with `set -m` here, Ctrl+C left every server running; without it, all of
# them die (see learn.md).

cd "$(dirname "$0")"

if [ ! -f backend/certs/cert.pem ]; then
  echo "No backend dev cert found — generating one (gen_dev_cert.py)..."
  (cd backend && source venv/bin/activate && python gen_dev_cert.py)
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

(
  cd backend
  source venv/bin/activate
  exec uvicorn app.main:app --reload --host 0.0.0.0 \
    --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
) &

(
  cd frontend
  exec npm run dev
) &

wait
