# SFU Server

A minimal SFU-like server that accepts RTP(H.264) streams from Android tablets,
forwards control via WebSocket and records the streams to MP4 files without
re-encoding.

## API

### POST /api/session/start
Request body:
```
{ "trainingId": "T001", "sessionId": "S001", "studentId": "ST001", "streamKey": "cam01" }
```
Response:
```
{ "status": "ready", "rtpUrl": "rtp://localhost:5000" }
```

### POST /api/session/stop
Request body:
```
{ "streamKeys": ["cam01"] }
```

### WebSocket `/ws`
Supports `subscribe` and `unsubscribe` messages:
```
{ "type": "subscribe", "streamKey": "cam01" }
```

## Running
```
cd server
npm install
npm run dev
```

By default the server listens on port `8080` and stores recordings under
`./video/{trainingId}/{sessionId}/{studentId}/{streamKey}.mp4`.
