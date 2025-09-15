// CPU 사용량 비교 테스트 도구
// Usage: node tools/cpu-test.cjs [스트림개수]

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8080);
const STREAM_COUNT = Number(process.argv[2] || 4);

console.log(`🧪 CPU 테스트 시작: ${STREAM_COUNT}개 스트림`);

// CPU 사용량 모니터링 함수
function getCpuUsage() {
  return new Promise((resolve) => {
    const top = spawn('top', ['-l', '1', '-n', '0']);
    let output = '';
    
    top.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    top.on('close', () => {
      const cpuMatch = output.match(/CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/);
      if (cpuMatch) {
        const user = parseFloat(cpuMatch[1]);
        const sys = parseFloat(cpuMatch[2]);
        const idle = parseFloat(cpuMatch[3]);
        resolve({ user, sys, idle, total: user + sys });
      } else {
        resolve({ user: 0, sys: 0, idle: 100, total: 0 });
      }
    });
  });
}

// 스트림 상태 확인 함수
function getStreamStatus() {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: 'localhost',
      port: PORT,
      path: '/stream-limit',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

// 카탈로그 가져오기 함수
function fetchCatalog(count) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: 'localhost',
      port: PORT,
      path: `/catalog?count=${count}`,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

async function runTest() {
  try {
    // 1. 초기 CPU 사용량 측정
    console.log('📊 초기 CPU 사용량 측정...');
    const initialCpu = await getCpuUsage();
    console.log(`초기 CPU: ${initialCpu.total.toFixed(1)}% (user: ${initialCpu.user.toFixed(1)}%, sys: ${initialCpu.sys.toFixed(1)}%)`);
    
    // 2. 카탈로그 가져오기
    const catalog = await fetchCatalog(STREAM_COUNT);
    const streamKeys = catalog.streams.map(s => s.streamKey);
    console.log(`📋 테스트할 스트림: ${streamKeys.join(', ')}`);
    
    // 3. WebSocket 연결 및 스트림 구독
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    let subscribedCount = 0;
    let producersReady = 0;
    
    ws.on('open', async () => {
      console.log('🔗 WebSocket 연결됨, 스트림 구독 시작...');
      
      // 스트림 구독
      for (const streamKey of streamKeys) {
        ws.send(JSON.stringify({ type: 'subscribe', streamKey }));
        subscribedCount++;
        console.log(`📡 구독: ${streamKey} (${subscribedCount}/${streamKeys.length})`);
        await new Promise(r => setTimeout(r, 100)); // 100ms 간격
      }
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'fileProducerCreated') {
          producersReady++;
          console.log(`🎬 Producer 준비: ${msg.streamKey} (${producersReady}/${streamKeys.length})`);
          
          // 모든 Producer가 준비되면 CPU 측정 시작
          if (producersReady === streamKeys.length) {
            setTimeout(async () => {
              console.log('⏱️ 5초 후 CPU 사용량 측정...');
              await new Promise(r => setTimeout(r, 5000));
              
              const finalCpu = await getCpuUsage();
              const streamStatus = await getStreamStatus();
              
              console.log('\n📈 테스트 결과:');
              console.log(`스트림 개수: ${STREAM_COUNT}`);
              console.log(`활성 스트림: ${streamStatus.activeStreams}`);
              console.log(`최대 동시 스트림: ${streamStatus.maxConcurrentStreams}`);
              console.log(`초기 CPU: ${initialCpu.total.toFixed(1)}%`);
              console.log(`최종 CPU: ${finalCpu.total.toFixed(1)}%`);
              console.log(`CPU 증가량: ${(finalCpu.total - initialCpu.total).toFixed(1)}%`);
              console.log(`CPU 사용률: User ${finalCpu.user.toFixed(1)}%, Sys ${finalCpu.sys.toFixed(1)}%`);
              
              // 연결 종료
              ws.close();
              process.exit(0);
            }, 1000);
          }
        } else if (msg.type === 'streamQueued') {
          console.log(`⏳ 대기열: ${msg.streamKey} (위치: ${msg.position})`);
        } else if (msg.type === 'error') {
          console.error(`❌ 오류: ${msg.code} ${msg.message || ''}`);
        }
      } catch (_) {
        // 바이너리 데이터 무시
      }
    });
    
    ws.on('close', () => {
      console.log('🔌 WebSocket 연결 종료');
    });
    
    ws.on('error', (err) => {
      console.error('❌ WebSocket 오류:', err);
      process.exit(1);
    });
    
  } catch (error) {
    console.error('❌ 테스트 실패:', error);
    process.exit(1);
  }
}

runTest();
