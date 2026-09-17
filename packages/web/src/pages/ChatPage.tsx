import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App, Alert, Button, Divider, Form, Input, Modal, Select, Space, Tag, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { Conversations, Bubble, Sender } from '@ant-design/x';
import { PlusOutlined, DeleteOutlined, StopOutlined, BulbOutlined, FolderAddOutlined, LoadingOutlined, CloseCircleFilled, ToolOutlined } from '@ant-design/icons';
import type { FeatureInfo, ProjectInfo, ServerMessage, SessionInfo } from '@codeforeman/shared';
import { api } from '../api';
import { onWsMessage, sendWs, subscribeSession, unsubscribeSession } from '../ws';

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
  subtype?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  duration_ms?: number;
  total_cost_usd?: number;
  [k: string]: unknown;
}

// ---------- 事件渲染 ----------

function ToolUseView({ name, input }: { name?: string; input: unknown }) {
  return (
    <details className="tool-block">
      <summary><Tag color="blue"><ToolOutlined /> {name}</Tag></summary>
      <pre>{JSON.stringify(input, null, 2)?.slice(0, 2000)}</pre>
    </details>
  );
}

function EventView({ event }: { event: StoredEvent }) {
  if (event.type === 'user') {
    const content = event.message?.content;
    if (typeof content === 'string') {
      return <Bubble content={content} placement="end" classNames={{ content: 'bubble-user' }} />;
    }
    if (Array.isArray(content)) {
      const results = content.filter((b) => b.type === 'tool_result');
      if (results.length === 0) return null;
      return (
        <details className="tool-block tool-result">
          <summary><Tag>工具结果 ×{results.length}</Tag></summary>
          <pre>{results.map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2))).join('\n---\n').slice(0, 2000)}</pre>
        </details>
      );
    }
    return null;
  }

  if (event.type === 'assistant') {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    return (
      <>
        {blocks.map((b, i) => {
          if (b.type === 'text' && b.text) {
            return <Bubble key={i} content={b.text} placement="start" classNames={{ content: 'bubble-assistant' }} />;
          }
          if (b.type === 'tool_use') return <ToolUseView key={i} name={b.name} input={b.input} />;
          return null;
        })}
      </>
    );
  }

  if (event.type === 'result') {
    const secs = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) : '?';
    return (
      <Divider plain style={{ margin: '4px 0' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          本轮结束 · {secs}s{event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''}
        </Typography.Text>
      </Divider>
    );
  }

  if (event.type === 'system' && event.subtype === 'interrupted') {
    return (
      <Divider plain style={{ margin: '4px 0' }}>
        <Typography.Text type="danger" style={{ fontSize: 12 }}><StopOutlined /> 已中断</Typography.Text>
      </Divider>
    );
  }

  if (event.type === 'error') {
    return <Alert type="error" message={String(event.message?.content ?? '')} showIcon />;
  }

  return null;
}

