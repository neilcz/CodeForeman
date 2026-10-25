import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db/index.js';
import { getProject } from '../projects/index.js';
import { sessionManager } from '../sessions/manager.js';
import { autoArchiveTask } from '../features/index.js';
import { getTaskExecutionMode } from '../settings/index.js';
import { worktreesDir } from '../config.js';
import * as git from '../git/index.js';
import type { TaskExecutionMode, TaskInfo, TaskStatus } from '@codeforeman/shared';

interface TaskRow {
  id: string;
  project_id: string;
  project_name?: string | null;
  title: string;
  description: string;
  source: 'manual' | 'chat';
  status: TaskStatus;
  auto_merge: number;
  origin_session_id: string | null;
  execution_mode: TaskExecutionMode | null;
  branch: string | null;
  session_id: string | null;
  worktree_path: string | null;
  queued_at: number | null;
  task_commit: string | null;
  merge_commit: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const TASK_SELECT = `
  SELECT t.*, p.name AS project_name FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
`;

function toInfo(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    title: row.title,
    description: row.description,
    source: row.source,
    status: row.status,
    autoMerge: row.auto_merge === 1,
    originSessionId: row.origin_session_id,
    executionMode: row.execution_mode,
    branch: row.branch,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
    queuedAt: row.queued_at,
    taskCommit: row.task_commit,
    mergeCommit: row.merge_commit,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 全局任务事件回调（server 注入，用于 WS 广播 task.updated） */
let notifyUpdate: (task: TaskInfo) => void = () => {};
export function onTaskUpdate(fn: (task: TaskInfo) => void) {
  notifyUpdate = fn;
}

type StatusExtra = Partial<Record<
  'error' | 'merge_commit' | 'branch' | 'session_id' | 'execution_mode' | 'worktree_path' | 'task_commit' | 'queued_at',
  string | number | null
>>;

function setStatus(id: string, status: TaskStatus, extra: StatusExtra = {}) {
  const fields = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, Date.now()];
  for (const [k, v] of Object.entries(extra)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  if (row) notifyUpdate(toInfo(row));
}

// ---------- CRUD ----------

export function listTasks(user: { id: string; role: string }, projectId?: string): TaskInfo[] {
  const conds: string[] = [];
  const params: string[] = [];
  if (projectId) {
    conds.push('t.project_id = ?');
    params.push(projectId);
  }
  if (user.role !== 'admin') {
    conds.push("t.project_id IN (SELECT id FROM projects WHERE owner_id = ? OR visibility = 'public')");
    params.push(user.id);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = db.prepare(`${TASK_SELECT} ${where} ORDER BY t.updated_at DESC`).all(...params) as TaskRow[];
  return rows.map(toInfo);
}

export function getTask(id: string): TaskInfo | null {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  return row ? toInfo(row) : null;
}

export function createTask(opts: {
  projectId: string; title: string; description?: string; source?: 'manual' | 'chat'; autoMerge?: boolean;
  /** 「存为计划」时记录来源会话 id，执行时也在该会话中继续 */
  originSessionId?: string;
}): TaskInfo {
  if (!getProject(opts.projectId)) throw new Error('project not found');
  if (opts.originSessionId) {
    const origin = sessionManager.get(opts.originSessionId);
    if (!origin || origin.projectId !== opts.projectId) throw new Error('来源会话不存在或不属于该项目');
  }
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, source, status, auto_merge, origin_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  ).run(id, opts.projectId, opts.title, opts.description ?? '', opts.source ?? 'manual',
    opts.autoMerge === false ? 0 : 1, opts.originSessionId ?? null, now, now);
  return getTask(id)!;
}

export function updateTask(id: string, patch: { title?: string; description?: string; autoMerge?: boolean }): TaskInfo {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status === 'running') throw new Error('执行中的任务不可编辑');
  db.prepare('UPDATE tasks SET title = ?, description = ?, auto_merge = ?, updated_at = ? WHERE id = ?')
    .run(patch.title ?? task.title, patch.description ?? task.description,
      (patch.autoMerge ?? task.autoMerge) ? 1 : 0, Date.now(), id);
  return getTask(id)!;
}

export async function deleteTask(id: string) {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status === 'running') throw new Error('执行中的任务不可删除');
  // 删除计划不删除任务分支；独立 worktree 先安全移除，有未提交改动时由 git 拒绝并保留现场
  if (task.worktreePath) {
    const project = getProject(task.projectId);
    if (project) {
      if (task.sessionId) sessionManager.closeSessionAtCwd(task.sessionId, task.worktreePath);
      await git.removeWorktree(project.path, task.worktreePath);
    }
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (task.originSessionId) sessionManager.pushUpdated(task.originSessionId);
  clearSerialAnchorIfDrained(task.projectId);
  await pump();
}

// ---------- 执行编排 ----------

/** 当前进程内真正执行/收尾中的任务；服务重启后由 recoverFromCrash 处理 running 残留 */
const activeTasks = new Set<string>();
/** 同一来源会话不能并行跑多个计划，也不能在正常聊天进行中插入计划 */
const activeSessions = new Set<string>();
/** 一轮串行队列在同一项目固定使用启动时的当前分支 */
const serialBranches = new Map<string, string>();
const snapshotCounts = new Map<string, number>();
let pumping = false;
let pumpPending = false;
let queueHalted = false;

function taskBranch(title: string, id: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'task';
  return `feature/${slug}-${id.slice(0, 6)}`;
}

function queuedTasks(): TaskInfo[] {
  const rows = db.prepare(
    `${TASK_SELECT} WHERE t.status = 'queued' ORDER BY COALESCE(t.queued_at, t.created_at), t.created_at`,
  ).all() as TaskRow[];
  return rows.map(toInfo);
}

function originSession(task: TaskInfo) {
  if (!task.originSessionId) return null;
  const session = sessionManager.get(task.originSessionId);
  return session?.projectId === task.projectId ? session : null;
}

function canStart(task: TaskInfo): boolean {
  const origin = originSession(task);
  if (!origin) return true;
  return !activeSessions.has(origin.id) && origin.status !== 'running';
}

function taskPrompt(task: TaskInfo, mode: TaskExecutionMode, branch: string, base: string): string {
  const lines = [
    `【执行计划】${task.title}`,
    '',
    task.description || '（无详细描述，按标题及此前对话上下文实现）',
    '',
    '要求：',
  ];
  if (mode === 'serial') {
    lines.push(`- 当前位于 git 分支 ${branch}，直接在当前分支实现，不要创建、切换或合并分支`);
  } else {
    lines.push(`- 当前目录是本任务独立 worktree，位于任务分支 ${branch}（从 ${base} 切出）`);
    lines.push('- 所有改动都限制在当前 worktree，不要操作主工作区或其他任务的 worktree，不要切换/合并分支');
  }
  lines.push(
    `- 完成后执行 git add + git commit 提交全部改动，commit message 格式：feat: ${task.title}`,
    '- 实现中有不明确的地方先给出你的假设再继续，不要停下来提问',
  );
  return lines.join('\n');
}

/** 启动一条已排队任务。启动失败会落到 failed，并行模式下不阻塞其他项目/会话 */
async function startTask(task: TaskInfo, mode: TaskExecutionMode): Promise<void> {
  if (activeTasks.has(task.id) || !canStart(task)) return;
  const previousMode = task.executionMode;
  const origin = originSession(task);
  activeTasks.add(task.id);
  if (origin) activeSessions.add(origin.id);
  let sessionId: string | null = null;

  // 先做 running 占位，避免 git 等待期间被编辑/删除或被另一个调度重复领取
  setStatus(task.id, 'running', {
    execution_mode: mode, branch: null, worktree_path: null, task_commit: null, error: null,
  });

  try {
    const project = getProject(task.projectId);
    if (!project) throw new Error('project not found');
    let branch: string;
    let base: string;
    let cwd = project.path;
    let worktreePath: string | null = null;

    if (mode === 'serial') {
      branch = await git.currentBranch(project.path);
      if (!branch) throw new Error('当前处于 detached HEAD，串行计划需要一个本地分支');
      const anchored = serialBranches.get(project.id);
      if (anchored && anchored !== branch) {
        throw new Error(`本轮队列固定使用分支 ${anchored}，当前已切换到 ${branch}；请切回后重试`);
      }
      serialBranches.set(project.id, branch);
      base = branch;

      // 串行任务共用当前工作区：开始前已有改动先单独快照，不能混入本条任务提交
      const snapshotted = (await git.status(project.path)).length;
      snapshotCounts.set(task.id, snapshotted);
      if (snapshotted > 0) {
        await git.commitAll(project.path, 'chore: wip 快照（执行计划前自动提交）');
      }
    } else {
      base = await git.defaultBranch(project.path);
      branch = previousMode === 'parallel' && task.branch ? task.branch : taskBranch(task.title, task.id);
      worktreePath = previousMode === 'parallel' && task.worktreePath
        ? task.worktreePath
        : path.join(worktreesDir, task.id);
      if (!fs.existsSync(worktreePath)) {
        await git.createWorktree(project.path, worktreePath, branch, base);
      }
      cwd = worktreePath;
    }

    // 会话产生的计划回到原会话执行；手动计划或来源会话已删除时才新建
    const session = origin ?? sessionManager.create(cwd, `[任务] ${task.title}`, project.id);
    sessionId = session.id;
    activeSessions.add(session.id);
    setStatus(task.id, 'running', { branch, worktree_path: worktreePath, session_id: session.id });
    sessionManager.send(session.id, taskPrompt(task, mode, branch, base), undefined, { cwd });
  } catch (err) {
    const message = (err as Error).message;
    setStatus(task.id, 'failed', { error: message });
    activeTasks.delete(task.id);
    if (origin) activeSessions.delete(origin.id);
    if (sessionId) activeSessions.delete(sessionId);
    if (mode === 'serial') {
      queueHalted = true;
      serialBranches.delete(task.projectId);
    }
  }
}

/** 按当前全局设置调度；串行严格 FIFO，并行跳过正在忙碌的来源会话 */
async function pump(): Promise<void> {
  if (pumping) {
    pumpPending = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpPending = false;
      const mode = getTaskExecutionMode();
      if (queueHalted) continue;
      if (mode === 'serial') {
        if (activeTasks.size > 0) continue;
        const next = queuedTasks()[0];
        // 严格 FIFO：队首会话正在聊天时等待它结束，不越过它执行后面的计划
        if (next && canStart(next)) await startTask(next, mode);
      } else {
        for (const task of queuedTasks()) {
          if (canStart(task)) await startTask(task, mode);
        }
      }
    } while (pumpPending);
  } finally {
    pumping = false;
  }
}

