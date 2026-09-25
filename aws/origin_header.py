"""deploy.sh helper for issues.md N42: read or set the X-Origin-Verify
header on the CloudFront distribution's "api" origin.

Reads `aws cloudfront get-distribution-config --output json` on stdin.

    origin_header.py read          print the current secret, if any
    origin_header.py write OUT     SECRET from the environment; write the
                                   updated DistributionConfig to OUT and exit
                                   0, or exit 1 if it is already in place

A separate file rather than inline `python -c` so the quoting survives
bash, Git Bash and Windows alike.
"""
import json
import os
import sys

HEADER = "X-Origin-Verify"


def api_origin(config: dict) -> dict:
    return next(o for o in config["Origins"]["Items"] if o["Id"] == "api")


def main() -> int:
    config = json.load(sys.stdin)["DistributionConfig"]
    origin = api_origin(config)
    items = (origin.get("CustomHeaders") or {}).get("Items") or []

    if sys.argv[1] == "read":
        for header in items:
            if header["HeaderName"].lower() == HEADER.lower():
                print(header["HeaderValue"])
        return 0

    wanted = {"Quantity": 1, "Items": [{"HeaderName": HEADER, "HeaderValue": os.environ["SECRET"]}]}
    if origin.get("CustomHeaders") == wanted:
        return 1
    origin["CustomHeaders"] = wanted
    with open(sys.argv[2], "w", encoding="utf-8") as out:
        json.dump(config, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
