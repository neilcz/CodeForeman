import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { envelope, type HealthStatus, type ServerHello } from '@codeforeman/shared';
import { config } from './config.js';
import { detectClaude } from './claude/detect.js';

const startedAt = Date.now();
const claudeVersion = await detectClaude();

const app = Fastify({ logger: true });

await app.register(fastifyWebsocket);

// ---------- API ----------

app.get('/api/health', async (): Promise<HealthStatus> => ({
  status: 'ok',
  version: config.version,
  claudeAvailable: claudeVersion !== null,
}));

// ---------- WebSocket（P0：握手 + ping/pong，验证中继链路） ----------

app.get('/ws', { websocket: true }, (socket) => {
  const hello: ServerHello = {
    version: config.version,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  };
  socket.send(JSON.stringify(envelope('server.hello', hello)));

  socket.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'client.ping') {
        socket.send(JSON.stringify(envelope('server.pong', msg.payload)));
      }
    } catch {
      // 忽略无法解析的消息
    }
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
app.log.info(`CodeForeman server ready, claude CLI: ${claudeVersion ?? 'NOT FOUND'}`);