/**
 * 点击「执行」= 加入队列。串行占用时返回 queued；空闲或并行时 pump 会直接启动。
 * 对 queued 再次点击表示人工解除失败暂停并尝试恢复队列。
 */
export async function executeTask(id: string): Promise<TaskInfo & { snapshotted: number }> {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status === 'running') throw new Error('任务已在执行中');
  if (task.status !== 'draft' && task.status !== 'queued') {
    throw new Error(`当前状态(${task.status})不可执行`);
  }
  if (task.status === 'draft') {
    setStatus(id, 'queued', { queued_at: Date.now(), error: null });
  }
  queueHalted = false;
  await pump();
  return { ...getTask(id)!, snapshotted: snapshotCounts.get(id) ?? 0 };
}

/** 服务启动时恢复 queued；若上次有 running 被中断，则暂停等人工确认，不自动提交未知现场 */
export function resumeQueue(paused: boolean) {
  queueHalted = paused;
  void pump();
}

/** 执行方式切换后立即重新评估等待队列，不解除串行失败暂停 */
export function kickQueue() {
  void pump();
}

function clearSerialAnchorIfDrained(projectId: string) {
  const queued = db.prepare(
    "SELECT 1 FROM tasks WHERE project_id = ? AND status = 'queued' LIMIT 1",
  ).get(projectId);
  if (!queued) serialBranches.delete(projectId);
}

