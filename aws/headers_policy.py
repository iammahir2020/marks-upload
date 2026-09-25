"""deploy.sh helper for issues.md N43: the CloudFront response headers policy
(the security headers every response carries) and attaching it.

    headers_policy.py config          print the policy's config JSON
    headers_policy.py attach ID OUT   stdin: `get-distribution-config --output
                                      json`; write the DistributionConfig with
                                      policy ID on every cache behaviour to
                                      OUT and exit 0, or exit 1 if it already is

The page's own Content-Security-Policy — which scripts and styles may run —
is NOT here: it is a <meta> in index.html, written at build time with the
exact hashes of that build's inline blocks (frontend/scripts/csp.mjs). This
header CSP carries only what a <meta> can't: frame-ancestors. Browsers
enforce both policies together.
"""
import json
import sys

NAME = "marks-scanner-security-headers"


def config() -> dict:
    return {
        "Name": NAME,
        "Comment": "issues.md N43 - security headers for the site and /api/*",
        "SecurityHeadersConfig": {
            # HTTPS only, for a year. No includeSubdomains/preload: the
            # site lives on a shared *.cloudfront.net name.
            "StrictTransportSecurity": {
                "Override": True, "IncludeSubdomains": False, "Preload": False,
                "AccessControlMaxAgeSec": 31536000,
            },
            # No MIME sniffing: a file is only ever what it says it is.
            "ContentTypeOptions": {"Override": True},
            # No other site may frame the app (clickjacking). Both the
            # legacy header and the CSP directive, for older browsers.
            "FrameOptions": {"Override": True, "FrameOption": "DENY"},
            "ContentSecurityPolicy": {
                "Override": True,
                "ContentSecurityPolicy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
            },
            # Other sites learn the origin, never the page path.
            "ReferrerPolicy": {"Override": True, "ReferrerPolicy": "strict-origin-when-cross-origin"},
        },
        "CustomHeadersConfig": {"Quantity": 1, "Items": [{
            # The camera is for this site only; nothing else is ever used.
            "Header": "Permissions-Policy",
            "Value": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
            "Override": True,
        }]},
    }


def attach(policy_id: str, out: str) -> int:
    dist = json.load(sys.stdin)["DistributionConfig"]
    behaviours = [dist["DefaultCacheBehavior"], *((dist.get("CacheBehaviors") or {}).get("Items") or [])]
    if all(b.get("ResponseHeadersPolicyId") == policy_id for b in behaviours):
        return 1
    for b in behaviours:
        b["ResponseHeadersPolicyId"] = policy_id
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(dist, fh)
    return 0


if __name__ == "__main__":
    if sys.argv[1] == "config":
        print(json.dumps(config()))
        sys.exit(0)
    sys.exit(attach(sys.argv[2], sys.argv[3]))
