import { db } from '../db/index.js';

/**
 * 全局设置的 kv 存取层（settings 表）。权限策略、全局指令、Claude 接入配置等都走这里，
 * 具体模块各自负责自己的 key 与编解码。
 */
export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
