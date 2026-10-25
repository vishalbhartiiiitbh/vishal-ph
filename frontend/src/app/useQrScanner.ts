"use client";

import jsQR from "jsqr";
import { useCallback, useEffect, useRef, useState } from "react";

type CameraFacing = "environment" | "user";

function parseRoomCode(raw: string): string | null {
  const value = raw.trim();

  try {
    const url = new URL(value);
    const roomCode = url.searchParams.get("room")?.trim().toUpperCase();
    return roomCode && /^[A-Z0-9]{6}$/.test(roomCode) ? roomCode : null;
  } catch {
    const roomParam = value.match(/[?&]room=([A-Z0-9]{6})(?:&|$)/i)?.[1];
    const code = (roomParam || value).replace(/[^A-Z0-9]/gi, "").toUpperCase();
    return /^[A-Z0-9]{6}$/.test(code) ? code : null;
  }
}

export function useQrScanner(onScanSuccess: (roomCode: string) => void) {
  const [isOpen, setIsOpen] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("environment");
  const [cameraError, setCameraError] = useState("");
  const [isCameraStarting, setIsCameraStarting] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    let animationFrame = 0;
    let stream: MediaStream | null = null;
    const video = videoRef.current;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const stopStream = () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };

    const scanFrame = () => {
      if (cancelled || !video || !stream) return;

      if (
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 &&
        context
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = jsQR(image.data, image.width, image.height, {
          inversionAttempts: "dontInvert",
        });
        const roomCode = result ? parseRoomCode(result.data) : null;

        if (roomCode) {
          cancelled = true;
          stopStream();
          setIsOpen(false);
          onScanSuccess(roomCode);
          return;
        }
      }

      animationFrame = requestAnimationFrame(scanFrame);
    };

    const startCamera = async () => {
      setCameraError("");
      setIsCameraStarting(true);

      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError(
          "Camera scanning needs a supported browser and a secure HTTPS connection (or localhost).",
        );
        setIsCameraStarting(false);
        return;
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: cameraFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          stopStream();
          return;
        }
        if (!video) {
          setCameraError("The camera preview could not be opened. Try again.");
          setIsCameraStarting(false);
          stopStream();
          return;
        }

        video.srcObject = stream;
        await video.play();
        if (cancelled) {
          stopStream();
          return;
        }
        setIsCameraStarting(false);
        animationFrame = requestAnimationFrame(scanFrame);
      } catch (error) {
        if (cancelled) return;
        setIsCameraStarting(false);
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          setCameraError(
            "Camera access was denied. Allow camera permission in your browser settings, then retry.",
          );
        } else if (
          error instanceof DOMException &&
          (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")
        ) {
          setCameraError("No camera was found on this device.");
        } else {
          console.error("Could not start the QR scanner camera:", error);
          setCameraError(
            "Could not start the camera. Check camera permissions and try again.",
          );
        }
      }
    };

    void startCamera();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [cameraFacing, isOpen, onScanSuccess, retryCount]);

  const openScanner = useCallback(() => {
    setCameraError("");
    setIsCameraStarting(true);
    setIsOpen(true);
  }, []);

  const closeScanner = useCallback(() => {
    setIsOpen(false);
    setIsCameraStarting(false);
    setCameraError("");
  }, []);

  const flipCamera = useCallback(() => {
    setCameraError("");
    setIsCameraStarting(true);
    setCameraFacing((facing) => (facing === "environment" ? "user" : "environment"));
  }, []);

  const retryCamera = useCallback(() => {
    setCameraError("");
    setIsCameraStarting(true);
    setRetryCount((count) => count + 1);
  }, []);

  return {
    isOpen,
    cameraFacing,
    cameraError,
    isCameraStarting,
    videoRef,
    openScanner,
    closeScanner,
    flipCamera,
    retryCamera,
  };
}
