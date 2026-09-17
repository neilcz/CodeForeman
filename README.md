# CodeForeman

**你的 7×24 服务端 AI 编程管家。** 把 Claude Code 装进 Docker 跑在服务器上，网页/手机随时随地派活、审批、验收——代码留在宿主机磁盘以 git 管理，每个任务在独立分支上执行，验收后自动合并回主分支。

## 为什么用它

在本地用 Claude Code 写代码已经很爽，但它有三个天然限制：**电脑合盖就停、离开工位就断、想法来了记不住**。CodeForeman 解决这三件事：

- 🖥️ **永不掉线**：Claude 跑在服务器容器里，关电脑、断网、刷新页面都不影响任务执行——浏览器只是一块「显示屏」
- 📱 **随处可用**：PC 网页 + 手机 H5 同一套系统，地铁上收到权限确认，点一下「允许」任务继续跑
- 🧠 **想法不落空**：临时想到的需求扔进计划队列，空了批量派给 Claude 执行，完成后自动合并回主分支

## 功能一览

### 项目管理
- 目录自动发现：配置一个项目根目录（如 `~/project`），其下每个文件夹自动成为可管理项目
- 网页内浏览文件树、Monaco 编辑器在线改代码（Cmd/Ctrl-S 保存）
- git 状态实时可见：当前分支（下拉可切换）、未提交改动；非 git 目录一键初始化
- 项目支持私有/公共可见性（多用户协作按分支隔离）；删除项目区分来源——工具创建的可连带删文件，纳管/扫描来的只删记录不动磁盘

### Claude 会话
- 结构化多轮对话：工具调用（读文件/写代码/跑命令）实时可见、可展开
- **权限中继**：Claude 要执行 Bash 等敏感操作时，网页/手机弹出确认卡片，远程批准/拒绝；文件编辑自动放行（acceptEdits），不被低风险操作打断
- 断线/服务重启自动恢复（session resume），支持主动中断，中断后可续聊
- 首条发言后自动概括生成会话标题；会话按项目筛选、可删除

### 计划队列（Backlog）
- 想法/计划统一管理：手动录入，或聊天中「存为计划」沉淀
- 一键执行：自动从主分支切出 `feature/*` 分支 → 拉起 Claude 实现并自行提交 → 待验收
- 验收后自动合并回主分支并删除任务分支；合并冲突自动回滚、保留分支等人工处理
- 搜索 + 项目筛选；弹窗表单草稿按账号本地缓存，写到一半关掉也不丢

### 功能演进
- 任务验收后自动归档：Claude 生成「功能名 + 迭代摘要」，关联任务、会话、合并 commit
- 会话可手动归档到功能；按功能查看演进时间线：历次需求 → 实现 → 代码变更

### 多用户与运维
- 管理员创建账号；scrypt 密码哈希；token 30 天有效；项目级访问控制
- 崩溃恢复：重启后残留的会话自动复位可续聊，执行中任务转「待验收」并附提示
- 空闲 Claude 进程自动回收；SIGTERM 优雅停机；WS 断线自动重连并恢复订阅
- 内置备份脚本（SQLite 在线备份 + 打包）；日志文件落盘

## 架构

```
┌──────────────┐  WebSocket/HTTP  ┌───────────────────────────────┐
│  Web / H5    │ ◄──────────────► │  CodeForeman Server (Docker)  │
│  React SPA   │                  │  ├─ Fastify API + token 认证   │
│  (antd + X)  │                  │  ├─ Session Manager           │
└──────────────┘                  │  │   └─ Claude Agent SDK       │
                                  │  │      (stream-json 双向流)   │
                                  │  ├─ Task Runner (计划执行编排) │
                                  │  ├─ Git Service (分支/合并)    │
                                  │  └─ SQLite (WAL)               │
                                  └──────┬────────────┬───────────┘
                              卷挂载      ▼            ▼
                        /projects ← 宿主机项目根目录（每个子目录 = 一个项目）
                        /data/db  ← SQLite 数据库
                        /root/.claude ← Claude 登录态（可选）
```

**技术栈**：Node.js 22 + TypeScript 全栈 · Fastify + WebSocket · Claude Agent SDK（stream-json 协议，session 可 resume）· better-sqlite3 · React 18 + antd v5 + Ant Design X + Monaco Editor · 单容器 Docker 部署

**模型接入**：任何 Anthropic 兼容端点均可——官方订阅（容器内 `claude login`）、Anthropic API key、或 Kimi 等第三方兼容服务（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`）。

## 快速开始（Docker，推荐）

前置：Docker + Docker Compose v2。

```bash
# 1. 克隆仓库
git clone <仓库地址> && cd CodeForeman

# 2. 配置
cp .env.example .env
# 编辑 .env：
#   - ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（Kimi 等兼容端点；官方订阅则留空）
#   - ANTHROPIC_MODEL（按接入方要求，如 k3；官方留空）
#   - ADMIN_PASSWORD（管理员初始密码，不设置则为 admin/admin）
#   - HOST_PROJECTS_DIR（宿主机项目根目录，每个子文件夹自动发现为项目）

# 3. 构建并启动（以后更新代码也用这条）
docker compose up -d --build

# 4. 官方订阅用户登录一次（登录态持久化在 claude-config 卷，重建不丢）
docker compose exec codeforeman claude login

# 访问 http://<服务器>:3780 ，用 admin / $ADMIN_PASSWORD 登录
```

验证：`docker compose ps` 状态 running，`docker compose logs -f` 无报错，网页能进项目列表即成功。

## 本地开发

前置：Node.js ≥ 22。

```bash
npm install
cp .env.example .env   # 同上；本地开发用 PROJECTS_DIR 指定项目根目录
npm run build
npm run dev:server     # 后端 http://localhost:3780
npm run dev:web        # 前端 http://localhost:5173（代理 /api 和 /ws）
```

代码结构（npm workspaces monorepo）：

- `packages/shared` — 前后端共享类型与 WS 协议定义（协议零漂移）
- `packages/server` — Fastify 后端（auth / projects / sessions / tasks / features / git / db）
- `packages/web` — React SPA（PC + H5 响应式）

## 运维

- **备份**：`./scripts/backup.sh ./data ./backups`（SQLite 在线备份 + 打包，保留最近 30 份）
- **日志**：`data/logs/server.log`；或 `docker compose logs -f`
- **资源**：compose 默认限制 4 CPU / 4G 内存，按需调整
- **更新**：`git pull && docker compose up -d --build`

## License

MIT
