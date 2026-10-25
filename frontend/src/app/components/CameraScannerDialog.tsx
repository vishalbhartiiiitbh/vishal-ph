"use client";

import type { RefObject } from "react";

type CameraScannerDialogProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraFacing: "environment" | "user";
  cameraError: string;
  isCameraStarting: boolean;
  onClose: () => void;
  onFlipCamera: () => void;
  onRetry: () => void;
};

export function CameraScannerDialog({
  videoRef,
  cameraFacing,
  cameraError,
  isCameraStarting,
  onClose,
  onFlipCamera,
  onRetry,
}: CameraScannerDialogProps) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="dialog-card scanner-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scanner-title"
      >
        <button className="dialog-close" type="button" onClick={onClose} aria-label="Close QR scanner">
          ×
        </button>
        <span className="section-kicker">JOIN A ROOM</span>
        <h2 id="scanner-title">Scan a room QR code</h2>
        <p>Allow camera access and point your camera at the invite QR code.</p>
        <div className="camera-preview">
          <video ref={videoRef} autoPlay muted playsInline aria-label="Camera preview for QR scanning" />
          {!cameraError && <span className="scanner-target" aria-hidden="true" />}
          {isCameraStarting && <span className="camera-message">Starting camera…</span>}
          {cameraError && (
            <div className="camera-error" role="alert">
              <span>{cameraError}</span>
              <button className="secondary-button" type="button" onClick={onRetry}>Retry camera</button>
            </div>
          )}
        </div>
        <div className="scanner-actions">
          <button className="secondary-button" type="button" onClick={onFlipCamera}>
            Switch to {cameraFacing === "environment" ? "front" : "rear"} camera
          </button>
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        </div>
        <p className="scanner-fallback">You can also enter the six-character room code manually.</p>
      </section>
    </div>
  );
}
