import { useEffect, useState } from 'react';
import type { HealthStatus, WsEnvelope, ServerHello } from '@codeforeman/shared';

export default function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [wsState, setWsState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [hello, setHello] = useState<ServerHello | null>(null);

  useEffect(() => {
    fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => setHealth(null));

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => setWsState('open');
    ws.onclose = () => setWsState('closed');
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as WsEnvelope;
      if (msg.type === 'server.hello') setHello(msg.payload as ServerHello);
    };
    return () => ws.close();
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '48px auto', padding: '0 16px' }}>
      <h1>CodeForeman</h1>
      <p>Server-side Code Agent Orchestrator — P0 基建验证</p>
      <ul>
        <li>HTTP API: {health ? `✅ v${health.version}` : '⏳ 连接中…'}</li>
        <li>Claude CLI: {health ? (health.claudeAvailable ? '✅ 可用' : '❌ 未检测到') : '⏳'}</li>
        <li>WebSocket: {wsState === 'open' ? '✅ 已连接' : wsState}</li>
        {hello && <li>服务端运行时长: {hello.uptimeSec}s</li>}
      </ul>
    </main>
  );
}
