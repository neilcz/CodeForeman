import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 加载仓库根目录的 .env（Claude/Kimi 凭证等）。Docker 中由 compose env_file 直接注入，跳过。
const envFile = path.resolve(__dirname, '../../../.env');
if (!process.env.ANTHROPIC_AUTH_TOKEN && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export const config = {
  port: Number(process.env.PORT ?? 3780),
  host: process.env.HOST ?? '0.0.0.0',
  /** 数据根目录：Docker 内为 /data，本地开发为仓库根下的 data/ */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data'),
  /** web 构建产物目录 */
  webDist: process.env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist'),
  version: '0.1.0',
  /** 当前接入的模型端点（仅展示用，不泄露 token） */
  endpoint: process.env.ANTHROPIC_BASE_URL ?? null,
  /** 权限确认等待超时：超时自动拒绝，防止进程无限挂起 */
  permissionTimeoutMs: 120_000,
} as const;

/**
 * 项目根目录：每个一级子文件夹即一个项目（自动发现）。
 * 默认 <dataDir>/projects；可用 PROJECTS_DIR 指向任意已有目录，
 * 如本机开发设 PROJECTS_DIR=/Users/neilcz/project，
 * Docker 部署则把宿主机目录挂进容器并指向挂载点。
 */
export const projectsDir = process.env.PROJECTS_DIR ?? path.join(config.dataDir, 'projects');
export const dbDir = path.join(config.dataDir, 'db');
// 显式配置的 PROJECTS_DIR 不存在时直接报错（防手滑写错路径后静默建错目录）
if (process.env.PROJECTS_DIR && !fs.existsSync(projectsDir)) {
  throw new Error(`PROJECTS_DIR 不存在: ${projectsDir}`);
}
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(dbDir, { recursive: true });
