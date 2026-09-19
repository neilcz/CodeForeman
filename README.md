# CodeForeman

**你的 7×24 服务端 AI 编程管家。** Claude Code 以常驻服务跑在你的开发机/服务器上，网页/手机随时随地派活、审批、验收——代码留在磁盘以 git 管理，每个任务在独立分支上执行，验收后自动合并回主分支。

## 为什么用它

在本地用 Claude Code 写代码已经很爽，但它有三个天然限制：**电脑合盖就停、离开工位就断、想法来了记不住**。CodeForeman 解决这三件事：

- 🖥️ **永不掉线**：Claude 跑在常驻服务里，关电脑、断网、刷新页面都不影响任务执行——浏览器只是一块「显示屏」
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
- SSH Key 管理（管理员）：网页内生成密钥对或导入已有私钥，用于 clone/push `git@...` 地址的仓库；公钥一键复制到 GitHub/GitLab Deploy Keys
- 崩溃恢复：重启后残留的会话自动复位可续聊，执行中任务转「待验收」并附提示
- 空闲 Claude 进程自动回收；SIGTERM 优雅停机；WS 断线自动重连并恢复订阅
- 内置备份脚本（SQLite 在线备份 + 打包）；日志文件落盘

## 架构

```
┌──────────────┐  WebSocket/HTTP  ┌───────────────────────────────┐
│  Web / H5    │ ◄──────────────► │  CodeForeman Server (Node)    │
│  React SPA   │                  │  ├─ Fastify API + token 认证   │
│  (antd + X)  │                  │  ├─ Session Manager           │
└──────────────┘                  │  │   └─ Claude Agent SDK       │
                                  │  │      (stream-json 双向流)   │
                                  │  ├─ Task Runner (计划执行编排) │
                                  │  ├─ Git Service (分支/合并)    │
                                  │  └─ SQLite (WAL)               │
                                  └──────┬────────────┬───────────┘
                              直接读写    ▼            ▼
                        PROJECTS_DIR ← 本机项目根目录（每个子目录 = 一个项目）
                        data/db      ← SQLite 数据库
                        ~/.claude    ← Claude 登录态（官方订阅时）
```

**技术栈**：Node.js 22 + TypeScript 全栈 · Fastify + WebSocket · Claude Agent SDK（stream-json 协议，session 可 resume）· better-sqlite3 · React 18 + antd v5 + Ant Design X + Monaco Editor · 裸机常驻服务（launchd / systemd），Docker 可选

**模型接入**：任何 Anthropic 兼容端点均可——官方订阅（宿主机 `claude login`）、Anthropic API key、或 Kimi 等第三方兼容服务（`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`）。

## 部署方式：推荐裸服务，不用 Docker

CodeForeman 支持裸服务（推荐）和 Docker 两种方式。**默认选裸服务**，原因：

1. **这个产品的核心价值是「让 Claude 在真实开发环境里干活」**。Claude 会话要执行的是真实任务：build、跑测试、打包。这些任务天然依赖宿主机环境——各语言工具链（JDK、Android SDK、Python、Go……）不可能为每个项目往镜像里装一遍；平台独有工具（uniapp-x 的 HBuilderX/cli、Xcode、macOS 签名工具）在 Linux 容器里**物理上不存在**；容器里也没法起模拟器、访问 keychain、用 SSH agent。容器化的假设是「执行环境可标准化」，而开发机的环境恰恰不可标准化——镜像越装越多，等于在容器里重新发明一台开发机，走不通。
2. **Docker 方案会不断为宿主环境打补丁**。挂载宿主机 SSH key 要复制修权限、绕开 macOS keychain、剔除不兼容的 ssh config、带 passphrase 的 key 不可用……每解决一个又冒出下一个，这是容器与宿主环境的结构性矛盾，不是配置问题。
3. **Docker 的好处在这个场景价值不大**。环境一致性恰恰是缺点（你要的就是宿主的「不一致」环境）；隔离对单用户开发工具意义有限；资源限制用 systemd 的 `CPUQuota`/`MemoryMax` 同样能做。

