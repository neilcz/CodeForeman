/**
 * CodeForeman 前后端共享类型与 WebSocket 协议定义。
 * web 和 server 都 import 本包，保证协议零漂移。
 */

/** WebSocket 消息信封：所有 WS 消息的统一外壳 */
export interface WsEnvelope<T = unknown> {
  type: string;
  payload: T;
  ts: number;
}

// ---------- 服务端 → 客户端事件 ----------

export interface ServerHello {
  version: string;
  uptimeSec: number;
}

/** Claude 流式事件占位（P1 细化，对齐 stream-json 协议） */
export interface ClaudeStreamEvent {
  sessionId: string;
  event: unknown;
}

/** 工具权限确认请求（P1 细化） */
export interface PermissionRequest {
  sessionId: string;
  toolName: string;
  input: unknown;
}

// ---------- 客户端 → 服务端消息 ----------

export interface ClientPing {
  nonce: number;
}

// ---------- 通用 ----------

export interface HealthStatus {
  status: 'ok';
  version: string;
  claudeAvailable: boolean;
}

export function envelope<T>(type: string, payload: T): WsEnvelope<T> {
  return { type, payload, ts: Date.now() };
}
