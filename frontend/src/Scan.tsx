// Camera capture + upload queue (step.md step 6), wired into the full
// confirm -> save -> next capture loop (step.md step 8).
import { useEffect, useReducer, useRef, useState } from 'react';
import { scanImage } from './api';
import { getAllRecords } from './db';
import Review from './Review';
import { inFlightCount, nextToReview, queueReducer } from './scanQueue';
import type { QuizConfig } from './types';

// Request a resolution generous enough that the detector's thin table
// rules survive compression (plan.md §6/step 1) — an over-compressed
// capture is exactly what destroys them.
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};
const CAPTURE_JPEG_QUALITY = 0.92;

interface ScanProps {
  config: QuizConfig;
  onShowResults: () => void;
}

interface Preview {
  url: string;
  width: number;
  height: number;
}

export default function Scan({ config, onShowResults }: ScanProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [entries, dispatch] = useReducer(queueReducer, []);
  // Records saved so far this session — not a plain in-memory counter,
  // because a mid-session refresh (step 8.3) would reset that to 0 while
  // IndexedDB still held every prior record. Seeded from the DB on mount
  // and incremented on each save, so it always reflects what's actually
  // persisted.
  const [savedCount, setSavedCount] = useState(0);
  useEffect(() => {
    getAllRecords().then((records) => setSavedCount(records.length));
  }, []);
  // Debug aid: the backend is stateless and discards every upload
  // immediately (plan.md §9), so without this there's no way to see what a
  // capture actually looked like when a scan unexpectedly fails — see
  // learn.md step 6.
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // Step 8.1 — Review auto-opens for the next finished capture with no tap
  // required, and closing it (save or Retake) hands off to whichever
  // capture is next in line; camera stays live underneath the whole time
  // (see the overlay note below), so there's nothing to "reopen".
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (reviewingId != null) return;
    const handled = new Set([...savedIds, ...dismissedIds]);
    const next = nextToReview(entries, handled);
    if (next != null) setReviewingId(next);
  }, [entries, reviewingId, savedIds, dismissedIds]);

  // The unmount cleanup below reads previews through a ref, not through the
  // closure (issues.md #11). With an empty dependency array the effect
  // captured `previews` as it was at MOUNT — `{}` — so it revoked nothing,
  // ever, and no other revokeObjectURL existed in the file: every captured
  // full-resolution JPEG was retained for the life of the session,
  // discarded retakes included. A ref updated on every render is the fix
  // that keeps the cleanup running exactly once while still seeing the
  // current map.
  const previewsRef = useRef<Record<string, Preview>>({});
  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    return () => {
      Object.values(previewsRef.current).forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, []);

  // Releases one preview immediately, for a capture that is definitively
  // finished with. Deliberately NOT called on save: Review fires its harvest
  // request by re-fetching this same blob URL *after* onSaved returns, so
  // revoking here would silently break training-data collection. Retakes and
  // dismissed failures have no such consumer.
  function releasePreview(id: string) {
    setPreviews((p) => {
      const preview = p[id];
      if (!preview) return p;
      URL.revokeObjectURL(preview.url);
      const { [id]: _dropped, ...rest } = p;
      return rest;
    });
  }

  // One place to retire a capture from the queue, so the two callers that
  // need it (Retake, and dismissing a failed upload) cannot drift apart.
  function dismissEntry(id: string) {
    setDismissedIds((s) => new Set(s).add(id));
    releasePreview(id);
  }

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia(CAMERA_CONSTRAINTS)
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      })
      .catch((err: Error) => {
        // getUserMedia fails at the camera, not at page load, when the
        // secure-context/HTTPS setup is wrong — this is almost always
        // that, not a real permissions problem (step.md step 6).
        setCameraError(err.message || 'Could not access the camera.');
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function capture() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    // Some phones report a portrait-shaped video track (videoWidth <
    // videoHeight) even though the underlying frame content doesn't
    // actually match — this device does exactly that, and the mismatch
    // was landing the photographed grid sideways or, worse, upside down,
    // depending on which way the backend's own rotation-retry guessed
    // first (see learn.md step 6, "bug three"). The marks grid template is
    // always physically wider than tall, so normalize here: a portrait
    // capture reliably means the content needs a 90° turn to read
    // correctly. Doing this once at the source, instead of leaving the
    // backend to search four orientations after the fact, is what's
    // actually supposed to fix "this keeps needing a rotation guess" for
    // good — not another backend-side threshold tweak.
    const isPortrait = video.videoHeight > video.videoWidth;
    const canvas = document.createElement('canvas');
    canvas.width = isPortrait ? video.videoHeight : video.videoWidth;
    canvas.height = isPortrait ? video.videoWidth : video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (isPortrait) {
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(-Math.PI / 2); // counterclockwise — matches this device's actual capture orientation
      ctx.drawImage(video, -video.videoWidth / 2, -video.videoHeight / 2);
    } else {
      ctx.drawImage(video, 0, 0);
    }

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const id = crypto.randomUUID();
        dispatch({ type: 'enqueue', id });
        setPreviews((p) => ({
          ...p,
          [id]: { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height },
        }));

        // Deliberately not awaited — the camera must stay usable while
        // this is in flight (step 6.3). Each capture races independently;
        // whichever request finishes first updates its own entry.
        scanImage(blob, config)
          .then((result) => dispatch({ type: 'resolve', id, result }))
          .catch((err: Error) =>
            dispatch({ type: 'reject', id, error: err.message || 'Upload failed.' }),
          );
      },
      'image/jpeg',
      CAPTURE_JPEG_QUALITY,
    );
  }

  const reviewingEntry = entries.find((e) => e.id === reviewingId);
  // A Retake dismisses the entry (see onRetake below) so it never blocks
  // nextToReview again, but it also shouldn't linger as a dead, unsaved
  // row the instructor has to look at (and could tap into a Review of a
  // scan they already discarded) — filter it out of the visible list
  // entirely rather than just marking it handled.
  const visibleEntries = entries.filter((e) => !dismissedIds.has(e.id));
  // The camera view is what the instructor is actually looking at right
  // after tapping Capture — a thumbnail appearing in the queue list below
  // isn't enough feedback on its own. Disabling the button and ringing it
  // with a spinner while the shot is in flight makes "yes, that
  // registered, hang on" visible without looking away.
  const capturing = inFlightCount(entries) > 0;

  return (
    <div className="page">
      {/* Review renders as an overlay, not a tree swap — swapping out this
          whole return would unmount <video>. The camera-setup effect below
          only ever binds the stream to the element that exists at mount
          time, so a video element recreated after Review closes would come
          back with no srcObject: a frozen preview, and Capture silently
          no-oping since video.videoWidth stays 0 (see learn.md step 7). */}
      {reviewingEntry?.result && (
        <div className="overlay">
          <div className="page">
            <Review
              result={reviewingEntry.result}
              config={config}
              imagePreviewUrl={previews[reviewingEntry.id]?.url}
              onRetake={() => {
                dismissEntry(reviewingEntry.id);
                setReviewingId(null);
              }}
              onSaved={() => {
                setSavedIds((s) => new Set(s).add(reviewingEntry.id));
                setSavedCount((n) => n + 1);
                setReviewingId(null);
              }}
            />
          </div>
        </div>
      )}

      <div className="app-header">
        <div>
          <span className="eyebrow">{config.quizName}</span>
          <h1>Scanned {savedCount}</h1>
        </div>
        <button className="btn btn-quiet" onClick={onShowResults}>
          View results &rarr;
        </button>
      </div>

      {cameraError && (
        <div className="banner banner-danger" role="alert">
          <strong>Camera error</strong>
          <span>{cameraError}</span>
        </div>
      )}

      <div className="camera-frame">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} autoPlay playsInline muted />
        {/* Framing guide (plan.md §3): frame tight on the three tables,
            marks table the largest rectangle in the shot. */}
        <div className="camera-guide" />
      </div>

      <div className="capture-bar">
        <div className="capture-btn-wrap">
          {capturing && <div className="capture-spinner" aria-hidden="true" />}
          <button
            className="capture-btn"
            onClick={capture}
            disabled={!!cameraError || capturing}
            aria-label={capturing ? 'Processing previous capture' : 'Capture'}
          />
        </div>
      </div>

      {(visibleEntries.length > 0 || inFlightCount(entries) > 0) && (
        <div className="stack-sm">
          {inFlightCount(entries) > 0 && (
            <p className="text-sm muted">{inFlightCount(entries)} upload(s) in progress…</p>
          )}

          <ul className="queue-list">
            {visibleEntries.map((entry) => {
              const preview = previews[entry.id];
              return (
                <li key={entry.id} className="queue-item">
                  {preview && <img className="queue-thumb" src={preview.url} alt="captured script" />}
                  <div className="queue-info">
                    {entry.status === 'pending' && <span className="muted">Scanning…</span>}
                    {entry.status === 'error' && (
                      <span style={{ color: 'var(--danger)' }}>Failed: {entry.error}</span>
                    )}
                    {entry.status === 'done' && entry.result && (
                      <div className="stack-sm" style={{ gap: 2 }}>
                        <span className="primary">
                          {entry.result.status === 'failed'
                            ? `Scan failed: ${entry.result.failure_reason}`
                            : `ID ${entry.result.student_id ?? '?'} · Serial ${entry.result.serial ?? '?'} · Total ${entry.result.total?.value ?? '?'}`}
                        </span>
                        {entry.result.low_confidence_fields.length > 0 && (
                          <span className="badge badge-warning" style={{ width: 'fit-content' }}>
                            {entry.result.low_confidence_fields.length} to check
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* A capture that failed at the transport layer — dead
                      backend, dropped wifi, or the 60s timeout in api.ts —
                      used to render as static red text with no action of
                      any kind (issues.md #6). Only backend-reported
                      `status: "failed"` results reached Review's
                      Retake/enter-manually path; a client-side failure just
                      sat there. Dismiss clears the row and releases its
                      blob, so the instructor can simply shoot it again. */}
                  {entry.status === 'error' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => dismissEntry(entry.id)}
                    >
                      Dismiss
                    </button>
                  )}
                  {entry.status === 'done' &&
                    entry.result &&
                    (savedIds.has(entry.id) ? (
                      <span className="badge badge-success">Saved</span>
                    ) : (
                      <button className="btn btn-secondary btn-sm" onClick={() => setReviewingId(entry.id)}>
                        Review
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