async function releaseAndPump(task: TaskInfo, sessionId: string) {
  activeTasks.delete(task.id);
  activeSessions.delete(sessionId);
  clearSerialAnchorIfDrained(task.projectId);
  await pump();
}

/** Claude 一轮结束：先兜底提交并记录任务 HEAD，再进入待验收和调度下一条 */
async function finishRunningTask(sessionId: string, turnError?: Error) {
  const row = db.prepare(
    "SELECT id FROM tasks WHERE session_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1",
  ).get(sessionId) as { id: string } | undefined;
  if (!row) {
    // 普通聊天结束也可能让等待该来源会话的计划获得执行条件
    await pump();
    return;
  }
  const task = getTask(row.id);
  if (!task) return;
  const mode = task.executionMode ?? 'parallel';

  if (turnError) {
    setStatus(task.id, 'failed', { error: turnError.message });
    if (mode === 'serial') {
      queueHalted = true;
      serialBranches.delete(task.projectId);
    }
    await releaseAndPump(task, sessionId);
    return;
  }

  try {
    const project = getProject(task.projectId);
    if (!project) throw new Error('project not found');
    const cwd = task.worktreePath ?? project.path;
    // Claude 可能忘了 commit；串行必须在下一条开始前兜底，并行也在验收前固定任务现场
    await git.commitAll(cwd, `feat: ${task.title}`);
    const taskCommit = await git.headCommit(cwd);
    setStatus(task.id, 'review', { task_commit: taskCommit, error: null });
  } catch (err) {
    setStatus(task.id, 'failed', { error: `任务收尾提交失败：${(err as Error).message}` });
    if (mode === 'serial') {
      queueHalted = true;
      serialBranches.delete(task.projectId);
    }
  }
  await releaseAndPump(task, sessionId);
}

