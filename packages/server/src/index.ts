import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { ClientMessage, HealthStatus } from '@codeforeman/shared';
import { config } from './config.js';
import { detectClaude } from './claude/detect.js';
import { sessionManager } from './sessions/manager.js';
import * as projects from './projects/index.js';
import * as tasks from './tasks/index.js';
import * as features from './features/index.js';
import * as git from './git/index.js';
import * as auth from './auth/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: auth.AuthUser;
  }
}

auth.seedAdmin();

const claudeVersion = await detectClaude();
const app = Fastify({ logger: true });
await app.register(fastifyWebsocket);

// ---------- 认证 ----------

const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login']);

function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return (req.query as { token?: string }).token;
}

app.addHook('preHandler', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  if (PUBLIC_PATHS.has(req.url.split('?')[0])) return;
  const user = auth.resolveToken(extractToken(req));
  if (!user) return reply.code(401).send({ error: '未登录或登录已过期' });
  req.user = user;
});

app.post('/api/auth/login', async (req, reply) => {
  const body = req.body as { username?: string; password?: string };
  if (!body.username || !body.password) return reply.code(400).send({ error: '用户名密码必填' });
  const token = auth.login(body.username, body.password);
  if (!token) return reply.code(401).send({ error: '用户名或密码错误' });
  return { token, user: auth.resolveToken(token) };
});

app.get('/api/auth/me', async (req) => req.user);

app.post('/api/auth/logout', async (req) => {
  const token = extractToken(req);
  if (token) auth.logout(token);
  return { ok: true };
});

// 用户管理（仅 admin）
app.get('/api/users', async (req, reply) => {
  if (req.user!.role !== 'admin') return reply.code(403).send({ error: '需要管理员权限' });
  return auth.listUsers();
});