**裸服务唯一的代价是隔离性**：Claude 子进程以服务运行用户的身份执行，拥有该用户的权限。缓解方式：用**专用用户**运行（只授予项目目录和工具链权限）、`PROJECTS_DIR` 限定项目根目录。

**Docker 仍然保留**（见下文「Docker 部署（可选）」），适用于：纯 Linux 服务器、项目不需要宿主特有工具链、或你明确想要进程隔离的场景。

## 快速开始（裸服务，推荐）

前置：Node.js ≥ 22、git、Claude Code CLI（官方订阅用户）。

```bash
# 1. 克隆仓库
git clone <仓库地址> && cd CodeForeman

# 2. 安装依赖并构建
npm install && npm run build

# 3. 配置
cp .env.example .env
# 编辑 .env：
#   - ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN（Kimi 等兼容端点；官方订阅则留空）
#   - ANTHROPIC_MODEL（按接入方要求，如 k3；官方留空）
#   - ADMIN_PASSWORD（管理员初始密码，不设置则为 admin/admin）
#   - PROJECTS_DIR（项目根目录，每个子文件夹自动发现为项目，如 /Users/you/project）

# 4. 前台试跑，确认无报错
npm start

# 5. 官方订阅用户：在宿主机登录一次即可（直接共享 ~/.claude，无需额外操作）
claude login

# 访问 http://<机器IP>:3780 ，用 admin / $ADMIN_PASSWORD 登录
```

### 常驻运行

前台试跑没问题后，用安装脚本注册为系统常驻服务（崩溃自动重启、开机/登录自启），脚本自动检测操作系统选择对应方式：

```bash
node scripts/install-service.mjs            # 安装并启动
node scripts/install-service.mjs restart    # 重启（更新代码后用）
node scripts/install-service.mjs uninstall  # 停止并卸载
```

- **macOS** → launchd 用户代理（`~/Library/LaunchAgents/com.codeforeman.plist`）
- **Linux** → systemd 用户服务（root 运行则为系统服务，含 4C/4G 资源限制，并自动 `enable-linger` 保证注销后存活）
- **Windows** → 任务计划程序（登录时自启，`schtasks`）

⚠️ 注意：常驻服务**不继承你的 shell 环境**。脚本会把当前 PATH 固化进服务配置；之后新增工具链（JDK、Android SDK、uniapp cli 等）后重新运行一次安装脚本即可刷新。

## Docker 部署（可选）

适用场景：纯 Linux 服务器、项目不需要宿主特有工具链、或需要进程隔离。

前置：Docker + Docker Compose v2。

```bash
# 1. 克隆仓库
git clone <仓库地址> && cd CodeForeman

# 2. 配置
cp .env.example .env
# 编辑 .env：凭证同上；Docker 特有的两项：
#   - HOST_PROJECTS_DIR（宿主机项目根目录，挂载到容器 /projects）
#   - HOST_SSH_DIR（SSH key 目录，见 .env.example 注释）

# 3. 构建并启动（以后更新代码也用这条）
docker compose up -d --build

# 4. 官方订阅用户登录一次（登录态持久化在 claude-config 卷，重建不丢）
docker compose exec codeforeman claude login

# 访问 http://<服务器>:3780 ，用 admin / $ADMIN_PASSWORD 登录
```

已知限制（裸服务不存在这些问题）：容器内没有各语言工具链和平台特有工具（uniapp-x/Xcode 等无法打包）；带 passphrase 的 SSH key 不可用（无交互、无 keychain）；macOS Docker Desktop 挂载性能与权限问题。

## 本地开发

```bash
npm install
cp .env.example .env   # 同上；用 PROJECTS_DIR 指定项目根目录
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
- **日志**：`data/logs/server.log`；systemd 用 `journalctl -u codeforeman -f`；Docker 用 `docker compose logs -f`
- **资源**：systemd 模板默认限制 4 CPU / 4G 内存（`CPUQuota`/`MemoryMax`），按需调整
- **更新**：`git pull && npm install && npm run build`，然后重启服务（`launchctl kickstart -k gui/$(id -u)/com.codeforeman` / `sudo systemctl restart codeforeman`）

## License

MIT
