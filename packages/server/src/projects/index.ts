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
  created_at: number;
}

function toInfo(row: ProjectRow): ProjectInfo {
  return { id: row.id, name: row.name, path: row.path, gitUrl: row.git_url, createdAt: row.created_at };
}

export function listProjects(): ProjectInfo[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
  return rows.map(toInfo);
}

export function getProject(id: string): ProjectInfo | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? toInfo(row) : null;
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
export async function createProject(opts: { name: string; gitUrl?: string; existingPath?: string }): Promise<ProjectInfo> {
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

  db.prepare('INSERT INTO projects (id, name, path, git_url, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, opts.name, projectPath, opts.gitUrl ?? null, Date.now());
  return getProject(id)!;
}

export function deleteProject(id: string, deleteFiles: boolean) {
  const project = getProject(id);
  if (!project) throw new Error('project not found');
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  if (deleteFiles && project.path.startsWith(projectsDir)) {
    fs.rmSync(project.path, { recursive: true, force: true });
  }
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
