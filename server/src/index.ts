import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { buildCatalog } from './catalog.js';
import { Catalog } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);
const MEDIA_DIR = process.env.MEDIA_DIR || path.resolve(process.cwd(), 'media');

let catalog: Catalog = { streams: [] };

async function start() {
  catalog = await buildCatalog(MEDIA_DIR).catch((err) => {
    console.warn('Failed to build catalog:', err);
    return { streams: [] };
  });

  const app = express();
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });
  app.get('/catalog', (_req, res) => {
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
          profile: msg.profile,
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
    case 'switch': {
      // Profile switch is acknowledged only
      ws.send(
        JSON.stringify({
          type: 'switched',
          streamKey: msg.streamKey,
          profile: msg.profile,
        })
      );
      break;
    }
    default:
      ws.send(JSON.stringify({ type: 'error', code: 'E_UNKNOWN_TYPE' }));
  }
}

start();
