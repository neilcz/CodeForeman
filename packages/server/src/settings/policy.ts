import os from 'node:os';
import path from 'node:path';
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

/** 放行判定的上下文：解析命令里的相对路径、识别本会话创建的临时测试文件 */
export interface AutoAllowContext {
  /** 会话工作目录（命令里相对路径按它解析） */
  cwd?: string;
  /** 本会话中 Claude 自己创建的文件（绝对路径集合），其中临时测试文件的删除属于收尾清理，无需确认 */
  sessionFiles?: ReadonlySet<string>;
}

/**
 * 临时测试文件的命名特征：basename 的分隔段里含 test/tmp/temp/scratch/e2e 等
 * （cf-permission-test.mjs、a.test.ts、tmp-x.sh、scratch.py 命中；contest.ts、latest.log 不命中）。
 * 只有这类文件才会在「本会话创建」时被免除删除确认——Write 了 src/feature.ts 再删掉仍需确认。
 */
const TEMP_TEST_NAME = /(?:^|[-_.])(tests?|tmp|temp|scratch|e2e|fixture|playground)(?=[-_.]|$)/i;

export function isTempTestFile(absPath: string): boolean {
  return TEMP_TEST_NAME.test(path.basename(absPath));
}

/**
 * 系统临时目录集合（绝对路径）。rm 目标全部落在这些目录之下时视为安全的临时文件清理。
 * macOS 上 /tmp、/var 是指向 /private/... 的软链，命令里写哪种前缀都可能，两个形态都收。
 */
const TMP_DIRS = (() => {
  const dirs = new Set<string>();
  for (const d of [os.tmpdir(), '/tmp', '/var/tmp']) {
    dirs.add(path.resolve(d));
    if (d.startsWith('/private/')) dirs.add(path.resolve(d.slice('/private'.length)));
    else dirs.add(path.resolve(`/private${d}`));
  }
  return [...dirs];
})();

