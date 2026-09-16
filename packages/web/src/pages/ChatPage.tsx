import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ProjectInfo, ServerMessage, SessionInfo } from '@codeforeman/shared';
import { api } from '../api';
import { onWsMessage, sendWs } from '../ws';

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

// ---------- 事件渲染 ----------

function EventView({ event }: { event: StoredEvent }) {
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

  if (event.type === 'result') {
    const secs = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) : '?';
    return <div className="turn-done">—— 本轮结束 · {secs}s{event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''} ——</div>;
  }

  if (event.type === 'error') {
    return <div className="error">出错：{String(event.message?.content ?? '')}</div>;
  }

  return null;
}

// ---------- 会话页 ----------

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [permission, setPermission] = useState<PermissionCard | null>(null);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = sessionId ?? null;

  useEffect(() => {
    api.get<SessionInfo[]>('/api/sessions').then(setSessions);
    api.get<ProjectInfo[]>('/api/projects').then(setProjects);
  }, []);

  // WS 消息分发
  useEffect(() => onWsMessage((msg) => {
    switch (msg.type) {
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
  }), []);

  // 切换会话：拉历史 + 订阅
  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setPermission(null);
    api.get<{ event: StoredEvent }[]>(`/api/sessions/${sessionId}/messages`)
      .then((rows) => setEvents(rows.map((r) => r.event)));
    sendWs({ type: 'session.subscribe', sessionId });
    return () => sendWs({ type: 'session.unsubscribe', sessionId });
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events, permission]);

  const active = sessions.find((s) => s.id === sessionId);

  const createSession = async (projectId: string) => {
    const s = await api.post<SessionInfo>('/api/sessions', { projectId });
    setSessions((prev) => [s, ...prev]);
    navigate(`/chat/${s.id}`);
  };

  const sendMessage = () => {
    const text = input.trim();
    if (!text || !sessionId) return;
    sendWs({ type: 'chat.send', sessionId, text });
    setInput('');
  };

  const respondPermission = (allow: boolean) => {
    if (!permission) return;
    sendWs({ type: 'permission.respond', sessionId: permission.sessionId, requestId: permission.requestId, allow });
    setPermission(null);
  };

  // 把聊天中聊出的想法存进 Backlog
  const saveAsTask = async () => {
    if (!active?.projectId) return;
    const title = prompt('想法标题（一句话）');
    if (!title?.trim()) return;
    const description = prompt('详细描述（可选）') ?? '';
    await api.post('/api/tasks', {
      projectId: active.projectId,
      title: title.trim(),
      description,
      source: 'chat',
    });
    alert('已加入想法队列');
  };

  return (
    <div className="chat-page">
      <aside className={`sidebar ${sessionId ? 'hidden-mobile' : ''}`}>
        <div className="sidebar-title">会话</div>
        <select
          className="new-session-select"
          value=""
          onChange={(e) => e.target.value && createSession(e.target.value)}
        >
          <option value="">+ 在项目中新建会话…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => navigate(`/chat/${s.id}`)}
            >
              <div className="session-main">
                <span className="title">{s.title || `会话 ${s.id.slice(0, 8)}`}</span>
                <span className="project-tag">{s.projectName ?? '未绑定'}</span>
              </div>
              <span className={`status ${s.status}`}>{s.status === 'running' ? '⏳' : s.status === 'error' ? '❌' : ''}</span>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat">
        {!active ? (
          <div className="empty-tip">{sessionId ? '加载中…' : '选择左侧会话，或在项目中新建'}</div>
        ) : (
          <>
            <header className="chat-header">
              <button className="back-mobile" onClick={() => navigate('/chat')}>←</button>
              <span>{active.title || `会话 ${active.id.slice(0, 8)}`}</span>
              <span className="cwd">{active.projectName ?? active.cwd}</span>
              <span className="spacer" />
              {active.projectId && <button className="idea-btn" onClick={saveAsTask}>💡 存为想法</button>}
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
