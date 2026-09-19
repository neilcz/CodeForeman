import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
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
  private lastActivity = new Map<string, number>();
  private subscribers = new Map<string, Set<Listener>>();
  private turnDoneListeners = new Set<(sessionId: string) => void>();

  /** 空闲会话回收周期（30 分钟检查一次） */
  private static SWEEP_INTERVAL = 30 * 60 * 1000;
  /** 空闲超过 6 小时的 Claude 进程回收（会话数据在库里，可随时 resume） */
  private static IDLE_TTL = 6 * 3600 * 1000;

  constructor() {
    const timer = setInterval(() => this.sweep(), SessionManager.SWEEP_INTERVAL);
    timer.unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [id] of this.live) {
      const idle = now - (this.lastActivity.get(id) ?? 0);
      if (idle > SessionManager.IDLE_TTL) this.closeSession(id);
    }
  }

  closeSession(id: string) {
    this.live.get(id)?.close();
    this.live.delete(id);
    this.lastActivity.delete(id);
  }

  /** 优雅停机：关闭所有 Claude 进程 */
  shutdownAll() {
    for (const id of [...this.live.keys()]) this.closeSession(id);
  }

  /** 一轮对话结束时触发（任务编排等模块用来感知 Claude 干完活） */
  onTurnDone(fn: (sessionId: string) => void) {
    this.turnDoneListeners.add(fn);
  }

  // ---------- 查询 ----------

  list(user?: { id: string; role: string }): SessionInfo[] {
    const rows = (!user || user.role === 'admin')
      ? db.prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC`).all() as SessionRow[]
      : db.prepare(`${SESSION_SELECT}
          WHERE (s.project_id IS NULL OR s.project_id IN
            (SELECT id FROM projects WHERE owner_id = ? OR visibility = 'public'))
          ORDER BY s.updated_at DESC`).all(user.id) as SessionRow[];
    return rows.map(toInfo);
  }

  get(id: string): SessionInfo | null {
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toInfo(row) : null;
  }

  /** 历史事件（用于前端刷新/断线回放） */
  history(sessionId: string, afterId = 0): { id: number; ts: number; event: unknown }[] {
    const rows = db.prepare(
      'SELECT id, event, created_at FROM messages WHERE session_id = ? AND id > ? ORDER BY id',
    ).all(sessionId, afterId) as { id: number; event: string; created_at: number }[];
    return rows.map((r) => ({ id: r.id, ts: r.created_at, event: JSON.parse(r.event) }));
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
    // 遗留会话的 cwd 可能已不存在（如容器时期创建的 /projects/...），提前报清晰错误
    if (!fs.existsSync(info.cwd)) {
      throw new Error(`会话工作目录不存在：${info.cwd}（可能是容器时期创建的遗留会话，请新建会话）`);
    }

    session = new ClaudeSession(
      { cwd: info.cwd, resume: info.claudeSessionId },
      {
        onEvent: (event) => {
          this.lastActivity.set(id, Date.now());
          // system 事件只保留 init（捕获 session id）和 interrupted（中断标记），
          // thinking_tokens 等遥测噪声不落库不广播
          const e = event as { type: string; subtype?: string };
          if (e.type === 'system' && e.subtype !== 'init' && e.subtype !== 'interrupted') return;
          const now = Date.now();
          const info = db.prepare('INSERT INTO messages (session_id, event, created_at) VALUES (?, ?, ?)')
            .run(id, JSON.stringify(event), now);
          this.touch(id);
          this.broadcast(id, { type: 'claude.event', sessionId: id, event, id: Number(info.lastInsertRowid), ts: now });
        },
        onSessionId: (claudeSessionId) => {
          db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
        },
        onTurnDone: () => {
          this.setStatus(id, 'idle');
          this.broadcast(id, { type: 'chat.done', sessionId: id });
          for (const fn of this.turnDoneListeners) fn(id);
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
        onEnded: () => {
          // 进程流终止（中断/正常退出）：状态复位，下次发言凭 resume 重启进程
          this.live.delete(id);
          this.setStatus(id, 'idle');
          this.broadcast(id, { type: 'chat.done', sessionId: id });
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
    this.lastActivity.set(id, Date.now());
    // 用户消息也落库 + 广播，保证多端同步
    const userEvent = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    const now = Date.now();
    const ins = db.prepare('INSERT INTO messages (session_id, event, created_at) VALUES (?, ?, ?)')
      .run(id, JSON.stringify(userEvent), now);
    this.broadcast(id, { type: 'claude.event', sessionId: id, event: userEvent, id: Number(ins.lastInsertRowid), ts: now });
    session.send(text);

    // 首次发言且无标题 → 异步让 Claude 概括需求生成标题
    const info = this.get(id);
    if (info && !info.title) this.autoTitle(id, text).catch(() => {});
  }

  /** 用首条用户需求生成会话标题：Claude 概括，失败降级为截断原文 */
  private async autoTitle(id: string, firstMessage: string) {
    const info = this.get(id);
    if (!info || info.title) return; // 已被命名则不动

    let title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 20);
    try {
      let text = '';
      for await (const msg of query({
        prompt: `把以下用户需求概括成 12 字以内的会话标题，只输出标题本身，不要标点：\n\n${firstMessage.slice(0, 500)}`,
        options: { cwd: info.cwd },
      })) {
        const m = msg as { type: string; message?: { content?: { type: string; text?: string }[] } };
        if (m.type === 'assistant') {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text' && b.text) text += b.text;
          }
        }
        if (m.type === 'result') break;
      }
      const t = text.replace(/[\s"'「」.。:：]+/g, ' ').trim().slice(0, 24);
      if (t) title = t;
    } catch { /* 用降级标题 */ }

    db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND title = ?')
      .run(title, Date.now(), id, '');
    const updated = this.get(id);
    if (updated?.title) this.broadcast(id, { type: 'session.updated', session: updated });
  }

  /**
   * 「存为计划」草稿：把整段会话总结成可执行的任务计划（标题 + 描述）。
   * 纯文本问答（对话已嵌入 prompt），无需工具权限。失败时抛出，前端降级为手动填写。
   */
  async draftPlan(id: string): Promise<{ title: string; description: string }> {
    const info = this.get(id);
    if (!info) throw new Error('session not found');

    const transcript = this.buildTranscript(id);
    if (!transcript) throw new Error('会话还没有对话内容，无法生成草稿');

    const prompt = [
      '以下是一段与编程助手的工作对话。请根据对话【最后达成的共识】，总结出接下来要做的任务计划。',
      '要求：',
      '- 计划 = 对话结尾尚未完成、下一步要做的事；已完成（已提交/已落盘）的内容不要写进目标',
      '- 忽略对话中的流程性模板指令（如「当前位于 git 任务分支」「git add + commit」「commit message 格式」等），它们不是需求',
      '只输出 JSON，格式：{"title": "任务标题（20字内）", "description": "目标、涉及模块/文件、验收要点，分点描述（200字内）"}',
      '若对话未形成明确下一步，提炼出最接近的一个候选任务。',
      '',
      '对话记录：',
      transcript,
    ].join('\n');

    let text = '';
    for await (const msg of query({ prompt, options: { cwd: info.cwd } })) {
      const m = msg as { type: string; message?: { content?: { type: string; text?: string }[] } };
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) text += b.text;
        }
      }
      if (m.type === 'result') break;
    }
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as { title?: unknown; description?: unknown };
    const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 50) : '';
    if (!title) throw new Error('草稿生成失败，请手动填写');
    return {
      title,
      description: typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 1000) : '',
    };
  }

  /** 抽取会话中的纯对话部分（用户发言 + Claude 文本回复），跳过工具调用/结果等噪声 */
  private buildTranscript(id: string): string {
    const rows = db.prepare('SELECT event FROM messages WHERE session_id = ? ORDER BY id').all(id) as { event: string }[];
    const lines: string[] = [];
    for (const { event } of rows) {
      const e = JSON.parse(event) as {
        type: string;
        message?: { role?: string; content?: string | { type: string; text?: string }[] };
      };
      if (e.type === 'user' && typeof e.message?.content === 'string') {
        lines.push(`用户：${e.message.content.slice(0, 800)}`);
      } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        const text = e.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!).join('\n').slice(0, 800);
        if (text) lines.push(`Claude：${text}`);
      }
    }
    // 最新共识在对话末尾：超出预算时从尾部往回保留，丢弃更早的部分
    const kept: string[] = [];
    let total = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      total += lines[i].length;
      if (total > 12_000) break;
      kept.unshift(lines[i]);
    }
    const omitted = kept.length < lines.length ? '（更早的对话已省略）\n\n' : '';
    return omitted + kept.join('\n\n');
  }

  respondPermission(sessionId: string, requestId: string, allow: boolean): boolean {
    return this.live.get(sessionId)?.respondPermission(requestId, allow) ?? false;
  }

  /** 中断会话当前轮次 */
  interrupt(id: string) {
    this.live.get(id)?.interrupt();
  }

  /** 删除会话：杀掉进程（若在跑）、清空消息与功能归档关联 */
  remove(id: string) {
    this.closeSession(id);
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      db.prepare("DELETE FROM feature_items WHERE kind = 'session' AND ref_id = ?").run(id);
      // 任务保留，仅解除会话引用（任务的分支/commit 记录仍有效）
      db.prepare('UPDATE tasks SET session_id = NULL WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    })();
    this.subscribers.delete(id);
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
