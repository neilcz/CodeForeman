import type { ServerMessage } from '@codeforeman/shared';

/** WS 单例：全局一条连接，监听器集合分发 */
let ws: WebSocket | null = null;
const listeners = new Set<(msg: ServerMessage) => void>();

function ensureOpen() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMessage;
    for (const fn of listeners) fn(msg);
  };
  ws.onclose = () => {
    // 简单重连：3s 后如果还有监听器则重连
    setTimeout(() => { if (listeners.size > 0) ensureOpen(); }, 3000);
  };
}

export function onWsMessage(fn: (msg: ServerMessage) => void): () => void {
  listeners.add(fn);
  ensureOpen();
  return () => { listeners.delete(fn); };
}

export function sendWs(msg: unknown) {
  ensureOpen();
  if (ws!.readyState === WebSocket.OPEN) ws!.send(JSON.stringify(msg));
}
