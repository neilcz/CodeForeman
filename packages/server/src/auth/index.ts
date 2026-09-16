import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';

export interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

interface UserRow extends AuthUser {
  password_hash: string;
}

const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天

function hashPassword(password: string, salt?: string): string {
  const s = salt ?? randomBytes(16).toString('hex');
  return `${s}:${scryptSync(password, s, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const candidate = hashPassword(password, salt).split(':')[1];
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

/** 首次启动播种 admin：密码取 ADMIN_PASSWORD，默认 admin（日志会告警） */
export function seedAdmin(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  const password = process.env.ADMIN_PASSWORD || 'admin';
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), 'admin', hashPassword(password), 'admin', Date.now());
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[CodeForeman] 已创建默认管理员 admin/admin，请尽快通过 ADMIN_PASSWORD 重置');
  }
  // 存量无归属的项目归 admin 所有
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get() as { id: string };
  db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL').run(admin.id);
}

export function login(username: string, password: string): string | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, row.id, Date.now(), Date.now() + TOKEN_TTL);
  return token;
}

export function resolveToken(token: string | undefined): AuthUser | null {
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.id, u.username, u.role FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND t.expires_at > ?',
  ).get(token, Date.now()) as AuthUser | undefined;
  return row ?? null;
}

export function logout(token: string) {
  db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
}

export function listUsers(): AuthUser[] {
  return db.prepare('SELECT id, username, role FROM users ORDER BY created_at').all() as AuthUser[];
}

export function createUser(username: string, password: string, role: 'admin' | 'user' = 'user'): AuthUser {
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) throw new Error('用户名仅限字母数字-_，2-32 位');
  if (password.length < 4) throw new Error('密码至少 4 位');
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, hashPassword(password), role, Date.now());
  return { id, username, role };
}