/** 合并冲突：拉起 Claude 会话在任务分支上把基线分支合并进来并解冲突 */
export async function resolveConflict(id: string): Promise<TaskInfo> {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'conflict' || !task.branch) throw new Error(`当前状态(${task.status})无需解冲突`);
  const project = getProject(task.projectId)!;
  const branch = task.branch;
  const base = await git.defaultBranch(project.path);
  const cwd = task.worktreePath ?? project.path;
  if (!fs.existsSync(cwd)) throw new Error(`任务工作目录不存在：${cwd}`);

  // 新版并行任务留在自己的 worktree；旧版任务仍在主工作区，保持原切分支兜底
  await git.commitAll(cwd, 'chore: wip 快照（解冲突前自动提交）');
  if ((await git.currentBranch(cwd)) !== branch) await git.checkout(cwd, branch);

  const session = sessionManager.create(cwd, `[解冲突] ${task.title}`, project.id);
  activeTasks.add(task.id);
  activeSessions.add(session.id);
  setStatus(id, 'running', { session_id: session.id, execution_mode: task.executionMode ?? 'parallel', error: null });

  const prompt = [
    `【合并冲突处理】${task.title}`,
    '',
    `当前位于任务分支 ${branch}，之前把它合并回 ${base} 时发生冲突。`,
    '请执行：',
    `1. 运行 git merge ${base}，让冲突暴露出来`,
    '2. 逐个解决冲突文件：理解两边改动的意图，保留双方有效改动',
    '3. 全部解决后 git add + git commit 完成合并提交',
    `4. 不要切换分支、不要合并回 ${base}（验收时由系统处理）`,
    '- 有不明确的地方先给出你的假设再继续，不要停下来提问',
  ].join('\n');
  try {
    sessionManager.send(session.id, prompt, undefined, { cwd });
  } catch (err) {
    activeTasks.delete(task.id);
    activeSessions.delete(session.id);
    setStatus(id, 'failed', { error: (err as Error).message });
    throw err;
  }

  return getTask(id)!;
}

/** 验收后清理 worktree；返回 null 表示成功/无需清理，否则返回不阻塞验收的警告 */
async function cleanupWorktree(task: TaskInfo): Promise<string | null> {
  if (!task.worktreePath) return null;
  const project = getProject(task.projectId);
  if (!project) return '项目不存在，无法清理任务 worktree';
  if (task.sessionId) sessionManager.closeSessionAtCwd(task.sessionId, task.worktreePath);
  try {
    await git.removeWorktree(project.path, task.worktreePath, true);
    return null;
  } catch (err) {
    return `任务已处理，但 worktree 清理失败：${(err as Error).message}`;
  }
}

