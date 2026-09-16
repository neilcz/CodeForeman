import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ClientMessage, HealthStatus } from '@codeforeman/shared';
import { config } from './config.js';
import { detectClaude } from './claude/detect.js';
import { sessionManager } from './sessions/manager.js';
import * as projects from './projects/index.js';
import * as git from './git/index.js';

const claudeVersion = await detectClaude();
const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

// ---------- 健康检查 ----------

app.get('/api/health', async (): Promise<HealthStatus> => ({
  status: 'ok',
  version: config.version,
  claudeAvailable: claudeVersion !== null,
  endpoint: config.endpoint,
}));

// ---------- 项目 ----------

app.get('/api/projects', async () => projects.listProjects());

app.post('/api/projects', async (req, reply) => {
  const body = (req.body ?? {}) as { name?: string; gitUrl?: string; existingPath?: string };
  if (!body.name?.trim()) return reply.code(400).send({ error: 'name 必填' });
  try {
    return await projects.createProject({ name: body.name.trim(), gitUrl: body.gitUrl, existingPath: body.existingPath });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.delete('/api/projects/:id', async (req) => {
  const { id } = req.params as { id: string };
  const { deleteFiles } = req.query as { deleteFiles?: string };
  projects.deleteProject(id, deleteFiles === 'true');
  return { ok: true };
});

// ---------- 项目文件 ----------

function projectPathOr404(id: string): string {
  const project = projects.getProject(id);
  if (!project) throw new Error('project not found');
  return project.path;
}

app.get('/api/projects/:id/tree', async (req) => {
  return projects.fileTree(projectPathOr404((req.params as { id: string }).id));
});

app.get('/api/projects/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { path: rel } = req.query as { path: string };
  try {
    return { content: projects.readFile(projectPathOr404(id), rel) };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.put('/api/projects/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { path: string; content: string };
  try {
    projects.writeFile(projectPathOr404(id), body.path, body.content);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------- 项目 git 状态 ----------

app.get('/api/projects/:id/git', async (req) => {
  const root = projectPathOr404((req.params as { id: string }).id);
  if (!(await git.isRepo(root))) return { isRepo: false };
  return {
    isRepo: true,
    branch: await git.currentBranch(root),
    defaultBranch: await git.defaultBranch(root),
    branches: await git.branches(root),
    changes: await git.status(root),
  };
});

// ---------- 会话 ----------

app.get('/api/sessions', async () => sessionManager.list());

app.post('/api/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { title?: string; projectId?: string };
  let cwd: string | undefined;
  if (body.projectId) {
    const project = projects.getProject(body.projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    cwd = project.path;
  }
  if (!cwd) return reply.code(400).send({ error: 'projectId 必填' });
  return sessionManager.create(cwd, body.title ?? '', body.projectId ?? null);
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
        sessionManager.respondPermission(msg.sessionId, msg.requestId, msg.allow);
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
