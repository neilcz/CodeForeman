import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载仓库根目录的 .env（Claude/Kimi 凭证、项目目录等）。
// loadEnvFile 不覆盖已有环境变量，因此 Docker/多配置注入仍然优先。
const envFile = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const config = {
  port: Number(process.env.PORT ?? 3780),
  host: process.env.HOST ?? '0.0.0.0',
  /** 数据根目录：Docker 内为 /data，裸服务/本地开发默认为仓库根下的 data/（可用 DATA_DIR 覆盖，如 ~/.codeforeman） */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data'),
  /** web 构建产物目录 */
  webDist: process.env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist'),
  version: '0.1.0',
  /** 当前接入的模型端点（仅展示用，不泄露 token） */
  endpoint: process.env.ANTHROPIC_BASE_URL ?? null,
  /** 权限确认等待超时：超时自动拒绝（拒绝必留痕，见 session.ts），防止进程无限挂起。所有确认统一 10 分钟 */
  permissionTimeoutMs: 600_000,
} as const;

/**
 * 项目根目录：每个一级子文件夹即一个项目（自动发现）。
 * 默认 <dataDir>/projects；可用 PROJECTS_DIR 指向任意已有目录，
 * 裸服务/本机开发直接指向真实目录，如 PROJECTS_DIR=/Users/neilcz/project；
 * Docker 部署则把宿主机目录挂进容器并指向挂载点。
 */
export const projectsDir = process.env.PROJECTS_DIR ?? path.join(config.dataDir, 'projects');
export const dbDir = path.join(config.dataDir, 'db');
/** 应用自管的 SSH key 目录（git clone/push 用） */
export const sshKeysDir = path.join(config.dataDir, 'ssh-keys');
/** 聊天附件目录：<uploadsDir>/<sessionId>/<file> */
export const uploadsDir = path.join(config.dataDir, 'uploads');
/** 并行计划的独立 git worktree 根目录：<worktreesDir>/<taskId> */
export const worktreesDir = path.join(config.dataDir, 'worktrees');
// 显式配置的 PROJECTS_DIR 不存在时直接报错（防手滑写错路径后静默建错目录）
if (process.env.PROJECTS_DIR && !fs.existsSync(projectsDir)) {
  throw new Error(`PROJECTS_DIR 不存在: ${projectsDir}`);
}
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(dbDir, { recursive: true });
fs.mkdirSync(sshKeysDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(worktreesDir, { recursive: true });
