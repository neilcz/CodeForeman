import { randomUUID } from 'node:crypto';
import type { ClaudeAuthStyle, ClaudeProfileInfo, ClaudeProfileInput } from '@codeforeman/shared';
import { getSetting, setSetting } from './store.js';

/**
 * Claude 接入配置：可保存多套（网关地址/密钥/模型），选一套生效。
 * 存 settings kv 表；密钥只进不出——读接口给 ClaudeProfileInfo（hasApiKey 布尔），
 * 编辑时留空即保持原值。
 */

/** 落库形态：比读接口多一份密钥明文，供 spawn Claude 子进程时注入环境变量 */
interface StoredProfile {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  authStyle: ClaudeAuthStyle;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

const PROFILES_KEY = 'claude_profiles';
const ACTIVE_KEY = 'claude_active_profile';
const AUTH_STYLES: ClaudeAuthStyle[] = ['bearer', 'api-key'];

/** 模型相关环境变量：配置里填的模型名要一并覆盖这些别名（子代理/后台任务也走同一模型名） */
const MODEL_ENV_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/**
 * 「接入相关」环境变量的完整清单：只要有一套配置生效，就先整体清掉这些再按配置写入。
 * 配置是完整定义（留空 = 不设置该变量，走 CLI 默认），绝不能从 .env 继承——
 * 否则「换网关但密钥留空」会把上一家的 token 发给新网关（401 是轻的，等于泄露凭据）。
 * 其余变量（PATH/HOME、API_TIMEOUT_MS、CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 等）照常继承。
 */
const PROVIDER_ENV_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  ...MODEL_ENV_VARS,
];

/**
 * Base URL 归一化：Claude Code 会在 ANTHROPIC_BASE_URL 后面自己拼 `/v1/messages`，
 * 而用户很容易把完整端点整段粘进来（如 https://apipok.com/v1/messages），
 * 那样请求会打到 /v1/messages/v1/messages 得到 404——CLI 把 404 翻译成
 * 「There's an issue with the selected model…」，看起来像模型名写错，极难排查（2026-10-14 踩过）。
 * 只清这一段后缀，其余原样保留：有的网关 base url 带末尾斜杠或路径前缀（如 kimi 的 /coding/），
 * 多改一个字符都可能拼错路径。
 */
function normalizeBaseUrl(raw?: string): string {
  return (raw ?? '').trim().replace(/\/v1\/messages\/?$/i, '');
}

function readProfiles(): StoredProfile[] {
  const raw = getSetting(PROFILES_KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as StoredProfile[];
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string') : [];
  } catch {
    return [];
  }
}

