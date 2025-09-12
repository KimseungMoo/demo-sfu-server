# demo-sfu-server

Demo SFU server project repository.

See [DEMO_SFU_SERVER_REQUIREMENTS.md](DEMO_SFU_SERVER_REQUIREMENTS.md) for the draft requirements of the local demo SFU server.

## Server

The SFU demo server implementation lives in the [`server/`](server) directory. It exposes:

- `GET /healthz` – basic health check
- `GET /catalog` – media catalog generated from `MEDIA_DIR`
- `ws://localhost:<PORT>/ws` – WebSocket API for stream control

To run the server locally:

```bash
cd server
npm install
npm run dev
```

By default the server looks for MP4 files under `../media` and listens on port `8080`.

