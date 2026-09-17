import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { db } from '../db/index.js';
import { getProject } from '../projects/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FeatureInfo, FeatureItemInfo } from '@codeforeman/shared';

const execFileAsync = promisify(execFile);

interface FeatureRow {
  id: string;
  project_id: string;
  project_name?: string | null;
  title: string;
  summary: string;
  created_at: number;
  updated_at: number;
}

const FEATURE_SELECT = `
  SELECT f.*, p.name AS project_name FROM features f
  JOIN projects p ON p.id = f.project_id
`;

// ---------- 查询 ----------

export function listFeatures(projectId: string): FeatureInfo[] {
  const rows = db.prepare(
    `${FEATURE_SELECT} WHERE f.project_id = ? ORDER BY f.updated_at DESC`,
  ).all(projectId) as FeatureRow[];
  return rows.map((f) => ({ ...toInfo(f), items: listItems(f.id) }));
}

/** 跨项目列出当前用户可见的全部功能（admin 全部；否则自己+公共项目的） */
export function listFeaturesForUser(user: { id: string; role: string }, projectId?: string): FeatureInfo[] {
  if (projectId) return listFeatures(projectId);
  const rows = (user.role === 'admin'
    ? db.prepare(`${FEATURE_SELECT} ORDER BY f.updated_at DESC`).all()
    : db.prepare(`${FEATURE_SELECT}
        WHERE (p.owner_id = ? OR p.visibility = 'public')
        ORDER BY f.updated_at DESC`).all(user.id)) as FeatureRow[];
  return rows.map((f) => ({ ...toInfo(f), items: listItems(f.id) }));
}

function toInfo(row: FeatureRow): Omit<FeatureInfo, 'items'> {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listItems(featureId: string): FeatureItemInfo[] {
  const rows = db.prepare(
    'SELECT * FROM feature_items WHERE feature_id = ? ORDER BY created_at ASC',
  ).all(featureId) as { id: string; kind: 'session' | 'task'; ref_id: string; created_at: number }[];

  return rows.map((r) => {
    const base = { id: r.id, kind: r.kind, refId: r.ref_id, createdAt: r.created_at };
    if (r.kind === 'task') {
      const t = db.prepare('SELECT title, status, merge_commit FROM tasks WHERE id = ?').get(r.ref_id) as
        { title: string; status: FeatureItemInfo['taskStatus']; merge_commit: string | null } | undefined;
      return { ...base, label: t?.title ?? '(任务已删除)', taskStatus: t?.status, mergeCommit: t?.merge_commit };
    }
    // session：取首条用户消息作为需求摘要
    const s = db.prepare('SELECT title FROM sessions WHERE id = ?').get(r.ref_id) as { title: string } | undefined;
    const firstUser = db.prepare(
      "SELECT event FROM messages WHERE session_id = ? AND json_extract(event, '$.type') = 'user' ORDER BY id LIMIT 1",
    ).get(r.ref_id) as { event: string } | undefined;
    let firstPrompt: string | null = null;
    if (firstUser) {
      const e = JSON.parse(firstUser.event);
      const c = e.message?.content;
      firstPrompt = (typeof c === 'string' ? c : null)?.slice(0, 120) ?? null;
    }
    return { ...base, label: s?.title ?? '会话', firstPrompt };
  });
}

// ---------- 写操作 ----------

export function createFeature(projectId: string, title: string, summary = ''): FeatureInfo {
  if (!getProject(projectId)) throw new Error('project not found');
  const id = randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO features (id, project_id, title, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, projectId, title, summary, now, now);
  return listFeatures(projectId).find((f) => f.id === id)!;
}

/** 把会话或任务归档到功能下（幂等） */
export function linkItem(featureId: string, kind: 'session' | 'task', refId: string) {
  db.prepare(
    'INSERT OR IGNORE INTO feature_items (id, feature_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), featureId, kind, refId, Date.now());
  db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(Date.now(), featureId);
}

export function updateFeatureSummary(id: string, summary: string) {
  db.prepare('UPDATE features SET summary = ?, updated_at = ? WHERE id = ?').run(summary, Date.now(), id);
}

// ---------- 任务完成后的自动归档 ----------

/**
 * 任务验收完成后自动归档为一个功能条目：
 * 把任务信息 + diff 概要交给 Claude 生成一句话功能标题 + 摘要。
 * 纯文本问答（diff 已嵌入 prompt），无需工具权限。失败时降级为任务标题。
 */
export async function autoArchiveTask(taskId: string): Promise<void> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
    { id: string; project_id: string; title: string; description: string; merge_commit: string | null; session_id: string | null } | undefined;
  if (!task) return;
  const project = getProject(task.project_id);
  if (!project) return;

  // 已有归档则跳过（幂等）
  const exists = db.prepare(
    "SELECT 1 FROM feature_items fi WHERE fi.kind = 'task' AND fi.ref_id = ?",
  ).get(taskId);
  if (exists) return;

  let diffStat = '';
  if (task.merge_commit) {
    try {
      const { stdout } = await execFileAsync(
        'git', ['show', '--stat', '--format=%s', task.merge_commit],
        { cwd: project.path, timeout: 15_000 },
      );
      diffStat = stdout.slice(0, 3000);
    } catch { /* diff 拿不到就只用任务文本 */ }
  }

  let title = task.title;
  let summary = task.description || task.title;
  try {
    const prompt = [
      '根据以下已完成的开发任务，生成一个功能归档条目。',
      '只输出 JSON，格式：{"title": "功能名（10字内）", "summary": "这次迭代做了什么（80字内）"}',
      '',
      `任务标题：${task.title}`,
      `任务描述：${task.description || '无'}`,
      diffStat ? `代码变更概要：\n${diffStat}` : '',
    ].join('\n');

    let text = '';
    for await (const msg of query({ prompt, options: { cwd: project.path } })) {
      const m = msg as { type: string; message?: { content?: { type: string; text?: string }[] } };
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) text += b.text;
        }
      }
      if (m.type === 'result') break;
    }
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (parsed.title) title = String(parsed.title).slice(0, 50);
    if (parsed.summary) summary = String(parsed.summary).slice(0, 500);
  } catch { /* 摘要生成失败时用任务标题兜底 */ }

  const feature = createFeature(task.project_id, title, summary);
  linkItem(feature.id, 'task', taskId);
  if (task.session_id) linkItem(feature.id, 'session', task.session_id);
}