function toInfo(p: StoredProfile): ClaudeProfileInfo {
  return {
    id: p.id,
    name: p.name,
    model: p.model,
    baseUrl: p.baseUrl,
    authStyle: p.authStyle,
    hasApiKey: !!p.apiKey,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** 全部配置（脱敏，无密钥；非管理员也能看到自己用的是什么） */
export function listClaudeProfiles(): ClaudeProfileInfo[] {
  return readProfiles().map(toInfo);
}

/** 当前生效的配置 id；null = 跟随服务器 .env（或配置已被删除） */
export function getActiveClaudeProfileId(): string | null {
  const id = getSetting(ACTIVE_KEY) ?? '';
  return readProfiles().some((p) => p.id === id) ? id : null;
}

/** 整份覆盖保存（配置列表短，前端全量提交最简单可靠）；返回脱敏后的新列表 */
export function saveClaudeProfiles(inputs: ClaudeProfileInput[]): ClaudeProfileInfo[] {
  if (!Array.isArray(inputs)) throw new Error('claudeProfiles 必须是数组');
  const prev = new Map(readProfiles().map((p) => [p.id, p]));
  const now = Date.now();
  const next = inputs.map((input): StoredProfile => {
    const name = input?.name?.trim();
    if (!name) throw new Error('每套配置都需要一个名称');
    const old = input.id ? prev.get(input.id) : undefined;
    const authStyle = AUTH_STYLES.includes(input.authStyle as ClaudeAuthStyle)
      ? (input.authStyle as ClaudeAuthStyle)
      : old?.authStyle ?? 'bearer';
    return {
      id: old?.id ?? randomUUID(),
      name,
      model: input.model?.trim() ?? '',
      baseUrl: normalizeBaseUrl(input.baseUrl),
      authStyle,
      // apiKey 省略 = 保持原值（前端不会回传已存密钥）；空串 = 清空
      apiKey: input.apiKey === undefined ? old?.apiKey ?? '' : input.apiKey.trim(),
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
  });
  const before = providerEnvRev();
  setSetting(PROFILES_KEY, JSON.stringify(next));
  // 生效的那套被删了 → 回落到 .env 默认
  const active = getSetting(ACTIVE_KEY) ?? '';
  if (active && !next.some((p) => p.id === active)) setSetting(ACTIVE_KEY, '');
  bumpEnvRev(before);
  return next.map(toInfo);
}

export function setActiveClaudeProfile(id: string | null) {
  const before = providerEnvRev();
  if (!id) {
    setSetting(ACTIVE_KEY, '');
  } else {
    if (!readProfiles().some((p) => p.id === id)) throw new Error('要生效的配置不存在');
    setSetting(ACTIVE_KEY, id);
  }
  bumpEnvRev(before);
}

function activeProfile(): StoredProfile | null {
  const id = getSetting(ACTIVE_KEY) ?? '';
  return id ? readProfiles().find((p) => p.id === id) ?? null : null;
}

/** 当前生效的模型端点（health / 设置页展示用，不含密钥） */
export function activeBaseUrl(): string | null {
  return activeProfile()?.baseUrl || null;
}

/** 生效配置对应的接入变量（只含被配置覆盖的那几个，不含 process.env 底噪） */
function providerEnv(): Record<string, string> | null {
  const p = activeProfile();
  if (!p) return null;
  const env: Record<string, string> = {};
  if (p.baseUrl) env.ANTHROPIC_BASE_URL = p.baseUrl;
  if (p.apiKey) {
    // 只带一种凭据：官方 API 同时收到 Authorization 与 x-api-key 会被拒
    if (p.authStyle === 'api-key') env.ANTHROPIC_API_KEY = p.apiKey;
    else env.ANTHROPIC_AUTH_TOKEN = p.apiKey;
  }
  if (p.model) for (const k of MODEL_ENV_VARS) env[k] = p.model;
  return env;
}

/** 变更检测用：同样的接入变量不需要重启任何进程 */
const providerEnvRev = () => JSON.stringify(providerEnv());
let envRev = 0;
function bumpEnvRev(before: string) {
  if (providerEnvRev() !== before) envRev++;
}

/**
 * 生效配置的版本号：每接入相关改动 +1。
 * 会话管理器拿它判断常驻的 Claude 进程要不要换环境重启（进程环境在 spawn 时固定，改不了）。
 */
export function claudeEnvRev(): number {
  return envRev;
}

/**
 * Claude 子进程环境：未选任何配置时返回 undefined，子进程照旧继承 process.env（与历史行为一致）。
 * 选了配置则返回整体环境——SDK 的 options.env 是「整体替换」而非合并，必须 spread process.env
 * 兜底 PATH/HOME/代理等；接入变量先整体清空再按配置写入（见 PROVIDER_ENV_VARS）。
 */
export function claudeEnv(): Record<string, string | undefined> | undefined {
  const overrides = providerEnv();
  if (!overrides) return undefined;
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of PROVIDER_ENV_VARS) delete env[k];
  Object.assign(env, overrides);
  return env;
}

/**
 * Claude 子进程的 SDK 选项片段（四处 spawn 点统一用）。
 *
 * 为什么不能只传 env：CLI 会读本机 `~/.claude/settings.json` 的 `env` 块，且它**盖过进程环境**——
 * 只传 env 时，用户本机那套网关/密钥/模型仍然生效，设置页里选的配置等于没换（实测：
 * 把 base url 指向本地探针，请求照样打到 settings.json 里的那家，探针一个字节都没收到）。
 * 所以选了配置就同时关掉「用户级」settings 来源（'project' 保留：仓库自己的 .claude 配置、
 * CLAUDE.md 等照旧加载，实测 CLAUDE.md 不受影响）。
 *
 * 没选配置时返回空对象：一切照旧（本机 claude 配置 + .env 都参与，与历史行为一致）。
 */
export function claudeSpawnOptions(): {
  env?: Record<string, string | undefined>;
  settingSources?: ('user' | 'project' | 'local')[];
} {
  const env = claudeEnv();
  return env ? { env, settingSources: ['project'] } : {};
}
