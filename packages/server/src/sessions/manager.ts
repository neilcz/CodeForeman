import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { ClaudeSession } from '../claude/session.js';
import type { ServerMessage, SessionInfo } from '@codeforeman/shared';

type Listener = (msg: ServerMessage) => void;

interface SessionRow {
  id: string;
  title: string;
  cwd: string;
  project_id: string | null;
  project_name?: string | null;
  claude_session_id: string | null;
  status: SessionInfo['status'];
  created_at: number;
  updated_at: number;
}

function toInfo(row: SessionRow): SessionInfo {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    status: row.status,
    claudeSessionId: row.claude_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SESSION_SELECT = `
  SELECT s.*, p.name AS project_name FROM sessions s
  LEFT JOIN projects p ON p.id = s.project_id
`;

/**
 * 会话管理器：会话 CRUD、Claude 进程生命周期、事件落库、向订阅者广播。
 */
export class SessionManager {
  private live = new Map<string, ClaudeSession>();
  private subscribers = new Map<string, Set<Listener>>();

  // ---------- 查询 ----------

  list(): SessionInfo[] {
    const rows = db.prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC`).all() as SessionRow[];
    return rows.map(toInfo);
  }

  get(id: string): SessionInfo | null {
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toInfo(row) : null;
  }

  /** 历史事件（用于前端刷新/断线回放） */
  history(sessionId: string, afterId = 0): { id: number; event: unknown }[] {
    const rows = db.prepare(
      'SELECT id, event FROM messages WHERE session_id = ? AND id > ? ORDER BY id',
    ).all(sessionId, afterId) as { id: number; event: string }[];
    return rows.map((r) => ({ id: r.id, event: JSON.parse(r.event) }));
  }

  // ---------- 生命周期 ----------

  create(cwd: string, title = '', projectId: string | null = null): SessionInfo {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      'INSERT INTO sessions (id, title, cwd, project_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, title, cwd, projectId, 'idle', now, now);
    return this.get(id)!;
  }

  /** 懒启动：首条消息时才真正 spawn Claude 进程 */
  private ensureLive(id: string): ClaudeSession {
    let session = this.live.get(id);
    if (session) return session;

    const info = this.get(id);
    if (!info) throw new Error(`session ${id} not found`);

    session = new ClaudeSession(
      { cwd: info.cwd, resume: info.claudeSessionId },
      {
        onEvent: (event) => {
          // system:init 之外的 system 事件（thinking_tokens 等进度遥测）不落库不广播
          const e = event as { type: string; subtype?: string };
          if (e.type === 'system' && e.subtype !== 'init') return;
          db.prepare('INSERT INTO messages (session_id, event, created_at) VALUES (?, ?, ?)')
            .run(id, JSON.stringify(event), Date.now());
          this.touch(id);
          this.broadcast(id, { type: 'claude.event', sessionId: id, event });
        },
        onSessionId: (claudeSessionId) => {
          db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
        },
        onTurnDone: () => {
          this.setStatus(id, 'idle');
          this.broadcast(id, { type: 'chat.done', sessionId: id });
        },
        onPermissionRequest: (req) => {
          this.broadcast(id, {
            type: 'permission.request',
            sessionId: id,
            requestId: req.requestId,
            toolName: req.toolName,
            input: req.input,
          });
        },
        onPermissionResolved: (requestId, allow) => {
          this.broadcast(id, { type: 'permission.resolved', requestId, allow });
        },
        onError: (err) => {
          this.setStatus(id, 'error');
          this.broadcast(id, { type: 'chat.error', sessionId: id, error: err.message });
          this.live.delete(id);
        },
      },
    );
    session.start();
    this.live.set(id, session);
    return session;
  }

  send(id: string, text: string) {
    const session = this.ensureLive(id);
    this.setStatus(id, 'running');
    // 用户消息也落库 + 广播，保证多端同步
    const userEvent = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    db.prepare('INSERT INTO messages (session_id, event, created_at) VALUES (?, ?, ?)')
      .run(id, JSON.stringify(userEvent), Date.now());
    this.broadcast(id, { type: 'claude.event', sessionId: id, event: userEvent });
    session.send(text);
  }

  respondPermission(sessionId: string, requestId: string, allow: boolean): boolean {
    return this.live.get(sessionId)?.respondPermission(requestId, allow) ?? false;
  }

  // ---------- 订阅 ----------

  subscribe(sessionId: string, listener: Listener) {
    let set = this.subscribers.get(sessionId);
    if (!set) this.subscribers.set(sessionId, (set = new Set()));
    set.add(listener);
  }

  unsubscribe(sessionId: string, listener: Listener) {
    this.subscribers.get(sessionId)?.delete(listener);
  }

  private broadcast(sessionId: string, msg: ServerMessage) {
    for (const listener of this.subscribers.get(sessionId) ?? []) listener(msg);
  }

  // ---------- 内部 ----------

  private touch(id: string) {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  private setStatus(id: string, status: SessionInfo['status']) {
    db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
    this.broadcast(id, { type: 'session.status', sessionId: id, status });
  }
}

export const sessionManager = new SessionManager();
