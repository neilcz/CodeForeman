# CodeForeman 执行方案

> 服务端 7×24 运行的 Claude 代码 agent 管理工具。本文档是经讨论确认后的最终方案。
>
> **状态（2026-09-18）：P0–P6 全部完成并实测通过。** 后续迭代的增量功能见文末「已完成增量」。

## 一、核心需求

1. **多项目管理**：网页里像本地 VSCode 一样浏览/编辑多个项目的代码，同时和 Claude 对话改代码
2. **对话历史双重管理**：按会话管理 + 按「功能」维度归档（需求 + Claude 实现 → 功能演进时间线）
3. **想法/计划队列（Backlog）**：统一待办池，来源包括用户手动录入、与 Claude 聊天沉淀。执行时拉起一个 Claude 会话干活
4. **Web + H5（手机网页）双端**，服务端中继 Claude 流式输出
5. **Docker 部署**：Claude Code CLI 装在容器内；代码在宿主机磁盘（git 管理），以卷挂载进容器

## 二、已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 语言 | **Node.js + TypeScript 全栈**。理由：① Claude Agent SDK 一等公民是 TS，stream-json 协议/类型同步最及时；② 前后端共享 `packages/shared` 协议类型，零漂移；③ node-pty / xterm.js / Monaco 生态都在 JS |
| Claude 接入 | **Claude Code CLI**，共享凭证（订阅登录态或 apikey，环境变量可切换），所有用户共用 |
| 对话形态 | **结构化对话界面**（Agent SDK / stream-json 驱动），能力与原 CLI 一致（工具/装包/skills/MCP 相同）；权限确认做成前端确认卡片。预留 node-pty + xterm.js 的 raw 终端模式接口 |
| 用户模型 | **轻量多用户**：账号体系 + 项目 `visibility: private/public`，注册默认关闭（管理员创建），共享 Claude 凭证 |
| 分支策略 | **每个任务切 `feature/<task-slug>` 分支**（隔离并行任务、绑定功能演进数据、失败可整体丢弃）；**默认完成后自动合并回主分支并删除分支**，创建任务时可改选「手动合并」；合并冲突时保留分支、任务标记 `conflict`、通知人工处理 |
| Claude 运行位置 | **容器内**，代码目录从宿主机挂载 |

## 三、技术选型

| 层 | 选型 |
|---|---|
| 后端 | Node.js + TypeScript + Fastify + @fastify/websocket |
| Claude 驱动 | @anthropic-ai/claude-agent-sdk（等价于 `claude -p --output-format stream-json`），session 可 resume |
| 数据库 | SQLite (better-sqlite3)，卷持久化 |
| 前端 | React + Vite + TS + Monaco Editor，响应式一套代码覆盖 PC + H5 |
| 部署 | 单容器 Docker + docker-compose；卷：`/data/projects`（宿主机代码）、`/data/db`、`/root/.claude`（登录态） |

## 四、架构

```
┌─────────────┐  WebSocket/HTTP  ┌──────────────────────────────┐
│ Web / H5    │ ◄──────────────► │  CodeForeman Server (容器内) │
│ React SPA   │                  │  ├─ Fastify API + 认证        │
└─────────────┘                  │  ├─ Session Manager           │
                                 │  │   └─ spawn Claude 进程     │
                                 │  │      (stream-json 双向)    │
                                 │  ├─ Task Runner (backlog执行) │
                                 │  ├─ Git Service (分支/commit) │
                                 │  └─ SQLite                    │
                                 └──────┬───────────┬───────────┘
                              卷挂载     ▼           ▼
                        /data/projects (宿主机磁盘, git 仓库)
                        /data/db + /root/.claude (凭证持久化)
```

**关键机制：**

1. **会话管理**：每个对话 = 一个 Claude session，保存 session_id 支持 resume；流式事件落库（messages 表），支持功能归档与 H5 断线重连回放
2. **Backlog → 执行**：状态机 `draft → queued → running → done/failed/conflict`；执行时切分支 → spawn Claude → 流式转播；完成后按任务配置自动合并/保留分支
3. **功能演进视图**：`features` 表关联 sessions + commits；手动归档 + 任务完成时 Claude 自动生成摘要
4. **权限确认中继**：Claude 工具权限请求 → WS 推前端确认卡片 → 用户选择回传 → 继续执行（H5 可远程批准）

## 五、代码结构

```
CodeForeman/
├── Dockerfile / docker-compose.yml
├── packages/
│   ├── shared/          # TS 类型 + WS 协议（前后端共用）
│   ├── server/
│   │   └── src/
│   │       ├── claude/      # 进程 spawn、stream-json 解析、权限回调
│   │       ├── sessions/    # 会话生命周期、resume、历史落库
│   │       ├── tasks/       # backlog 状态机、任务执行编排
│   │       ├── git/         # 分支创建、合并、冲突检测
│   │       ├── projects/    # 多项目 CRUD、文件树读写
│   │       ├── auth/        # 用户、JWT
│   │       └── db/          # SQLite schema + migration
│   └── web/
│       └── src/
│           ├── pages/       # Projects / Chat / Backlog / Features
│           ├── components/  # ChatView, FileTree, MonacoEditor, ApprovalCard
│           └── h5/          # 移动端布局适配
```

## 六、分期计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| ✅ **P0 基建** | monorepo 脚手架、Dockerfile（Node + Claude Code CLI + git）、docker-compose、健康检查 | 容器里 `claude -p "hello"` 有输出 |
| ✅ **P1 对话闭环** | spawn/resume Claude 会话、WS 流式中继、消息落库、权限确认卡片 | web 上完成多轮对话并改文件，刷新后历史在 |
| ✅ **P2 项目管理** | 项目 CRUD、文件树、Monaco 编辑保存、git 状态/分支展示 | 网页内浏览+编辑代码 |
| ✅ **P3 Backlog** | 想法/计划 CRUD、状态机、执行时自动切分支 + 拉起 Claude，默认自动合并 + 删分支，冲突兜底 | 提交想法→执行→Claude 在新分支完成并合并回主分支 |
| ✅ **P4 功能演进** | feature 归档、手动关联 + Claude 自动摘要、演进时间线 UI | 功能下历次需求→实现→commit 时间线可见 |
| ✅ **P5 多用户 + H5** | 账号体系、项目可见性、移动端适配 | 双账号私有项目隔离，手机可对话/批准权限 |
| ✅ **P6 加固** | 进程崩溃恢复、资源限制、日志、备份 | 重启服务后会话可恢复 |

P0–P3 为 MVP。以上全部阶段已完成并验收。

## 七、已完成增量（P6 之后）

- **项目根目录可配置 + 目录自动发现**：`PROJECTS_DIR` 环境变量；根目录下每个一级子文件夹自动注册为项目（启动自动扫 + 手动扫描按钮）；`managed` 标记区分来源，扫描/纳管目录删除时绝不动磁盘文件
- **前端整体迁移 antd + Ant Design X**：Conversations/Bubble/Sender/Timeline 等；科技蓝主题；全站 emoji 图标清除
- **会话增强**：删除会话（级联清理）、项目筛选、首条发言后 Claude 自动概括标题、中断按钮（AbortController）、acceptEdits 模式（编辑免确认）
- **WS 可靠性**：CONNECTING 消息入队补发、断线重连自动恢复订阅
- **项目页**：分支下拉切换（checkout API）、非 git 目录一键初始化
- **计划页改版**：卡片 + 搜索 + 项目筛选 + 弹窗表单 + 草稿按账号 localStorage 缓存
- **功能演进**：默认全项目视图（ACL 感知）+ 项目筛选
