"use client";

import { QRCodeSVG } from "qrcode.react";

type RoomQrDialogProps = {
  roomCode: string;
  shareUrl: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
};

export function RoomQrDialog({
  roomCode,
  shareUrl,
  copied,
  onCopy,
  onClose,
}: RoomQrDialogProps) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="dialog-card qr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-qr-title"
      >
        <button className="dialog-close" type="button" onClick={onClose} aria-label="Close QR code">
          ×
        </button>
        <span className="section-kicker">ROOM {roomCode}</span>
        <h2 id="room-qr-title">Scan to join</h2>
        <p>Open your phone camera and scan this code to join the room.</p>
        <div className="qr-code-frame">
          <QRCodeSVG
            value={shareUrl}
            size={240}
            level="H"
            marginSize={3}
            title={`Invite link for room ${roomCode}`}
          />
        </div>
        <button className="primary-button dialog-action" type="button" onClick={onCopy}>
          {copied ? "Invite link copied" : "Copy invite link"}
        </button>
        <p className="qr-url">{shareUrl}</p>
      </section>
    </div>
  );
}
