"use client";

import Link from "next/link";
import JSZip from "jszip";
import { useCallback, useEffect, useRef, useState } from "react";
import { CameraScannerDialog } from "./components/CameraScannerDialog";
import { RoomQrDialog } from "./components/RoomQrDialog";
import { useQrScanner } from "./useQrScanner";

const SIGNALING_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL || "ws://localhost:8080";
const CHUNK_SIZE = 16 * 1024;
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
const TURN_URLS = (process.env.NEXT_PUBLIC_TURN_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  ...(TURN_URLS.length > 0 &&
  process.env.NEXT_PUBLIC_TURN_USERNAME &&
  process.env.NEXT_PUBLIC_TURN_CREDENTIAL
    ? [{
        urls: TURN_URLS,
        username: process.env.NEXT_PUBLIC_TURN_USERNAME,
        credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
      }]
    : []),
];

type SignalPacket = {
  type: string;
  payload?: {
    roomCode?: string;
    message?: string;
    sdp?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
    name?: string;
    size?: number;
  };
};

type TransferState = {
  direction: "send" | "receive" | null;
  name: string;
  transferred: number;
  total: number;
  result: "idle" | "active" | "complete" | "error";
};

const emptyTransfer: TransferState = {
  direction: null,
  name: "",
  transferred: 0,
  total: 0,
  result: "idle",
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unitIndex).toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]/g, "_") || "shared-file";
}