// ---------- 会话页 ----------

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [filterProjectId, setFilterProjectId] = useState(() => localStorage.getItem('cf_chat_project') ?? '');
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [permission, setPermission] = useState<PermissionCard | null>(null);
  const [input, setInput] = useState('');
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [ideaForm] = Form.useForm();
  const [archiveForm] = Form.useForm();
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = sessionId ?? null;

  useEffect(() => {
    api.get<SessionInfo[]>('/api/sessions').then(setSessions);
    api.get<ProjectInfo[]>('/api/projects').then(setProjects);
  }, []);

  useEffect(() => onWsMessage((msg) => {
    switch (msg.type) {
      case 'session.status':
        setSessions((s) => s.map((x) => (x.id === msg.sessionId ? { ...x, status: msg.status } : x)));
        break;
      case 'session.updated':
        setSessions((s) => s.map((x) => (x.id === msg.session.id ? msg.session : x)));
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

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setPermission(null);
    api.get<{ event: StoredEvent }[]>(`/api/sessions/${sessionId}/messages`)
      .then((rows) => setEvents(rows.map((r) => r.event)));
    subscribeSession(sessionId);
    return () => unsubscribeSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events, permission]);

  const active = sessions.find((s) => s.id === sessionId);
  const filteredSessions = filterProjectId
    ? sessions.filter((s) => s.projectId === filterProjectId)
    : sessions;

  const changeFilter = (pid: string) => {
    setFilterProjectId(pid);
    localStorage.setItem('cf_chat_project', pid);
  };

  const createSession = async (projectId: string) => {
    const s = await api.post<SessionInfo>('/api/sessions', { projectId });
    setSessions((prev) => [s, ...prev]);
    navigate(`/chat/${s.id}`);
  };

  const deleteSession = async (id: string) => {
    await api.del(`/api/sessions/${id}`);
    setSessions((prev) => prev.filter((x) => x.id !== id));
    if (sessionId === id) navigate('/chat');
    message.success('会话已删除');
  };

  const sendMessage = (text: string) => {
    if (!text.trim() || !sessionId) return;
    sendWs({ type: 'chat.send', sessionId, text: text.trim() });
    setInput('');
  };

  const respondPermission = (allow: boolean) => {
    if (!permission) return;
    sendWs({ type: 'permission.respond', sessionId: permission.sessionId, requestId: permission.requestId, allow });
    setPermission(null);
  };

  const projectOptions = [
    { value: '', label: '所有项目' },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <div className="chat-page">
      <div className={`chat-sider ${sessionId ? 'hidden-mobile' : ''}`}>
        <Select
          style={{ width: '100%' }}
          value={filterProjectId}
          options={projectOptions}
          onChange={changeFilter}
          placeholder="按项目筛选"
        />
        {filterProjectId ? (
          <Button type="primary" icon={<PlusOutlined />} block onClick={() => createSession(filterProjectId)}>
            新会话（{projects.find((p) => p.id === filterProjectId)?.name}）
          </Button>
        ) : (
          <Select
            style={{ width: '100%' }}
            value={null}
            placeholder="+ 在项目中新建会话…"
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(v) => v && createSession(v)}
          />
        )}
        <Conversations
          className="conversations"
          activeKey={sessionId}
          onActiveChange={(id) => navigate(`/chat/${id}`)}
          items={filteredSessions.map((s) => ({
            key: s.id,
            label: (
              <div>
                <div>{s.title || `会话 ${s.id.slice(0, 8)}`}</div>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {s.projectName ?? '未绑定'}
                  {s.status === 'running' && (
                    <Typography.Text style={{ fontSize: 11, color: '#1677ff', marginLeft: 6 }}>
                      <LoadingOutlined spin /> 进行中
                    </Typography.Text>
                  )}
                  {s.status === 'error' && (
                    <Typography.Text type="danger" style={{ fontSize: 11, marginLeft: 6 }}>
                      <CloseCircleFilled /> 出错
                    </Typography.Text>
                  )}
                </Typography.Text>
              </div>
            ),
          }))}
          menu={(conv) => ({
            items: [{ key: 'del', label: '删除会话', icon: <DeleteOutlined />, danger: true }],
            onClick: () => {
              Modal.confirm({
                title: '删除会话？',
                content: '历史消息将一并清除，关联的任务不受影响。',
                okButtonProps: { danger: true },
                onOk: () => deleteSession(String(conv.key)),
              });
            },
          })}
        />
      </div>

      <div className="chat-main">
        {!active ? (
          <div className="empty-tip">{sessionId ? '加载中…' : '选择左侧会话，或新建一个'}</div>
        ) : (
          <>
            <div className="chat-header">
              <Button className="back-mobile" type="text" onClick={() => navigate('/chat')}>←</Button>
              <Typography.Text strong>{active.title || `会话 ${active.id.slice(0, 8)}`}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{active.projectName ?? active.cwd}</Typography.Text>
              <span className="spacer" />
              <Space>
                {active.projectId && (
                  <>
                    <Button size="small" icon={<BulbOutlined />} onClick={() => setIdeaOpen(true)}>存为想法</Button>
                    <Button size="small" icon={<FolderAddOutlined />} onClick={() => setArchiveOpen(true)}>归档</Button>
                  </>
                )}
              </Space>
            </div>

            <div className="messages">
              {events.map((e, i) => <EventView key={i} event={e} />)}

              {permission && (
                <Alert
                  type="warning"
                  showIcon
                  message={<>Claude 请求权限：<b>{permission.toolName}</b></>}
                  description={<pre className="perm-pre">{JSON.stringify(permission.input, null, 2)?.slice(0, 1000)}</pre>}
                  action={
                    <Space direction="vertical">
                      <Button size="small" type="primary" onClick={() => respondPermission(true)}>允许</Button>
                      <Button size="small" onClick={() => respondPermission(false)}>拒绝</Button>
                    </Space>
                  }
                />
              )}
              {active.status === 'running' && (
                <div className="thinking-bar">
                  <Typography.Text type="secondary">Claude 正在工作…</Typography.Text>
                  <Button size="small" danger icon={<StopOutlined />} onClick={() => sendWs({ type: 'chat.interrupt', sessionId })}>
                    中断
                  </Button>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            <div className="sender-bar">
              <Sender
                value={input}
                onChange={setInput}
                onSubmit={sendMessage}
                placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
                loading={active.status === 'running'}
              />
            </div>
          </>
        )}
      </div>

      {/* 存为想法 */}
      <Modal
        title="存为想法"
        open={ideaOpen}
        onCancel={() => setIdeaOpen(false)}
        onOk={() => ideaForm.submit()}
        destroyOnHidden
      >
        <Form
          form={ideaForm}
          layout="vertical"
          onFinish={async (v) => {
            await api.post('/api/tasks', {
              projectId: active?.projectId,
              title: v.title.trim(),
              description: v.description ?? '',
              source: 'chat',
            });
            setIdeaOpen(false);
            ideaForm.resetFields();
            message.success('已加入想法队列');
          }}
        >
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="一句话说清要做什么" />
          </Form.Item>
          <Form.Item name="description" label="详细描述（可选）">
            <Input.TextArea rows={3} placeholder="越具体 Claude 做得越准" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 归档到功能 */}
      <ArchiveModal
        open={archiveOpen}
        sessionId={sessionId}
        projectId={active?.projectId}
        form={archiveForm}
        onClose={() => setArchiveOpen(false)}
      />
    </div>
  );
}

// 归档弹窗独立组件，避免主组件过重
function ArchiveModal({ open, sessionId, projectId, form, onClose }: {
  open: boolean;
  sessionId?: string;
  projectId?: string | null;
  form: FormInstance;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [features, setFeatures] = useState<FeatureInfo[]>([]);

  useEffect(() => {
    if (open && projectId) {
      api.get<FeatureInfo[]>(`/api/features?projectId=${projectId}`).then(setFeatures);
    }
  }, [open, projectId]);

  return (
    <Modal
      title="归档到功能演进"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={async (v) => {
          let featureId = v.featureId;
          if (!featureId) {
            const created = await api.post<{ id: string }>('/api/features', { projectId, title: v.newTitle.trim() });
            featureId = created.id;
          }
          await api.post(`/api/features/${featureId}/link`, { kind: 'session', refId: sessionId });
          onClose();
          form.resetFields();
          message.success('已归档到功能演进');
        }}
      >
        <Form.Item name="featureId" label="选择已有功能">
          <Select
            allowClear
            placeholder="选择一个功能，或在下面输入新功能名"
            options={features.map((f) => ({ value: f.id, label: f.title }))}
          />
        </Form.Item>
        <Form.Item
          noStyle
          shouldUpdate={(a, b) => a.featureId !== b.featureId}
        >
          {({ getFieldValue }) => !getFieldValue('featureId') && (
            <Form.Item name="newTitle" label="新功能名称" rules={[{ required: true, message: '选择已有功能或输入新功能名' }]}>
              <Input placeholder="如：用户登录模块" />
            </Form.Item>
          )}
        </Form.Item>
      </Form>
    </Modal>
  );
}
