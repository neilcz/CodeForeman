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
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = 'draft' | 'queued' | 'running' | 'review' | 'done' | 'failed' | 'conflict';

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
}

export interface TaskInfo {
  id: string;
  projectId: string;
  projectName: string | null;
  title: string;
  description: string;
  source: 'manual' | 'chat';
  status: TaskStatus;
  /** true=验收后自动合并回主分支并删除任务分支；false=保留分支手动合并 */
  autoMerge: boolean;
  branch: string | null;
  sessionId: string | null;
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

// ---------- 客户端 → 服务端 ----------

export type ClientMessage =
  | { type: 'session.subscribe'; sessionId: string }
  | { type: 'session.unsubscribe'; sessionId: string }
  | { type: 'chat.send'; sessionId: string; text: string }
  | { type: 'chat.interrupt'; sessionId: string }
  | { type: 'permission.respond'; sessionId: string; requestId: string; allow: boolean };

// ---------- 服务端 → 客户端 ----------

export type ServerMessage =
  | { type: 'server.hello'; version: string; sessions: SessionInfo[] }
  | { type: 'session.created'; session: SessionInfo }
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'session.status'; sessionId: string; status: SessionInfo['status'] }
  /** Claude 原始事件（SDK message），同时已落库 */
  | { type: 'claude.event'; sessionId: string; event: unknown }
  | { type: 'chat.done'; sessionId: string }
  | { type: 'chat.error'; sessionId: string; error: string }
  | { type: 'permission.request'; requestId: string; sessionId: string; toolName: string; input: unknown }
  | { type: 'permission.resolved'; requestId: string; allow: boolean }
  /** 任务状态变化（广播给所有连接） */
  | { type: 'task.updated'; task: TaskInfo };

export type WsMessage = ClientMessage | ServerMessage;
