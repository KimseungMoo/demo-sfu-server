import { spawn } from 'child_process';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import http from 'http';
import * as mediasoup from 'mediasoup';
import path from 'path';
import { WebSocketServer } from 'ws';
import { buildCatalog, expandCatalog } from './catalog.js';
import { Catalog } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const MEDIA_DIR = process.env.MEDIA_DIR || path.resolve(process.cwd(), 'media');
const STREAM_COUNT = Number(process.env.STREAM_COUNT);
const H264_PASSTHROUGH = process.env.H264_PASSTHROUGH === '1' || process.env.H264_PASSTHROUGH === 'true';
const AUTO_START_PRODUCERS_COUNT = Number(process.env.AUTO_START_PRODUCERS_COUNT || 0);

let baseCatalog: Catalog = { streams: [] };
let catalog: Catalog = { streams: [] };

// mediasoup 설정
const mediasoupConfig = {
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 20000, // 🔧 포트 범위 대폭 확장 (100 → 10,000개)
    logLevel: 'warn',
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp',
    ],
  },
  router: {
    mediaCodecs: [
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: {
          'packetization-mode': 1,
          'profile-level-id': '42e01f',
        },
      },
    ],
  },
  webRtcTransport: {
    listenIps: [
      {
        ip: '127.0.0.1',
        announcedIp: undefined,
      },
    ],
    maxIncomingBitrate: 1500000,
    initialAvailableOutgoingBitrate: 1000000,
  },
};

// mediasoup 컴포넌트
let mediasoupWorker: mediasoup.types.Worker;
let mediasoupRouter: mediasoup.types.Router;

// Transport 관리
const transports = new Map<string, mediasoup.types.WebRtcTransport>();
const producers = new Map<string, mediasoup.types.Producer>();
const consumers = new Map<string, mediasoup.types.Consumer>();

// 파일 기반 Producer 관리
const fileProducers = new Map<string, {
  producer: mediasoup.types.Producer;
  transport: mediasoup.types.PlainTransport;
  ffmpegProcess?: any;
}>();

// 🆕 동시 처리 제한 및 대기열 관리
const MAX_CONCURRENT_STREAMS = Number(process.env.MAX_CONCURRENT_STREAMS) || 4; // 최대 동시 스트림 수 (env로 조정)
const streamQueue = new Set<string>(); // 대기중인 스트림

// 스트림 상태 관리
type StreamState = {
  streamKey: string;
  isPlaying: boolean;
  isLooping: boolean;
  currentPosition: number;
  duration: number;
  subscribers: Set<WebSocket>;
  intervalId?: NodeJS.Timeout;
  initSegment?: Buffer;
  segmentIndex: number;
  // mediasoup 관련
  producer?: mediasoup.types.Producer;
  consumers: Map<string, mediasoup.types.Consumer>;
};

const streamStates = new Map<string, StreamState>();

// mediasoup 초기화
async function initMediasoup() {
  try {
    // Worker 생성
    mediasoupWorker = await mediasoup.createWorker({
      rtcMinPort: mediasoupConfig.worker.rtcMinPort,
      rtcMaxPort: mediasoupConfig.worker.rtcMaxPort,
      logLevel: mediasoupConfig.worker.logLevel as any,
      logTags: mediasoupConfig.worker.logTags as any,
    });

    mediasoupWorker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds...');
      setTimeout(() => process.exit(1), 2000);
    });

    // Router 생성
    mediasoupRouter = await mediasoupWorker.createRouter({
      mediaCodecs: mediasoupConfig.router.mediaCodecs as any,
    });

    // console.log('✅ mediasoup 초기화 완료');
    // console.log(`   Worker PID: ${mediasoupWorker.pid}`);
    // console.log(`   Router ID: ${mediasoupRouter.id}`);
  } catch (error) {
    console.error('❌ mediasoup 초기화 실패:', error);
    throw error;
  }
}

// 🆕 파일 정보 확인 함수
async function getVideoInfo(filePath: string): Promise<{fps: number, duration: number, resolution: string}> {
  return new Promise((resolve, reject) => {
    const ffprobeArgs = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'v:0',
      filePath
    ];
    
    const ffprobe = spawn('ffprobe', ffprobeArgs);
    let output = '';
    
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}`));
        return;
      }
      
      try {
        const info = JSON.parse(output);
        const videoStream = info.streams[0];
        const fps = eval(videoStream.r_frame_rate) || 30; // 기본값 30fps
        const duration = parseFloat(videoStream.duration) || 0;
        const resolution = `${videoStream.width}x${videoStream.height}`;
        
        // console.log(`📹 [${path.basename(filePath)}] 비디오 정보: ${fps}fps, ${duration}초, ${resolution}`);
        resolve({ fps, duration, resolution });
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe output: ${err}`));
      }
    });
  });
}

