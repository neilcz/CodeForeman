# CodeForeman

服务端 7×24 运行的 Claude 代码 agent 管理工具：多项目管理 + Claude 对话 + 想法/计划队列 + 功能演进视图，Web / H5 双端。

方案详见 [docs/PLAN.md](docs/PLAN.md)。

## 功能

- **项目**：创建（空项目 / git clone / 纳管已有目录）、文件树浏览、Monaco 编辑（Cmd/Ctrl-S 保存）、git 状态；项目可设为私有或公共
- **会话**：与 Claude（Kimi k3 等兼容端点）结构化多轮对话，工具调用实时可见，权限请求网页确认（手机上也能远程批准），断线/重启后可 resume
- **想法队列**：记录想法/计划 → 一键执行（自动切 `feature/*` 分支 → Claude 实现并提交 → 待验收）→ 验收后自动合并回主分支并删除任务分支；冲突自动回滚并保留分支
- **功能演进**：任务验收后自动归档（Claude 生成摘要），会话可手动归档，按功能查看迭代时间线
- **多用户**：管理员创建账号，公共/私有项目隔离，共享容器内 Claude 凭证

## 本地开发

```bash
npm install
cp .env.example .env   # 填入 Claude/Kimi 凭证，可设 ADMIN_PASSWORD
npm run build
npm run dev:server     # 后端 http://localhost:3780
npm run dev:web        # 前端 http://localhost:5173（代理 /api 和 /ws）
```

## Docker 部署

```bash
# 1. 准备代码目录（宿主机磁盘，git 管理）与配置
mkdir -p data/projects
cp .env.example .env   # 填凭证 + ADMIN_PASSWORD

# 2. 构建并启动（更新代码后也用这条，--build 保证重建镜像）
docker compose up -d --build

# 3. 若用官方订阅而非 apikey 类凭证：
docker compose exec codeforeman claude login   # 登录态持久化在 claude-config 卷

# 访问 http://<服务器>:3780，默认管理员 admin / $ADMIN_PASSWORD（未设置则为 admin）
```

## 运维

- **备份**：`./scripts/backup.sh ./data ./backups`（SQLite 在线备份 + 打包，保留最近 30 份）
- **日志**：`data/logs/server.log`（stdout 同步输出，`docker compose logs -f` 可看）
- **崩溃恢复**：重启后残留的 running 会话自动复位 idle（可 resume），running 任务转为「待验收」并附提示
- **资源**：compose 已限制 4 CPU / 4G 内存，可按需调整

## 结构

- `packages/shared` — 前后端共享类型与 WS 协议
- `packages/server` — Fastify 后端（auth / projects / sessions / tasks / features / git / db）
- `packages/web` — React SPA（PC + H5 响应式）
