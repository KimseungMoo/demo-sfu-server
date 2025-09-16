#!/usr/bin/env node
import { spawn } from 'child_process';

const serverBase = process.env.SERVER_BASE || 'http://localhost:8080';
const trainingId = process.env.TRAINING_ID || 'T001';
const sessionId = process.env.SESSION_ID || 'S001';
const studentId = process.env.STUDENT_ID || 'ST001';
// List of avfoundation device indices to stream. Adjust as needed.
const devices = (process.env.CAM_INDEXES || '0,1,2').split(',');

async function startSession(streamKey) {
  const res = await fetch(`${serverBase}/api/session/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trainingId, sessionId, studentId, streamKey }),
  });
  if (!res.ok) {
    throw new Error(`session start failed for ${streamKey}: ${res.status}`);
  }
  const data = await res.json();
  return data.rtpUrl;
}

function streamCamera(device, streamKey, rtpUrl) {
  const ffmpegArgs = [
    '-f', 'avfoundation',
    '-i', `${device}:none`,
    '-vcodec', 'copy',
    '-an',
    '-f', 'rtp',
    rtpUrl,
  ];
  console.log(`Streaming camera index ${device} as ${streamKey} -> ${rtpUrl}`);
  const ff = spawn('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
  ff.on('exit', (code) => {
    console.log(`ffmpeg for ${streamKey} exited with code ${code}`);
  });
}

(async () => {
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i];
    const streamKey = `cam${String(i + 1).padStart(2, '0')}`;
    try {
      const rtpUrl = await startSession(streamKey);
      streamCamera(device, streamKey, rtpUrl);
    } catch (err) {
      console.error(err);
    }
  }
})();