// 🆕 대기열 처리 함수
function processStreamQueue() {
  if (fileProducers.size >= MAX_CONCURRENT_STREAMS || streamQueue.size === 0) {
    return;
  }
  
  const nextStreamKey = streamQueue.values().next().value;
  if (nextStreamKey) {
    streamQueue.delete(nextStreamKey);
    // 대기중인 스트림의 실제 Producer 생성은 구독 시점에서 처리
    console.log(`🎬 대기열에서 스트림 처리: ${nextStreamKey} (활성: ${fileProducers.size}/${MAX_CONCURRENT_STREAMS})`);
  }
}

// 🆕 기존 FFmpeg 프로세스 정리 함수
function cleanupExistingFFmpegProcesses() {
  
  // 현재 실행 중인 FFmpeg 프로세스 확인
  const ps = spawn('ps', ['aux']);
  let output = '';
  
  ps.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  ps.on('close', () => {
    const lines = output.split('\n');
    const ffmpegProcesses = lines.filter(line => 
      line.includes('ffmpeg') && 
      line.includes('media/') && 
      !line.includes('grep')
    );
    
    if (ffmpegProcesses.length > 0) {
      console.log(`🧹 기존 FFmpeg 프로세스 ${ffmpegProcesses.length}개 정리 중...`);
      
      ffmpegProcesses.forEach(line => {
        const pid = line.trim().split(/\s+/)[1];
        if (pid && pid !== 'PID') {
          try {
            process.kill(parseInt(pid), 'SIGTERM');
            console.log(`✅ FFmpeg 프로세스 ${pid} 종료됨`);
          } catch (err) {
            console.log(`⚠️ FFmpeg 프로세스 ${pid} 종료 실패: ${err.message}`);
          }
        }
      });
      
      // 프로세스 종료 대기
      setTimeout(() => {
        console.log(`🧹 FFmpeg 프로세스 정리 완료`);
      }, 1000);
    }
  });
}

// 🆕 서버 내부 스트림 상태 정리 함수
function cleanupServerStreamState() {
  console.log(`🧹 서버 내부 스트림 상태 정리 중...`);
  
  // 기존 Producer 정리
  fileProducers.forEach((producerInfo, streamKey) => {
    try {
      if (producerInfo.ffmpegProcess && !producerInfo.ffmpegProcess.killed) {
        producerInfo.ffmpegProcess.kill('SIGTERM');
        console.log(`✅ 기존 Producer ${streamKey}의 FFmpeg 프로세스 종료됨`);
      }
    } catch (err) {
      console.log(`⚠️ Producer ${streamKey} 정리 실패: ${err.message}`);
    }
  });
  
  // 내부 상태 초기화
  fileProducers.clear();
  streamQueue.clear();
  
  console.log(`🧹 서버 내부 스트림 상태 정리 완료`);
}

// 🆕 서버 시작 시 내부 상태 초기화
function initializeServerState() {
  console.log(`🚀 서버 내부 상태 초기화 중...`);
  
  // 모든 내부 상태 초기화
  fileProducers.clear();
  streamQueue.clear();
  producers.clear();
  consumers.clear();
  
  console.log(`✅ 서버 내부 상태 초기화 완료`);
}

