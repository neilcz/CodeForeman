import type { ServerMessage } from '@codeforeman/shared';
import { getToken, setToken } from './api';

/** WS 单例：全局一条连接，监听器集合分发；鉴权失败跳登录 */
let ws: WebSocket | null = null;
const listeners = new Set<(msg: ServerMessage) => void>();

function ensureOpen() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken() ?? '')}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMessage;
    for (const fn of listeners) fn(msg);
  };
  ws.onclose = (e) => {
    if (e.code === 4401) {
      setToken(null);
      location.href = '/login';
      return;
    }
    setTimeout(() => { if (listeners.size > 0) ensureOpen(); }, 3000);
  };
}

export function onWsMessage(fn: (msg: ServerMessage) => void): () => void {
  listeners.add(fn);
  if (getToken()) ensureOpen();
  return () => { listeners.delete(fn); };
}

export function sendWs(msg: unknown) {
  ensureOpen();
  if (ws!.readyState === WebSocket.OPEN) ws!.send(JSON.stringify(msg));
}
