// WebSocket 클라이언트 테스트 스크립트
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:8080/ws');

ws.on('open', function open() {
  console.log('✅ WebSocket 연결됨');
  
  // 스트림 구독 요청
  console.log('📡 WELD-A1 스트림 구독 요청...');
  ws.send(JSON.stringify({
    type: 'subscribe',
    streamKey: 'WELD-A1'
  }));
  
  // 5초 후 루프 모드 활성화
  setTimeout(() => {
    console.log('🔄 루프 모드 활성화...');
    ws.send(JSON.stringify({
      type: 'control',
      streamKey: 'WELD-A1',
      action: 'loopOn'
    }));
  }, 5000);
  
  // 10초 후 상태 조회
  setTimeout(() => {
    console.log('📊 상태 조회...');
    ws.send(JSON.stringify({
      type: 'status'
    }));
  }, 10000);
  
  // 15초 후 구독 해제
  setTimeout(() => {
    console.log('❌ 구독 해제...');
    ws.send(JSON.stringify({
      type: 'unsubscribe',
      streamKey: 'WELD-A1'
    }));
    
    // 2초 후 연결 종료
    setTimeout(() => {
      console.log('🔌 연결 종료');
      ws.close();
    }, 2000);
  }, 15000);
});

ws.on('message', function message(data) {
  try {
    const msg = JSON.parse(data.toString());
    
    switch (msg.type) {
      case 'subscribed':
        console.log(`✅ 구독됨: ${msg.streamKey}`);
        break;
      case 'unsubscribed':
        console.log(`❌ 구독 해제됨: ${msg.streamKey}`);
        break;
      case 'segment':
        if (msg.isInit) {
          console.log(`🎬 Init segment 수신: ${msg.streamKey} (seq: ${msg.seq})`);
        } else {
          console.log(`📺 Media segment 수신: ${msg.streamKey} (seq: ${msg.seq}, pts: ${msg.pts}ms)`);
        }
        break;
      case 'eos':
        console.log(`🏁 스트림 종료: ${msg.streamKey}`);
        break;
      case 'control_ack':
        console.log(`✅ 제어 명령 확인: ${msg.action} - ${msg.streamKey}`);
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
