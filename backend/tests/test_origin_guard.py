"""issues.md N42 — only requests that came through CloudFront reach the API
once deployed, and the interactive API docs are gone.

CloudFront adds an `X-Origin-Verify` header carrying a secret (deploy.sh
sets it on the distribution and in the Lambda's ORIGIN_SECRET); anything
calling API Gateway's execute-api URL directly doesn't have it.
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))
from app import config as config_module  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
SECRET = "s3cret-value-from-deploy"
CONFIG = {"quizName": "q", "idDigits": 7, "totalMax": 5.0, "questions": [{"q": 1, "max": 5.0}]}
BLANK = cv2.imencode(".jpg", np.full((60, 80, 3), 255, np.uint8))[1].tobytes()


def scan(headers=None):
    return client.post("/api/scan", files={"image": ("c.jpg", BLANK, "image/jpeg")},
                       data={"config": json.dumps(CONFIG)}, headers=headers or {})


@pytest.fixture
def deployed(monkeypatch):
    monkeypatch.setattr(config_module, "ORIGIN_SECRET", SECRET)


def test_a_request_through_cloudfront_is_served(deployed):
    assert scan({"x-origin-verify": SECRET}).status_code == 200


@pytest.mark.parametrize("headers", [{}, {"x-origin-verify": "wrong"}, {"x-origin-verify": SECRET + "x"}],
                         ids=["no header", "wrong secret", "secret plus extra"])
def test_a_direct_call_is_refused_before_any_work(deployed, headers):
    with patch("app.main.detect_any_orientation") as detect, \
         patch("app.main.limiter") as limiter:
        resp = scan(headers)
    assert resp.status_code == 403
    detect.assert_not_called()
    limiter.check.assert_not_called()  # refused before it could spend anyone's budget


def test_harvest_is_guarded_too(deployed):
    resp = client.post("/api/harvest", files={"image": ("c.jpg", BLANK, "image/jpeg")},
                       data={"config": json.dumps(CONFIG), "original": "{}", "confirmed": "{}"})
    assert resp.status_code == 403


def test_the_laptop_checks_nothing(monkeypatch):
    monkeypatch.setattr(config_module, "ORIGIN_SECRET", None)
    assert scan().status_code == 200


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_the_interactive_api_docs_are_not_served(path):
    assert client.get(path).status_code == 404
