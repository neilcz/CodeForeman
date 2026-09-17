# CodeForeman

服务端 7×24 运行的 Claude 代码 agent 管理工具：多项目管理 + Claude 对话 + 想法/计划队列 + 功能演进视图，Web / H5 双端。

方案详见 [docs/PLAN.md](docs/PLAN.md)。

## 功能

- **项目**：目录自动发现（`PROJECTS_DIR` 下每个一级子文件夹自动注册为项目）、创建（空项目 / git clone / 纳管已有路径）、非 git 目录一键 `git init`、文件树浏览、Monaco 编辑（Cmd/Ctrl-S 保存）、git 状态；项目可设为私有或公共；删除时区分来源 —— 工具创建的项目可连带删除文件，扫描/纳管的项目只删记录不动磁盘
- **会话**：与 Claude（Kimi k3 等兼容端点）结构化多轮对话，工具调用实时可见，权限请求网页确认（手机上也能远程批准），断线/重启后可 resume；支持会话删除与按项目筛选
- **想法队列**：记录想法/计划 → 一键执行（自动切 `feature/*` 分支 → Claude 实现并提交 → 待验收）→ 验收后自动合并回主分支并删除任务分支；冲突自动回滚并保留分支
- **功能演进**：任务验收后自动归档（Claude 生成摘要），会话可手动归档，按功能查看迭代时间线
- **多用户**：管理员创建账号，公共/私有项目隔离，共享容器内 Claude 凭证

## 本地开发

### 前置要求

- **Node.js ≥ 22**（`node -v` 确认；建议用 nvm/fnm 管理版本）
- **Claude 凭证**（二选一）：
  - A. 第三方兼容端点（如 Kimi）：需要 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
  - B. 官方订阅：无需环境变量，后续在容器/本机执行 `claude login` 即可

### 安装步骤

```bash
# 1. 克隆仓库
git clone <仓库地址> && cd CodeForeman

# 2. 安装依赖（npm workspaces，一次装齐 shared/server/web 三个包）
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，至少填：
#   - ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（Kimi 等兼容端点）
#   - ADMIN_PASSWORD（管理员初始密码，不设置则为 admin/admin）
# 可选：
#   - ANTHROPIC_MODEL（模型名，按接入方要求设置；官方可留空）
#   - PROJECTS_DIR（项目根目录，默认 data/projects）

# 4. 构建共享包与产物
npm run build

# 5. 启动（两个终端分别运行，或一条 npm run dev 同时拉起）
npm run dev:server     # 后端 http://localhost:3780
npm run dev:web        # 前端 http://localhost:5173（代理 /api 和 /ws）
```

### 验证

浏览器打开 http://localhost:5173 ，用 `admin / $ADMIN_PASSWORD` 登录，能进项目列表即成功。

`PROJECTS_DIR` 指定项目根目录（默认 `data/projects`），其下每个一级子文件夹启动时自动发现为项目；显式配置了不存在的路径会启动即报错，防止静默建错目录。项目页也可手动「扫描目录」。

## Docker 部署

### 前置要求

- **Docker** 与 **Docker Compose v2**（`docker compose version` 确认）

### 部署步骤

```bash
# 1. 克隆仓库
git clone <仓库地址> && cd CodeForeman

# 2. 准备代码目录（宿主机磁盘，git 管理）与配置
#    该目录下每个一级子文件夹会被自动发现为一个项目
mkdir -p data/projects
cp .env.example .env   # 填凭证 + ADMIN_PASSWORD
#    代码目录不在默认位置时，在 .env 里设 HOST_PROJECTS_DIR=/path/to/projects

# 3. 构建并启动（更新代码后也用这条，--build 保证重建镜像）
docker compose up -d --build

# 4. 若用官方订阅而非 apikey 类凭证：
docker compose exec codeforeman claude login   # 登录态持久化在 claude-config 卷

# 访问 http://<服务器>:3780，默认管理员 admin / $ADMIN_PASSWORD（未设置则为 admin）
```

### 验证

```bash
docker compose ps        # 容器状态为 running
docker compose logs -f   # 观察启动日志无报错
```

浏览器打开 http://<服务器>:3780 ，用 `admin / $ADMIN_PASSWORD` 登录即可。

## 运维

- **备份**：`./scripts/backup.sh ./data ./backups`（SQLite 在线备份 + 打包，保留最近 30 份）
- **日志**：`data/logs/server.log`（stdout 同步输出，`docker compose logs -f` 可看）
- **崩溃恢复**：重启后残留的 running 会话自动复位 idle（可 resume），running 任务转为「待验收」并附提示
- **资源**：compose 已限制 4 CPU / 4G 内存，可按需调整

## 结构

- `packages/shared` — 前后端共享类型与 WS 协议
- `packages/server` — Fastify 后端（auth / projects / sessions / tasks / features / git / db）
- `packages/web` — React SPA（PC + H5 响应式）
