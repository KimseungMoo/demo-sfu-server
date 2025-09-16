# RTP Test Client (macOS)

A simple Node script that captures all connected cameras on macOS using
`ffmpeg`'s `avfoundation` input and streams them as H.264 RTP to the SFU
server.

The script assumes each camera provides H.264 frames and sends them without
re-encoding (`-vcodec copy`).

## Prerequisites

- macOS with `ffmpeg` installed (`brew install ffmpeg`)
- Node 18+
- Cameras capable of H.264 output (internal and external)

## Usage

1. Start the SFU server and expose its IP address via `RTP_ANNOUNCE_IP`.
2. On macOS, run:

```bash
cd client
node rtp-mac.js
```

Environment variables:

- `SERVER_BASE` – base URL of the SFU server (default `http://localhost:8080`)
- `TRAINING_ID`, `SESSION_ID`, `STUDENT_ID` – identifiers for the session
- `CAM_INDEXES` – comma-separated list of avfoundation device indexes (default `0,1,2`)

The script starts one session per camera (`cam01`, `cam02`, ...), obtains the
`rtpUrl` from the server and pipes the camera feed directly via RTP without
transcoding.
