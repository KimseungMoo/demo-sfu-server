# demo-sfu-server

Demo SFU server project repository.

See [DEMO_SFU_SERVER_REQUIREMENTS.md](DEMO_SFU_SERVER_REQUIREMENTS.md) for the draft requirements of the local demo SFU server.

## Server

The SFU server implementation lives in the [`server/`](server) directory. It exposes:

- `POST /api/session/start` – allocate an RTP port and begin recording the incoming H.264 stream to MP4
- `POST /api/session/stop` – stop recording and close the session
- `GET /healthz` – basic health check
- `ws://localhost:<PORT>/ws` – WebSocket API for stream control (`subscribe`/`unsubscribe`)

To run the server locally:

```bash
cd server
npm install
npm run dev
```

By default the server stores recordings under
`/video/{trainingId}/{sessionId}/{studentId}/{streamKey}.mp4` (configurable via
the `VIDEO_ROOT` environment variable) and listens on port `8080`.

## macOS RTP Test Client

The [`client/`](client) directory contains a helper script for macOS that uses
`ffmpeg` to stream all attached cameras as H.264 over RTP to the server without
re-encoding. See [client/README.md](client/README.md) for usage.

Example WebSocket subscribe message:

```json
{ "type": "subscribe", "streamKey": "cam01" }
```
