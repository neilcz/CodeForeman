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

export const projectsDir = path.join(config.dataDir, 'projects');
export const dbDir = path.join(config.dataDir, 'db');
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(dbDir, { recursive: true });
