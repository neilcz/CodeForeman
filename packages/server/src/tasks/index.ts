import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { getProject } from '../projects/index.js';
import { sessionManager } from '../sessions/manager.js';
import { autoArchiveTask } from '../features/index.js';
import * as git from '../git/index.js';
import type { TaskInfo, TaskStatus } from '@codeforeman/shared';

interface TaskRow {
  id: string;
  project_id: string;
  project_name?: string | null;
  title: string;
  description: string;
  source: 'manual' | 'chat';
  status: TaskStatus;
  auto_merge: number;
  branch: string | null;
  session_id: string | null;
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
    branch: row.branch,
    sessionId: row.session_id,
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

function setStatus(id: string, status: TaskStatus, extra: Partial<Record<'error' | 'merge_commit' | 'branch' | 'session_id', string | null>> = {}) {
  const fields = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [status, Date.now()];
  for (const [k, v] of Object.entries(extra)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow;
  notifyUpdate(toInfo(row));
}

// ---------- CRUD ----------

export function listTasks(projectId?: string): TaskInfo[] {
  const rows = (projectId
    ? db.prepare(`${TASK_SELECT} WHERE t.project_id = ? ORDER BY t.updated_at DESC`).all(projectId)
    : db.prepare(`${TASK_SELECT} ORDER BY t.updated_at DESC`).all()) as TaskRow[];
  return rows.map(toInfo);
}

export function getTask(id: string): TaskInfo | null {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as TaskRow | undefined;
  return row ? toInfo(row) : null;
}

export function createTask(opts: {
  projectId: string; title: string; description?: string; source?: 'manual' | 'chat'; autoMerge?: boolean;
}): TaskInfo {
  if (!getProject(opts.projectId)) throw new Error('project not found');
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, source, status, auto_merge, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(id, opts.projectId, opts.title, opts.description ?? '', opts.source ?? 'manual',
    opts.autoMerge === false ? 0 : 1, now, now);
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

export function deleteTask(id: string) {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status === 'running') throw new Error('执行中的任务不可删除');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// ---------- 执行编排 ----------

function taskBranch(title: string, id: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'task';
  return `feature/${slug}-${id.slice(0, 6)}`;
}

/** 执行任务：切任务分支 → 拉起 Claude 会话并下达任务 */
export async function executeTask(id: string): Promise<TaskInfo> {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status === 'running') throw new Error('任务已在执行中');
  const project = getProject(task.projectId)!;

  const branch = task.branch ?? taskBranch(task.title, task.id);
  const base = await git.defaultBranch(project.path);
  await git.createBranch(project.path, branch, base);

  const session = sessionManager.create(project.path, `[任务] ${task.title}`, project.id);
  setStatus(id, 'running', { branch, session_id: session.id, error: null });

  const prompt = [
    `【任务】${task.title}`,
    '',
    task.description || '（无详细描述，按标题实现）',
    '',
    '要求：',
    `- 当前位于 git 任务分支 ${branch}（从 ${base} 切出），直接在本分支实现，不要切换/合并分支`,
    `- 完成后执行 git add + git commit 提交全部改动，commit message 格式：feat: ${task.title}`,
    '- 实现中有不明确的地方先给出你的假设再继续，不要停下来提问',
  ].join('\n');
  sessionManager.send(session.id, prompt);

  return getTask(id)!;
}

/** 验收完成：兜底提交 → 按 autoMerge 合并回主分支 → 删除任务分支 */
export async function completeTask(id: string): Promise<TaskInfo> {
  const task = getTask(id);
  if (!task) throw new Error('task not found');
  if (task.status !== 'review' && task.status !== 'running') {
    throw new Error(`当前状态(${task.status})不可验收`);
  }
  const project = getProject(task.projectId)!;
  const branch = task.branch!;

  // Claude 可能忘了 commit，兜底提交剩余改动
  await git.commitAll(project.path, `feat: ${task.title}`);

  if (!task.autoMerge) {
    setStatus(id, 'done');
    autoArchiveTask(id).catch(() => {});
    return getTask(id)!;
  }

  const base = await git.defaultBranch(project.path);
  await git.checkout(project.path, base);
  try {
    await git.merge(project.path, branch);
  } catch {
    // 冲突：回滚合并，切回任务分支，标记 conflict 等人手工处理
    await git.mergeAbort(project.path).catch(() => {});
    await git.checkout(project.path, branch).catch(() => {});
    setStatus(id, 'conflict', { error: `合并 ${branch} → ${base} 冲突，已保留分支，请人工处理` });
    return getTask(id)!;
  }
  const mergeCommit = await git.headCommit(project.path);
  await git.deleteBranch(project.path, branch).catch(() => {});
  setStatus(id, 'done', { merge_commit: mergeCommit });
  // 异步归档到功能演进（生成摘要要走一次 Claude 调用，不阻塞验收响应）
  autoArchiveTask(id).catch(() => {});
  return getTask(id)!;
}

/** 放弃执行：标记 failed（保留分支以便人工查看） */
export function failTask(id: string, reason: string): TaskInfo {
  setStatus(id, 'failed', { error: reason });
  return getTask(id)!;
}

// Claude 一轮结束 → 执行中的任务进入「待验收」
sessionManager.onTurnDone((sessionId) => {
  const row = db.prepare("SELECT id FROM tasks WHERE session_id = ? AND status = 'running'").get(sessionId) as { id: string } | undefined;
  if (row) setStatus(row.id, 'review');
});
