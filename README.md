# Vishal PH

Vishal PH is a peer-to-peer file-sharing app. The Next.js client lives in
`frontend/`; the Express/WebSocket signaling service and MongoDB room metadata
live in `backend/`. Files are sent directly between browsers over a WebRTC data
channel and are not uploaded to MongoDB.

## Requirements

- Node.js and npm
- MongoDB Community Server running locally
- MongoDB Compass (optional; use it to inspect the local database)

Compass is a database client, not the MongoDB server. Start your local MongoDB
service first, then connect Compass to `mongodb://127.0.0.1:27017`.

## Start the app

In the first terminal, configure and start the backend:

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

In a second terminal, start the frontend:

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:3000> in two browser windows. Create a room in one,
then join with its invite link or six-character code. Once the peer connection
is ready, select multiple files in the file picker or choose a folder with
**Choose folder**. Send regular file selections with **Send files**; a folder
selection includes files in its subfolders and is packaged into a ZIP archive
that preserves the folder structure. Choose **Send folder** to send it. The
other device receives one ZIP file; empty folders are not included.

The room card includes **Show QR code**. A phone can scan it using its native
camera and open the invite link; the page automatically joins that room. The
**Scan QR** button also lets a browser scan an invite from inside the app.

The backend defaults to `mongodb://127.0.0.1:27017` and the `vishal_ph` database.
On first startup it creates a `rooms` collection, a unique room-code index, and
a TTL index that removes expired room metadata. Compass can display the
database, room codes, two peer IDs, room state, and timestamps.

Set `MONGODB_URI` and optionally `MONGODB_DB_NAME` in `backend/.env` to use a
different MongoDB instance. Keep credentials private and do not commit `.env`.
Set `NEXT_PUBLIC_SIGNALING_URL` in `frontend/.env.local` to use a different
WebSocket endpoint; production deployments should use `wss://`.

## Use with a physical phone

For a phone on the internet or mobile data, deploy the frontend over HTTPS and
the backend with a publicly reachable WSS endpoint. Set
`NEXT_PUBLIC_SIGNALING_URL=wss://your-signaling-host.example` in
`frontend/.env.local` before building/deploying the frontend. Restart the
development server after changing this setting. Then create a room on the
desktop and scan its QR code with the phone camera.

Camera access on phones requires HTTPS (or localhost). A phone's `localhost`
points to the phone itself, not your development computer, so a plain local
`http://localhost:3000` link will not work for another device. For local testing
on Wi-Fi, use a trusted HTTPS tunnel or HTTPS reverse proxy for both the
frontend and signaling server, then configure the frontend with the public
`wss://` signaling URL. Do not expose MongoDB directly to the internet.

WebRTC can connect directly on many networks using STUN. Some mobile carriers
and restrictive Wi-Fi networks require TURN relaying. To enable a TURN service,
set `NEXT_PUBLIC_TURN_URLS`, `NEXT_PUBLIC_TURN_USERNAME`, and
`NEXT_PUBLIC_TURN_CREDENTIAL` in the frontend environment. These values are
sent to browsers, so use short-lived credentials from your TURN provider, not
permanent provider secrets.

## Room data and file privacy

MongoDB stores room codes, peer IDs, room status, and timestamps only. It does
not store file names, file contents, or transfer chunks. The signaling server
uses the database to enforce the two-peer room limit, while live WebSocket
connections exchange WebRTC setup messages. A public STUN server is configured;
some networks may also require TURN for peer connectivity.
