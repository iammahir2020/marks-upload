#!/usr/bin/env python3
"""Generate a self-signed HTTPS cert for the dev backend (step.md step 6).

Why the backend needs HTTPS too, not just the frontend: a page loaded over
HTTPS can't fetch a plain-HTTP endpoint except localhost/127.0.0.1 — modern
browsers block that as "mixed content." The phone loads the frontend via
this laptop's LAN IP (not localhost), so a plain-HTTP backend would have
every /api/scan request silently blocked the moment a real phone tried it.
Not caught by anything before step 6 because nothing talked to the network
across origins until now.

Mirrors frontend/vite.config.ts's approach: detect this machine's actual
LAN IP rather than hardcoding one, so this keeps working on a different
network.

    python gen_dev_cert.py
"""
import socket
import subprocess
import sys
from pathlib import Path

CERT_DIR = Path(__file__).parent / "certs"


def detect_lan_ip() -> str | None:
    """The IP this machine would use to reach the outside world — the
    standard no-dependency trick (connect a UDP socket, send nothing)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main() -> int:
    CERT_DIR.mkdir(exist_ok=True)
    key_path = CERT_DIR / "key.pem"
    cert_path = CERT_DIR / "cert.pem"

    lan_ip = detect_lan_ip()
    san_entries = ["DNS:localhost", "IP:127.0.0.1"]
    if lan_ip:
        san_entries.append(f"IP:{lan_ip}")
    san = ",".join(san_entries)

    print(f"Generating dev cert for: {san}")

    result = subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key_path), "-out", str(cert_path),
            "-days", "365",
            "-subj", "/CN=localhost",
            "-addext", f"subjectAltName={san}",
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return 1

    print(f"Wrote {cert_path} and {key_path}")
    print("Run uvicorn with: --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem")
    return 0


if __name__ == "__main__":
    sys.exit(main())
