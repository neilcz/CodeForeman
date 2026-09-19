import { db } from '../db/index.js';
import type { InstructionItem, PermissionPolicy } from '@codeforeman/shared';

const DEFAULT_POLICY: PermissionPolicy = 'allow-except-delete';
const POLICIES: PermissionPolicy[] = ['strict', 'allow-except-delete', 'allow-all'];

function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function setSetting(key: string, value: string) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getPermissionPolicy(): PermissionPolicy {
  const v = getSetting('permission_policy');
  return (POLICIES as string[]).includes(v ?? '') ? (v as PermissionPolicy) : DEFAULT_POLICY;
}

export function setPermissionPolicy(policy: PermissionPolicy) {
  if (!(POLICIES as string[]).includes(policy)) throw new Error(`未知策略: ${policy}`);
  setSetting('permission_policy', policy);
}

// ---------- 全局指令（注入每个 Claude 会话的系统提示词） ----------

/**
 * 预置默认条目。仅在用户从未保存过指令列表时生效；
 * 一旦管理员在设置页保存（哪怕删空），就以库里为准。
 */
const DEFAULT_INSTRUCTIONS: InstructionItem[] = [
  {
    id: 'default-db-redis',
    enabled: true,
    text: [
      '【PostgreSQL/Redis 复用】当前项目需要连接或配置 PostgreSQL、Redis 这类持久化服务时：',
      '1. 先检查是否已有实例在运行（其他项目可能已启动过：探测本机及局域网的常用端口 5432/6379 等，可尝试连接或询问用户）；',
      '2. 已有实例则直接使用它，不要创建新实例——在已有实例上为当前项目新建独立的 database、或用 key 前缀做隔离即可；',
      '3. 确认没有任何可用实例时才考虑新增：优先在 docker compose 里起独立服务容器并告知用户，不要在当前工作环境内直接安装（apt-get install 等），环境重建后服务和数据都会丢失；',
      '4. 连接地址写入项目的环境变量/配置文件（如 .env），注明复用的是哪个已有实例，不要硬编码。',
    ].join('\n'),
  },
];

export function getInstructions(): InstructionItem[] {
  const raw = getSetting('global_instructions');
  if (raw === undefined) return DEFAULT_INSTRUCTIONS;
  try {
    const list = JSON.parse(raw) as InstructionItem[];
    return Array.isArray(list) ? list.filter((i) => i && typeof i.text === 'string') : [];
  } catch {
    return [];
  }
}

export function setInstructions(items: InstructionItem[]) {
  if (!Array.isArray(items)) throw new Error('instructions 必须是数组');
  const clean = items.map((i) => {
    if (!i?.id || typeof i.text !== 'string' || !i.text.trim()) {
      throw new Error('每条指令需要 id 和非空 text');
    }
    return { id: String(i.id), text: i.text.trim(), enabled: i.enabled !== false };
  });
  setSetting('global_instructions', JSON.stringify(clean));
}

/** 拼接启用中的指令，注入 Claude 系统提示词；全停用/为空时不注入 */
export function instructionPrompt(): string | undefined {
  const parts = getInstructions().filter((i) => i.enabled).map((i) => i.text);
  return parts.length ? parts.join('\n\n') : undefined;
}

/**
 * 删除类 Bash 命令探测（启发式，宁可误拦不可漏放——误拦的代价只是多一次确认）。
 * 覆盖：rm/rmdir/unlink/shred、git rm/git clean、find -delete、trash 系。
 * 已知漏网：python/node 脚本里的 rmtree 等 API 调用（无法静态识别）。
 */
const DELETE_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\bshred\b/,
  /\bgit\s+rm\b/,
  /\bgit\s+clean\b/,
  /\bfind\b[\s\S]*?\s-delete\b/,
  /\b(gio\s+)?trash\b/,
];

export function isDeleteCommand(command: string): boolean {
  return DELETE_PATTERNS.some((re) => re.test(command));
}

/** 按当前策略，该工具调用是否无需人工确认直接放行 */
export function autoAllow(toolName: string, input: Record<string, unknown>): boolean {
  const policy = getPermissionPolicy();
  if (policy === 'strict') return false;
  if (policy === 'allow-all') return true;
  // allow-except-delete：删除文件的 Bash 命令仍需确认
  return !(toolName === 'Bash' && typeof input.command === 'string' && isDeleteCommand(input.command));
}
