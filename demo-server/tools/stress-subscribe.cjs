// Simple stress tool: subscribes to many streams to spin up file-based Producers
// Usage:
//   PORT=8080 COUNT=20 node server/tools/stress-subscribe.cjs
//   or: node server/tools/stress-subscribe.cjs 20

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8080);
const COUNT = Number(process.env.COUNT || process.argv[2] || 10);

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

(async () => {
  console.log(`Stress subscribe: COUNT=${COUNT}, PORT=${PORT}`);
  const catalog = await fetchCatalog(COUNT);
  const streamKeys = catalog.streams.map((s) => s.streamKey);
  console.log(`Loaded ${streamKeys.length} stream keys`);

  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);

  ws.on('open', async () => {
    console.log('WebSocket connected; subscribing to streams...');
    // Subscribe sequentially with a tiny delay to avoid burst
    for (const [i, key] of streamKeys.entries()) {
      ws.send(JSON.stringify({ type: 'subscribe', streamKey: key }));
      if ((i + 1) % 10 === 0) console.log(`Subscribed ${i + 1}/${streamKeys.length}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'fileProducerCreated') {
        console.log(`🎬 producer ready: ${msg.streamKey}`);
      } else if (msg.type === 'streamQueued') {
        console.log(`⏳ queued: ${msg.streamKey} (pos=${msg.position}, active=${msg.activeStreams})`);
      } else if (msg.type === 'error') {
        console.error(`❌ error: ${msg.code} ${msg.message || ''}`);
      }
    } catch (_) {
      // ignore binary segments
    }
  });

  ws.on('close', () => console.log('WebSocket closed'));
  ws.on('error', (err) => console.error('WebSocket error', err));
})();