/** target 是否严格位于 dir 之下（不含 dir 本身——防止 rm -rf /tmp 把临时目录整个端掉） */
function isStrictlyUnder(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 单个删除目标是否安全：在系统临时目录下，或属于本会话创建的临时测试文件 */
function deleteTargetSafe(raw: string, cwd: string, sessionFiles?: ReadonlySet<string>): boolean {
  // 含变量/命令替换/家目录展开的目标无法静态判定，一律按不安全处理
  if (/[$`~]/.test(raw)) return false;
  const abs = path.resolve(cwd, raw);
  if (TMP_DIRS.some((d) => isStrictlyUnder(abs, d))) return true;
  return (sessionFiles?.has(abs) ?? false) && isTempTestFile(abs);
}

/** 按 shell 语句切分命令（&&/||/;/|/换行）。引号内的分隔符不切——ssh "远端命令" 这类嵌套命令必须保持完整 */
function splitStatements(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (ch === ';' || ch === '|' || ch === '\n') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 分词并去掉成对引号（rm "/tmp/a b" 这类带空格路径要能整体取出） */
function tokenize(statement: string): string[] {
  const m = statement.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return m.map((t) => t.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
}

/** 提取 rm 系命令的目标参数：跳过选项，-- 之后全部是目标 */
function extractTargets(args: string[]): string[] {
  const out: string[] = [];
  let flagsDone = false;
  for (const a of args) {
    if (!flagsDone && a === '--') { flagsDone = true; continue; }
    if (!flagsDone && a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

/** ssh 选项中带值的单字母选项（取值在下一个 token）；-p2222 这类粘连写法不占位 */
const SSH_VALUE_OPTS = new Set(['i', 'p', 'l', 'o', 'F', 'J', 'L', 'R', 'D', 'W', 'b', 'c', 'm', 'S', 'w']);

/** 从 ssh 参数里取出远端命令串：跳过选项与 host，剩余部分拼回一条命令 */
function extractSshRemoteCommand(args: string[]): string | null {
  let j = 0;
  while (j < args.length && args[j].startsWith('-')) {
    const opt = args[j].replace(/^-+/, '');
    j += SSH_VALUE_OPTS.has(opt[0]) && opt.length === 1 ? 2 : 1;
  }
  j++; // 跳过 host（user@host）
  if (j >= args.length) return null;
  return args.slice(j).join(' ');
}

/**
 * 判定一个语句是否为删除语句。
 * - targets=null：是删除但目标无法静态枚举（git rm/clean、find -delete、xargs rm），按不安全处理
 * - nested：ssh 包装的远端命令，需要递归分析（远端 /tmp 清理与本地同等对待）
 */
function classifyStatement(tokens: string[]): { isDelete: boolean; targets?: string[] | null; nested?: string } {
  // 剥掉前导环境变量赋值与 sudo
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'sudo')) i++;
  const cmd = tokens[i]?.replace(/^.*\//, ''); // /bin/rm → rm
  if (!cmd) return { isDelete: false };
  if (cmd === 'ssh') {
    const nested = extractSshRemoteCommand(tokens.slice(i + 1));
    return nested ? { isDelete: true, nested } : { isDelete: false };
  }
  if (cmd === 'find') {
    return tokens.includes('-delete') ? { isDelete: true, targets: null } : { isDelete: false };
  }
  if (cmd === 'git') {
    const sub = tokens[i + 1];
    const isDelete = sub === 'rm' || sub === 'clean';
    return { isDelete, targets: null }; // git 操作的一定是仓库文件，直接按不安全处理
  }
  if (cmd === 'gio' && tokens[i + 1] === 'trash') {
    return { isDelete: true, targets: extractTargets(tokens.slice(i + 2)) };
  }
  if (['rm', 'rmdir', 'unlink', 'shred', 'trash'].includes(cmd)) {
    return { isDelete: true, targets: extractTargets(tokens.slice(i + 1)) };
  }
  // xargs rm：rm 藏在参数里，目标来自管道，无法静态枚举
  if (cmd === 'xargs' && tokens.slice(i + 1).some((t) => t.replace(/^.*\//, '') === 'rm')) {
    return { isDelete: true, targets: null };
  }
  return { isDelete: false };
}

/**
 * 删除命令分级：
 * - none：不含删除
 * - safe：含删除，但所有目标都在系统临时目录下或属于本会话创建的临时测试文件 → 可自动放行
 * - unsafe：含删除且目标涉及项目文件/磁盘其他位置，或目标无法静态判定 → 需人工确认
 *
 * 解析不出来的一律 unsafe（宁可误拦）：isDeleteCommand 命中但逐句分析找不到删除语句
 * （如 echo "rm is dangerous"）也按 unsafe 拦，与旧行为一致。
 */
export function analyzeDeleteCommand(command: string, ctx: AutoAllowContext = {}, depth = 0): 'none' | 'safe' | 'unsafe' {
  if (!isDeleteCommand(command)) return 'none';
  const cwd = ctx.cwd ?? process.cwd();
  let sawDelete = false;
  for (const statement of splitStatements(command)) {
    const c = classifyStatement(tokenize(statement));
    if (!c.isDelete) continue;
    // ssh 远端命令：递归分析（嵌套层数设上限，防止 ssh 套 ssh 无限深入）
    if (c.nested !== undefined) {
      if (depth >= 3) return 'unsafe';
      const r = analyzeDeleteCommand(c.nested, ctx, depth + 1);
      if (r === 'none') continue;
      sawDelete = true;
      if (r === 'unsafe') return 'unsafe';
      continue;
    }
    sawDelete = true;
    if (!c.targets || c.targets.length === 0) return 'unsafe';
    for (const t of c.targets) {
      if (!deleteTargetSafe(t, cwd, ctx.sessionFiles)) return 'unsafe';
    }
  }
  return sawDelete ? 'safe' : 'unsafe';
}

/** 按给定策略，该工具调用是否无需人工确认直接放行 */
export function shouldAutoAllow(
  policy: PermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
  ctx: AutoAllowContext = {},
): boolean {
  // 交互类工具只在完全托管模式下自动放行
  if (INTERACTIVE_TOOLS.has(toolName)) return policy === 'allow-all';
  if (policy === 'strict') return false;
  if (policy === 'allow-all') return true;
  // allow-except-delete：删除命令按目标位置分级——临时目录/本会话创建的临时测试文件直接放行，
  // 项目文件及磁盘其他位置的删除仍需人工确认
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return analyzeDeleteCommand(input.command, ctx) !== 'unsafe';
  }
  return true;
}
