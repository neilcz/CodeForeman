/**
 * 权限策略回归测试（纯函数，不依赖数据库/服务进程，需先 npm run build）。
 * 背景：默认策略下 ExitPlanMode/AskUserQuestion 曾被 autoAllow 秒批，
 * 导致「先给方案我同意后再执行」被自动执行；此处锁定该行为不再回退。
 * 2026-10-16 起默认策略细化：删除按目标位置分级——/tmp 临时目录与本会话创建的文件放行，
 * 项目文件及磁盘其他位置仍需人工确认。
 *
 * 运行：node cf-permission-test.mjs
 */
import { shouldAutoAllow, isDeleteCommand, analyzeDeleteCommand, INTERACTIVE_TOOLS } from './packages/server/dist/settings/policy.js';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (期望 ${expected}，实际 ${actual})`}`);
}

const CWD = '/Users/me/proj';
const ctx = { cwd: CWD };
// 本会话创建的文件（绝对路径，模拟 session.ts 里 trackCreatedFiles 的记录）
const ctxWithSession = { cwd: CWD, sessionFiles: new Set(['/Users/me/proj/cf-tmp-test.mjs']) };

// --- 默认策略 allow-except-delete：交互类工具必须转人工 ---
check('默认策略: ExitPlanMode 不自动放行', shouldAutoAllow('allow-except-delete', 'ExitPlanMode', { plan: '...' }), false);
check('默认策略: AskUserQuestion 不自动放行', shouldAutoAllow('allow-except-delete', 'AskUserQuestion', { questions: [] }), false);
check('默认策略: 普通 Edit 自动放行', shouldAutoAllow('allow-except-delete', 'Edit', { file_path: '/a.ts' }), true);
check('默认策略: 普通 Bash(ls) 自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'ls -la' }), true);

// --- 默认策略：删除按目标位置分级 ---
check('默认策略: rm /tmp 下文件 自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -rf /tmp/x' }, ctx), true);
check('默认策略: rm 相对路径落在 /tmp 自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f a.log' }, { cwd: '/tmp' }), true);
check('默认策略: rm 项目文件 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f src/index.ts' }, ctx), false);
check('默认策略: rm 磁盘其他位置 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f /Users/me/notes.md' }, ctx), false);
check('默认策略: rm /tmp 本身 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -rf /tmp' }, ctx), false);
check('默认策略: 混合删除(/tmp+项目) 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f /tmp/a && rm -f src/b.ts' }, ctx), false);
check('默认策略: 变量目标无法判定 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -rf "$DIR"' }, ctx), false);
check('默认策略: git clean -fd 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'git clean -fd' }, ctx), false);
check('默认策略: git rm 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'git rm a.ts' }, ctx), false);
check('默认策略: find -delete 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: "find . -name '*.log' -delete" }, ctx), false);

// --- 默认策略：本会话创建的临时测试文件删除放行 ---
const ctxWithFeature = { cwd: CWD, sessionFiles: new Set(['/Users/me/proj/src/new-feature.ts']) };
check('默认策略: rm 本会话创建的临时测试文件 自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f cf-tmp-test.mjs' }, ctxWithSession), true);
check('默认策略: rm 本会话创建但非临时测试文件 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f src/new-feature.ts' }, ctxWithFeature), false);
check('默认策略: 同名文件但非本会话创建 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'rm -f cf-tmp-test.mjs' }, ctx), false);

// --- strict：一切转人工 ---
check('严格模式: ExitPlanMode 不自动放行', shouldAutoAllow('strict', 'ExitPlanMode', {}), false);
check('严格模式: AskUserQuestion 不自动放行', shouldAutoAllow('strict', 'AskUserQuestion', {}), false);
check('严格模式: Bash(ls) 不自动放行', shouldAutoAllow('strict', 'Bash', { command: 'ls' }), false);

// --- allow-all：完全托管，全部放行（含交互类与删除） ---
check('全部放行: ExitPlanMode 自动放行', shouldAutoAllow('allow-all', 'ExitPlanMode', { plan: '...' }), true);
check('全部放行: AskUserQuestion 自动放行', shouldAutoAllow('allow-all', 'AskUserQuestion', {}), true);
check('全部放行: Bash(rm 项目文件) 自动放行', shouldAutoAllow('allow-all', 'Bash', { command: 'rm -rf src' }, ctx), true);

// --- 删除命令分级 ---
check('analyzeDeleteCommand: 无删除 → none', analyzeDeleteCommand('ls -la', ctx), 'none');
check('analyzeDeleteCommand: rm /tmp → safe', analyzeDeleteCommand('rm -rf /tmp/x', ctx), 'safe');
check('analyzeDeleteCommand: rm 项目文件 → unsafe', analyzeDeleteCommand('rm -f src/a.ts', ctx), 'unsafe');
check('analyzeDeleteCommand: 带引号的 /tmp 路径 → safe', analyzeDeleteCommand('rm -f "/tmp/my file"', ctx), 'safe');
check('analyzeDeleteCommand: xargs rm → unsafe', analyzeDeleteCommand("find . -name '*.log' | xargs rm", ctx), 'unsafe');
check('analyzeDeleteCommand: sudo rm 项目文件 → unsafe', analyzeDeleteCommand('sudo rm -f /etc/hosts', ctx), 'unsafe');

// --- ssh 远端命令：递归分析远端删除目标（2026-10-16 真实 case：git archive | ssh "...rm -rf /tmp/... && docker build" 被误拦） ---
const SSH_DEPLOY = 'git archive HEAD backend-go deploy | ssh -i ~/Downloads/pok-hk.pem ubuntu@apipok.com "sudo rm -rf /tmp/.apibuild/backend-go /tmp/.apibuild/deploy && sudo mkdir -p /tmp/.apibuild && sudo tar -x -C /tmp/.apibuild && cd /tmp/.apibuild/deploy && sudo docker compose build go-backend 2>&1 | tail -5"';
check('默认策略: ssh 远端删 /tmp 自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: SSH_DEPLOY }, ctx), true);
check('默认策略: ssh 远端删项目路径 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'ssh ubuntu@h "rm -rf /srv/app/data"' }, ctx), false);
check('默认策略: ssh 远端混合删除(/tmp+其他) 不自动放行', shouldAutoAllow('allow-except-delete', 'Bash', { command: 'ssh -p 2222 ubuntu@h "rm -rf /tmp/a && rm -rf /srv/app"' }, ctx), false);
check('默认策略: 引号内的 && 不切分（ssh 嵌套完整解析）', analyzeDeleteCommand(SSH_DEPLOY, ctx), 'safe');

// --- 临时测试文件命名判定 ---
import { isTempTestFile } from './packages/server/dist/settings/policy.js';
check('isTempTestFile: cf-permission-test.mjs', isTempTestFile('/proj/cf-permission-test.mjs'), true);
check('isTempTestFile: a.test.ts', isTempTestFile('/proj/a.test.ts'), true);
check('isTempTestFile: scratch.py', isTempTestFile('/proj/scratch.py'), true);
check('isTempTestFile: src/index.ts', isTempTestFile('/proj/src/index.ts'), false);
check('isTempTestFile: contest.ts 不误伤', isTempTestFile('/proj/contest.ts'), false);
check('isTempTestFile: latest.log 不误伤', isTempTestFile('/proj/latest.log'), false);

// --- 删除命令探测 ---
check('isDeleteCommand: rm -rf', isDeleteCommand('rm -rf /tmp/a'), true);
check('isDeleteCommand: find -delete', isDeleteCommand("find . -name '*.log' -delete"), true);
check('isDeleteCommand: ls', isDeleteCommand('ls -la'), false);
check('isDeleteCommand: grep rm 字符串不误伤？（已知启发式会误拦，宁可误拦）', isDeleteCommand('echo "rm is dangerous"'), true);

// --- 交互工具集合 ---
check('INTERACTIVE_TOOLS 含 ExitPlanMode', INTERACTIVE_TOOLS.has('ExitPlanMode'), true);
check('INTERACTIVE_TOOLS 含 AskUserQuestion', INTERACTIVE_TOOLS.has('AskUserQuestion'), true);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
