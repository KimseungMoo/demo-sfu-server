import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 8080;
const DEFAULT_VIDEO_ROOT = path.join(path.parse(process.cwd()).root, 'video');
const VIDEO_ROOT = process.env.VIDEO_ROOT || DEFAULT_VIDEO_ROOT;
const RTP_BASE_PORT = parseInt(process.env.RTP_BASE_PORT || '5000', 10);
const RTP_ANNOUNCE_IP = process.env.RTP_ANNOUNCE_IP || 'localhost';

const app = express();
app.use(express.json());

// in-memory session tracking
const sessions = new Map(); // streamKey -> {ffmpeg, port, filePath}
let nextPort = RTP_BASE_PORT;

function allocatePort() {
  return nextPort++;
}

app.get('/healthz', (_, res) => {
  res.status(200).send('ok');
});

app.post('/api/session/start', (req, res) => {
  const { trainingId, sessionId, studentId, streamKey } = req.body || {};
  if (!trainingId || !sessionId || !studentId || !streamKey) {
    res.status(400).json({ error: 'missing parameter' });
    return;
  }
  if (sessions.has(streamKey)) {
    res.status(400).json({ error: 'stream already started' });
    return;
  }

  const port = allocatePort();
  const dir = path.join(VIDEO_ROOT, trainingId, sessionId, studentId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${streamKey}.mp4`);

  const ffmpegArgs = [
    '-loglevel', 'error',
    '-i', `rtp://0.0.0.0:${port}`,
    '-c', 'copy',
    '-f', 'mp4',
    filePath,
  ];
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.on('exit', (code) => {
    console.log(`ffmpeg for ${streamKey} exited with code ${code}`);
  });

  sessions.set(streamKey, { ffmpeg, port, filePath });

  res.json({ status: 'ready', rtpUrl: `rtp://${RTP_ANNOUNCE_IP}:${port}` });
});

app.post('/api/session/stop', (req, res) => {
  const { streamKeys } = req.body || {};
  if (!Array.isArray(streamKeys)) {
    res.status(400).json({ error: 'streamKeys must be array' });
    return;
  }

  streamKeys.forEach((key) => {
    const session = sessions.get(key);
    if (session) {
      session.ffmpeg.kill('SIGINT');
      sessions.delete(key);
    }
  });

  res.json({ status: 'stopped' });
});

const server = app.listen(PORT, () => {
  console.log(`SFU server listening on port ${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        ws.send(JSON.stringify({ type: 'subscribed', streamKey: msg.streamKey }));
        break;
      case 'unsubscribe':
        ws.send(JSON.stringify({ type: 'unsubscribed', streamKey: msg.streamKey }));
        break;
      default:
        ws.send(JSON.stringify({ type: 'error', message: 'unknown type' }));
    }
  });
});