// 파일 기반 Producer 생성 함수
async function createFileProducer(streamKey: string, filePath: string): Promise<mediasoup.types.Producer> {
  // 🆕 기존 FFmpeg 프로세스 및 서버 상태 정리 (일시적으로 비활성화)
  // cleanupExistingFFmpegProcesses();
  // cleanupServerStreamState();
  
  // 🆕 동시 스트림 수 제한 체크
  if (fileProducers.size >= MAX_CONCURRENT_STREAMS) {
    streamQueue.add(streamKey);
    throw new Error(`최대 동시 스트림 수 초과. 대기열에 추가됨 (${fileProducers.size}/${MAX_CONCURRENT_STREAMS})`);
  }
  
  try {
    console.log(`🎬 파일 기반 Producer 생성 시작: ${streamKey} (활성: ${fileProducers.size + 1}/${MAX_CONCURRENT_STREAMS})`);
    
    // 🆕 비디오 파일 정보 미리 확인
    const videoInfo = await getVideoInfo(filePath);
    console.log(`📊 [${streamKey}] 원본 비디오 정보: ${videoInfo.fps}fps, ${videoInfo.resolution}`);
    
    // 1. Producer용 PlainTransport 생성 (서버 내부용)
    const producerTransport = await mediasoupRouter.createPlainTransport({
      listenIp: { ip: '127.0.0.1', announcedIp: undefined },
      rtcpMux: false,
      comedia: true  // FFmpeg가 먼저 패킷을 보낼 수 있도록 활성화
    });

    // console.log(`📡 PlainTransport 생성됨: ${producerTransport.id}, 포트: ${producerTransport.tuple.localPort}`);

    // 2. Producer 생성
    const producer = await producerTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [{
          mimeType: 'video/H264',
          payloadType: 96,
          clockRate: 90000,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f'
          }
        }],
        encodings: [{ 
          ssrc: Math.floor(Math.random() * 1000000),
          rtx: { ssrc: Math.floor(Math.random() * 1000000) }
        }],
        headerExtensions: [],
        rtcp: {
          cname: `file-producer-${streamKey}`
        }
      }
    });

    // console.log(`🎥 Producer 생성됨: ${producer.id}`);

    // 🔧 PlainTransport를 FFmpeg와 연결
    const encoding = producer.rtpParameters.encodings?.[0];
    if (!encoding || !encoding.ssrc) {
      throw new Error('Producer encoding 또는 SSRC가 없습니다');
    }
    const ssrc = encoding.ssrc;
    
    // FFmpeg가 보내는 주소/포트 설정 (원격 주소)
    // FFmpeg는 임의의 포트에서 PlainTransport의 localPort로 전송
    await producerTransport.connect({
      ip: '127.0.0.1',
      port: 0,  // FFmpeg가 사용할 임의의 포트
      rtcpPort: 0  // RTCP도 임의의 포트
    });

    // console.log(`🔗 PlainTransport 연결됨: SSRC=${ssrc}, 포트=${producerTransport.tuple.localPort}`);

    // 3. FFmpeg로 파일을 RTP 스트림으로 변환 (SSRC 명시) - CPU 최적화
    const activeStreamCount = fileProducers.size;
    const targetFps = Math.max(Math.min(videoInfo.fps, 30), 15); // 15-30 fps 범위로 제한
    
    // 🆕 동시 스트림 수에 따른 동적 최적화
    let preset = 'ultrafast';
    let bitrate = '1.5M';
    let maxrate = '2M';
    let bufsize = '3M';
    
    if (activeStreamCount >= 4) {
      // 4개 이상 스트림 시 극도 최적화
      preset = 'ultrafast';
      bitrate = '1M';
      maxrate = '1.2M';
      bufsize = '2M';
    } else if (activeStreamCount >= 2) {
      // 2-3개 스트림 시 성능 우선
      preset = 'superfast';
      bitrate = '1.2M';
      maxrate = '1.5M';
      bufsize = '2.5M';
    }
    
    const gopSize = Math.min(targetFps * 1, 30); // GOP 크기 축소 (1초)
    const keyintMin = Math.floor(targetFps / 2); // 키프레임 간격 단축
    
    console.log(`🎯 [${streamKey}] 최적화 설정: ${targetFps}fps, preset=${preset}, 활성스트림=${activeStreamCount}`);
    
    const ffmpegArgs = H264_PASSTHROUGH
      ? [
          '-re',
          '-i', filePath,
          '-an', // 오디오 제거
          '-c:v', 'copy', // 재인코딩 없이 복사
          '-bsf:v', 'h264_mp4toannexb', // H.264 Annex B 변환
          '-f', 'rtp',
          '-ssrc', ssrc.toString(),
          `rtp://127.0.0.1:${producerTransport.tuple.localPort}`
        ]
      : [
          '-re', // 실시간 재생 속도
          '-i', filePath,
          '-c:v', 'libx264',
          '-preset', preset, // 🆕 동적 preset 설정
          '-tune', 'zerolatency',
          '-profile:v', 'baseline',
          '-level', '3.0',
          '-pix_fmt', 'yuv420p',
          '-r', targetFps.toString(), // 동적 프레임레이트 설정
          '-g', gopSize.toString(), // 🆕 축소된 GOP 크기
          '-keyint_min', keyintMin.toString(), // 🆕 단축된 키프레임 간격
          '-sc_threshold', '0', // 씬 체인지 감지 비활성화
          '-b:v', bitrate, // 🆕 동적 비트레이트
          '-maxrate', maxrate, // 🆕 동적 최대 비트레이트
          '-bufsize', bufsize, // 🆕 동적 버퍼 크기
          '-threads', '2', // 🆕 스레드 수 제한 (CPU 과부하 방지)
          '-x264opts', 'sliced-threads:rc-lookahead=10:me=dia:subme=1', // 🆕 x264 최적화
          '-avoid_negative_ts', 'make_zero', // 타임스탬프 정규화
          '-fflags', '+genpts', // PTS 재생성 강제
          '-f', 'rtp',
          '-ssrc', ssrc.toString(), // SSRC 명시적 설정
          `rtp://127.0.0.1:${producerTransport.tuple.localPort}`
        ];

    // console.log(`🚀 FFmpeg 시작: ${ffmpegArgs.join(' ')}`);
    
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stdout.on('data', (data) => {
      // console.log(`FFmpeg stdout: ${data}`);
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      // 🆕 프레임레이트와 성능 지표 추출 및 모니터링
      const frameMatch = output.match(/frame=\s*(\d+)/);
      const fpsMatch = output.match(/fps=\s*([\d.]+)/);
      const speedMatch = output.match(/speed=\s*([\d.]+)x/);
      const bitrateMatch = output.match(/bitrate=\s*([\d.]+)kbits\/s/);
      
      if (frameMatch && fpsMatch && speedMatch) {
        const frame = parseInt(frameMatch[1]);
        const fps = parseFloat(fpsMatch[1]);
        const speed = parseFloat(speedMatch[1]);
        const bitrate = bitrateMatch ? parseFloat(bitrateMatch[1]) : 0;
        
        // 🆕 적응형 성능 관리
        if (fps < 20 && speed < 0.7) {
          // console.error(`🔥 [${streamKey}] 심각한 성능 저하: ${fps}fps, ${speed}x - 긴급 최적화 필요`);
          
          // 심각한 성능 저하 시 자동 재시작 (향후 구현)
          // restartProducerWithLowerSettings(streamKey);
        } else if (fps < 25) {
          // console.warn(`⚠️ [${streamKey}] 낮은 FPS 감지: ${fps} (목표: 30)`);
        }
        
        if (speed < 0.8) {
          // console.warn(`⚠️ [${streamKey}] 느린 처리 속도: ${speed}x (목표: 1.0x)`);
        }
        
        // 5초마다 성능 요약 출력
        if (frame % 150 === 0) { // 30fps * 5초 = 150프레임
          // console.log(`📊 [${streamKey}] 성능 요약 - Frame: ${frame}, FPS: ${fps}, Speed: ${speed}x, Bitrate: ${bitrate}kbps`);
        }
      }
      
      // 전체 stderr 출력 (기존 로직 유지)
      // console.log(`FFmpeg stderr: ${output}`);
    });
    
    ffmpegProcess.on('close', (code) => {
      console.log(`FFmpeg 프로세스 종료: ${code}`);
    });

    // 4. Producer 정보 저장
    fileProducers.set(streamKey, {
      producer,
      transport: producerTransport,
      ffmpegProcess
    });

    // 🆕 추가: producers Map에도 저장하여 WebRTC 시그널링에서 찾을 수 있도록 함
    producers.set(producer.id, producer);

    // 5. 모든 구독자에게 Producer 생성 알림
    const streamState = streamStates.get(streamKey);
    if (streamState) {
      streamState.subscribers.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'fileProducerCreated',
            streamKey: streamKey,
            producerId: producer.id,
            transportId: producerTransport.id
          }));
        }
      });
    }

    // console.log(`✅ 파일 기반 Producer 생성 완료: ${streamKey} -> ${producer.id}`);
    
    // 🔍 Producer RTP 수신 모니터링
    const monitorInterval = setInterval(() => {
      if (producer.closed) {
        clearInterval(monitorInterval);
        return;
      }
      
      producer.getStats()
        .then(stats => {
          // console.log(`📊 Producer ${streamKey} 전체 Stats (${stats.length}개):`, 
          //   stats.map(stat => ({ type: stat.type })));
            
          const inboundStats = stats.filter(stat => stat.type === 'inbound-rtp');
          if (inboundStats.length > 0) {
            inboundStats.forEach(stat => {
              // console.log(`📊 Producer ${streamKey} RTP Stats:`, {
              //   packetsLost: (stat as any).packetsLost || 0,
              //   jitter: (stat as any).jitter || 0,
              //   timestamp: new Date().toISOString()
              // });
            });
          } else {
            console.log(`⚠️ Producer ${streamKey}: inbound-rtp stats가 없습니다`);
          }
        })
        .catch(err => {
          console.log(`⚠️ Producer ${streamKey} stats 조회 실패:`, (err as Error).message);
        });
    }, 5000); // 5초마다 확인
    
    return producer;

  } catch (error) {
    console.error(`❌ 파일 기반 Producer 생성 실패 (${streamKey}):`, error);
    throw error;
  }
}