/** 验收完成：串行只确认/归档；并行兜底提交 → 按 autoMerge 合并 → 清理 worktree */
export async function completeTask(id: string, opts: { force?: boolean } = {}): Promise<TaskInfo> {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'review' && task.status !== 'running') {
    throw new Error(`当前状态(${task.status})不可验收`);
  }
  if (activeTasks.has(id)) throw new Error('任务仍在执行或收尾，请稍候');
  const project = getProject(task.projectId)!;

  // 串行提交已在进入 review 前完成。这里绝不再 commitAll，避免把后续任务改动算进来。
  if (task.executionMode === 'serial') {
    setStatus(id, 'done', { error: null });
    autoArchiveTask(id).catch(() => {});
    return getTask(id)!;
  }

  const branch = task.branch;
  if (!branch) throw new Error('任务缺少执行分支，无法验收');

  // 任务分支已被手动删除：force 时直接标记完成（不合并），否则报 branch_missing 让前端询问
  if (!(await git.branches(project.path)).includes(branch)) {
    if (!opts.force) {
      const err = new Error(`任务分支 ${branch} 已不存在，无法合并`) as Error & { code?: string };
      err.code = 'branch_missing';
      throw err;
    }
    setStatus(id, 'done', { error: `分支 ${branch} 已不存在，人工确认视为完成（未合并）` });
    autoArchiveTask(id).catch(() => {});
    return getTask(id)!;
  }

  const cwd = task.worktreePath ?? project.path;
  if (!fs.existsSync(cwd)) throw new Error(`任务工作目录不存在：${cwd}`);
  // 允许验收前在 worktree 里做过人工修正；串行模式已在上面排除
  await git.commitAll(cwd, `feat: ${task.title}`);
  const taskCommit = await git.headCommit(cwd);

  if (!task.autoMerge) {
    const warning = await cleanupWorktree(task);
    setStatus(id, 'done', {
      task_commit: taskCommit,
      worktree_path: warning ? task.worktreePath : null,
      error: warning,
    });
    autoArchiveTask(id).catch(() => {});
    return getTask(id)!;
  }

  const base = await git.defaultBranch(project.path);
  await git.checkout(project.path, base);
  try {
    await git.merge(project.path, branch);
  } catch {
    // 冲突：回滚主工作区合并；新版任务分支留在原 worktree，旧版才切回主工作区
    await git.mergeAbort(project.path).catch(() => {});
    if (!task.worktreePath) await git.checkout(project.path, branch).catch(() => {});
    setStatus(id, 'conflict', { error: `合并 ${branch} → ${base} 冲突，已保留分支，请人工处理` });
    return getTask(id)!;
  }
  const mergeCommit = await git.headCommit(project.path);
  const warning = await cleanupWorktree(task);
  // worktree 没删掉时分支仍被占用，保留分支和警告，不影响已经完成的合并
  if (!task.worktreePath || !warning) await git.deleteBranch(project.path, branch).catch(() => {});
  setStatus(id, 'done', {
    task_commit: taskCommit,
    merge_commit: mergeCommit,
    worktree_path: warning ? task.worktreePath : null,
    error: warning,
  });
  // 异步归档到功能演进（生成摘要要走一次 Claude 调用，不阻塞验收响应）
  autoArchiveTask(id).catch(() => {});
  return getTask(id)!;
}

/** 放弃执行：标记 failed（保留分支以便人工查看） */
export function failTask(id: string, reason: string): TaskInfo {
  setStatus(id, 'failed', { error: reason });
  return getTask(id)!;
}

sessionManager.onTurnDone((sessionId) => {
  void finishRunningTask(sessionId).catch((err) => console.error('[tasks] 收尾失败', err));
});

sessionManager.onTurnError((sessionId, error) => {
  void finishRunningTask(sessionId, error).catch((err) => console.error('[tasks] 错误收尾失败', err));
});