app.post('/api/users', async (req, reply) => {
  if (req.user!.role !== 'admin') return reply.code(403).send({ error: '需要管理员权限' });
  const body = req.body as { username?: string; password?: string; role?: 'admin' | 'user' };
  if (!body.username || !body.password) return reply.code(400).send({ error: '用户名密码必填' });
  try {
    return auth.createUser(body.username, body.password, body.role ?? 'user');
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------- 健康检查 ----------

app.get('/api/health', async (): Promise<HealthStatus> => ({
  status: 'ok',
  version: config.version,
  claudeAvailable: claudeVersion !== null,
  endpoint: config.endpoint,
}));

// ---------- 项目 ----------

app.get('/api/projects', async (req) => projects.listProjects(req.user!));

app.post('/api/projects', async (req, reply) => {
  const body = (req.body ?? {}) as { name?: string; gitUrl?: string; existingPath?: string; visibility?: 'private' | 'public' };
  if (!body.name?.trim()) return reply.code(400).send({ error: 'name 必填' });
  try {
    return await projects.createProject({
      name: body.name.trim(),
      gitUrl: body.gitUrl,
      existingPath: body.existingPath,
      ownerId: req.user!.id,
      visibility: body.visibility ?? 'private',
    });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.delete('/api/projects/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const project = projects.getProject(id);
  if (!project) return reply.code(404).send({ error: 'project not found' });
  if (req.user!.role !== 'admin' && project.ownerId !== req.user!.id) {
    return reply.code(403).send({ error: '只有项目所有者或管理员可以删除' });
  }
  const { deleteFiles } = req.query as { deleteFiles?: string };
  projects.deleteProject(id, deleteFiles === 'true');
  return { ok: true };
});

// ---------- 项目文件（需项目访问权） ----------

function accessibleProjectPath(req: FastifyRequest, id: string): string | null {
  if (!projects.canAccess(req.user!, id)) return null;
  return projects.getProject(id)?.path ?? null;
}

app.get('/api/projects/:id/tree', async (req, reply) => {
  const root = accessibleProjectPath(req, (req.params as { id: string }).id);
  if (!root) return reply.code(403).send({ error: '无权访问该项目' });
  return projects.fileTree(root);
});

app.get('/api/projects/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  const root = accessibleProjectPath(req, id);
  if (!root) return reply.code(403).send({ error: '无权访问该项目' });
  const { path: rel } = req.query as { path: string };
  try {
    return { content: projects.readFile(root, rel) };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.put('/api/projects/:id/file', async (req, reply) => {
  const { id } = req.params as { id: string };
  const root = accessibleProjectPath(req, id);
  if (!root) return reply.code(403).send({ error: '无权访问该项目' });
  const body = req.body as { path: string; content: string };
  try {
    projects.writeFile(root, body.path, body.content);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------- 项目 git 状态 ----------

app.get('/api/projects/:id/git', async (req, reply) => {
  const root = accessibleProjectPath(req, (req.params as { id: string }).id);
  if (!root) return reply.code(403).send({ error: '无权访问该项目' });
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

app.get('/api/sessions', async (req) => sessionManager.list(req.user));

app.post('/api/sessions', async (req, reply) => {
  const body = (req.body ?? {}) as { title?: string; projectId?: string };
  if (!body.projectId) return reply.code(400).send({ error: 'projectId 必填' });
  if (!projects.canAccess(req.user!, body.projectId)) return reply.code(403).send({ error: '无权访问该项目' });
  const project = projects.getProject(body.projectId)!;
  return sessionManager.create(project.path, body.title ?? '', body.projectId);
});

app.get('/api/sessions/:id/messages', async (req, reply) => {
  const { id } = req.params as { id: string };
  const session = sessionManager.get(id);
  if (!session) return reply.code(404).send({ error: 'session not found' });
  if (session.projectId && !projects.canAccess(req.user!, session.projectId)) {
    return reply.code(403).send({ error: '无权访问该会话' });
  }
  const { after } = req.query as { after?: string };
  return sessionManager.history(id, after ? Number(after) : 0);
});

// ---------- 任务（Backlog） ----------

app.get('/api/tasks', async (req) => {
  const { projectId } = req.query as { projectId?: string };
  return tasks.listTasks(req.user!, projectId);
});

app.post('/api/tasks', async (req, reply) => {
  const body = req.body as { projectId?: string; title?: string; description?: string; source?: 'manual' | 'chat'; autoMerge?: boolean };
  if (!body.projectId || !body.title?.trim()) return reply.code(400).send({ error: 'projectId 和 title 必填' });
  if (!projects.canAccess(req.user!, body.projectId)) return reply.code(403).send({ error: '无权访问该项目' });
  try {
    return tasks.createTask({
      projectId: body.projectId,
      title: body.title.trim(),
      description: body.description,
      source: body.source,
      autoMerge: body.autoMerge,
    });
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.patch('/api/tasks/:id', async (req, reply) => {
  try {
    return tasks.updateTask((req.params as { id: string }).id, req.body as never);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.delete('/api/tasks/:id', async (req, reply) => {
  try {
    tasks.deleteTask((req.params as { id: string }).id);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/execute', async (req, reply) => {
  try {
    return await tasks.executeTask((req.params as { id: string }).id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/complete', async (req, reply) => {
  try {
    return await tasks.completeTask((req.params as { id: string }).id);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/tasks/:id/fail', async (req, reply) => {
  const body = (req.body ?? {}) as { reason?: string };
  try {
    return tasks.failTask((req.params as { id: string }).id, body.reason ?? '人工标记失败');
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------- 功能演进 ----------

app.get('/api/features', async (req, reply) => {
  const { projectId } = req.query as { projectId: string };
  if (!projectId) return [];
  if (!projects.canAccess(req.user!, projectId)) return reply.code(403).send({ error: '无权访问该项目' });
  return features.listFeatures(projectId);
});

app.post('/api/features', async (req, reply) => {
  const body = req.body as { projectId?: string; title?: string; summary?: string };
  if (!body.projectId || !body.title?.trim()) return reply.code(400).send({ error: 'projectId 和 title 必填' });
  if (!projects.canAccess(req.user!, body.projectId)) return reply.code(403).send({ error: '无权访问该项目' });
  try {
    return features.createFeature(body.projectId, body.title.trim(), body.summary ?? '');
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

app.post('/api/features/:id/link', async (req, reply) => {
  const body = req.body as { kind: 'session' | 'task'; refId: string };
  try {
    features.linkItem((req.params as { id: string }).id, body.kind, body.refId);
    return { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

// ---------- WebSocket ----------

/** 所有在线 socket，用于 task.updated 等全局广播 */
const allSockets = new Set<WebSocket>();

tasks.onTaskUpdate((task) => {
  const msg = JSON.stringify({ type: 'task.updated', task });
  for (const s of allSockets) {
    if (s.readyState === s.OPEN) s.send(msg);
  }
});

app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
  const user = auth.resolveToken((req.query as { token?: string }).token);
  if (!user) {
    socket.close(4401, 'unauthorized');
    return;
  }
  allSockets.add(socket);
  const send = (msg: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  send({ type: 'server.hello', version: config.version, sessions: sessionManager.list(user) });

  // sessionId -> listener，断开时统一退订
  const subscriptions = new Map<string, (msg: unknown) => void>();

  // 会话级 ACL：只能操作自己可见项目下的会话
  const sessionAllowed = (sessionId: string): boolean => {
    const s = sessionManager.get(sessionId);
    if (!s) return false;
    return !s.projectId || projects.canAccess(user, s.projectId);
  };

  socket.on('message', (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'session.subscribe': {
        if (subscriptions.has(msg.sessionId) || !sessionAllowed(msg.sessionId)) return;
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
        if (!sessionAllowed(msg.sessionId)) return;
        try {
          sessionManager.send(msg.sessionId, msg.text);
        } catch (err) {
          send({ type: 'chat.error', sessionId: msg.sessionId, error: (err as Error).message });
        }
        break;
      case 'permission.respond':
        if (!sessionAllowed(msg.sessionId)) return;
        sessionManager.respondPermission(msg.sessionId, msg.requestId, msg.allow);
        break;
    }
  });

  socket.on('close', () => {
    allSockets.delete(socket);
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
