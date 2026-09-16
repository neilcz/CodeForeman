import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ClientMessage, HealthStatus } from '@codeforeman/shared';
import { config, projectsDir } from './config.js';
import { detectClaude } from './claude/detect.js';
import { sessionManager } from './sessions/manager.js';

const claudeVersion = await detectClaude();
const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

// P1 阶段还没有项目管理（P2），先用一个默认工作区承载所有会话
const defaultWorkspace = path.join(projectsDir, 'default');
fs.mkdirSync(defaultWorkspace, { recursive: true });
if (!fs.existsSync(path.join(defaultWorkspace, '.git'))) {
  execFileSync('git', ['init'], { cwd: defaultWorkspace });
}

// ---------- API ----------

app.get('/api/health', async (): Promise<HealthStatus> => ({
  status: 'ok',
  version: config.version,
  claudeAvailable: claudeVersion !== null,
  endpoint: config.endpoint,
}));

app.get('/api/sessions', async () => sessionManager.list());

app.post('/api/sessions', async (req) => {
  const body = (req.body ?? {}) as { title?: string; cwd?: string };
  const session = sessionManager.create(body.cwd ?? defaultWorkspace, body.title ?? '');
  return session;
});

app.get('/api/sessions/:id/messages', async (req) => {
  const { id } = req.params as { id: string };
  const { after } = req.query as { after?: string };
  return sessionManager.history(id, after ? Number(after) : 0);
});

// ---------- WebSocket ----------

app.get('/ws', { websocket: true }, (socket: WebSocket) => {
  const send = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  send({ type: 'server.hello', version: config.version, sessions: sessionManager.list() });

  // sessionId -> listener，断开时统一退订
  const subscriptions = new Map<string, (msg: unknown) => void>();

  socket.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'session.subscribe': {
        if (subscriptions.has(msg.sessionId)) return;
        const listener = (m: unknown) => send(m);
        subscriptions.set(msg.sessionId, listener);
        sessionManager.subscribe(msg.sessionId, listener as never);
        break;
      }
      case 'session.unsubscribe': {
        const listener = subscriptions.get(msg.sessionId);
        if (listener) {
          sessionManager.unsubscribe(msg.sessionId, listener as never);
          subscriptions.delete(msg.sessionId);
        }
        break;
      }
      case 'chat.send':
        try {
          sessionManager.send(msg.sessionId, msg.text);
        } catch (err) {
          send({ type: 'chat.error', sessionId: msg.sessionId, error: (err as Error).message });
        }
        break;
      case 'permission.respond':
        sessionManager.respondPermission(msg.sessionId ?? '', msg.requestId, msg.allow);
        break;
    }
  });

  socket.on('close', () => {
    for (const [sessionId, listener] of subscriptions) {
      sessionManager.unsubscribe(sessionId, listener as never);
    }
    subscriptions.clear();
  });
});

// ---------- 静态资源 + SPA 兜底 ----------

const webDist = path.resolve(config.webDist);
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`web dist not found at ${webDist}, static serving disabled`);
}

await app.listen({ port: config.port, host: config.host });
app.log.info(`CodeForeman ready | claude: ${claudeVersion ?? 'NOT FOUND'} | endpoint: ${config.endpoint ?? 'official'}`);