export default function Home() {
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [peerState, setPeerState] = useState("disconnected");
  const [status, setStatus] = useState("Connecting to the signaling server...");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [folderFileCount, setFolderFileCount] = useState(0);
  const [preparingFolder, setPreparingFolder] = useState(false);
  const [transfer, setTransfer] = useState<TransferState>(emptyTransfer);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [showRoomQr, setShowRoomQr] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const incomingFileRef = useRef<{
    chunks: ArrayBuffer[];
    name: string;
    size: number;
    received: number;
  } | null>(null);
  const cancelSendRef = useRef(false);
  const autoJoinRef = useRef("");

  const sendSignal = useCallback(
    (type: string, payload?: SignalPacket["payload"]) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setStatus("The signaling server is not connected yet.");
        return false;
      }

      socket.send(JSON.stringify({ type, payload }));
      return true;
    },
    [],
  );

  const onQrScan = useCallback(
    (code: string) => {
      setJoinCode(code);
      if (sendSignal("join-room", { roomCode: code })) {
        setStatus(`Joining room ${code}...`);
      }
    },
    [sendSignal],
  );
  const qrScanner = useQrScanner(onQrScan);

  const closePeer = useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    if (peerRef.current) {
      peerRef.current.onicecandidate = null;
      peerRef.current.onconnectionstatechange = null;
      peerRef.current.ondatachannel = null;
      peerRef.current.close();
    }
    peerRef.current = null;
    pendingCandidatesRef.current = [];
    incomingFileRef.current = null;
    cancelSendRef.current = true;
    setPeerState("disconnected");
    setTransfer(emptyTransfer);
  }, []);

  const configureChannel = useCallback((channel: RTCDataChannel) => {
    channel.binaryType = "arraybuffer";
    channelRef.current = channel;
    setPeerState(channel.readyState === "open" ? "connected" : "connecting");
    setStatus(
      channel.readyState === "open"
        ? "Peer connected. You can send files directly."
        : "Peer found. Establishing a direct connection...",
    );

    channel.onopen = () => {
      setPeerState("connected");
      setStatus("Peer connected. You can send files directly.");
    };

    channel.onclose = () => {
      if (channelRef.current === channel) {
        channelRef.current = null;
        incomingFileRef.current = null;
        setTransfer(emptyTransfer);
        setPeerState("disconnected");
        setStatus("Peer connection closed.");
      }
    };

    channel.onerror = () => {
      setStatus("The peer-to-peer data channel encountered an error.");
    };

    channel.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") {
        let packet: { type?: string; payload?: { name?: string; size?: number } };
        try {
          packet = JSON.parse(event.data);
        } catch {
          setStatus("Received an invalid file-transfer message.");
          return;
        }

        if (packet.type === "meta") {
          const name = packet.payload?.name;
          const size = packet.payload?.size;
          if (typeof name !== "string" || typeof size !== "number" || size < 0) {
            setStatus("Received invalid file metadata.");
            return;
          }

          incomingFileRef.current = { chunks: [], name, size, received: 0 };
          setTransfer({
            direction: "receive",
            name,
            transferred: 0,
            total: size,
            result: "active",
          });
          setStatus(`Receiving ${name} from your peer...`);
          return;
        }

        if (packet.type === "eof") {
          const incoming = incomingFileRef.current;
          if (!incoming) {
            setStatus("Received a file-complete message without file data.");
            return;
          }
          if (incoming.received !== incoming.size) {
            incomingFileRef.current = null;
            setTransfer({ ...emptyTransfer, result: "error" });
            setStatus("The received file was incomplete. Ask the sender to retry.");
            return;
          }

          const url = URL.createObjectURL(
            new Blob(incoming.chunks, { type: "application/octet-stream" }),
          );
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = safeFileName(incoming.name);
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          setTransfer({
            direction: "receive",
            name: incoming.name,
            transferred: incoming.size,
            total: incoming.size,
            result: "complete",
          });
          setStatus(`Download ready: ${incoming.name}`);
          incomingFileRef.current = null;
          return;
        }

        if (packet.type === "cancel-transfer") {
          incomingFileRef.current = null;
          setTransfer(emptyTransfer);
          setStatus("The other peer cancelled the transfer.");
        }
        return;
      }

      const incoming = incomingFileRef.current;
      if (!incoming) {
        setStatus("Received file data before its metadata.");
        return;
      }

      incoming.received += event.data.byteLength;
      if (incoming.received > incoming.size) {
        incomingFileRef.current = null;
        setTransfer({ ...emptyTransfer, result: "error" });
        setStatus("The received data exceeded the declared file size.");
        return;
      }

      incoming.chunks.push(event.data);
      setTransfer({
        direction: "receive",
        name: incoming.name,
        transferred: incoming.received,
        total: incoming.size,
        result: "active",
      });
    };
  }, []);

  const createPeer = useCallback(() => {
    closePeer();
    const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerRef.current = peer;

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal("ice-candidate", { candidate: event.candidate.toJSON() });
      }
    };
    peer.onconnectionstatechange = () => {
      setPeerState(peer.connectionState);
      if (peer.connectionState === "failed") {
        setStatus("Could not connect to the peer. Try again on a different network.");
      }
    };
    peer.ondatachannel = (event) => configureChannel(event.channel);
    return peer;
  }, [closePeer, configureChannel, sendSignal]);

  const handleSignal = useCallback(
    async (packet: SignalPacket) => {
      switch (packet.type) {
        case "room-created": {
          const code = packet.payload?.roomCode;
          if (code) {
            setRoomCode(code);
            setJoinCode(code);
            setStatus(`Room ${code} is ready. Share the link or code with your peer.`);
          }
          break;
        }
        case "room-joined": {
          const code = packet.payload?.roomCode;
          if (code) {
            setRoomCode(code);
            setJoinCode(code);
            setStatus(`Joined room ${code}. Waiting for the peer connection...`);
          }
          break;
        }
        case "peer-joined": {
          setStatus("Peer joined. Setting up a direct connection...");
          const peer = createPeer();
          const channel = peer.createDataChannel("file-transfer", { ordered: true });
          configureChannel(channel);
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          sendSignal("offer", { sdp: peer.localDescription ?? offer });
          break;
        }
        case "offer": {
          if (!packet.payload?.sdp) {
            setStatus("Received an incomplete connection offer.");
            break;
          }
          const peer = createPeer();
          await peer.setRemoteDescription(packet.payload.sdp);
          for (const candidate of pendingCandidatesRef.current.splice(0)) {
            await peer.addIceCandidate(candidate);
          }
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          sendSignal("answer", { sdp: peer.localDescription ?? answer });
          setStatus("Connecting directly to your peer...");
          break;
        }
        case "answer": {
          if (!packet.payload?.sdp || !peerRef.current) {
            setStatus("Received an answer without an active connection.");
            break;
          }
          await peerRef.current.setRemoteDescription(packet.payload.sdp);
          for (const candidate of pendingCandidatesRef.current.splice(0)) {
            await peerRef.current.addIceCandidate(candidate);
          }
          break;
        }
        case "ice-candidate": {
          const candidate = packet.payload?.candidate;
          if (!candidate) break;
          if (peerRef.current?.remoteDescription) {
            await peerRef.current.addIceCandidate(candidate);
          } else {
            pendingCandidatesRef.current.push(candidate);
          }
          break;
        }
        case "peer-left":
          closePeer();
          setStatus("Your peer left the room. You can share the room code again.");
          break;
        case "error":
          setStatus(packet.payload?.message || "The signaling server returned an error.");
          break;
      }
    },
    [closePeer, configureChannel, createPeer, sendSignal],
  );

  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get("room");
    if (room) {
      const code = room.trim().toUpperCase();
      autoJoinRef.current = code;
    }

    let disposed = false;
    let retryTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(SIGNALING_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        setSignalingConnected(true);
        setStatus("Signaling server connected. Create a room or join with a code.");
        if (autoJoinRef.current) {
          const code = autoJoinRef.current;
          autoJoinRef.current = "";
          setJoinCode(code);
          sendSignal("join-room", { roomCode: code });
        }
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        try {
          const packet = JSON.parse(String(event.data)) as SignalPacket;
          void handleSignal(packet).catch((error: unknown) => {
            console.error("Signaling message handling failed:", error);
            setStatus("Could not complete peer connection setup. Please try again.");
          });
        } catch (error) {
          console.error("Invalid signaling message:", error);
          setStatus("The signaling server sent an invalid message.");
        }
      };
      socket.onerror = () => {
        if (!disposed) setStatus("Unable to reach the signaling server.");
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed) return;
        setSignalingConnected(false);
        setStatus("Signaling server disconnected. Reconnecting...");
        retryTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      channelRef.current = null;
    };
  }, [handleSignal, sendSignal]);

  const shareUrl = roomCode && typeof window !== "undefined"
    ? `${window.location.origin}${window.location.pathname}?room=${roomCode}`
    : "";
  const progress = transfer.total > 0
    ? Math.min(100, Math.round((transfer.transferred / transfer.total) * 100))
    : transfer.result === "complete"
      ? 100
      : 0;

  const createRoom = () => {
    if (sendSignal("create-room")) {
      setStatus("Creating a private room...");
    }
  };

  const joinRoom = () => {
    const code = joinCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setStatus("Enter a valid 6-character room code.");
      return;
    }
    if (sendSignal("join-room", { roomCode: code })) {
      setStatus(`Joining room ${code}...`);
    }
  };

  const selectFiles = (files?: FileList | File[]) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    setSelectedFiles(selected);
    setSelectedFolder("");
    setFolderFileCount(0);
    setTransfer({
      direction: "send",
      name: selected[0].name,
      transferred: 0,
      total: selected[0].size,
      result: "idle",
    });
    setStatus(
      channelRef.current?.readyState === "open"
        ? `${selected.length} file${selected.length === 1 ? "" : "s"} ready to send.`
        : "Files selected. Connect to a peer before sending.",
    );
  };

  const selectFolder = async (files?: FileList) => {
    if (!files?.length) return;
    const folderFiles = Array.from(files);
    const firstPath = folderFiles[0].webkitRelativePath;
    if (!firstPath.includes("/")) {
      setSelectedFiles([]);
      setSelectedFolder("");
      setFolderFileCount(0);
      setStatus("This browser did not provide folder paths. Try a browser that supports folder selection.");
      return;
    }
    const folderName = firstPath.split("/")[0];
    const zip = new JSZip();

    setSelectedFiles([]);
    setSelectedFolder("");
    setFolderFileCount(0);
    setPreparingFolder(true);
    setStatus(`Preparing ${folderName} folder...`);

    try {
      for (const file of folderFiles) {
        zip.file(file.webkitRelativePath, file);
      }

      const archive = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 1 },
        },
        ({ percent }) => {
          setStatus(`Preparing ${folderName} folder... ${Math.round(percent)}%`);
        },
      );
      const archiveFile = new File(
        [archive],
        `${safeFileName(folderName)}.zip`,
        { type: "application/zip" },
      );
      setSelectedFiles([archiveFile]);
      setSelectedFolder(folderName);
      setFolderFileCount(folderFiles.length);
      setPreparingFolder(false);
      setTransfer({
        direction: "send",
        name: archiveFile.name,
        transferred: 0,
        total: archiveFile.size,
        result: "idle",
      });
      setStatus(
        channelRef.current?.readyState === "open"
          ? `${folderName} is ready to send as a ZIP archive.`
          : "Folder prepared. Connect to a peer before sending.",
      );
    } catch (error) {
      console.error("Could not prepare folder archive:", error);
      setPreparingFolder(false);
      setStatus("Could not prepare the folder archive. Please try again.");
    }
  };

  const sendFile = async () => {
    const files = selectedFiles;
    const channel = channelRef.current;
    if (files.length === 0 || !channel || channel.readyState !== "open") {
      setStatus("Connect to a peer before sending a file.");
      return;
    }

    cancelSendRef.current = false;
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    let currentFile = files[0];
    let currentIndex = 0;

    try {
      for (const [index, file] of files.entries()) {
        currentFile = file;
        currentIndex = index;
        setTransfer({
          direction: "send",
          name: file.name,
          transferred: 0,
          total: file.size,
          result: "active",
        });
        setStatus(`Sending ${file.name} (${index + 1} of ${files.length}) directly to your peer...`);

        channel.send(JSON.stringify({
          type: "meta",
          payload: { name: file.name, size: file.size },
        }));

        let offset = 0;
        while (offset < file.size) {
          if (cancelSendRef.current) throw new Error("Transfer cancelled.");
          if (channel.readyState !== "open") {
            throw new Error("The peer connection closed during transfer.");
          }
          if (channel.bufferedAmount > BUFFER_HIGH) {
            await new Promise<void>((resolve, reject) => {
              const onLow = () => {
                channel.removeEventListener("close", onClose);
                resolve();
              };
              const onClose = () => {
                channel.removeEventListener("bufferedamountlow", onLow);
                reject(new Error("The peer connection closed during transfer."));
              };
              channel.addEventListener("bufferedamountlow", onLow, { once: true });
              channel.addEventListener("close", onClose, { once: true });
            });
          }

          const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
          if (cancelSendRef.current) throw new Error("Transfer cancelled.");
          channel.send(chunk);
          offset += chunk.byteLength;
          setTransfer({
            direction: "send",
            name: file.name,
            transferred: offset,
            total: file.size,
            result: "active",
          });
        }

        if (cancelSendRef.current) throw new Error("Transfer cancelled.");
        channel.send(JSON.stringify({ type: "eof" }));
        setTransfer({
          direction: "send",
          name: file.name,
          transferred: file.size,
          total: file.size,
          result: "complete",
        });
        setSelectedFiles(files.slice(index + 1));
      }

      if (fileInputRef.current) fileInputRef.current.value = "";
      setSelectedFolder("");
      setFolderFileCount(0);
      setStatus(`${files.length} file${files.length === 1 ? "" : "s"} sent successfully.`);
    } catch (error) {
      const cancelled = cancelSendRef.current;
      setSelectedFiles(files.slice(currentIndex));
      setTransfer({
        direction: "send",
        name: currentFile.name,
        transferred: 0,
        total: currentFile.size,
        result: cancelled ? "idle" : "error",
      });
      setStatus(
        cancelled
          ? "File transfer cancelled. You can send the remaining files."
          : error instanceof Error
            ? error.message
            : "File transfer failed.",
      );
    }
  };

  const cancelTransfer = () => {
    cancelSendRef.current = true;
    if (channelRef.current?.readyState === "open") {
      channelRef.current.send(JSON.stringify({ type: "cancel-transfer" }));
    }
    setTransfer(emptyTransfer);
    setStatus("Cancelling file transfer...");
  };

  const copyShareLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (error) {
      console.error("Could not copy the room link:", error);
      setStatus("Could not copy the link. You can copy the room code instead.");
    }
  };

  const leaveRoom = () => {
    closePeer();
    setRoomCode("");
    setJoinCode("");
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, "Left room");
    setStatus("Left the room. Reconnecting to the signaling server...");
  };

  const activeTransfer = transfer.result === "active";
  const selectionLocked = activeTransfer || preparingFolder;
  const roomActive = Boolean(roomCode);

  return (
    <main className="app-shell">
      <div className="landing-frame">
        <header className="topbar">
          <Link className="brand" href="/" aria-label="Vishal PH home">
            <span className="brand-mark">V</span>
            <span>vishal<span className="brand-accent">.ph</span></span>
          </Link>
          <nav className="top-nav" aria-label="Main navigation">
            <a href="#workspace">Send files</a>
            <a href="#connect-devices">Connect devices</a>
            <a href="#how-it-works">How it works</a>
          </nav>
          <div className="topbar-actions">
            <div className="server-status">
              <span className={`status-dot ${signalingConnected ? "online" : ""}`} />
              {signalingConnected ? "Service online" : "Connecting"}
            </div>
            <a className="nav-cta" href="#workspace">Get started <span aria-hidden="true">→</span></a>
          </div>
        </header>

        <section className="page-intro">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-spark">✳</span> FAST · PRIVATE · DIRECT</div>
            <h1>Share big files.<br /><span>Get it there.</span></h1>
            <p className="hero-description">
              Send files directly between devices. No cloud storage, no complicated setup—just connect and share.
            </p>
            <div className="hero-actions">
              <a className="primary-button hero-cta" href="#workspace">Start sharing <span aria-hidden="true">→</span></a>
              <a className="hero-secondary" href="#how-it-works"><span aria-hidden="true">▶</span> How it works</a>
            </div>
            <div className="hero-points" aria-label="Sharing features">
              <span><i aria-hidden="true">↯</i> Peer-to-peer transfer</span>
              <span><i aria-hidden="true">⌑</i> Private room codes</span>
              <span><i aria-hidden="true">✓</i> No file storage</span>
            </div>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="visual-orbit orbit-one" />
            <div className="visual-orbit orbit-two" />
            <div className="visual-file-card file-card-top">
              <span className="file-type video-type">▶</span>
              <span><strong>Project_video.mp4</strong><small>Ready to share</small></span>
              <span className="file-check">✓</span>
            </div>
            <div className="visual-transfer-card">
              <div className="visual-card-heading">
                <span className="visual-app-icon">↗</span>
                <span><strong>Direct transfer</strong><small>Device to device</small></span>
                <span className="visual-menu">···</span>
              </div>
              <div className="visual-drop">
                <span className="visual-cloud">↑</span>
                <strong>Drop files to share</strong>
                <small>or browse your device</small>
              </div>
              <div className="visual-peers">
                <span className="peer-avatar avatar-blue">V</span>
                <span className="peer-link">············</span>
                <span className="peer-avatar avatar-violet">P</span>
              </div>
            </div>
            <div className="visual-file-card file-card-bottom">
              <span className="file-type image-type">▧</span>
              <span><strong>Shared privately</strong><small>Files stay between devices</small></span>
              <span className="file-check">✓</span>
            </div>
            <div className="visual-secure-card"><span>✓</span> No cloud upload</div>
          </div>
        </section>

        <div className="feature-strip" id="how-it-works">
          <div className="feature-label">MADE FOR EASY SHARING</div>
          <div className="feature-item"><span className="feature-icon">↯</span><span><strong>Direct transfer</strong><small>Powered by WebRTC</small></span></div>
          <div className="feature-item"><span className="feature-icon">⌑</span><span><strong>Private rooms</strong><small>Connect with a short code</small></span></div>
          <div className="feature-item"><span className="feature-icon">✓</span><span><strong>No file storage</strong><small>Your files aren&apos;t uploaded</small></span></div>
          <div className="feature-note">Simple sharing.<br /><strong>Device to device.</strong></div>
        </div>

      <section className="workspace-grid" id="workspace" aria-label="File sharing workspace">
        <div className="transfer-panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">01 / SEND FILES</span>
              <h2>Start sharing</h2>
            </div>
            <span className={`peer-pill ${peerState === "connected" ? "peer-ready" : ""}`}>
              <span className="status-dot" />
              {peerState === "connected" ? "Peer connected" : "Waiting for peer"}
            </span>
          </div>

          <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          multiple
          onChange={(event) => {
            selectFiles(event.target.files ?? undefined);
            event.currentTarget.value = "";
          }}
          disabled={selectionLocked}
          />
          <input
            ref={(input) => {
              folderInputRef.current = input;
              input?.setAttribute("webkitdirectory", "");
            }}
            className="visually-hidden"
            type="file"
            multiple
            onChange={(event) => {
              void selectFolder(event.target.files ?? undefined);
              event.currentTarget.value = "";
            }}
            disabled={selectionLocked}
          />
          <div
          className={`dropzone ${dragging ? "dropzone-active" : ""} ${selectionLocked ? "dropzone-disabled" : ""}`}
          role="button"
          tabIndex={selectionLocked ? -1 : 0}
          aria-disabled={selectionLocked}
          onClick={() => {
            if (!selectionLocked) fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (!selectionLocked && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!selectionLocked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!selectionLocked) selectFiles(event.dataTransfer.files);
          }}
          >
          <span className="upload-icon" aria-hidden="true">↑</span>
          <span className="dropzone-title">
            {selectedFolder
              ? `${selectedFolder} folder selected`
              : selectedFiles.length === 0
                ? "Drop files here"
                : selectedFiles.length === 1
                  ? selectedFiles[0].name
                  : `${selectedFiles.length} files selected`}
            </span>
            <span className="dropzone-subtitle">
              {selectedFolder
                ? `${folderFileCount} files · ${selectedFiles[0] ? formatBytes(selectedFiles[0].size) : "ZIP"} archive`
                : selectedFiles.length > 0
                ? `${formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))} total · Click to choose files`
                : "or click to browse your device"}
            </span>
          </div>
          <div className="folder-picker-row">
            <span className="folder-picker-note">Or select an entire folder</span>
            <button
              className="secondary-button folder-picker-button"
              type="button"
              onClick={() => {
                if (!selectionLocked) folderInputRef.current?.click();
              }}
              disabled={selectionLocked}
            >
              Choose folder
            </button>
          </div>

          {(transfer.name || activeTransfer) && (
            <div className="transfer-details" aria-live="polite">
              <div className="transfer-meta">
                <span className="transfer-filename">
                  {transfer.direction === "receive" ? "Receiving" : "Sending"} · {transfer.name}
                </span>
                <span className="transfer-percent">
                  {transfer.result === "complete" ? "Done" : `${progress}%`}
                </span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="File transfer progress"
                aria-valuenow={progress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${progress}%` }} />
              </div>
              <div className="transfer-meta transfer-caption">
                <span>{formatBytes(transfer.transferred)} of {formatBytes(transfer.total)}</span>
                {activeTransfer && transfer.direction === "send" && (
                  <button className="text-button" type="button" onClick={cancelTransfer}>Cancel</button>
                )}
              </div>
            </div>
          )}

          <button
            className="primary-button send-button"
            type="button"
            onClick={() => void sendFile()}
            disabled={selectedFiles.length === 0 || peerState !== "connected" || activeTransfer}
          >
            {preparingFolder
              ? "Preparing folder..."
              : activeTransfer
              ? "Transferring..."
              : selectedFolder
                ? "Send folder"
                : `Send ${selectedFiles.length > 1 ? `${selectedFiles.length} files` : "file"}`}
            <span aria-hidden="true">↗</span>
          </button>
          <p className="privacy-note">Your file travels directly to the other device.</p>
        </div>

        <section className="room-section" id="connect-devices" aria-labelledby="room-heading">
        <div className="room-intro">
          <span className="section-kicker">02 / CONNECT DEVICES</span>
          <h2 id="room-heading">Meet in a private room.</h2>
          <p>Create a room and share its link, or join someone with their six-character code.</p>
        </div>

        <div className="room-card">
          <div className="room-card-top">
            <span className="room-number">A</span>
            <div>
              <h3>{roomActive ? "Your room is ready" : "Create a room"}</h3>
              <p>{roomActive ? "Share this with the person you want to connect with." : "Get a private link in one click."}</p>
            </div>
          </div>
          {roomActive ? (
            <>
              <div className="room-code">{roomCode}</div>
              <div className="room-actions">
                <button className="primary-button" type="button" onClick={() => void copyShareLink()}>
                  {copied ? "Link copied" : "Copy invite link"}
                  <span aria-hidden="true">{copied ? "✓" : "↗"}</span>
                </button>
                <button className="secondary-button" type="button" onClick={() => setShowRoomQr(true)}>
                  Show QR code
                </button>
                <button className="secondary-button" type="button" onClick={leaveRoom}>Leave room</button>
              </div>
            </>
          ) : (
            <button
              className="primary-button room-action-button"
              type="button"
              onClick={createRoom}
              disabled={!signalingConnected}
            >
              Create private room <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>

        <div className="room-card join-card">
          <div className="room-card-top">
            <span className="room-number">B</span>
            <div>
              <h3>Join a room</h3>
              <p>Already have an invite code? Enter it here.</p>
            </div>
          </div>
          <label className="input-label" htmlFor="join-code">Room code</label>
          <div className="join-row">
            <input
              id="join-code"
              className="room-input"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
              onKeyDown={(event) => {
                if (event.key === "Enter") joinRoom();
              }}
              placeholder="e.g. K7M2PQ"
              maxLength={6}
              autoComplete="off"
              disabled={roomActive}
            />
            <button
              className="secondary-button scan-button"
              type="button"
              onClick={qrScanner.openScanner}
              disabled={roomActive}
            >
              <span aria-hidden="true">▦</span> Scan QR
            </button>
            <button
              className="primary-button join-button"
              type="button"
              onClick={joinRoom}
              disabled={!signalingConnected || roomActive || joinCode.length !== 6}
            >
              Join room <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
        </section>
      </section>

      <div className={`connection-message ${peerState === "connected" ? "connection-message-ready" : ""}`} role="status">
        <span className={`status-dot ${peerState === "connected" ? "online" : ""}`} />
        <span>{status}</span>
        {roomActive && <span className="connection-state">{peerState}</span>}
      </div>

        <footer className="footer">
          <Link className="brand footer-brand" href="/">vishal<span className="brand-accent">.ph</span></Link>
          <span>Files move between devices, not through our storage.</span>
          <span className="footer-tech">POWERED BY WEBRTC</span>
        </footer>
      </div>

      {showRoomQr && roomActive && shareUrl && (
        <RoomQrDialog
          roomCode={roomCode}
          shareUrl={shareUrl}
          copied={copied}
          onCopy={() => void copyShareLink()}
          onClose={() => setShowRoomQr(false)}
        />
      )}
      {qrScanner.isOpen && (
        <CameraScannerDialog
          videoRef={qrScanner.videoRef}
          cameraFacing={qrScanner.cameraFacing}
          cameraError={qrScanner.cameraError}
          isCameraStarting={qrScanner.isCameraStarting}
          onClose={qrScanner.closeScanner}
          onFlipCamera={qrScanner.flipCamera}
          onRetry={qrScanner.retryCamera}
        />
      )}
    </main>
  );
}
