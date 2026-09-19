import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App, Alert, Button, Divider, Form, Input, Modal, Select, Space, Spin, Typography } from 'antd';
import type { FormInstance } from 'antd';
import { Conversations, Bubble, Sender } from '@ant-design/x';
import { PlusOutlined, DeleteOutlined, StopOutlined, BulbOutlined, FolderAddOutlined, LoadingOutlined, CloseCircleFilled } from '@ant-design/icons';
import type { FeatureInfo, ProjectInfo, ServerMessage, SessionInfo } from '@codeforeman/shared';
import { api } from '../api';
import { onWsMessage, sendWs, subscribeSession, unsubscribeSession } from '../ws';
import MarkdownView from '../MarkdownView';
import { Editor, langOf } from '../monaco';

// ---------- 类型 ----------

interface PermissionCard {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
}

interface ContentBlock {
  type: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  thinking?: string;
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
  /** 落库时间（服务端 created_at / 广播 ts，前端注入） */
  ts?: number;
  [k: string]: unknown;
}

// ---------- 事件 → 缩略行（Claude Code 风格：圆点 + 竖线 + 单行摘要，点击展开） ----------

const oneLine = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

interface ToolItem {
  kind: 'tool';
  key: string;
  ts?: number;
  name: string;
  input: unknown;
  result?: string;
}

type RenderItem =
  | { kind: 'user'; key: string; ts?: number; text: string }
  | { kind: 'assistant'; key: string; ts?: number; text: string; final?: boolean }
  | { kind: 'thinking'; key: string; ts?: number; text: string }
  | ToolItem
  | { kind: 'tool-result'; key: string; ts?: number; text: string } // 找不到对应 tool_use 的孤立结果
  | { kind: 'result'; key: string; ts?: number; secs: string; cost?: number; delta?: number }
  | { kind: 'interrupted'; key: string; ts?: number }
  | { kind: 'error'; key: string; ts?: number; text: string };

/** 把事件流整理成渲染行：tool_result 按 tool_use_id 合并进对应工具行 */
function buildItems(events: StoredEvent[]): RenderItem[] {
  const items: RenderItem[] = [];
  const tools = new Map<string, ToolItem>();
  let seq = 0;
  const key = () => `k${seq++}`;
  let prevCost: number | undefined; // total_cost_usd 是累计值，用于算本轮增量
  for (const ev of events) {
    if (ev.type === 'user') {
      const content = ev.message?.content;
      if (typeof content === 'string') {
        items.push({ kind: 'user', key: key(), ts: ev.ts, text: content });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== 'tool_result') continue;
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content, null, 2);
          const t = b.tool_use_id ? tools.get(b.tool_use_id) : undefined;
          if (t) t.result = t.result ? `${t.result}\n---\n${text}` : text;
          else items.push({ kind: 'tool-result', key: key(), ts: ev.ts, text });
        }
      }
    } else if (ev.type === 'assistant') {
      const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) items.push({ kind: 'assistant', key: key(), ts: ev.ts, text: b.text });
        else if (b.type === 'thinking' && b.thinking) items.push({ kind: 'thinking', key: key(), ts: ev.ts, text: b.thinking });
        else if (b.type === 'tool_use') {
          const t: ToolItem = { kind: 'tool', key: key(), ts: ev.ts, name: b.name ?? 'tool', input: b.input };
          if (b.id) tools.set(b.id, t);
          items.push(t);
        }
      }
    } else if (ev.type === 'result') {
      const cost = ev.total_cost_usd;
      items.push({
        kind: 'result', key: key(), ts: ev.ts,
        secs: ev.duration_ms ? (ev.duration_ms / 1000).toFixed(1) : '?',
        cost,
        delta: cost != null && prevCost != null ? cost - prevCost : undefined,
      });
      if (cost != null) prevCost = cost;
    } else if (ev.type === 'system' && ev.subtype === 'interrupted') {
      items.push({ kind: 'interrupted', key: key(), ts: ev.ts });
    } else if (ev.type === 'error') {
      items.push({ kind: 'error', key: key(), ts: ev.ts, text: String(ev.message?.content ?? '') });
    }
  }
  // 每轮对话（result/interrupted/新用户消息为轮次边界）的最后一条 AI 文本标记为 final：
  // 展开显示、大字体、无时间线；进行中的轮次最后一条同样命中，保证流式可见
  let lastAi = -1;
  for (let i = 0; i <= items.length; i++) {
    const it = items[i];
    const boundary = i === items.length
      || it.kind === 'result' || it.kind === 'interrupted' || it.kind === 'user' || it.kind === 'error';
    if (boundary) {
      if (lastAi >= 0) (items[lastAi] as { final?: boolean }).final = true;
      lastAi = -1;
    } else if (it.kind === 'assistant') {
      lastAi = i;
    }
  }
  return items;
}

