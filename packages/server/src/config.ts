import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3780),
  host: process.env.HOST ?? '0.0.0.0',
  /** 数据根目录：Docker 内为 /data，本地开发为仓库根下的 data/ */
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, '../../../data'),
  /** web 构建产物目录（Docker 镜像内为 /app/web-dist） */
  webDist: process.env.WEB_DIST ?? path.resolve(__dirname, '../../web/dist'),
  version: '0.1.0',
} as const;
