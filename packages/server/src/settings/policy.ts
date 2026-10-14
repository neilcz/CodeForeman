import type { PermissionPolicy } from '@codeforeman/shared';

/**
 * 权限判定纯函数（不依赖 db，便于单测）。
 * settings/index.ts 用当前持久化策略包装 shouldAutoAllow 对外提供 autoAllow。
 */

/**
 * 交互类工具：存在的唯一用途就是停下来收集人的决定
 * （ExitPlanMode=方案确认，AskUserQuestion=选项提问）。
 * 自动放行等于替用户拍板——用户说「先给方案我同意后再执行」时方案会被秒批，
 * 所以除 allow-all（明确的完全托管模式）外一律转人工确认。
 */
export const INTERACTIVE_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion']);

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

/** 按给定策略，该工具调用是否无需人工确认直接放行 */
export function shouldAutoAllow(
  policy: PermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  // 交互类工具只在完全托管模式下自动放行
  if (INTERACTIVE_TOOLS.has(toolName)) return policy === 'allow-all';
  if (policy === 'strict') return false;
  if (policy === 'allow-all') return true;
  // allow-except-delete：删除文件的 Bash 命令仍需确认
  return !(toolName === 'Bash' && typeof input.command === 'string' && isDeleteCommand(input.command));
}