const fmtTime = (ts?: number) =>
  ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';

/** 工具行摘要：优先 description，其次文件路径/命令等关键参数 */
function toolSummary(input: unknown): string {
  const o = input as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return '';
  if (typeof o.description === 'string' && o.description) return o.description;
  for (const k of ['file_path', 'path', 'command', 'pattern', 'url', 'query']) {
    if (typeof o[k] === 'string' && o[k]) return o[k] as string;
  }
  return oneLine(JSON.stringify(o), 80);
}

/** 工具输入展示：Bash 直接显示命令，其余显示格式化 JSON */
function toolInputDisplay(input: unknown): string {
  const o = input as Record<string, unknown> | null;
  if (o && typeof o.command === 'string') return o.command;
  return JSON.stringify(input, null, 2)?.slice(0, 4000) ?? '';
}

function CcRow({ dot, summary, time, open, children }: {
  dot: string;
  summary: React.ReactNode;
  time?: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details className="cc-row" open={open || undefined}>
      <summary>
        <span className={`cc-dot ${dot}`} />
        <span className="cc-summary">{summary}</span>
        {time && <span className="cc-time">{time}</span>}
      </summary>
      <div className="cc-detail">{children}</div>
    </details>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const desc = toolSummary(item.input);
  return (
    <CcRow
      dot="cc-dot-tool"
      time={fmtTime(item.ts)}
      summary={<><b>{item.name}</b>{desc && <span className="cc-dim"> {oneLine(desc, 80)}</span>}</>}
    >
      <div className="cc-box">
        <div className="cc-io">
          <span className="cc-io-label">IN</span>
          <pre>{toolInputDisplay(item.input)}</pre>
        </div>
        {item.result != null && (
          <div className="cc-io">
            <span className="cc-io-label">OUT</span>
            <pre>{item.result.slice(0, 4000)}</pre>
          </div>
        )}
      </div>
    </CcRow>
  );
}

function ItemView({ item, onFileClick }: {
  item: RenderItem;
  onFileClick?: (path: string) => void;
}) {
  switch (item.kind) {
    case 'user':
      // 用户消息保持居右气泡，不进时间轴
      return (
        <Bubble
          content={item.text}
          placement="end"
          classNames={{ content: 'bubble-user' }}
          contentRender={(c) => <MarkdownView text={String(c)} onFileClick={onFileClick} />}
        />
      );
    case 'assistant':
      // 本轮最后一条 AI 回复（总结性文案）：展开、大字体、无时间线
      if (item.final) {
        return (
          <div className="cc-final">
            <MarkdownView text={item.text} onFileClick={onFileClick} />
            {item.ts && <div className="cc-final-time cc-dim">{fmtTime(item.ts)}</div>}
          </div>
        );
      }
      return (
        <CcRow dot="cc-dot-ai" time={fmtTime(item.ts)} summary={oneLine(item.text)}>
          <MarkdownView text={item.text} onFileClick={onFileClick} />
        </CcRow>
      );
    case 'thinking':
      return (
        <CcRow dot="cc-dot-think" time={fmtTime(item.ts)} summary={<span className="cc-dim">思考 · {oneLine(item.text, 80)}</span>}>
          <div className="cc-think-body cc-dim">{item.text}</div>
        </CcRow>
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'tool-result':
      return (
        <CcRow dot="cc-dot-tool" time={fmtTime(item.ts)} summary={<span className="cc-dim">工具结果 · {oneLine(item.text, 80)}</span>}>
          <div className="cc-box">
            <div className="cc-io">
              <span className="cc-io-label">OUT</span>
              <pre>{item.text.slice(0, 4000)}</pre>
            </div>
          </div>
        </CcRow>
      );
    case 'result':
      return (
        <Divider plain style={{ margin: '4px 0' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            本轮结束{fmtTime(item.ts) && ` · ${fmtTime(item.ts)}`} · {item.secs}s
            {item.delta != null && ` · 本轮 $${item.delta.toFixed(4)}`}
            {item.cost != null && ` · 累计 $${item.cost.toFixed(4)}`}
          </Typography.Text>
        </Divider>
      );
    case 'interrupted':
      return (
        <Divider plain style={{ margin: '4px 0' }}>
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            <StopOutlined /> 已中断{fmtTime(item.ts) && ` · ${fmtTime(item.ts)}`}
          </Typography.Text>
        </Divider>
      );
    case 'error':
      return <div className="cc-plain"><Alert type="error" message={item.text} showIcon /></div>;
  }
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
  const [ideaDrafting, setIdeaDrafting] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  /** 点击消息里的文件路径 → 弹窗查看（content 为 null 表示加载中） */
  const [fileView, setFileView] = useState<{ path: string; content: string | null } | null>(null);
  const [ideaForm] = Form.useForm();
  const [archiveForm] = Form.useForm();
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = sessionId ?? null;
  /** 已渲染消息的 DB 行 id（重连补拉/重复广播去重用） */
  const seenIdsRef = useRef<Set<number>>(new Set());
  const lastIdRef = useRef(0);

  useEffect(() => {
    api.get<SessionInfo[]>('/api/sessions').then(setSessions);
    api.get<ProjectInfo[]>('/api/projects').then(setProjects);
  }, []);

  useEffect(() => onWsMessage((msg) => {
    switch (msg.type) {
      case 'server.hello': {
        // 每次（重）连接服务端都会推全量会话列表：刷新状态，并补拉断线期间错过的消息
        setSessions(msg.sessions);
        const sid = activeRef.current;
        if (sid) {
          api.get<{ id: number; ts: number; event: StoredEvent }[]>(`/api/sessions/${sid}/messages?after=${lastIdRef.current}`)
            .then((rows) => {
              const fresh = rows.filter((r) => !seenIdsRef.current.has(r.id));
              if (!fresh.length) return;
              for (const r of fresh) {
                seenIdsRef.current.add(r.id);
                lastIdRef.current = Math.max(lastIdRef.current, r.id);
              }
              setEvents((e) => [...e, ...fresh.map((r) => ({ ...r.event, ts: r.ts }))]);
            });
        }
        break;
      }
      case 'session.status':
        setSessions((s) => s.map((x) => (x.id === msg.sessionId ? { ...x, status: msg.status } : x)));
        break;
      case 'session.updated':
        setSessions((s) => s.map((x) => (x.id === msg.session.id ? msg.session : x)));
        break;
      case 'claude.event':
        if (msg.sessionId === activeRef.current) {
          if (msg.id != null) {
            if (seenIdsRef.current.has(msg.id)) break; // 补拉与实时广播可能重复，按行 id 去重
            seenIdsRef.current.add(msg.id);
            lastIdRef.current = Math.max(lastIdRef.current, msg.id);
          }
          setEvents((e) => [...e, { ...(msg.event as StoredEvent), ts: msg.ts ?? Date.now() }]);
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
    seenIdsRef.current = new Set();
    lastIdRef.current = 0;
    api.get<{ id: number; ts: number; event: StoredEvent }[]>(`/api/sessions/${sessionId}/messages`)
      .then((rows) => {
        seenIdsRef.current = new Set(rows.map((r) => r.id));
        lastIdRef.current = rows.length ? rows[rows.length - 1].id : 0;
        setEvents(rows.map((r) => ({ ...r.event, ts: r.ts })));
      });
    subscribeSession(sessionId);
    return () => unsubscribeSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events, permission]);

  const active = sessions.find((s) => s.id === sessionId);

  /** 事件流 → 缩略行（每轮的最后一条 AI 回复在 buildItems 里标记 final 展开显示） */
  const items = useMemo(() => buildItems(events), [events]);

  /** 打开会话绑定的项目里的文件（相对项目根目录） */
  const openFile = async (rel: string) => {
    if (!active?.projectId) {
      message.warning('该会话未绑定项目，无法打开文件');
      return;
    }
    setFileView({ path: rel, content: null });
    try {
      const { content } = await api.get<{ content: string }>(
        `/api/projects/${active.projectId}/file?path=${encodeURIComponent(rel)}`,
      );
      setFileView({ path: rel, content });
    } catch (e) {
      setFileView(null);
      message.error(`无法打开 ${rel}：${(e as Error).message}`);
    }
  };
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

  /** 打开「存为计划」弹窗，并让 Claude 总结当前会话预填草稿（失败时仍可手动填写） */
  const openIdeaDraft = async () => {
    if (!sessionId) return;
    setIdeaOpen(true);
    setIdeaDrafting(true);
    try {
      const draft = await api.post<{ title: string; description: string }>(
        `/api/sessions/${sessionId}/plan-draft`, {},
      );
      // 用户等待期间若已手动输入过，不覆盖
      if (!ideaForm.getFieldValue('title')?.trim()) ideaForm.setFieldsValue(draft);
    } catch (e) {
      message.warning(`草稿生成失败（${(e as Error).message}），请手动填写`);
    } finally {
      setIdeaDrafting(false);
    }
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
                    <Button size="small" icon={<BulbOutlined />} onClick={openIdeaDraft}>存为计划</Button>
                    <Button size="small" icon={<FolderAddOutlined />} onClick={() => setArchiveOpen(true)}>归档</Button>
                  </>
                )}
              </Space>
            </div>

            <div className="messages">
              {items.map((it) => (
                <ItemView key={it.key} item={it} onFileClick={openFile} />
              ))}

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
                placeholder="输入消息，Enter 发送（Shift+Enter 换行）；对话进行中发送会排队"
              />
            </div>
          </>
        )}
      </div>

      {/* 文件查看（只读）：点击消息里的文件路径弹出 */}
      <Modal
        title={fileView?.path}
        open={!!fileView}
        onCancel={() => setFileView(null)}
        footer={null}
        width="80%"
        styles={{ body: { height: '70vh', padding: 0 } }}
        destroyOnHidden
      >
        {fileView?.content != null ? (
          <Editor
            path={fileView.path}
            language={langOf(fileView.path)}
            value={fileView.content}
            theme="vs-dark"
            options={{ readOnly: true, fontSize: 13, minimap: { enabled: false }, automaticLayout: true }}
          />
        ) : (
          <div className="empty-tip">加载中…</div>
        )}
      </Modal>

      {/* 存为计划 */}
      <Modal
        title="存为计划"
        open={ideaOpen}
        onCancel={() => { setIdeaOpen(false); ideaForm.resetFields(); }}
        onOk={() => ideaForm.submit()}
        okButtonProps={{ disabled: ideaDrafting }}
        destroyOnHidden
      >
        <Spin spinning={ideaDrafting} tip="正在总结对话生成草稿…">
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
              message.success('已加入计划队列');
            }}
          >
            <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
              <Input placeholder="一句话说清要做什么" />
            </Form.Item>
            <Form.Item name="description" label="详细描述（可选）">
              <Input.TextArea rows={5} placeholder="越具体 Claude 做得越准" />
            </Form.Item>
          </Form>
        </Spin>
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
