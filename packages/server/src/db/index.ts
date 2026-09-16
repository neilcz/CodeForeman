import path from 'node:path';
import Database from 'better-sqlite3';
import { dbDir } from '../config.js';

export const db = new Database(path.join(dbDir, 'codeforeman.db'));
db.pragma('journal_mode = WAL');

/**
 * 极简 migration：PRAGMA user_version 记录版本，数组下标即目标版本。
 * 每个元素是升到该版本要执行的 SQL（不可变，只追加）。
 */
const migrations: string[] = [
  // v1: 初始 schema
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    claude_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
  `,
  // v2: 项目管理 —— projects 表 + sessions 归属项目
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    git_url TEXT,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id);
  `,
  // v3: Backlog —— 想法/计划任务
  `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'draft',
    auto_merge INTEGER NOT NULL DEFAULT 1,
    branch TEXT,
    session_id TEXT,
    merge_commit TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
  `,
  // v4: 功能演进 —— features + 关联项（session/task）
  `
  CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feature_items (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL REFERENCES features(id),
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(feature_id, kind, ref_id)
  );
  CREATE INDEX IF NOT EXISTS idx_feature_items ON feature_items(feature_id, created_at);
  `,
  // v5: 多用户 —— users/tokens + 项目归属与可见性
  `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id);
  ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
  `,
];

export function migrate() {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let v = current + 1; v <= migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v - 1]);
      db.pragma(`user_version = ${v}`);
    })();
  }
}

migrate();
