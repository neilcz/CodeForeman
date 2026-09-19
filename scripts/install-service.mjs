#!/usr/bin/env node
/**
 * CodeForeman 常驻服务安装器（跨平台）
 *
 * 自动检测操作系统选择启动方式：
 *   macOS  → launchd（~/Library/LaunchAgents/com.codeforeman.plist）
 *   Linux  → systemd user unit（~/.config/systemd/user/）；root 运行时装系统级 unit
 *   Windows→ 任务计划程序（登录时自启，schtasks）
 *
 * 用法：
 *   node scripts/install-service.mjs            # 安装并启动
 *   node scripts/install-service.mjs uninstall  # 停止并卸载
 *   node scripts/install-service.mjs restart    # 重启
 *
 * 注意：常驻服务不继承你的 shell 环境。脚本会把当前 PATH 固化进服务配置，
 * 之后新增工具链（JDK/Android SDK/uniapp cli 等）需要重新运行本脚本刷新。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'packages/server/dist/index.js');
const NODE = process.execPath;
const LABEL = 'com.codeforeman';
const action = process.argv[2] ?? 'install';

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function ensureBuilt() {
  if (!fs.existsSync(ENTRY)) {
    console.error('未找到构建产物 packages/server/dist/index.js，请先执行：npm install && npm run build');
    process.exit(1);
  }
  fs.mkdirSync(path.join(REPO, 'data/logs'), { recursive: true });
}

/** 常驻服务使用的 PATH：当前 shell PATH + 常见工具链目录（去重、只保留存在的） */
function servicePath() {
  const extras = {
    darwin: ['/opt/homebrew/bin', '/usr/local/bin'],
    linux: ['/usr/local/bin', '/usr/bin', '/bin'],
    win32: [],
  }[process.platform] ?? [];
  const parts = [...(process.env.PATH ?? '').split(path.delimiter), ...extras];
  return [...new Set(parts)].filter((p) => p && fs.existsSync(p)).join(path.delimiter);
}

// ---------- macOS (launchd) ----------
const plistPath = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);

function plistContent() {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(NODE)}</string>
    <string>${esc(ENTRY)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(REPO)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(servicePath())}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(REPO)}/data/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${esc(REPO)}/data/logs/launchd.err.log</string>
</dict>
</plist>
`;
}

function darwinInstall() {
  fs.writeFileSync(plistPath, plistContent());
  console.log(`已写入 ${plistPath}`);
  const domain = `gui/${process.getuid()}`;
  try { run('launchctl', ['bootout', `${domain}/${LABEL}`]); } catch { /* 未加载过 */ }
  run('launchctl', ['bootstrap', domain, plistPath]);
  run('launchctl', ['kickstart', `${domain}/${LABEL}`]);
  console.log(`✅ 服务已启动。管理：launchctl kickstart -k ${domain}/${LABEL}（重启）/ launchctl bootout ${domain}/${LABEL}（停止）`);
}

function darwinUninstall() {
  const domain = `gui/${process.getuid()}`;
  try { run('launchctl', ['bootout', `${domain}/${LABEL}`]); } catch { /* 未加载 */ }
  fs.rmSync(plistPath, { force: true });
  console.log('✅ 已卸载');
}

// ---------- Linux (systemd) ----------
function linuxPaths() {
  const isRoot = process.getuid() === 0;
  return {
    isRoot,
    unitDir: isRoot ? '/etc/systemd/system' : path.join(os.homedir(), '.config/systemd/user'),
    systemctl: isRoot ? ['systemctl'] : ['systemctl', '--user'],
  };
}

function linuxUnit() {
  return `[Unit]
Description=CodeForeman - AI coding foreman
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO}
ExecStart=${NODE} ${ENTRY}
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${servicePath()}
# 资源限制（对应原 docker compose 的 4 CPU / 4G 内存），按需调整
CPUQuota=400%
MemoryMax=4G

[Install]
WantedBy=${linuxPaths().isRoot ? 'multi-user.target' : 'default.target'}
`;
}

function linuxInstall() {
  const { unitDir, systemctl, isRoot } = linuxPaths();
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, 'codeforeman.service');
  fs.writeFileSync(unitPath, linuxUnit());
  console.log(`已写入 ${unitPath}`);
  run(systemctl[0], [...systemctl.slice(1), 'daemon-reload']);
  run(systemctl[0], [...systemctl.slice(1), 'enable', '--now', 'codeforeman']);
  if (!isRoot) {
    // 用户级服务默认只在登录会话内运行；linger 让它开机自启、注销不停
    try { run('loginctl', ['enable-linger', os.userInfo().username]); } catch { /* 无 loginctl 则跳过 */ }
  }
  console.log('✅ 服务已启动。日志：journalctl ' + (isRoot ? '-u' : '--user -u') + ' codeforeman -f');
}

function linuxUninstall() {
  const { unitDir, systemctl } = linuxPaths();
  try { run(systemctl[0], [...systemctl.slice(1), 'disable', '--now', 'codeforeman']); } catch { /* 未启用 */ }
  fs.rmSync(path.join(unitDir, 'codeforeman.service'), { force: true });
  run(systemctl[0], [...systemctl.slice(1), 'daemon-reload']);
  console.log('✅ 已卸载');
}

// ---------- Windows (任务计划程序) ----------
const TASK = 'CodeForeman';

function win32Install() {
  // 用 cmd 包装以设置工作目录并落日志；/sc onlogon 登录即启动
  const logDir = path.join(REPO, 'data', 'logs');
  const cmd = `cmd /c "cd /d "${REPO}" && "${NODE}" "${ENTRY}" >> "${logDir}\\service.out.log" 2>&1"`;
  run('schtasks', ['/create', '/f', '/tn', TASK, '/sc', 'onlogon', '/rl', 'limited', '/tr', cmd]);
  run('schtasks', ['/run', '/tn', TASK]);
  console.log(`✅ 任务已创建并启动。管理：schtasks /end /tn ${TASK}（停止）/ taskschd.msc（图形界面）`);
}

function win32Uninstall() {
  try { run('schtasks', ['/end', '/tn', TASK]); } catch { /* 未运行 */ }
  try { run('schtasks', ['/delete', '/f', '/tn', TASK]); } catch { /* 不存在 */ }
  console.log('✅ 已卸载');
}

// ---------- 分发 ----------
const handlers = {
  darwin: { install: darwinInstall, uninstall: darwinUninstall },
  linux: { install: linuxInstall, uninstall: linuxUninstall },
  win32: { install: win32Install, uninstall: win32Uninstall },
};

const platform = handlers[process.platform];
if (!platform) {
  console.error(`不支持的平台: ${process.platform}`);
  process.exit(1);
}

if (action === 'install') {
  ensureBuilt();
  platform.install();
} else if (action === 'uninstall') {
  platform.uninstall();
} else if (action === 'restart') {
  platform.uninstall();
  ensureBuilt();
  platform.install();
} else {
  console.error('用法: node scripts/install-service.mjs [install|uninstall|restart]');
  process.exit(1);
}
