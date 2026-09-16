# CodeForeman

服务端 7×24 运行的 Claude 代码 agent 管理工具：多项目管理 + Claude 对话 + 想法/计划队列 + 功能演进视图，Web / H5 双端。

方案详见 [docs/PLAN.md](docs/PLAN.md)。

## 本地开发

```bash
npm install
npm run build
npm run dev:server   # 后端 http://localhost:3780
npm run dev:web      # 前端 http://localhost:5173（代理 /api 和 /ws 到后端）
```

## Docker 部署

```bash
# 1. 准备代码目录（宿主机磁盘，git 管理）
mkdir -p data/projects

# 2. 构建并启动
docker compose up -d --build

# 3. 首次：登录 Claude（订阅方式），登录态持久化在 claude-config 卷
docker compose exec codeforeman claude login
#   或使用 apikey：在 docker-compose.yml 中设置 ANTHROPIC_API_KEY

# 访问 http://<服务器>:3780
```

## 结构

- `packages/shared` — 前后端共享类型与 WS 协议
- `packages/server` — Fastify 后端（会话管理 / Claude 进程编排 / Git / SQLite）
- `packages/web` — React SPA（PC + H5 响应式）
