# Vishal PH frontend

The Next.js app in this folder is the user-facing client. It creates and joins
rooms through the WebSocket signaling service in the sibling `backend/`
directory, negotiates WebRTC connections, and transfers files directly between
browsers.

Run the signaling service and a local MongoDB server first, then start this app:

```bash
npm install
npm run dev
```

The app defaults to `ws://localhost:8080`. Set `NEXT_PUBLIC_SIGNALING_URL` in
`.env.local` to use another signaling service. Use `wss://` when deploying over
HTTPS.
