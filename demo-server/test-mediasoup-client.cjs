// mediasoup WebRTC 클라이언트 테스트 스크립트
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8080/ws');

// Transport ID 저장
let transportId = null;
let producerId = null;

ws.on('open', function open() {
  console.log('✅ WebSocket 연결됨');
  
  // 1. Router RTP Capabilities 요청
  console.log('📡 Router RTP Capabilities 요청...');
  ws.send(JSON.stringify({
    type: 'getRouterRtpCapabilities'
  }));
  
  // 2. WebRTC Transport 생성 요청
  setTimeout(() => {
    console.log('🚀 WebRTC Transport 생성 요청...');
    ws.send(JSON.stringify({
      type: 'createWebRtcTransport',
      clientId: 'test-client-001'
    }));
  }, 1000);
  
  // 3. Transport 연결 시뮬레이션
  setTimeout(() => {
    if (transportId) {
      console.log('🔗 Transport 연결 시뮬레이션...');
      ws.send(JSON.stringify({
        type: 'connectTransport',
        transportId: transportId,
        dtlsParameters: {
          role: 'auto',
          fingerprints: [
            {
              algorithm: 'sha-256',
              value: 'test-fingerprint'
            }
          ]
        }
      }));
    }
  }, 2000);
  
  // 4. Producer 생성 시뮬레이션
  setTimeout(() => {
    if (transportId) {
      console.log('📹 Producer 생성 시뮬레이션...');
      ws.send(JSON.stringify({
        type: 'produce',
        transportId: transportId,
        kind: 'video',
        streamKey: 'WELD-A1',
        rtpParameters: {
          codecs: [
            {
              mimeType: 'video/H264',
              payloadType: 96,
              clockRate: 90000,
              parameters: {
                'packetization-mode': 1,
                'profile-level-id': '42e01f'
              }
            }
          ],
          headerExtensions: [],
          encodings: [
            {
              ssrc: 1234567890,
              rtx: { ssrc: 1234567891 }
            }
          ],
          rtcp: {
            cname: 'test-cname'
          }
        }
      }));
    }
  }, 3000);
  
  // 5. Consumer 생성 시뮬레이션
  setTimeout(() => {
    if (transportId && producerId) {
      console.log('👁️ Consumer 생성 시뮬레이션...');
      ws.send(JSON.stringify({
        type: 'consume',
        transportId: transportId,
        producerId: producerId,
        rtpCapabilities: {
          codecs: [
            {
              kind: 'video',
              mimeType: 'video/H264',
              clockRate: 90000,
              parameters: {
                'packetization-mode': 1,
                'profile-level-id': '42e01f'
              }
            }
          ],
          headerExtensions: []
        }
      }));
    }
  }, 4000);
  
  // 6. 기존 WebSocket 스트리밍 테스트
  setTimeout(() => {
    console.log('📺 기존 WebSocket 스트리밍 테스트...');
    ws.send(JSON.stringify({
      type: 'subscribe',
      streamKey: 'WELD-A1'
    }));
  }, 5000);
  
  // 7. 상태 조회
  setTimeout(() => {
    console.log('📊 상태 조회...');
    ws.send(JSON.stringify({
      type: 'status'
    }));
  }, 8000);
  
  // 8. 연결 종료
  setTimeout(() => {
    console.log('🔌 연결 종료');
    ws.close();
  }, 10000);
});

ws.on('message', function message(data) {
  try {
    const msg = JSON.parse(data.toString());
    
    switch (msg.type) {
      case 'routerRtpCapabilities':
        console.log(`✅ Router RTP Capabilities 수신: ${Object.keys(msg.rtpCapabilities).length}개 항목`);
        break;
      case 'webRtcTransportCreated':
        transportId = msg.id;
        console.log(`✅ WebRTC Transport 생성됨: ${msg.id}`);
        console.log(`   ICE Parameters: ${Object.keys(msg.iceParameters).length}개`);
        console.log(`   ICE Candidates: ${msg.iceCandidates.length}개`);
        break;
      case 'transportConnected':
        console.log(`✅ Transport 연결됨: ${msg.transportId}`);
        break;
      case 'producerCreated':
        producerId = msg.id;
        console.log(`✅ Producer 생성됨: ${msg.id} (${msg.streamKey})`);
        break;
      case 'fileProducerCreated':
        console.log(`🎬 파일 기반 Producer 생성됨: ${msg.producerId} (${msg.streamKey})`);
        console.log(`   Transport ID: ${msg.transportId}`);
        break;
      case 'consumerCreated':
        console.log(`✅ Consumer 생성됨: ${msg.id} (Producer: ${msg.producerId})`);
        console.log(`   Kind: ${msg.kind}, RTP Parameters: ${Object.keys(msg.rtpParameters).length}개`);
        break;
      case 'subscribed':
        console.log(`✅ 구독됨: ${msg.streamKey}`);
        break;
      case 'segment':
        if (msg.isInit) {
          console.log(`🎬 Init segment 수신: ${msg.streamKey} (seq: ${msg.seq})`);
        } else {
          console.log(`📺 Media segment 수신: ${msg.streamKey} (seq: ${msg.seq}, pts: ${msg.pts}ms)`);
        }
        break;
      case 'status':
        console.log(`📊 현재 구독 스트림: ${msg.streams.join(', ')}`);
        break;
      case 'error':
        console.error(`❌ 에러: ${msg.code} - ${msg.message || 'Unknown error'}`);
        break;
      default:
        console.log(`📨 알 수 없는 메시지: ${msg.type}`);
    }
  } catch (error) {
    // 바이너리 데이터 (fMP4 세그먼트)
    console.log(`📦 바이너리 데이터 수신: ${data.length} bytes`);
  }
});

ws.on('close', function close() {
  console.log('🔌 WebSocket 연결 종료');
});

ws.on('error', function error(err) {
  console.error('❌ WebSocket 에러:', err);
});
