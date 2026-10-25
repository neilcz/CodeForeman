import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { db } from '../db/index.js';
import { ClaudeSession, type PermissionResponseOpts } from '../claude/session.js';
import { uploadsDir } from '../config.js';
import { claudeEnvRev, claudeSpawnOptions } from '../settings/index.js';
import type { AttachmentInfo, ServerMessage, SessionInfo } from '@codeforeman/shared';

type Listener = (msg: ServerMessage) => void;

/**
 * 附件清单注入提示词：文件已落盘，告知路径与查看方式——
 * 图片用 Read 直接看（多模态）；视频 Read 看不了，提示 ffmpeg 抽帧；其余按格式读取
 */
function attachmentPrompt(sessionId: string, attachments: AttachmentInfo[]): string {
  const lines = attachments.map((a) => {
    const p = path.join(uploadsDir, sessionId, a.file);
    if (a.kind === 'image') return `- 图片 ${a.name}：${p}（用 Read 工具查看即可理解图片内容）`;
    if (a.kind === 'video') return `- 视频 ${a.name}：${p}（视频不能直接查看，需要时先用 ffmpeg 抽取关键帧图片再 Read）`;
    return `- 文件 ${a.name}：${p}（按格式读取：文本直接 Read，PDF 可 Read，其他二进制用合适工具解析）`;
  });
  return ['用户随消息上传了以下附件（已保存到本机）：', ...lines].join('\n');
}

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
  /** 各常驻进程实际使用的工作目录：来源会话执行并行计划时可能临时指向任务 worktree */
  private liveCwd = new Map<string, string>();
  /** 各常驻进程 spawn 时的接入配置版本（见 settings/claude.ts claudeEnvRev）：不一致就要换新进程 */
  private liveEnvRev = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  private subscribers = new Map<string, Set<Listener>>();
  private turnDoneListeners = new Set<(sessionId: string) => void>();
  private turnErrorListeners = new Set<(sessionId: string, error: Error) => void>();
  /** 全局监听（会话新建/状态/标题变更），server 注入后向所有在线 socket 广播 */
  private globalListeners = new Set<Listener>();

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
    this.liveCwd.delete(id);
    this.liveEnvRev.delete(id);
    this.lastActivity.delete(id);
  }

  /** 仅在进程仍指向指定 worktree 时关闭；用户已切回主目录或其他任务时不误伤 */
  closeSessionAtCwd(id: string, cwd: string) {
    if (this.liveCwd.get(id) === path.resolve(cwd)) this.closeSession(id);
  }

  /**
   * 生效的 Claude 接入配置变了：关掉空闲会话的常驻进程，让它们下次发言按新配置重新 spawn
   * （会话历史在库里，凭 claude_session_id resume 接续，用户无感）。
   * 正在跑的轮次不动——进程环境在 spawn 时就固定了，只有重启进程才会换配置。
   * 返回被回收的会话数（设置页提示用）。
   */
  applyClaudeEnvChange(): number {
    let closed = 0;
    for (const id of [...this.live.keys()]) {
      if (this.get(id)?.status === 'running') continue;
      this.closeSession(id);
      closed++;
    }
    return closed;
  }

  /** 优雅停机：关闭所有 Claude 进程 */
  shutdownAll() {
    for (const id of [...this.live.keys()]) this.closeSession(id);
  }

  /** 一轮对话结束时触发（任务编排等模块用来感知 Claude 干完活） */
  onTurnDone(fn: (sessionId: string) => void) {
    this.turnDoneListeners.add(fn);
  }

  /** Claude 进程本轮出错：任务队列据此停止/释放，不让任务永远卡在 running */
  onTurnError(fn: (sessionId: string, error: Error) => void) {
    this.turnErrorListeners.add(fn);
  }

  /** 全局会话事件（session.created / session.status / session.updated） */
  onGlobal(fn: Listener) {
    this.globalListeners.add(fn);
  }

  // ---------- 查询 ----------

  list(user?: { id: string; role: string }): SessionInfo[] {
    const rows = (!user || user.role === 'admin')
      ? db.prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC`).all() as SessionRow[]
      : db.prepare(`${SESSION_SELECT}
          WHERE (s.project_id IS NULL OR s.project_id IN
            (SELECT id FROM projects WHERE owner_id = ? OR visibility = 'public'))
          ORDER BY s.updated_at DESC`).all(user.id) as SessionRow[];
    return this.annotateFlags(rows.map(toInfo));
  }

  get(id: string): SessionInfo | null {
    const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? this.annotateFlags([toInfo(row)])[0] : null;
  }

  /**
   * 批量标注「已存计划 / 已归档」标记（两条 IN 查询，避免逐行 N+1）：
   * 已存计划 = 存在 origin_session_id 指向该会话的任务；已归档 = feature_items 有该会话条目
   */
  private annotateFlags(infos: SessionInfo[]): SessionInfo[] {
    if (infos.length === 0) return infos;
    const ids = infos.map((i) => i.id);
    const ph = ids.map(() => '?').join(',');
    // 每组取最新一条（ORDER BY DESC + 首次写入生效）
    const plannedRows = db.prepare(
      `SELECT origin_session_id AS sid, title FROM tasks
       WHERE origin_session_id IN (${ph}) ORDER BY created_at DESC`,
    ).all(...ids) as { sid: string; title: string }[];
    const archivedRows = db.prepare(
      `SELECT fi.ref_id AS sid, f.title FROM feature_items fi
       JOIN features f ON f.id = fi.feature_id
       WHERE fi.kind = 'session' AND fi.ref_id IN (${ph})
       ORDER BY fi.created_at DESC`,
    ).all(...ids) as { sid: string; title: string }[];
    const planTitle = new Map<string, string>();
    for (const r of plannedRows) if (!planTitle.has(r.sid)) planTitle.set(r.sid, r.title);
    const featureTitle = new Map<string, string>();
    for (const r of archivedRows) if (!featureTitle.has(r.sid)) featureTitle.set(r.sid, r.title);
    for (const i of infos) {
      i.planned = planTitle.has(i.id);
      i.planTitle = planTitle.get(i.id) ?? null;
      i.archived = featureTitle.has(i.id);
      i.archiveFeatureTitle = featureTitle.get(i.id) ?? null;
    }
    return infos;
  }

  /** 归档/存计划后推送最新的会话信息（planned/archived 标记变化复用 session.updated 通道） */
  pushUpdated(id: string) {
    const info = this.get(id);
    if (!info) return;
    this.broadcast(id, { type: 'session.updated', session: info });
    this.broadcastGlobal({ type: 'session.updated', session: info });
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
    const info = this.get(id)!;
    // 全局广播：任务编排等服务端拉起的会话，否则侧边栏要刷新才能看到
    this.broadcastGlobal({ type: 'session.created', session: info });
    return info;
  }

  /** 懒启动：首条消息时才真正 spawn Claude 进程；任务可指定本轮使用的 worktree */
  private ensureLive(id: string, cwd?: string): ClaudeSession {
    const info = this.get(id);
    if (!info) throw new Error(`session ${id} not found`);
    const targetCwd = path.resolve(cwd ?? info.cwd);
    let session = this.live.get(id);
    if (session) {
      const sameCwd = this.liveCwd.get(id) === targetCwd;
      // 配置或工作目录变化都要换新进程；正在跑的轮次不允许切到另一个目录。
      if (sameCwd && (this.liveEnvRev.get(id) === claudeEnvRev() || info.status === 'running')) return session;
      if (info.status === 'running') {
        throw new Error('会话正在其他工作目录执行任务，请等待本轮结束后再发送消息');
      }
      this.closeSession(id);
    }

    // 遗留会话的 cwd 可能已不存在（如容器时期创建的 /projects/...），提前报清晰错误
    if (!fs.existsSync(targetCwd)) {
      throw new Error(`会话工作目录不存在：${targetCwd}（可能是容器时期创建的遗留会话，请新建会话）`);
    }

    // 本进程实例的归属标记：旧进程可能晚于新进程结束（如切换配置时主动关闭 + 立刻重开），
    // 回调里据此判断「我是否还是当前注册的那个」——否则旧进程的收尾回调会把新进程从表里删掉、
    // 把它的状态改成 idle、把它的事件混进对话
    let instance: ClaudeSession | null = null;
    const stale = () => this.live.get(id) !== instance;

    session = new ClaudeSession(
      { cwd: targetCwd, resume: info.claudeSessionId },
      {
        onEvent: (event) => {
          if (stale()) return;
          this.lastActivity.set(id, Date.now());
          // system 事件只保留 init（捕获 session id）、interrupted（中断标记）
          // 和 permission.timeout（审批超时留痕），thinking_tokens 等遥测噪声不落库不广播
          const e = event as { type: string; subtype?: string };
          if (e.type === 'system'
            && e.subtype !== 'init' && e.subtype !== 'interrupted' && e.subtype !== 'permission.timeout') return;
          const now = Date.now();
          const info = db.prepare('INSERT INTO messages (session_id, event, created_at) VALUES (?, ?, ?)')
            .run(id, JSON.stringify(event), now);
          this.touch(id);
          this.broadcast(id, { type: 'claude.event', sessionId: id, event, id: Number(info.lastInsertRowid), ts: now });
        },
        onSessionId: (claudeSessionId) => {
          if (stale()) return;
          db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ?').run(claudeSessionId, id);
        },
        onTurnDone: () => {
          if (stale()) return;
          this.setStatus(id, 'idle');
          this.broadcast(id, { type: 'chat.done', sessionId: id });
          for (const fn of this.turnDoneListeners) fn(id);
        },
        onPermissionRequest: (req) => {
          if (stale()) return;
          this.broadcast(id, {
            type: 'permission.request',
            sessionId: id,
            requestId: req.requestId,
            toolName: req.toolName,
            input: req.input,
          });
        },
        onPermissionResolved: (requestId, allow) => {
          if (stale()) return;
          this.broadcast(id, { type: 'permission.resolved', requestId, allow });
        },
        onError: (err) => {
          if (stale()) return;
          this.setStatus(id, 'error');
          this.broadcast(id, { type: 'chat.error', sessionId: id, error: err.message });
          this.live.delete(id);
          this.liveCwd.delete(id);
          for (const fn of this.turnErrorListeners) fn(id, err);
        },
        onEnded: () => {
          // 进程流终止（中断/正常退出）：状态复位，下次发言凭 resume 重启进程
          if (stale()) return;
          // result 后的正常关闭已在 onTurnDone 置 idle；仍是 running 说明本轮被中断/异常终止
          const interrupted = this.get(id)?.status === 'running';
          this.live.delete(id);
          this.liveCwd.delete(id);
          this.setStatus(id, 'idle');
          this.broadcast(id, { type: 'chat.done', sessionId: id });
          if (interrupted) {
            const err = new Error('本轮执行已中断');
            for (const fn of this.turnErrorListeners) fn(id, err);
          }
        },
      },
    );
    instance = session;
    session.start();
    this.live.set(id, session);
    this.liveCwd.set(id, targetCwd);
    this.liveEnvRev.set(id, claudeEnvRev());
    return session;
  }

  send(id: string, text: string, attachments?: AttachmentInfo[], opts: { cwd?: string } = {}) {
    const session = this.ensureLive(id, opts.cwd);
    this.setStatus(id, 'running');
    this.lastActivity.set(id, Date.now());
    // 用户消息也落库 + 广播，保证多端同步；attachments 仅用于历史展示，不进 prompt
    const userEvent = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      ...(attachments?.length ? { attachments } : {}),
    };
    const now = Date.now();
    const ins = db.prepare('INSERT INTO messages (session_id, event, created_at) VALUES (?, ?, ?)')
      .run(id, JSON.stringify(userEvent), now);
    this.broadcast(id, { type: 'claude.event', sessionId: id, event: userEvent, id: Number(ins.lastInsertRowid), ts: now });
    // 新消息 = 本会话刚有活动：推一次完整会话信息，各端侧栏立刻把它排到最前
    this.pushUpdated(id);
    session.send(attachments?.length ? `${text}\n\n${attachmentPrompt(id, attachments)}` : text);

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
        options: { cwd: info.cwd, ...claudeSpawnOptions() },
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
    if (updated?.title) {
      this.broadcast(id, { type: 'session.updated', session: updated });
      this.broadcastGlobal({ type: 'session.updated', session: updated });
    }
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
    for await (const msg of query({ prompt, options: { cwd: info.cwd, ...claudeSpawnOptions() } })) {
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

  respondPermission(sessionId: string, requestId: string, allow: boolean, opts?: PermissionResponseOpts): boolean {
    return this.live.get(sessionId)?.respondPermission(requestId, allow, opts) ?? false;
  }

  /** 中断会话当前轮次 */
  interrupt(id: string) {
    this.live.get(id)?.interrupt();
  }

  /** 删除会话：杀掉进程（若在跑）、清空消息与功能归档关联、清理上传附件 */
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
    fs.rmSync(path.join(uploadsDir, id), { recursive: true, force: true });
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

  private broadcastGlobal(msg: ServerMessage) {
    for (const listener of this.globalListeners) listener(msg);
  }

  // ---------- 内部 ----------

  private touch(id: string) {
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  private setStatus(id: string, status: SessionInfo['status']) {
    const updatedAt = Date.now();
    db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(status, updatedAt, id);
    this.broadcast(id, { type: 'session.status', sessionId: id, status, updatedAt });
    // 全局广播：未订阅该会话的页面（侧边栏/其他会话）也要实时更新状态；
    // 带上 updatedAt 让侧边栏顺势重排（否则新消息不会把会话顶到最前）
    this.broadcastGlobal({ type: 'session.status', sessionId: id, status, updatedAt });
  }
}

export const sessionManager = new SessionManager();
