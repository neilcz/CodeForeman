import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db/index.js';
import { projectsDir } from '../config.js';
import type { FileNode, ProjectInfo } from '@codeforeman/shared';

const execFileAsync = promisify(execFile);

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  git_url: string | null;
  owner_id: string | null;
  visibility: 'private' | 'public';
  managed: number;
  created_at: number;
}

function toInfo(row: ProjectRow): ProjectInfo {
  return {
    id: row.id, name: row.name, path: row.path, gitUrl: row.git_url,
    ownerId: row.owner_id, visibility: row.visibility, managed: row.managed === 1, createdAt: row.created_at,
  };
}

/** 可见项目：admin 全部；普通用户 = 自己的 + 公共的 */
export function listProjects(user: { id: string; role: string }): ProjectInfo[] {
  const rows = (user.role === 'admin'
    ? db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
    : db.prepare("SELECT * FROM projects WHERE owner_id = ? OR visibility = 'public' ORDER BY created_at DESC").all(user.id)
  ) as ProjectRow[];
  return rows.map(toInfo);
}

export function getProject(id: string): ProjectInfo | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? toInfo(row) : null;
}

export function canAccess(user: { id: string; role: string }, projectId: string): boolean {
  if (user.role === 'admin') return true;
  const row = db.prepare('SELECT owner_id, visibility FROM projects WHERE id = ?').get(projectId) as
    { owner_id: string | null; visibility: string } | undefined;
  if (!row) return false;
  return row.owner_id === user.id || row.visibility === 'public';
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '');
  return s || `project-${Date.now()}`;
}

/**
 * 创建项目：
 * - 传 gitUrl → clone 到 /data/projects/<slug>
 * - 传 existingPath → 纳管宿主机已有目录（需为绝对路径且存在）
 * - 都不传 → 新建空目录并 git init
 */
export async function createProject(opts: { name: string; gitUrl?: string; existingPath?: string; ownerId?: string; visibility?: 'private' | 'public' }): Promise<ProjectInfo> {
  const id = randomUUID();
  let projectPath: string;

  if (opts.existingPath) {
    projectPath = path.resolve(opts.existingPath);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      throw new Error(`目录不存在: ${projectPath}`);
    }
  } else {
    projectPath = path.join(projectsDir, slugify(opts.name));
    if (fs.existsSync(projectPath)) throw new Error(`目录已存在: ${projectPath}`);
    if (opts.gitUrl) {
      await execFileAsync('git', ['clone', opts.gitUrl, projectPath], { timeout: 300_000 });
    } else {
      fs.mkdirSync(projectPath, { recursive: true });
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectPath });
    }
  }

  db.prepare('INSERT INTO projects (id, name, path, git_url, owner_id, visibility, managed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, opts.name, projectPath, opts.gitUrl ?? null, opts.ownerId ?? null, opts.visibility ?? 'private',
      opts.existingPath ? 0 : 1, Date.now());
  return getProject(id)!;
}

export function deleteProject(id: string, deleteFiles: boolean) {
  const project = getProject(id);
  if (!project) throw new Error('project not found');
  // 扫描/纳管的目录（managed=0）绝不删文件；只有工具自己创建的才允许连带删除
  const managed = (db.prepare('SELECT managed FROM projects WHERE id = ?').get(id) as { managed: number } | undefined)?.managed;
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  if (deleteFiles && managed === 1 && project.path.startsWith(projectsDir)) {
    fs.rmSync(project.path, { recursive: true, force: true });
  }
}

// ---------- 目录自动发现 ----------

/**
 * 扫描项目根目录：每个一级子文件夹注册为一个项目。
 * 已注册（path 唯一）的跳过；隐藏目录、软链跳过；非 git 仓库原样保留。
 * 新发现的项目归属 admin，默认私有（宁漏共享不漏隐私）。
 */
export function scanProjectsDir(): { added: ProjectInfo[]; skipped: number } {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get() as
    { id: string } | undefined;
  const added: ProjectInfo[] = [];
  let skipped = 0;

  for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(projectsDir, e.name);
    if (fs.lstatSync(full).isSymbolicLink()) continue;
    if (db.prepare('SELECT 1 FROM projects WHERE path = ?').get(full)) {
      skipped++;
      continue;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO projects (id, name, path, git_url, owner_id, visibility, managed, created_at) VALUES (?, ?, ?, NULL, ?, 'private', 0, ?)",
    ).run(id, e.name, full, admin?.id ?? null, Date.now());
    added.push(getProject(id)!);
  }
  return { added, skipped };
}

/** 对未初始化的项目目录执行 git init */
export async function gitInit(id: string): Promise<void> {
  const project = getProject(id);
  if (!project) throw new Error('project not found');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: project.path });
}

// ---------- 文件操作（全部限制在项目根目录内） ----------

function resolveSafe(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('路径越界');
  }
  return abs;
}

const IGNORED = new Set(['.git', 'node_modules', 'dist', '.DS_Store']);
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;
const MAX_FILE_SIZE = 1024 * 1024;

export function fileTree(root: string): FileNode[] {
  let count = 0;
  const walk = (dir: string, rel: string, depth: number): FileNode[] => {
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !IGNORED.has(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (++count > MAX_ENTRIES) break;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: childRel, type: 'dir', children: walk(path.join(dir, e.name), childRel, depth + 1) });
      } else {
        nodes.push({ name: e.name, path: childRel, type: 'file' });
      }
    }
    return nodes;
  };
  return walk(root, '', 0);
}

export function readFile(root: string, rel: string): string {
  const abs = resolveSafe(root, rel);
  const stat = fs.statSync(abs);
  if (stat.size > MAX_FILE_SIZE) throw new Error(`文件过大（>${MAX_FILE_SIZE / 1024}KB），暂不支持编辑`);
  return fs.readFileSync(abs, 'utf8');
}

export function writeFile(root: string, rel: string, content: string) {
  const abs = resolveSafe(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}
