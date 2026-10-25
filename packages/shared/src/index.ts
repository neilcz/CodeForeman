/**
 * CodeForeman 前后端共享类型与 WebSocket 协议定义。
 * web 和 server 都 import 本包，保证协议零漂移。
 */

// ---------- 领域模型 ----------

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  gitUrl: string | null;
  ownerId: string | null;
  visibility: 'private' | 'public';
  /** true=本工具创建（删除时可连带删文件）；false=扫描/纳管（绝不删文件） */
  managed: boolean;
  createdAt: number;
}

export interface FileNode {
  name: string;
  path: string; // 相对项目根
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface GitChange {
  path: string;
  status: string;
}

export interface GitState {
  isRepo: true;
  branch: string;
  defaultBranch: string;
  branches: string[];
  changes: GitChange[];
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  projectId: string | null;
  projectName: string | null;
  status: 'idle' | 'running' | 'error';
  /** Claude CLI 侧的 session id，用于 resume；首轮 init 前为 null */
  claudeSessionId: string | null;
  /** 已存为计划（有任务从本会话产生）；planTitle 为最新一条计划标题 */
  planned?: boolean;
  planTitle?: string | null;
  /** 已归档到功能演进；archiveFeatureTitle 为归档到的功能名 */
  archived?: boolean;
  archiveFeatureTitle?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = 'draft' | 'queued' | 'running' | 'review' | 'done' | 'failed' | 'conflict';

/** 计划执行方式：串行在当前分支逐条提交；并行使用独立分支与 worktree */
export type TaskExecutionMode = 'serial' | 'parallel';

/** 功能演进：一个功能聚合多次会话/任务的迭代记录 */
export interface FeatureInfo {
  id: string;
  projectId: string;
  projectName: string | null;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  items: FeatureItemInfo[];
}

export interface FeatureItemInfo {
  id: string;
  kind: 'session' | 'task';
  refId: string;
  createdAt: number;
  /** 冗余展示字段：会话标题或任务标题 */
  label: string;
  /** 任务特有：状态 / 合并 commit */
  taskStatus?: TaskStatus;
  mergeCommit?: string | null;
  /** 会话特有：首条用户需求摘要 */
  firstPrompt?: string | null;
  /** AI 生成的改进点总结（这次迭代改进/解决了什么） */
  summary?: string;
}

export interface TaskInfo {
  id: string;
  projectId: string;
  projectName: string | null;
  title: string;
  description: string;
  source: 'manual' | 'chat';
  status: TaskStatus;
  /** true=验收后自动合并回主分支并删除任务分支；false=保留分支手动合并（仅并行模式） */
  autoMerge: boolean;
  /** 「存为计划」的来源会话；执行时优先复用 */
  originSessionId: string | null;
  /** 实际启动时的执行方式；null 为旧版任务 */
  executionMode: TaskExecutionMode | null;
  /** 本次实际执行的分支：串行为当前分支，并行为独立任务分支 */
  branch: string | null;
  sessionId: string | null;
  /** 并行任务的独立工作目录 */
  worktreePath: string | null;
  /** 入队时间，串行队列据此 FIFO */
  queuedAt: number | null;
  /** Claude 执行结束时的提交/HEAD */
  taskCommit: string | null;
  mergeCommit: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HealthStatus {
  status: 'ok';
  version: string;
  claudeAvailable: boolean;
  endpoint: string | null;
}

export interface SshKeyInfo {
  name: string;
  /** ed25519 / rsa 等，取自公钥类型 */
  type: string;
  fingerprint: string;
  publicKey: string;
  createdAt: number;
}

/**
 * 工具权限策略：
 * - strict：编辑自动放行，Bash 等操作都需网页确认（最早的行为）
 * - allow-except-delete：除删除文件外全部自动放行（默认）
 * - allow-all：全部自动放行，慎用
 * 注意：ExitPlanMode（方案确认）/ AskUserQuestion（提问）这类专门收集人工决定的工具，
 * 除 allow-all 外一律转人工确认，否则「先给方案我同意后再执行」会被秒批自动执行。
 */
export type PermissionPolicy = 'strict' | 'allow-except-delete' | 'allow-all';

/**
 * 全局指令条目：注入每个 Claude 会话的系统提示词（管理员在设置页维护）。
 * 系统预置默认条目（如数据库/Redis 走独立容器），用户可自行增删改。
 */
export interface InstructionItem {
  id: string;
  text: string;
  enabled: boolean;
}

/**
 * 密钥发送方式：
 * - bearer：写 ANTHROPIC_AUTH_TOKEN（Authorization: Bearer），Kimi/DeepSeek 等第三方网关
 * - api-key：写 ANTHROPIC_API_KEY（x-api-key），Anthropic 官方 API
 * 官方 API 同时带两种凭据会被拒，故只设其中一个，另一个从子进程环境里删掉。
 */
export type ClaudeAuthStyle = 'bearer' | 'api-key';

/**
 * Claude 接入配置（可保存多套、选一套生效）。读取接口永不回传 apiKey 明文，只给 hasApiKey——
 * 设置页编辑时密钥留空即表示沿用已存密钥。
 */
export interface ClaudeProfileInfo {
  id: string;
  name: string;
  /** 主模型名；同时覆盖 Haiku/Sonnet/Opus 等别名与子代理模型，留空=沿用服务器 .env */
  model: string;
  /** 留空=沿用服务器 .env 的 ANTHROPIC_BASE_URL */
  baseUrl: string;
  authStyle: ClaudeAuthStyle;
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 保存配置的入参：apiKey 省略 = 保持原值不变，空串 = 清空 */
export interface ClaudeProfileInput {
  id?: string;
  name: string;
  model?: string;
  baseUrl?: string;
  authStyle?: ClaudeAuthStyle;
  apiKey?: string;
}

// ---------- 客户端 → 服务端 ----------

/** 聊天附件：上传后服务端返回的元信息（随用户消息落库，用于历史渲染与提示词注入） */
export interface AttachmentInfo {
  /** 原始文件名（展示用） */
  name: string;
  /** 服务端存储文件名（取回 URL 用：/api/sessions/:id/attachments/:file） */
  file: string;
  kind: 'image' | 'video' | 'file';
  size: number;
}

export type ClientMessage =
  | { type: 'session.subscribe'; sessionId: string }
  | { type: 'session.unsubscribe'; sessionId: string }
  | { type: 'chat.send'; sessionId: string; text: string; attachments?: AttachmentInfo[] }
  | { type: 'chat.interrupt'; sessionId: string }
  | {
      type: 'permission.respond'; sessionId: string; requestId: string; allow: boolean;
      /** AskUserQuestion 的回答：{ 问题原文: 选中项 }，allow=true 时并入 updatedInput 回传 */
      answers?: Record<string, string>;
      /** 打回/拒绝原因（如 ExitPlanMode 打回意见），作为 deny message 回传给 Claude */
      denyMessage?: string;
    };

// ---------- 服务端 → 客户端 ----------

export type ServerMessage =
  | { type: 'server.hello'; version: string; sessions: SessionInfo[] }
  | { type: 'session.created'; session: SessionInfo }
  | { type: 'session.updated'; session: SessionInfo }
  /** updatedAt 为服务端本次写库值：前端据此重排侧栏列表（否则新消息不会把会话顶到最前） */
  | { type: 'session.status'; sessionId: string; status: SessionInfo['status']; updatedAt: number }
  /** Claude 原始事件（SDK message），同时已落库；id 为 messages 表行 id，用于重连去重/增量补拉 */
  | { type: 'claude.event'; sessionId: string; event: unknown; id?: number; ts?: number }
  | { type: 'chat.done'; sessionId: string }
  | { type: 'chat.error'; sessionId: string; error: string }
  | { type: 'permission.request'; requestId: string; sessionId: string; toolName: string; input: unknown }
  | { type: 'permission.resolved'; requestId: string; allow: boolean }
  /** 任务状态变化（广播给所有连接） */
  | { type: 'task.updated'; task: TaskInfo };

export type WsMessage = ClientMessage | ServerMessage;
