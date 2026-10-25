import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { getProject } from '../projects/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FeatureInfo, FeatureItemInfo } from '@codeforeman/shared';
import { oneShotText } from '../ai.js';
import { sessionManager } from '../sessions/manager.js';

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
  ).all(featureId) as { id: string; kind: 'session' | 'task'; ref_id: string; summary: string; created_at: number }[];

  return rows.map((r) => {
    const base = { id: r.id, kind: r.kind, refId: r.ref_id, summary: r.summary || undefined, createdAt: r.created_at };
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

/** 把会话或任务归档到功能下（幂等）；会话条目异步生成/刷新 AI 改进点 */
export function linkItem(featureId: string, kind: 'session' | 'task', refId: string) {
  db.prepare(
    'INSERT OR IGNORE INTO feature_items (id, feature_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(randomUUID(), featureId, kind, refId, Date.now());
  db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(Date.now(), featureId);
  // 已归档过的会话再次归档 = 刷新改进点（幂等更新，不产生重复条目）
  if (kind === 'session') {
    // 会话的「已归档」标记变了，推给各端刷新列表
    sessionManager.pushUpdated(refId);
    summarizeSessionItem(featureId, refId).catch((e) => console.error('[features] 改进点生成失败', refId, e));
  }
}

/** 启动时回填：功能上线前归档的会话没有改进点，逐个补齐（串行，避免并发打满模型端点） */
export async function backfillSummaries(): Promise<void> {
  const rows = db.prepare(
    "SELECT feature_id, ref_id FROM feature_items WHERE kind = 'session' AND summary = ''",
  ).all() as { feature_id: string; ref_id: string }[];
  if (rows.length === 0) return;
  console.error(`[features] 开始回填 ${rows.length} 条会话节点`);
  for (const r of rows) {
    await summarizeSessionItem(r.feature_id, r.ref_id).catch((e) => console.error('[features] 回填失败', r.ref_id, e));
  }
  console.error('[features] 回填完成');
}

/**
 * 为归档的会话生成时间线节点：通读完整对话，按「功能迭代/升级/关键里程碑」的
 * 语义边界拆分（不按消息、不按会话边界）——一次对话里几件独立的事就拆几个节点；
 * 与卡片已有节点重复的不重复输出；纯过程性内容 → 不上时间线（summary 置空）。
 */
export async function summarizeSessionItem(featureId: string, sessionId: string): Promise<void> {
  const feature = db.prepare('SELECT project_id FROM features WHERE id = ?').get(featureId) as
    { project_id: string } | undefined;
  if (!feature) return;
  const project = getProject(feature.project_id);
  if (!project) return;

  // 提取对话文本（用户提的需求 + Claude 的回答），首条需求 + 最近内容优先
  const rows = db.prepare(
    'SELECT event FROM messages WHERE session_id = ? ORDER BY id',
  ).all(sessionId) as { event: string }[];
  const texts: string[] = [];
  for (const r of rows) {
    try {
      const e = JSON.parse(r.event) as {
        type: string;
        message?: { content?: string | { type: string; text?: string }[] };
      };
      const c = e.message?.content;
      if (e.type === 'user' && typeof c === 'string') texts.push(`用户：${c}`);
      if (e.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) if (b.type === 'text' && b.text) texts.push(`Claude：${b.text}`);
      }
    } catch { /* 跳过无法解析的消息 */ }
  }
  if (texts.length === 0) return;
  // 用户需求是里程碑标记（每条【任务】/新需求都是一阶段），全量保留；
  // Claude 的回答只取尾部（成果汇报），控制总长
  const userTexts = texts.filter((t) => t.startsWith('用户：')).map((t) => t.slice(0, 300));
  const claudeTail = texts.filter((t) => t.startsWith('Claude：')).slice(-30).join('\n').slice(-4000);
  const transcript = [
    '【需求时间线】',
    userTexts.join('\n').slice(0, 8000),
    '',
    '【最近的成果汇报】',
    claudeTail,
  ].join('\n');

  // 卡片上已有的节点标题（判重：同一件事跨多个会话推进时，不重复生成节点）
  const siblingSummaries = db.prepare(
    "SELECT summary FROM feature_items WHERE feature_id = ? AND kind = 'session' AND ref_id != ? AND summary != ''",
  ).all(featureId, sessionId) as { summary: string }[];
  const existingTitles: string[] = [];
  for (const s of siblingSummaries) {
    try {
      const p = JSON.parse(s.summary) as unknown;
      const arr = Array.isArray(p) ? p : [p];
      for (const n of arr) {
        const t = (n as { title?: unknown })?.title;
        if (t) existingTitles.push(String(t));
      }
    } catch { /* 忽略无法解析的旧数据 */ }
  }

  const out = await oneShotText(project.path, [
    '通读以下开发对话（用户需求 + AI 成果汇报），按「功能迭代/功能升级/关键里程碑」的语义边界拆出时间线节点。',
    '规则：',
    '- 按内容拆分，不按消息或对话边界：对话中每一项独立的功能迭代/升级/关键里程碑（方案定稿、部署上线、重大定型）→ 一个节点 {"title":"名称（10字内）","desc":"一句话说明（40字内，聚焦成果）"}',
    '- 同一件事的多个步骤/多条消息合并为一个节点；一件事只干了一半没有成果的不输出',
    '- 与已有节点是同一事件/同一功能的不重复输出',
    '- 纯过程性事项（修 bug、合并分支、提交、配置微调、清理仓库等）不输出',
    '- 没有值得输出的 → {"nodes": []}',
    '- 只输出 JSON：{"nodes": [...]}，不要输出其他内容',
    existingTitles.length > 0 ? `\n该功能时间线上已有节点（避免重复）：${existingTitles.join('、')}` : '',
    '',
    transcript,
  ].join('\n'));
  if (!out) {
    console.error('[features] 节点生成失败：AI 调用无返回', sessionId);
    return;
  }
  let nodes: { title: string; desc: string }[] = [];
  try {
    const parsed = JSON.parse(out.replace(/```json|```/g, '').trim()) as { nodes?: unknown };
    if (Array.isArray(parsed?.nodes)) {
      nodes = parsed.nodes
        .map((n) => ({
          title: String((n as { title?: unknown })?.title ?? '').slice(0, 30),
          desc: String((n as { desc?: unknown })?.desc ?? '').slice(0, 100),
        }))
        .filter((n) => n.title);
    }
  } catch { /* 解析失败视为无节点 */ }
  // 无节点（skip）→ summary 置空，前端不在时间线渲染该会话
  db.prepare('UPDATE feature_items SET summary = ? WHERE feature_id = ? AND ref_id = ?')
    .run(nodes.length > 0 ? JSON.stringify(nodes) : '', featureId, sessionId);
}

export function updateFeatureSummary(id: string, summary: string) {
  db.prepare('UPDATE features SET summary = ?, updated_at = ? WHERE id = ?').run(summary, Date.now(), id);
}

// ---------- 任务完成后的自动归档 ----------

/**
 * 任务验收完成后自动归档：
 * AI 先判断这次任务是否属于功能迭代——不是（部署/文档/修 bug/配置等）→ 不归档；
 * 是 → 决定归入某个已有功能卡片（成为新的时间线节点）还是新功能（新建卡片）。
 * 节点内容由其执行会话生成（summarizeSessionItem），任务条目本身只作 meta 展示。
 * 失败时降级为新建卡片 + 任务标题。
 */
export async function autoArchiveTask(taskId: string): Promise<void> {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
    { id: string; project_id: string; title: string; description: string; merge_commit: string | null; task_commit: string | null; session_id: string | null } | undefined;
  if (!task) return;
  const project = getProject(task.project_id);
  if (!project) return;

  // 已有归档则跳过（幂等）
  const exists = db.prepare(
    "SELECT 1 FROM feature_items fi WHERE fi.kind = 'task' AND fi.ref_id = ?",
  ).get(taskId);
  if (exists) return;

  let diffStat = '';
  const resultCommit = task.merge_commit ?? task.task_commit;
  if (resultCommit) {
    try {
      const { stdout } = await execFileAsync(
        'git', ['show', '--stat', '--format=%s', resultCommit],
        { cwd: project.path, timeout: 15_000 },
      );
      diffStat = stdout.slice(0, 3000);
    } catch { /* diff 拿不到就只用任务文本 */ }
  }

  const existing = listFeatures(task.project_id).map((f) => ({ id: f.id, title: f.title }));
  let attachId: string | null = null;
  let title = task.title;
  let summary = task.description || task.title;
  try {
    const out = await oneShotText(project.path, [
      '根据以下已完成的开发任务和该项目已有的功能列表，决定这个任务如何归档到功能演进。',
      '只输出 JSON：{"skip": false, "featureId": "已有功能的 id 或 null", "title": "新功能名（10字内，仅 featureId 为 null 时需要）", "summary": "这次迭代做了什么（60字内）"}',
      '判断标准：',
      '- 任务只是过程性事项（修 bug、合并分支、提交、配置微调、清理仓库等）→ {"skip": true}，其余字段省略（不上功能演进）',
      '- 功能迭代/功能升级，或关键里程碑（方案设计定稿、部署上线、重大版本定型）→ 归档：属于某个已有功能则 featureId 返回该功能的 id，全新功能方向返回 null',
      '',
      `任务标题：${task.title}`,
      `任务描述：${task.description || '无'}`,
      diffStat ? `代码变更概要：\n${diffStat}` : '',
      existing.length > 0
        ? `已有功能：\n${existing.map((f) => `- ${f.id} ${f.title}`).join('\n')}`
        : '已有功能：（空，必然是新功能）',
    ].join('\n'));
    if (out) {
      const parsed = JSON.parse(out.replace(/```json|```/g, '').trim()) as { skip?: unknown; featureId?: unknown; title?: unknown; summary?: unknown };
      // 非功能迭代：不归档（不建卡、不留空时间线）
      if (parsed.skip === true) return;
      // 校验返回的 id 真实存在，防幻觉
      if (typeof parsed.featureId === 'string' && existing.some((f) => f.id === parsed.featureId)) {
        attachId = parsed.featureId;
      }
      if (parsed.title) title = String(parsed.title).slice(0, 50);
      if (parsed.summary) summary = String(parsed.summary).slice(0, 500);
    }
  } catch { /* 判断失败时降级为新建卡片 */ }

  const feature = attachId
    ? listFeatures(task.project_id).find((f) => f.id === attachId)!
    : createFeature(task.project_id, title, summary);
  linkItem(feature.id, 'task', taskId);
  if (task.session_id) linkItem(feature.id, 'session', task.session_id);
}
