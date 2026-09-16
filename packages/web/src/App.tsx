import { useEffect, useRef, useState } from 'react';
import type { ServerMessage, SessionInfo } from '@codeforeman/shared';
import './style.css';

// ---------- 类型 ----------

interface PermissionCard {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface StoredEvent {
  type: string;
  session_id?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  duration_ms?: number;
  total_cost_usd?: number;
  subtype?: string;
  [k: string]: unknown;
}

// ---------- WS 单例 ----------

let ws: WebSocket | null = null;
const wsListeners = new Set<(msg: ServerMessage) => void>();

function connectWs(onMsg: (msg: ServerMessage) => void) {
  wsListeners.add(onMsg);
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      for (const fn of wsListeners) fn(msg);
    };
  }
  return () => { wsListeners.delete(onMsg); };
}

function sendWs(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------- 事件渲染 ----------

function EventView({ event }: { event: StoredEvent }) {
  // 用户消息：我们发出的文本，或工具结果回传
  if (event.type === 'user') {
    const content = event.message?.content;
    if (typeof content === 'string') {
      return <div className="msg user"><div className="bubble">{content}</div></div>;
    }
    if (Array.isArray(content)) {
      const results = content.filter((b) => b.type === 'tool_result');
      if (results.length === 0) return null;
      return (
        <details className="tool-result">
          <summary>工具结果 ×{results.length}</summary>
          <pre>{results.map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2))).join('\n---\n').slice(0, 2000)}</pre>
        </details>
      );
    }
    return null;
  }

  // Claude 回复：文本 + 工具调用
  if (event.type === 'assistant') {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    return (
      <div className="msg assistant">
        {blocks.map((b, i) => {
          if (b.type === 'text' && b.text) {
            return <div key={i} className="bubble text">{b.text}</div>;
          }
          if (b.type === 'tool_use') {
            return (
              <details key={i} className="tool-use">
                <summary>🔧 {b.name}</summary>
                <pre>{JSON.stringify(b.input, null, 2)?.slice(0, 2000)}</pre>
              </details>
            );
          }
          return null;
        })}
      </div>
    );
  }

  // 一轮结束
  if (event.type === 'result') {
    const secs = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) : '?';
    return <div className="turn-done">—— 本轮结束 · {secs}s{event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''} ——</div>;
  }

  return null; // system/auth 等事件不渲染
}

// ---------- 主界面 ----------

export default function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [permission, setPermission] = useState<PermissionCard | null>(null);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  // WS 连接 + 消息分发
  useEffect(() => {
    const disconnect = connectWs((msg) => {
      setConnected(true);
      switch (msg.type) {
        case 'server.hello':
          setSessions(msg.sessions);
          break;
        case 'session.created':
          setSessions((s) => [msg.session, ...s]);
          break;
        case 'session.status':
          setSessions((s) => s.map((x) => (x.id === msg.sessionId ? { ...x, status: msg.status } : x)));
          break;
        case 'claude.event':
          if (msg.sessionId === activeRef.current) {
            setEvents((e) => [...e, msg.event as StoredEvent]);
          }
          break;
        case 'permission.request':
          if (msg.sessionId === activeRef.current) {
            setPermission({ requestId: msg.requestId, sessionId: msg.sessionId, toolName: msg.toolName, input: msg.input });
          }
          break;
        case 'permission.resolved':
          setPermission((p) => (p?.requestId === msg.requestId ? null : p));
          break;
        case 'chat.error':
          if (msg.sessionId === activeRef.current) {
            setEvents((e) => [...e, { type: 'error', message: { content: msg.error } } as StoredEvent]);
          }
          break;
      }
    });
    return disconnect;
  }, []);

  // 切换会话：拉历史 + 订阅
  useEffect(() => {
    if (!activeId) return;
    setEvents([]);
    setPermission(null);
    fetch(`/api/sessions/${activeId}/messages`)
      .then((r) => r.json())
      .then((rows: { event: StoredEvent }[]) => setEvents(rows.map((r) => r.event)));
    sendWs({ type: 'session.subscribe', sessionId: activeId });
    return () => sendWs({ type: 'session.unsubscribe', sessionId: activeId });
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events, permission]);

  const active = sessions.find((s) => s.id === activeId);

  const createSession = async () => {
    const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const session = (await res.json()) as SessionInfo;
    setSessions((s) => [session, ...s.filter((x) => x.id !== session.id)]);
    setActiveId(session.id);
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text || !activeId) return;
    sendWs({ type: 'chat.send', sessionId: activeId, text });
    setInput('');
  };

  const respondPermission = (allow: boolean) => {
    if (!permission) return;
    sendWs({ type: 'permission.respond', sessionId: permission.sessionId, requestId: permission.requestId, allow });
    setPermission(null);
  };

  return (
    <div className="layout">
      <aside className={`sidebar ${activeId ? 'hidden-mobile' : ''}`}>
        <div className="sidebar-header">
          <span className="logo">CodeForeman</span>
          <span className={`dot ${connected ? 'on' : 'off'}`} />
        </div>
        <button className="new-session" onClick={createSession}>+ 新会话</button>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === activeId ? 'active' : ''}`}
              onClick={() => setActiveId(s.id)}
            >
              <span className="title">{s.title || `会话 ${s.id.slice(0, 8)}`}</span>
              <span className={`status ${s.status}`}>{s.status === 'running' ? '⏳' : s.status === 'error' ? '❌' : ''}</span>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat">
        {!active ? (
          <div className="empty">选择左侧会话，或新建一个开始对话</div>
        ) : (
          <>
            <header className="chat-header">
              <button className="back-mobile" onClick={() => setActiveId(null)}>←</button>
              <span>{active.title || `会话 ${active.id.slice(0, 8)}`}</span>
              <span className="cwd">{active.cwd}</span>
            </header>

            <div className="messages">
              {events.map((e, i) => <EventView key={i} event={e} />)}
              {active.status === 'running' && <div className="thinking">Claude 正在工作…</div>}

              {permission && (
                <div className="permission-card">
                  <div className="perm-title">⚠️ Claude 请求权限：<b>{permission.toolName}</b></div>
                  <pre>{JSON.stringify(permission.input, null, 2)?.slice(0, 1000)}</pre>
                  <div className="perm-actions">
                    <button className="allow" onClick={() => respondPermission(true)}>允许</button>
                    <button className="deny" onClick={() => respondPermission(false)}>拒绝</button>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="input-bar">
              <textarea
                value={input}
                placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />
              <button onClick={sendMessage} disabled={!input.trim()}>发送</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
