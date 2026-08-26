// Camera capture + upload queue (step.md step 6). No review UI yet — this
// just proves photograph -> upload -> ScanResult round-trips without the
// camera ever blocking on a network call (step 6.4).
import { useEffect, useReducer, useRef, useState } from 'react';
import { scanImage } from './api';
import Review from './Review';
import { inFlightCount, queueReducer } from './scanQueue';
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
}

interface Preview {
  url: string;
  width: number;
  height: number;
}

export default function Scan({ config }: ScanProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [entries, dispatch] = useReducer(queueReducer, []);
  const [scannedCount, setScannedCount] = useState(0);
  // Debug aid: the backend is stateless and discards every upload
  // immediately (plan.md §9), so without this there's no way to see what a
  // capture actually looked like when a scan unexpectedly fails — see
  // learn.md step 6.
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  // Step 7's Review screen, wired in minimally so it can be exercised at
  // all — the full "confirm advances straight back to a live camera" loop
  // is step 8's job, not this one.
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      Object.values(previews).forEach((p) => URL.revokeObjectURL(p.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        setScannedCount((n) => n + 1);
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

  return (
    <div>
      {/* Review renders as an overlay, not a tree swap — swapping out this
          whole return would unmount <video>. The camera-setup effect below
          only ever binds the stream to the element that exists at mount
          time, so a video element recreated after Review closes would come
          back with no srcObject: a frozen preview, and Capture silently
          no-oping since video.videoWidth stays 0 (see learn.md step 7). */}
      {reviewingEntry?.result && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--bg)',
            overflowY: 'auto',
            padding: '1rem',
            zIndex: 10,
          }}
        >
          <Review
            result={reviewingEntry.result}
            config={config}
            imagePreviewUrl={previews[reviewingEntry.id]?.url}
            onRetake={() => setReviewingId(null)}
            onSaved={() => {
              setSavedIds((s) => new Set(s).add(reviewingEntry.id));
              setReviewingId(null);
            }}
          />
        </div>
      )}

      <p>Scanned {scannedCount}</p>

      {cameraError && <p role="alert">Camera error: {cameraError}</p>}

      <div style={{ position: 'relative', width: 'fit-content' }}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video ref={videoRef} autoPlay playsInline muted style={{ maxWidth: '100%' }} />
        {/* Framing guide (plan.md §3): frame tight on the three tables,
            marks table the largest rectangle in the shot. */}
        <div
          style={{
            position: 'absolute',
            inset: '15%',
            border: '2px dashed #fff',
            pointerEvents: 'none',
          }}
        />
      </div>

      <button onClick={capture} disabled={!!cameraError}>
        Capture
      </button>

      <p>{inFlightCount(entries)} upload(s) in progress…</p>

      <ul>
        {entries.map((entry) => {
          const preview = previews[entry.id];
          return (
            <li key={entry.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              {preview && (
                <img
                  src={preview.url}
                  alt="captured"
                  style={{ width: 80, height: 'auto', border: '1px solid #888' }}
                />
              )}
              <span>
                {preview && `${preview.width}×${preview.height} — `}
                {entry.status === 'pending' && 'Scanning…'}
                {entry.status === 'error' && `Failed: ${entry.error}`}
                {entry.status === 'done' && entry.result && (
                  <>
                    {entry.result.status === 'failed'
                      ? `Scan failed: ${entry.result.failure_reason}`
                      : `ID ${entry.result.student_id ?? '?'} · Serial ${entry.result.serial ?? '?'} · Total ${entry.result.total?.value ?? '?'}`}
                    {entry.result.low_confidence_fields.length > 0 &&
                      ` (low confidence: ${entry.result.low_confidence_fields.join(', ')})`}
                  </>
                )}
              </span>
              {entry.status === 'done' &&
                entry.result &&
                (savedIds.has(entry.id) ? (
                  <span>Saved ✓</span>
                ) : (
                  <button onClick={() => setReviewingId(entry.id)}>Review</button>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
