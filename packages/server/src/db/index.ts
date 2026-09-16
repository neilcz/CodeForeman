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
