import type { ServerMessage } from '@codeforeman/shared';
import { getToken, setToken } from './api';

/**
 * WS 单例：全局一条连接。
 * 可靠性保证：
 * 1. CONNECTING 期间的消息进入队列，open 后补发（不再静默丢失）
 * 2. 断线重连后自动恢复所有会话订阅（服务端订阅随旧连接销毁）
 */
let ws: WebSocket | null = null;
const listeners = new Set<(msg: ServerMessage) => void>();
const outbox: string[] = [];
const wantedSubscriptions = new Set<string>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function ensureOpen() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken() ?? '')}`);

  ws.onopen = () => {
    // 恢复订阅 + 补发积压消息
    for (const sessionId of wantedSubscriptions) {
      ws!.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
    }
    for (const m of outbox.splice(0)) ws!.send(m);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMessage;
    for (const fn of listeners) fn(msg);
  };
  ws.onclose = (e) => {
    ws = null;
    if (e.code === 4401) {
      setToken(null);
      window.location.href = '/login';
      return;
    }
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (listeners.size > 0) ensureOpen();
      }, 3000);
    }
  };
}

export function onWsMessage(fn: (msg: ServerMessage) => void): () => void {
  listeners.add(fn);
  if (getToken()) ensureOpen();
  return () => { listeners.delete(fn); };
}

/** 发送消息；未连上时入队，连接恢复后补发 */
export function sendWs(msg: unknown) {
  ensureOpen();
  if (ws!.readyState === WebSocket.OPEN) ws!.send(JSON.stringify(msg));
  else outbox.push(JSON.stringify(msg));
}

/** 订阅会话（重连自动恢复；组件卸载时应调用 unsubscribeSession） */
export function subscribeSession(sessionId: string) {
  if (wantedSubscriptions.has(sessionId)) return;
  wantedSubscriptions.add(sessionId);
  sendWs({ type: 'session.subscribe', sessionId });
}

export function unsubscribeSession(sessionId: string) {
  wantedSubscriptions.delete(sessionId);
  sendWs({ type: 'session.unsubscribe', sessionId });
}
