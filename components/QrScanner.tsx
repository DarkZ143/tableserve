"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { tablePathFromQr } from "../lib/qr";

function cameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Camera access was blocked. Allow camera access in your browser settings and try again.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "No camera was found on this device.";
    if (error.name === "NotReadableError") return "The camera is already in use by another app. Close it and try again.";
  }
  return "The camera could not start. Open this page over HTTPS (or localhost during development), allow camera access, and try again.";
}

export default function QrScanner({ onClose, onScan }: { onClose: () => void; onScan: (path: string) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    let decoded = false;
    let controls: { stop: () => void } | null = null;

    async function startCamera() {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        if (stopped) return;
        const video = videoRef.current;
        if (!video) return;
        const reader = new BrowserQRCodeReader();
        controls = await reader.decodeFromConstraints(
          { audio: false, video: { facingMode: { ideal: "environment" } } },
          video,
          (result, _decodeError, scanControls) => {
            if (!result || stopped || decoded) return;
            const path = tablePathFromQr(result.getText(), window.location.origin);
            if (!path) {
              setError("That QR code is not a TableServe table code. Point the camera at the QR on your table.");
              return;
            }
            decoded = true;
            scanControls.stop();
            onScan(path);
          },
        );
        if (stopped) controls.stop();
        else setStarting(false);
      } catch (cameraFailure) {
        if (!stopped) {
          setStarting(false);
          setError(cameraError(cameraFailure));
        }
      }
    }

    void startCamera();
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onScan, attempt]);

  return (
    <div className="scanner-overlay">
      <section className="scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <div className="scanner-heading">
          <div><div className="eyebrow">TableServe ordering</div><h2 id="scanner-title">Scan your table QR</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close QR scanner"><X size={18} /></button>
        </div>
        <div className="scanner-video-wrap">
          <video ref={videoRef} className="scanner-video" autoPlay muted playsInline aria-label="Camera preview for scanning the table QR code" />
          <span className="scanner-frame" aria-hidden="true" />
        </div>
        <div className={`scanner-message${error ? " error" : ""}`} role={error ? "alert" : "status"}>
          {error ? <>{error}<button className="btn btn-quiet btn-small" type="button" onClick={() => { setError(""); setStarting(true); setAttempt((current) => current + 1); }}>Try again</button></> : <><Camera size={15} />{starting ? "Starting your camera…" : "Hold the QR code inside the frame."}</>}
        </div>
        <p className="scanner-hint">Camera scanning needs permission and a secure connection: HTTPS in production, or localhost during development.</p>
      </section>
    </div>
  );
}