// 파일 기반 Producer 정리 함수
function cleanupFileProducer(streamKey: string) {
  const fileProducer = fileProducers.get(streamKey);
  if (fileProducer) {
    console.log(`🧹 파일 기반 Producer 정리: ${streamKey} (활성: ${fileProducers.size - 1}/${MAX_CONCURRENT_STREAMS})`);
    
    // FFmpeg 프로세스 종료
    if (fileProducer.ffmpegProcess) {
      fileProducer.ffmpegProcess.kill();
    }
    
    // Producer 및 Transport 정리
    fileProducer.producer.close();
    fileProducer.transport.close();
    
    // 🆕 추가: producers Map에서도 제거
    producers.delete(fileProducer.producer.id);
    
    fileProducers.delete(streamKey);
    
    // 🆕 대기열에서 다음 스트림 처리
    setTimeout(() => processStreamQueue(), 1000); // 1초 후 대기열 처리
  }
}

// fMP4 변환 및 스트리밍 함수들
async function createInitSegment(filePath: string): Promise<Buffer> {
  // 간단한 fMP4 init segment 생성 (실제로는 mp4box를 사용해야 함)
  // 현재는 더미 데이터로 구현
  const fileBuffer = fs.readFileSync(filePath);
  return fileBuffer.slice(0, Math.min(1024, fileBuffer.length)); // 첫 1KB를 init segment로 사용
}

