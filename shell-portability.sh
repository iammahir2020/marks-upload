# Sourced by dev.sh / local-stack.sh / preflight.sh / fetch-crops.sh.
# Not executable and not meant to be run.
#
# Everything here exists because this project is developed on both Linux
# and Windows (Git Bash), where two conventions differ in ways that make a
# script fail outright rather than degrade:
#
#   * `python3` does not exist on Windows. Worse than not existing: a
#     stock Windows 11 has an "app execution alias" at that exact name
#     which prints "Python was not found; run without arguments to install
#     from the Microsoft Store" and exits non-zero. A script that calls
#     `python3` there does not get a missing-command error it can handle —
#     it gets a successful-looking launch of something that is not Python.
#
#   * A virtualenv puts its programs in `bin/` on Linux and `Scripts/` on
#     Windows, and they carry a `.exe` suffix on Windows. `venv/bin/python`
#     is simply not a path that exists in a Windows venv.
#
# Factored into one file rather than repeated per script for the same
# reason frontend/scripts/landing-shell.mjs was: four copies of this drift,
# and the drift shows up as a script that works on one machine only.

# Python on Windows encodes stdout with the ANSI codepage (cp1252 here),
# not UTF-8, so every em dash and section sign in these scripts' output
# comes out as a replacement character. The summaries in fetch-crops.sh
# and preflight.sh quote plan.md section numbers, so this is not purely
# cosmetic — it makes the reference unreadable. Harmless on Linux, where
# UTF-8 is already the default.
export PYTHONIOENCODING=utf-8

# The Python to use for small inline scripts. Not the venv's — these are
# stdlib-only one-liners (json parsing, a socket call) that must work
# before any venv exists, which is exactly when preflight.sh runs.
portable_python() {
  if [ -n "${PORTABLE_PYTHON:-}" ]; then
    printf '%s' "$PORTABLE_PYTHON"
    return 0
  fi
  # `py` is the Windows Python launcher and is the reliable answer there.
  if command -v py >/dev/null 2>&1 && py -3 -c '' >/dev/null 2>&1; then
    PORTABLE_PYTHON="py -3"
  # Test python3 by RUNNING it, not by `command -v`: the Microsoft Store
  # alias answers `command -v` and then refuses to execute anything.
  elif command -v python3 >/dev/null 2>&1 && python3 -c '' >/dev/null 2>&1; then
    PORTABLE_PYTHON="python3"
  elif command -v python >/dev/null 2>&1 && python -c '' >/dev/null 2>&1; then
    PORTABLE_PYTHON="python"
  else
    return 1
  fi
  printf '%s' "$PORTABLE_PYTHON"
}

# The directory a virtualenv keeps its executables in: `Scripts` on
# Windows, `bin` everywhere else. Takes the venv root, prints the dir.
venv_bin_dir() {
  if [ -d "$1/Scripts" ]; then
    printf '%s' "$1/Scripts"
  else
    printf '%s' "$1/bin"
  fi
}

# A program inside a virtualenv, by name, with the platform's suffix.
# `venv_exe backend/venv python` -> backend/venv/bin/python
#                               -> backend\venv\Scripts\python.exe
venv_exe() {
  local dir
  dir="$(venv_bin_dir "$1")"
  if [ -f "$dir/$2.exe" ]; then
    printf '%s' "$dir/$2.exe"
  else
    printf '%s' "$dir/$2"
  fi
}

# `source` this to enter a venv, on either layout.
venv_activate() {
  # shellcheck disable=SC1090
  . "$(venv_bin_dir "$1")/activate"
}

# True on Windows (Git Bash, MSYS2, Cygwin). Used where a path has to be
# handed to a native Windows program such as docker.exe, which does not
# understand the `/g/Dev/...` form MSYS presents.
is_windows() {
  case "${OSTYPE:-$(uname -s)}" in
    msys*|cygwin*|win32*|MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

# Put Docker and the AWS CLI on PATH when Windows has installed them but
# this shell cannot see them.
#
# Both installers add their directory to the MACHINE PATH and broadcast a
# settings-change message. Already-running processes mostly ignore it, and
# every process they spawn inherits their stale copy — so a terminal
# launched from an editor that was open before the install will report
# `docker: command not found` indefinitely, while `docker` works fine from
# a new window. That is a confusing failure to hand someone: the tool is
# plainly installed, the error says it is not, and restarting the editor
# is not an obvious remedy.
#
# So: if the command is genuinely absent, look where Windows actually put
# it before believing it is missing. Same posture as gen_dev_cert.py's
# openssl lookup and id_ocr.py's Tesseract probe, for the same reason.
# Never overrides a copy already on PATH, and is a no-op off Windows.
ensure_native_tools_on_path() {
  is_windows || return 0
  local pf="${PROGRAMFILES:-C:\\Program Files}"
  local pf_unix
  if command -v cygpath >/dev/null 2>&1; then
    pf_unix="$(cygpath -u "$pf")"
  else
    pf_unix="/c/Program Files"
  fi
  local dir
  for dir in "$pf_unix/Docker/Docker/resources/bin" "$pf_unix/Amazon/AWSCLIV2"; do
    [ -d "$dir" ] || continue
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) PATH="$PATH:$dir" ;;
    esac
  done
  export PATH
}

# Stop MSYS rewriting arguments that merely LOOK like Unix paths.
#
# Git Bash converts any argument beginning with "/" into a Windows path
# before handing it to a native program. That is usually helpful and here
# it is destructive: every docker argument naming a path INSIDE the
# container — `-v name:/data`, `--tmpfs /tmp`, `sh -c "... /certs/key.pem"`
# — is a Linux path that must survive verbatim, and MSYS turns `/data`
# into something like `C:/Program Files/Git/data`. Host-side paths still
# need `native_path`; the two are complementary, not alternatives.
#
# Call this in scripts that drive docker. It is a no-op off Windows.
disable_msys_path_conversion() {
  if is_windows; then
    export MSYS_NO_PATHCONV=1
    export MSYS2_ARG_CONV_EXCL='*'
  fi
}

# A path in the form the host's native tools expect. On Linux this is the
# identity function; on Windows it turns /g/Dev/x into G:/Dev/x, which
# docker accepts and MSYS will not mangle further.
native_path() {
  if is_windows && command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}
