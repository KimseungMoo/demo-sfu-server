import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { buildCatalog, expandCatalog } from './catalog.js';
import { Catalog } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const MEDIA_DIR = process.env.MEDIA_DIR || path.resolve(process.cwd(), 'media');
const STREAM_COUNT = Number(process.env.STREAM_COUNT);

let baseCatalog: Catalog = { streams: [] };
let catalog: Catalog = { streams: [] };

async function start() {
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

  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // text only
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', code: 'E_BAD_MESSAGE' }));
      }
    });
  });

  server.listen(PORT, () => {
    console.log(`Demo SFU server listening on http://localhost:${PORT}`);
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

function handleMessage(ws: WS, msg: any) {
  const session = getSession(ws);
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
      session.subscriptions.add(msg.streamKey);
      ws.send(
        JSON.stringify({
          type: 'subscribed',
          streamKey: msg.streamKey,
        })
      );
      // TODO: implement media segment streaming
      break;
    }
    case 'unsubscribe': {
      session.subscriptions.delete(msg.streamKey);
      ws.send(
        JSON.stringify({ type: 'unsubscribed', streamKey: msg.streamKey })
      );
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
    default:
      ws.send(JSON.stringify({ type: 'error', code: 'E_UNKNOWN_TYPE' }));
  }
}

start();