async function createMediaSegment(filePath: string, startTime: number, duration: number, totalDuration: number): Promise<Buffer> {
  // 실제 비디오 시간에 맞춰 fMP4 media segment 생성
  const fileBuffer = fs.readFileSync(filePath);
  
  // 전체 파일 길이를 기준으로 시간 비율 계산
  const timeRatio = startTime / totalDuration;
  const startByte = Math.floor(timeRatio * fileBuffer.length);
  const segmentSize = Math.floor((duration / totalDuration) * fileBuffer.length);
  const endByte = Math.min(startByte + segmentSize, fileBuffer.length);
  
  return fileBuffer.slice(startByte, endByte);
}

function startStreaming(streamKey: string) {
  const streamState = streamStates.get(streamKey);
  if (!streamState || streamState.isPlaying) return;

  const stream = catalog.streams.find(s => s.streamKey === streamKey);
  if (!stream) return;

  streamState.isPlaying = true;
  streamState.currentPosition = 0;
  streamState.segmentIndex = 0;

  // Init segment 전송
  if (!streamState.initSegment) {
    createInitSegment(stream.path).then(initSegment => {
      streamState.initSegment = initSegment;
      streamState.subscribers.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          // Init segment 헤더 전송
          const header = JSON.stringify({
            type: 'segment',
            streamKey,
            seq: 0,
            isInit: true,
            pts: 0
          });
          ws.send(header);
          // Init segment 데이터 전송
          ws.send(initSegment);
        }
      });
    });
  }

  // Media segments 주기적 전송
  const segmentDuration = 1.0; // 1초 세그먼트
  streamState.intervalId = setInterval(async () => {
    if (!streamState.isPlaying) return;

    try {
      const segment = await createMediaSegment(stream.path, streamState.currentPosition, segmentDuration, streamState.duration);
      
      streamState.subscribers.forEach(ws => {
        if (ws.readyState === ws.OPEN) {
          // Media segment 헤더 전송
          const header = JSON.stringify({
            type: 'segment',
            streamKey,
            seq: streamState.segmentIndex,
            isInit: false,
            pts: streamState.currentPosition * 1000 // ms 단위
          });
          ws.send(header);
          // Media segment 데이터 전송
          ws.send(segment);
        }
      });

      streamState.currentPosition += segmentDuration;
      streamState.segmentIndex++;

      // 스트림 종료 체크
      if (streamState.currentPosition >= streamState.duration) {
        if (streamState.isLooping) {
          // 루프 모드: 처음부터 다시 시작
          streamState.currentPosition = 0;
          streamState.segmentIndex = 0;
        } else {
          // 스트림 종료
          stopStreaming(streamKey);
          streamState.subscribers.forEach(ws => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({
                type: 'eos',
                streamKey
              }));
            }
          });
        }
      }
    } catch (error) {
      console.error(`Error streaming ${streamKey}:`, error);
      stopStreaming(streamKey);
    }
  }, segmentDuration * 1000);
}

function stopStreaming(streamKey: string) {
  const streamState = streamStates.get(streamKey);
  if (!streamState) return;

  streamState.isPlaying = false;
  if (streamState.intervalId) {
    clearInterval(streamState.intervalId);
    streamState.intervalId = undefined;
  }
}

function pauseStreaming(streamKey: string) {
  const streamState = streamStates.get(streamKey);
  if (streamState) {
    streamState.isPlaying = false;
    if (streamState.intervalId) {
      clearInterval(streamState.intervalId);
      streamState.intervalId = undefined;
    }
  }
}

function resumeStreaming(streamKey: string) {
  const streamState = streamStates.get(streamKey);
  if (streamState && streamState.subscribers.size > 0) {
    startStreaming(streamKey);
  }
}

