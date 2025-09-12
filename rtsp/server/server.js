// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});
const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const RTSP_URL = 'rtsp://192.168.254.1/live';
const RECORDING_DIR = path.join(__dirname, 'recordings');
let ffmpegProcess = null;

// 녹화 디렉토리가 없으면 생성
if (!fs.existsSync(RECORDING_DIR)) {
    fs.mkdirSync(RECORDING_DIR);
}

// React 정적 파일 제공 (필요시)
app.use(express.static('public'));

// WebRTC 시그널링 (Go2rtc와 연동)
io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('webrtc-offer', async (data) => {
        try {
            console.log('Received WebRTC offer from client');
            console.log('Offer SDP:', data.sdp);
            
            // go2rtc WebRTC API 호출 (올바른 형식)
            const response = await axios.post('http://127.0.0.1:1984/api/webrtc?src=camera', data.sdp, {
                headers: {
                    'Content-Type': 'text/plain'
                }
            });
            
            console.log('Received answer from go2rtc');
            console.log('Answer SDP:', response.data);
            
            // go2rtc로부터 받은 answer를 클라이언트에 전송
            socket.emit('webrtc-answer', {
                type: 'answer',
                sdp: response.data
            });
            
        } catch (error) {
            console.error('go2rtc communication error:', error.response?.data || error.message);
            socket.emit('webrtc-error', { error: error.message });
        }
    });

    // ICE candidates는 go2rtc에서 자동으로 처리되므로 별도 처리 불필요
    socket.on('webrtc-candidate', (data) => {
        console.log('Received ICE candidate (handled by go2rtc automatically)');
    });

    // 녹화 시작 이벤트 (비디오 스트림이 수신되었을 때 또는 수동 시작)
    socket.on('start-recording', () => {
        console.log('Recording start requested');
        if (!ffmpegProcess) {
            startRecording();
            socket.emit('recording-started');
            // 같은 방에 있는 모든 클라이언트에게 알림
            socket.broadcast.emit('recording-started');
        } else {
            console.log('Recording already in progress');
            socket.emit('recording-started'); // 이미 녹화 중이라고 알림
        }
    });

    // 녹화 중지 이벤트
    socket.on('stop-recording', () => {
        console.log('Recording stop requested');
        if (ffmpegProcess) {
            console.log('Stopping recording...');
            ffmpegProcess.kill('SIGINT');
            ffmpegProcess = null;
            socket.emit('recording-stopped');
            // 같은 방에 있는 모든 클라이언트에게 알림
            socket.broadcast.emit('recording-stopped');
        } else {
            console.log('No recording in progress');
            socket.emit('recording-stopped'); // 이미 중지 상태라고 알림
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        // 클라이언트가 연결을 끊으면 녹화도 중지 (선택사항)
        // 여러 클라이언트가 있을 수 있으므로 주석 처리
        // if (ffmpegProcess) {
        //     console.log('Stopping recording due to client disconnect...');
        //     ffmpegProcess.kill('SIGINT');
        //     ffmpegProcess = null;
        // }
    });
});

function startRecording() {
    const now = new Date();
    const dateString = now.toISOString().replace(/[:.-]/g, '');
    const SAVE_FILE = path.join(RECORDING_DIR, `video-${dateString}.mp4`);

    console.log(`Starting recording to ${SAVE_FILE}`);
    
    ffmpegProcess = spawn('ffmpeg', [
        '-i', RTSP_URL,
        '-c:v', 'copy',  // 비디오만 복사
        '-an',  // 오디오 완전 제외
        '-f', 'mp4',
        '-y', // 파일 덮어쓰기 허용
        '-avoid_negative_ts', 'make_zero',  // 타임스탬프 문제 해결
        SAVE_FILE
    ]);

    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`ffmpeg: ${data.toString()}`);
    });

    ffmpegProcess.on('close', (code) => {
        console.log(`Recording process exited with code ${code}`);
        ffmpegProcess = null;
    });

    ffmpegProcess.on('error', (error) => {
        console.error('FFmpeg error:', error);
        ffmpegProcess = null;
    });
}

http.listen(3001, () => {
    console.log('Server is running on port 3001');
});