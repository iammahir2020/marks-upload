# Step 11.3 — the container that runs both on a laptop and on AWS Lambda.
#
# Base image: a plain slim Python rather than public.ecr.aws/lambda/python,
# which is what step.md's "How" first suggested. The reason is step 11.3.3's
# own decision to use the **Lambda Web Adapter** instead of Mangum: the
# adapter is what speaks the Lambda Runtime API, so the Lambda base image's
# runtime interface client is redundant, and keeping it would mean the
# container answers Lambda's `/2015-03-31/functions/function/invocations`
# envelope rather than a plain `POST /api/scan`. That would break the local
# verification 11.3.5 exists for — step.md's own check curls `/api/scan`
# directly. One image, one protocol, tested the same way it ships.
#
# Deliberately NOT here: `torch` (733 MB, training only — requirements-cnn.txt
# keeps it out) and any `apt install`. The no-apt property is earned by step
# 3r.6e's CNN default: the remote path needed the Tesseract binary, the
# default path needs nothing outside pip.
#
# Python 3.12, pinned by digest (issues.md N51). 3.10 reached end of life in
# October 2026, so its base image stops getting security fixes; 3.12 is
# supported until October 2028 and every pinned wheel in requirements.txt
# ships for it. The digest, not the tag, is what is pulled: a tag can be
# re-pointed at different bytes, a digest cannot. To move to a newer patch
# release, look the digest up and change it here deliberately:
#   docker buildx imagetools inspect public.ecr.aws/docker/library/python:3.12-slim
FROM public.ecr.aws/docker/library/python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

# The adapter runs as a Lambda extension: it starts, waits for the web
# server below to accept connections, then translates Lambda invocations
# into ordinary HTTP requests against it. On a laptop it simply isn't
# activated, so the same image runs under plain `docker run`.
# Pinned by digest for the same reason as the base image.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1@sha256:46d6625e68cbbdd2efab4a20245977664513f13ffef47915b000d431adcea0b4 /lambda-adapter /opt/extensions/lambda-adapter

WORKDIR /var/task

# Dependencies first, as their own layer — they change far less often than
# the application code, so an app edit rebuilds in seconds.
# requirements.txt, not requirements-dev.txt: no test runner or test client
# in the image that serves the public URL (issues.md N15).
COPY requirements.txt requirements-deploy.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-deploy.txt

# The app, and the trained model it needs. digit_cnn.onnx is ~1.8 MB and is
# committed to git (step 11.3.2) precisely so there is no download or
# training step at boot — that is what keeps cold init at the measured
# 0.9 s. cnn/ carries the inference code app/recognizers/local.py imports.
COPY app/ ./app/
COPY cnn/ ./cnn/

# 11.3.4 — no --ssl-* flags. TLS is terminated by CloudFront and by the
# Lambda Function URL; a self-signed cert inside the container would be
# both wrong and unreachable. $PORT so the adapter and a local run can
# disagree about the port without an image rebuild.
# Both names on purpose. The adapter's current variable is AWS_LWA_PORT;
# bare PORT still works but only as a legacy alias, and relying on a
# deprecated alias for the one setting that decides whether the container
# answers at all is a bad trade for one line. uvicorn reads $PORT.
# A mismatch here is invisible locally (the adapter is inert outside
# Lambda) and shows up in production as a hang or a 502.
ENV PORT=8000
ENV AWS_LWA_PORT=8000
EXPOSE 8000

# Harvesting defaults to the local filesystem, which on Lambda is READ-ONLY
# outside /tmp. A deployment must set HARVEST_BACKEND=s3 (step 11.2) or
# HARVEST_ENABLED=false. Left at the default here on purpose: the image
# should behave identically to the laptop app unless told otherwise, and
# `docker run --read-only` is exactly how that mistake gets caught before
# it reaches CloudWatch.

# Not root (issues.md N51). Lambda runs the image as its own unprivileged
# user whatever this says, so this is for every OTHER place the image runs:
# preflight.sh, local-stack.sh, a plain `docker run`. The app writes nothing
# outside /tmp (see above), so it needs no write access to /var/task.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin app
USER app

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