async function start() {
  // mediasoup 초기화
  await initMediasoup();
  
  baseCatalog = await buildCatalog(MEDIA_DIR).catch((err) => {
    console.warn('Failed to build catalog:', err);
    return { streams: [] };
  });
  catalog = expandCatalog(
    baseCatalog,
    STREAM_COUNT && STREAM_COUNT > 0
      ? STREAM_COUNT
      : baseCatalog.streams.length,
  );

  const app = express();
  
  // CORS 설정 - localhost:5173에서의 요청 허용
  app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });
  app.get('/catalog', (req, res) => {
    const count = Number(req.query.count);
    if (!Number.isNaN(count) && count > 0) {
      catalog = expandCatalog(baseCatalog, count);
    }
    res.json(catalog);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // 🧪 서버 단독 스트레스: 구독자 없이 파일 기반 Producer 자동 기동
  if (AUTO_START_PRODUCERS_COUNT > 0) {
    const count = Math.min(AUTO_START_PRODUCERS_COUNT, catalog.streams.length);
    console.log(`🧪 AUTO_START_PRODUCERS_COUNT=${count} (H264_PASSTHROUGH=${H264_PASSTHROUGH ? 'on' : 'off'})`);
    // 순차적으로 시작하여 포트/CPU 스파이크 방지
    (async () => {
      for (let i = 0; i < count; i++) {
        const s = catalog.streams[i];
        try {
          await createFileProducer(s.streamKey, s.path);
        } catch (err) {
          console.error(`AUTO_START 실패: ${s.streamKey}`, err);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
  }

  wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    ws.on('message', (data, isBinary) => {
      console.log('📡 WebSocket 원시 메시지 수신:', {
        isBinary,
        dataLength: Buffer.isBuffer(data) ? data.length : data.toString().length,
        timestamp: new Date().toISOString()
      });
      
      if (isBinary) return; // text only
      
      try {
        const msgText = data.toString();
        // console.log('📋 메시지 파싱 시도:', msgText.substring(0, 200) + (msgText.length > 200 ? '...' : ''));
        
        const msg = JSON.parse(msgText);
        handleMessage(ws, msg);
      } catch (err) {
        console.error('❌ 메시지 파싱 실패:', err.message);
        ws.send(JSON.stringify({ type: 'error', code: 'E_BAD_MESSAGE' }));
      }
    });
    
    ws.on('close', () => {
      console.log('WebSocket connection closed');
      // 연결이 끊어지면 모든 구독 해제
      const session = getSession(ws);
      session.subscriptions.forEach(streamKey => {
        const streamState = streamStates.get(streamKey);
        if (streamState) {
          streamState.subscribers.delete(ws);
          if (streamState.subscribers.size === 0) {
            stopStreaming(streamKey);
            // 🆕 파일 기반 Producer도 정리
            cleanupFileProducer(streamKey);
          }
        }
      });
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  server.listen(PORT, () => {
    console.log(`Demo SFU server listening on http://localhost:${PORT}`);
    // 🆕 서버 시작 시 내부 상태 초기화
    initializeServerState();
  });
}

type WS = import('ws').WebSocket;

type ClientSession = {
  subscriptions: Set<string>;
};

const sessions = new WeakMap<WS, ClientSession>();

function getSession(ws: WS): ClientSession {
  let s = sessions.get(ws);
  if (!s) {
    s = { subscriptions: new Set() };
    sessions.set(ws, s);
  }
  return s;
}

// WebRTC 시그널링 처리
async function handleWebRTCSignaling(ws: WS, msg: any) {
  // console.log('🚀 handleWebRTCSignaling 함수 시작:', msg.type);
  
  try {
    // console.log('🔄 switch 문 진입:', msg.type);
    switch (msg.type) {
      case 'getRouterRtpCapabilities': {
        // console.log('📡 getRouterRtpCapabilities 케이스 처리 시작');
        
        const rtpCapabilities = mediasoupRouter.rtpCapabilities;
        // console.log('📋 RTP Capabilities 생성 완료:', !!rtpCapabilities);
        
        const response = {
          type: 'routerRtpCapabilities',
          rtpCapabilities
        };
        
        ws.send(JSON.stringify(response));
        // console.log('✅ routerRtpCapabilities 응답 전송 완료');
        break;
      }
      case 'createWebRtcTransport': {
        const transport = await mediasoupRouter.createWebRtcTransport({
          ...mediasoupConfig.webRtcTransport,
          appData: { clientId: msg.clientId }
        });
        
        // Transport 저장
        transports.set(transport.id, transport);
        
        ws.send(JSON.stringify({
          type: 'webRtcTransportCreated',
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        }));
        break;
      }
      case 'connectTransport': {
        const transport = transports.get(msg.transportId);
        if (transport) {
          await transport.connect({ dtlsParameters: msg.dtlsParameters });
          ws.send(JSON.stringify({
            type: 'transportConnected',
            transportId: msg.transportId
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'E_TRANSPORT_NOT_FOUND',
            message: `Transport ${msg.transportId} not found`
          }));
        }
        break;
      }
      case 'produce': {
        const transport = transports.get(msg.transportId);
        if (transport) {
          const producer = await transport.produce({
            kind: msg.kind,
            rtpParameters: msg.rtpParameters,
            appData: { streamKey: msg.streamKey }
          });
          
          // Producer 저장
          producers.set(producer.id, producer);
          
          ws.send(JSON.stringify({
            type: 'producerCreated',
            id: producer.id,
            streamKey: msg.streamKey
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'E_TRANSPORT_NOT_FOUND',
            message: `Transport ${msg.transportId} not found`
          }));
        }
        break;
      }
      case 'consume': {
        const transport = transports.get(msg.transportId);
        if (transport) {
          const producer = producers.get(msg.producerId);
          if (producer) {
            const consumer = await transport.consume({
              producerId: msg.producerId,
              rtpCapabilities: msg.rtpCapabilities,
              paused: true
            });
            
            // 🚀 Consumer 즉시 resume하여 미디어 전송 시작
            await consumer.resume();
            // console.log(`✅ Consumer ${consumer.id} resumed for producer ${msg.producerId}`);
            
            // Consumer 저장
            consumers.set(consumer.id, consumer);
            
            ws.send(JSON.stringify({
              type: 'consumerCreated',
              id: consumer.id,
              producerId: msg.producerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'E_PRODUCER_NOT_FOUND',
              message: `Producer ${msg.producerId} not found`
            }));
          }
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            code: 'E_TRANSPORT_NOT_FOUND',
            message: `Transport ${msg.transportId} not found`
          }));
        }
        break;
      }
    }
  } catch (error) {
    console.error('❌ WebRTC 시그널링 에러:', {
      messageType: msg.type,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    ws.send(JSON.stringify({
      type: 'error',
      code: 'E_WEBRTC_ERROR',
      message: error.message
    }));
  }
}

function handleMessage(ws: WS, msg: any) {
  // 🆕 디버깅 로그 추가
  // console.log('📨 WebSocket 메시지 수신:', {
  //   type: msg.type,
  //   message: JSON.stringify(msg),
  //   timestamp: new Date().toISOString()
  // });
  
  const session = getSession(ws);
  
  // WebRTC 시그널링 메시지 처리 - 정확한 메시지 타입 매칭
  if (msg.type === 'getRouterRtpCapabilities' || 
      msg.type === 'createWebRtcTransport' || 
      msg.type === 'connectTransport' || 
      msg.type === 'produce' || 
      msg.type === 'consume') {
    // console.log('🎯 WebRTC 시그널링 메시지 처리 중:', msg.type);
    handleWebRTCSignaling(ws, msg);
    return;
  }
  
  switch (msg.type) {
    case 'subscribe': {
      const stream = catalog.streams.find((s) => s.streamKey === msg.streamKey);
      if (!stream) {
        ws.send(
          JSON.stringify({ type: 'error', code: 'E_STREAM_NOT_FOUND' })
        );
        return;
      }
      if (session.subscriptions.has(msg.streamKey)) {
        ws.send(
          JSON.stringify({ type: 'error', code: 'E_ALREADY_SUBSCRIBED' })
        );
        return;
      }
      
      // 구독자 추가
      session.subscriptions.add(msg.streamKey);
      
      // 스트림 상태 초기화 또는 구독자 추가
      let streamState = streamStates.get(msg.streamKey);
      if (!streamState) {
        streamState = {
          streamKey: msg.streamKey,
          isPlaying: false,
          isLooping: false,
          currentPosition: 0,
          duration: stream.durationSec,
          subscribers: new Set(),
          segmentIndex: 0,
          producer: undefined,
          consumers: new Map()
        };
        streamStates.set(msg.streamKey, streamState);
      }
      
      if (streamState) {
        streamState.subscribers.add(ws);
      }
      
      // 구독 승인 응답
      ws.send(
        JSON.stringify({
          type: 'subscribed',
          streamKey: msg.streamKey,
        })
      );
      
      // 스트리밍 시작 (기존 WebSocket + MSE 방식)
      startStreaming(msg.streamKey);
      
      // 🆕 파일 기반 Producer 생성 (mediasoup + WebRTC 방식) - 재시도 로직 포함
      const streamInfo = catalog.streams.find(s => s.streamKey === msg.streamKey);
      if (streamInfo) {
        // 재시도 로직을 포함한 Producer 생성
        const createProducerWithRetry = async (retryCount = 0): Promise<void> => {
          try {
            await createFileProducer(msg.streamKey, streamInfo.path);
        } catch (err) {
          const error = err as Error;
          
          // 🆕 대기열 처리
          if (error.message.includes('최대 동시 스트림 수 초과')) {
            console.log(`⏳ [${msg.streamKey}] 대기열에 추가됨. 현재 활성 스트림: ${fileProducers.size}/${MAX_CONCURRENT_STREAMS}`);
            
            ws.send(JSON.stringify({
              type: 'streamQueued',
              streamKey: msg.streamKey,
              message: '다른 스트림 처리 완료 후 자동으로 시작됩니다',
              position: streamQueue.size,
              activeStreams: fileProducers.size
            }));
            
            return; // 대기열 처리이므로 재시도 없이 종료
          }
          
          console.error(`파일 기반 Producer 생성 실패 (시도 ${retryCount + 1}/3): ${msg.streamKey}`, {
            error: error.message,
            stack: error.stack,
            streamKey: msg.streamKey,
            filePath: streamInfo.path
          });
          
          // 3번까지 재시도 (포트 문제 등)
          if (retryCount < 2 && error.message.includes('no more available ports')) {
            console.log(`🔄 포트 부족으로 인한 재시도: ${msg.streamKey} (${retryCount + 1}/3)`);
            // 1초 후 재시도
            setTimeout(() => createProducerWithRetry(retryCount + 1), 1000);
          } else {
            // 최종 실패
            ws.send(JSON.stringify({
              type: 'error',
              code: 'E_FILE_PRODUCER_CREATION_FAILED',
              message: error.message,
              retryCount: retryCount + 1
            }));
          }
        }
        };
        
        createProducerWithRetry();
      }
      break;
    }
    case 'unsubscribe': {
      session.subscriptions.delete(msg.streamKey);
      
      // 구독자 제거
      const streamState = streamStates.get(msg.streamKey);
      if (streamState) {
        streamState.subscribers.delete(ws);
        
        // 구독자가 없으면 스트리밍 중지
        if (streamState.subscribers.size === 0) {
          stopStreaming(msg.streamKey);
          // 🆕 파일 기반 Producer도 정리
          cleanupFileProducer(msg.streamKey);
        }
      }
      
      ws.send(
        JSON.stringify({ type: 'unsubscribed', streamKey: msg.streamKey })
      );
      break;
    }
    case 'control': {
      const streamState = streamStates.get(msg.streamKey);
      if (!streamState) {
        ws.send(JSON.stringify({ type: 'error', code: 'E_STREAM_NOT_FOUND' }));
        return;
      }
      
      switch (msg.action) {
        case 'pause':
          pauseStreaming(msg.streamKey);
          break;
        case 'resume':
          resumeStreaming(msg.streamKey);
          break;
        case 'loopOn':
          streamState.isLooping = true;
          break;
        case 'loopOff':
          streamState.isLooping = false;
          break;
        case 'seek':
          if (typeof msg.position === 'number') {
            streamState.currentPosition = Math.max(0, Math.min(msg.position, streamState.duration));
          }
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', code: 'E_UNKNOWN_ACTION' }));
          return;
      }
      
      ws.send(JSON.stringify({
        type: 'control_ack',
        streamKey: msg.streamKey,
        action: msg.action
      }));
      break;
    }
    case 'status': {
      ws.send(
        JSON.stringify({
          type: 'status',
          streams: Array.from(session.subscriptions.values()),
        })
      );
      break;
    }

    // 🆕 setWebRTCMode 메시지 핸들러 추가
    case 'setWebRTCMode': {
      // console.log(`📡 ${msg.streamKey} WebRTC 모드 설정: ${msg.enabled ? '활성화' : '비활성화'}`);
      
      // 현재는 단순 응답만 (향후 확장 가능)
      ws.send(JSON.stringify({
        type: 'webRTCModeSet',
        streamKey: msg.streamKey,
        enabled: msg.enabled,
        status: 'success'
      }));
      
      // 만약 WebRTC 모드가 활성화되면서 해당 스트림의 Producer가 이미 생성되어 있다면 알림
      const existingProducer = Array.from(fileProducers.entries()).find(([key, _]) => key === msg.streamKey);
      if (msg.enabled && existingProducer) {
        const [streamKey, fileProducer] = existingProducer;
        ws.send(JSON.stringify({
          type: 'fileProducerCreated',
          streamKey: streamKey,
          producerId: fileProducer.producer.id, 
          transportId: fileProducer.transport.id
        }));
      }
      
      break;
    }
    default:
      ws.send(JSON.stringify({ type: 'error', code: 'E_UNKNOWN_TYPE' }));
  }
}

start();
