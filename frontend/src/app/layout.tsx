import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vishal PH — Peer-to-peer file sharing",
  description:
    "Send files directly between devices with private, room-based WebRTC sharing.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
