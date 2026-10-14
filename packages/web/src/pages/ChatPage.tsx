import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App, Alert, Button, Checkbox, Divider, Form, Input, Modal, Radio, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { Conversations, Bubble, type ConversationItemType } from '@ant-design/x';
import { PlusOutlined, DeleteOutlined, StopOutlined, BulbOutlined, FolderAddOutlined, InboxOutlined, LoadingOutlined, CloseCircleFilled, VideoCameraOutlined, FileOutlined, CaretRightOutlined } from '@ant-design/icons';
import type { AttachmentInfo, FeatureInfo, ProjectInfo, ServerMessage, SessionInfo } from '@codeforeman/shared';
import { api, attachmentUrl } from '../api';
import { onWsMessage, sendWs, subscribeSession, unsubscribeSession } from '../ws';
import MarkdownView from '../MarkdownView';
import ChatInput from '../ChatInput';
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
  /** 用户消息携带的附件（服务端落库时附带） */
  attachments?: AttachmentInfo[];
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
  | { kind: 'user'; key: string; ts?: number; text: string; attachments?: AttachmentInfo[] }
  | { kind: 'assistant'; key: string; ts?: number; text: string; final?: boolean }
  | { kind: 'thinking'; key: string; ts?: number; text: string }
  | ToolItem
  | { kind: 'tool-result'; key: string; ts?: number; text: string } // 找不到对应 tool_use 的孤立结果
  | { kind: 'result'; key: string; ts?: number; secs: string; cost?: number; delta?: number }
  | { kind: 'interrupted'; key: string; ts?: number }
  | { kind: 'perm-timeout'; key: string; ts?: number; text: string }
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
        items.push({ kind: 'user', key: key(), ts: ev.ts, text: content, attachments: ev.attachments });
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
      // 历史里可能残留 resume 冷启动的空 result（num_turns:0，服务端新版已过滤），渲染时跳过
      if ((ev as { num_turns?: number }).num_turns === 0) continue;
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
    } else if (ev.type === 'system' && ev.subtype === 'permission.timeout') {
      // 审批超时留痕（服务端落库的系统消息）：超时自动拒绝了哪个工具的哪次请求
      const m = (ev as unknown as Record<string, unknown>).message;
      items.push({ kind: 'perm-timeout', key: key(), ts: ev.ts, text: typeof m === 'string' ? m : '权限确认超时，已自动拒绝' });
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

/**
 * RenderItem 逐字段浅比较：buildItems 在每次 events 变化时重建全部 item 对象，
 * 引用必然全新，memo 默认的浅比较会失效——按字段比对（均为字符串/稳定引用，O(1)），
 * 注意必须覆盖 result（tool_result 会合入已有工具行）和 final（轮次边界会改展开标记）
 */
function sameItem(a: RenderItem, b: RenderItem): boolean {
  for (const k of ['kind', 'ts', 'text', 'result', 'final', 'attachments', 'name', 'input', 'secs', 'cost', 'delta'] as const) {
    if ((a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  }
  return true;
}

const ItemView = memo(function ItemView({ item, onFileClick, sessionId }: {
  item: RenderItem;
  onFileClick?: (path: string) => void;
  sessionId?: string;
}) {
  switch (item.kind) {
    case 'user':
      // 用户消息保持居右气泡，不进时间轴；附件（图片缩略图/文件卡片）排在文字上方
      return (
        <div className="user-msg">
          {!!item.attachments?.length && (
            <div className="user-attach-row">
              {item.attachments.map((a) => {
                const url = sessionId ? attachmentUrl(sessionId, a.file) : '#';
                if (a.kind === 'image') {
                  return (
                    <a key={a.file} href={url} target="_blank" rel="noreferrer" title={a.name}>
                      <img className="attach-thumb" src={url} alt={a.name} />
                    </a>
                  );
                }
                return (
                  <a key={a.file} className="attach-chip" href={url} target="_blank" rel="noreferrer" title={a.name}>
                    {a.kind === 'video' ? <VideoCameraOutlined /> : <FileOutlined />} {a.name}
                  </a>
                );
              })}
            </div>
          )}
          {item.text && (
            <Bubble
              content={item.text}
              placement="end"
              classNames={{ content: 'bubble-user' }}
              contentRender={(c) => <MarkdownView text={String(c)} onFileClick={onFileClick} />}
            />
          )}
        </div>
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
    case 'perm-timeout':
      return (
        <Divider plain style={{ margin: '4px 0' }}>
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            {item.text}{fmtTime(item.ts) && ` · ${fmtTime(item.ts)}`}
          </Typography.Text>
        </Divider>
      );
    case 'error':
      return <div className="cc-plain"><Alert type="error" message={item.text} showIcon /></div>;
  }
}, (a, b) => a.sessionId === b.sessionId && a.onFileClick === b.onFileClick && sameItem(a.item, b.item));

// ---------- 会话页 ----------

/** 未绑定项目的会话归入的分组名 */
const UNGROUPED_GROUP = '未绑定';

/** 侧栏里超过这个时长没动静的会话默认折叠起来（项目会话太多时不再把其他项目挤到下面） */
const OLDER_MS = 3 * 86400_000;
/** 折叠行的 key 前缀（会话 id 是 uuid，不会撞） */
const OLDER_PREFIX = '__older__:';

/**
 * 按最后活动时间倒序。服务端 list 已排好序，但增量消息（新建/更新/状态变化）只带了单条会话，
 * 必须本地重排——否则新消息不会把会话顶到最前，要刷新页面才看到。
 */
const sortSessions = (list: SessionInfo[]) => [...list].sort((a, b) => b.updatedAt - a.updatedAt);

/** 项目组标识色：组名哈希取色相（同名恒同色，无需配置），深色侧栏用中等亮度 */
function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 65% 55%)`;
}

/** 会话列表时间（微信式）：今天显示时分，昨天/一周内给相对词，更早给日期 */
function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400_000;
  if (ts >= startOfToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (ts >= startOfToday - DAY) return '昨天';
  if (ts >= startOfToday - 6 * DAY) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}-${d.getDate()}`;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export default function ChatPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [filterProjectId, setFilterProjectId] = useState(() => localStorage.getItem('cf_chat_project') ?? '');
  /** 「所有项目」视图下按项目分组，记录被折叠的组名（存 localStorage；新出现的组默认展开） */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(
    () => JSON.parse(localStorage.getItem('cf_chat_collapsed_groups') ?? '[]') as string[],
  );
  /** 已展开「更早的会话」的项目组名（只在本次页面停留内有效，刷新后回到默认折叠） */
  const [expandedOlder, setExpandedOlder] = useState<string[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [permission, setPermission] = useState<PermissionCard | null>(null);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [ideaDrafting, setIdeaDrafting] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  /** 点击消息里的文件路径 → 弹窗查看（content 为 null 表示加载中） */
  const [fileView, setFileView] = useState<{ path: string; content: string | null } | null>(null);
  const [ideaForm] = Form.useForm();
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  /** 用户是否贴在消息区底部（自动滚动跟随开关，上翻阅读时不打断） */
  const nearBottomRef = useRef(true);
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
        setSessions(sortSessions(msg.sessions));
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
      case 'session.created':
        // 服务端（任务编排等）新拉起的会话实时进列表；hello 全量/重复广播按 id 去重
        setSessions((s) => sortSessions([msg.session, ...s.filter((x) => x.id !== msg.session.id)]));
        break;
      case 'session.status':
        // 状态变化附带服务端刚写入的 updatedAt：发消息（running）就会把会话顶到列表最前
        setSessions((s) => sortSessions(s.map((x) => (
          x.id === msg.sessionId ? { ...x, status: msg.status, updatedAt: msg.updatedAt } : x
        ))));
        break;
      case 'session.updated':
        setSessions((s) => sortSessions(s.map((x) => (x.id === msg.session.id ? msg.session : x))));
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

  // 自动滚动：只有贴在底部时才跟随新事件（用户上翻阅读时不打断）；事件驱动用瞬时定位，
  // 避免流式期间 smooth 动画被反复打断重启造成卡顿；自己发的消息（user 文本事件）始终 smooth 到底
  useEffect(() => {
    const last = events[events.length - 1];
    const ownMsg = last?.type === 'user' && typeof last.message?.content === 'string';
    if (ownMsg) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    else if (nearBottomRef.current) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [events, permission]);

  // 切换会话后重置为贴底，历史加载完成即落到底部
  useEffect(() => {
    nearBottomRef.current = true;
  }, [sessionId]);

  /** 贴底判定：距底 80px 内视为跟随状态 */
  const onMessagesScroll = () => {
    const el = messagesRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const active = sessions.find((s) => s.id === sessionId);

  /** 事件流 → 缩略行（每轮的最后一条 AI 回复在 buildItems 里标记 final 展开显示） */
  const items = useMemo(() => buildItems(events), [events]);

  /** 打开会话绑定的项目里的文件（相对项目根目录）；useCallback 固定引用，避免击穿消息行 memo */
  const openFile = useCallback(async (rel: string) => {
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
  }, [active?.projectId, message]);
  const filteredSessions = useMemo(
    () => (filterProjectId ? sessions.filter((s) => s.projectId === filterProjectId) : sessions),
    [sessions, filterProjectId],
  );

  /**
   * 分组（仅「所有项目」视图）：组名按项目名，出现顺序即「组内最新会话」排序
   * （sessions 本身按 updatedAt 倒排，Set 保留首次出现顺序）。
   * 组件受控属性是 expandedKeys，对外持久化「已折叠」集合，新项目组默认展开。
   */
  const groupNames = useMemo(
    () => [...new Set(filteredSessions.map((s) => s.projectName ?? UNGROUPED_GROUP))],
    [filteredSessions],
  );
  const expandedGroups = groupNames.filter((g) => !collapsedGroups.includes(g));
  const onGroupExpand = (keys: string[]) => {
    const next = groupNames.filter((g) => !keys.includes(g));
    setCollapsedGroups(next);
    localStorage.setItem('cf_chat_collapsed_groups', JSON.stringify(next));
  };

  /** 各项目组的会话数（组标题计数用；折叠行不算会话，不能直接数 groupInfo.data.length） */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of filteredSessions) {
      const g = s.projectName ?? UNGROUPED_GROUP;
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return counts;
  }, [filteredSessions]);

  const changeFilter = (pid: string) => {
    setFilterProjectId(pid);
    localStorage.setItem('cf_chat_project', pid);
  };

  const createSession = async (projectId: string) => {
    const s = await api.post<SessionInfo>('/api/sessions', { projectId });
    // session.created 广播可能先于 POST 响应到达，按 id 去重防止重复条目
    setSessions((prev) => sortSessions([s, ...prev.filter((x) => x.id !== s.id)]));
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

  const respondPermission = (allow: boolean, extra?: { answers?: Record<string, string>; denyMessage?: string }) => {
    if (!permission) return;
    sendWs({ type: 'permission.respond', sessionId: permission.sessionId, requestId: permission.requestId, allow, ...extra });
    setPermission(null);
  };

  const projectOptions = [
    { value: '', label: '所有项目' },
    ...projects.map((p) => ({ value: p.id, label: p.name })),
  ];

  /**
   * 侧栏条目列表：memo 缓存，避免消息流/输入引起的重渲染反复重建整列 JSX。
   * 每个项目内超过三天没动静的会话默认收成一行「更早的 N 个会话」（合成条目，key 带前缀），
   * 否则某个项目会话太多时，其他项目组会被挤到列表很下面。
   */
  const convItems = useMemo(() => {
    const item = (s: SessionInfo): ConversationItemType => ({
      key: s.id,
      group: s.projectName ?? UNGROUPED_GROUP,
      label: (
        <div>
          <div>{s.title || `会话 ${s.id.slice(0, 8)}`}</div>
          <Typography.Text type="secondary" className="conv-item-sub">
            <span>{formatSessionTime(s.updatedAt)}</span>
            {/* 分组视图下组标题已显示项目名，条目内不再重复 */}
            {filterProjectId && <span>{s.projectName ?? '未绑定'}</span>}
            {s.status === 'running' && (
              <Typography.Text style={{ color: '#1677ff' }}>
                <LoadingOutlined spin /> 进行中
              </Typography.Text>
            )}
            {s.status === 'error' && (
              <Typography.Text type="danger">
                <CloseCircleFilled /> 出错
              </Typography.Text>
            )}
            {s.planned && (
              <Tooltip title={s.planTitle ? `已保存计划：${s.planTitle}` : '已保存计划'}>
                <BulbOutlined className="conv-flag-icon" style={{ color: '#1677ff' }} />
              </Tooltip>
            )}
            {s.archived && (
              <Tooltip title={s.archiveFeatureTitle ? `已归档：${s.archiveFeatureTitle}` : '已归档'}>
                <InboxOutlined className="conv-flag-icon" style={{ color: '#52c41a' }} />
              </Tooltip>
            )}
          </Typography.Text>
        </div>
      ),
    });

    const cutoff = Date.now() - OLDER_MS;
    const buckets = new Map<string, { recent: SessionInfo[]; older: SessionInfo[] }>();
    for (const s of filteredSessions) {
      const group = s.projectName ?? UNGROUPED_GROUP;
      let bucket = buckets.get(group);
      if (!bucket) buckets.set(group, (bucket = { recent: [], older: [] }));
      // 当前打开的会话永远不折进去，否则点进去后它就从列表里消失了
      (s.updatedAt >= cutoff || s.id === sessionId ? bucket.recent : bucket.older).push(s);
    }

    const list: ConversationItemType[] = [];
    for (const [group, { recent, older }] of buckets) {
      list.push(...recent.map(item));
      if (!older.length) continue;
      const open = expandedOlder.includes(group);
      list.push({
        key: OLDER_PREFIX + group,
        group,
        label: (
          <span className="conv-more">
            <CaretRightOutlined className={`conv-more-caret${open ? ' open' : ''}`} />
            {open ? '收起更早的会话' : `更早的 ${older.length} 个会话`}
          </span>
        ),
      });
      if (open) list.push(...older.map(item));
    }
    return list;
  }, [filteredSessions, filterProjectId, expandedOlder, sessionId]);

  return (
    <div className="chat-page">
      <div className={`chat-sider ${sessionId ? 'hidden-mobile' : ''}`}>
        <Select
          style={{ width: '100%' }}
          value={filterProjectId}
          options={projectOptions}
          onChange={changeFilter}
          placeholder="按项目筛选"
          showSearch
          optionFilterProp="label"
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
            showSearch
            optionFilterProp="label"
          />
        )}
        <Conversations
          className="conversations"
          // '' 而非 undefined：合成条目（「更早的 N 个会话」）点击后不会被组件内部记为选中项
          activeKey={sessionId ?? ''}
          onActiveChange={(id) => {
            const key = String(id);
            if (key.startsWith(OLDER_PREFIX)) {
              const group = key.slice(OLDER_PREFIX.length);
              setExpandedOlder((list) =>
                (list.includes(group) ? list.filter((g) => g !== group) : [...list, group]),
              );
              return;
            }
            navigate(`/chat/${key}`);
          }}
          groupable={filterProjectId ? false : {
            collapsible: true,
            expandedKeys: expandedGroups,
            onExpand: onGroupExpand,
            label: (group) => (
              <span className="conv-group-label">
                <span className="conv-group-dot" style={{ background: projectColor(group) }} />
                {group}
                <span className="conv-group-count">{groupCounts.get(group) ?? 0}</span>
              </span>
            ),
          }}
          items={convItems}
          menu={(conv) => (String(conv.key).startsWith(OLDER_PREFIX) ? undefined : {
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

            <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
              {items.map((it) => (
                <ItemView key={it.key} item={it} onFileClick={openFile} sessionId={sessionId} />
              ))}

              {permission && (
                <PermissionAlert key={permission.requestId} permission={permission} onRespond={respondPermission} />
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

            {/* 输入区独立组件：打字只重渲染自身；key 随会话切换，自动重置输入与待发送附件 */}
            <ChatInput key={active.id} sessionId={active.id} />
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
                originSessionId: sessionId,
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
        sessionTitle={active?.title}
        projectId={active?.projectId}
        onClose={() => setArchiveOpen(false)}
      />
    </div>
  );
}

// ---------- 权限确认卡片 ----------

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

type RespondFn = (allow: boolean, extra?: { answers?: Record<string, string>; denyMessage?: string }) => void;

/**
 * 权限确认卡片：按工具类型定制交互。
 * - ExitPlanMode：方案全文（Markdown）+ 同意并执行/打回（可附修改意见）
 * - AskUserQuestion：逐题渲染选项，回答随 allow 回传
 * - 其他（删除命令等）：原始 JSON + 允许/拒绝
 * 通过 key=requestId 挂载，本地状态（打回意见/已选答案）随请求切换自动重置
 */
function PermissionAlert({ permission, onRespond }: { permission: PermissionCard; onRespond: RespondFn }) {
  const [feedback, setFeedback] = useState('');
  /** 问题原文 → 已选 label 列表（单选也存数组，统一处理） */
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const input = (permission.input ?? {}) as Record<string, unknown>;

  if (permission.toolName === 'ExitPlanMode') {
    const plan = typeof input.plan === 'string' && input.plan
      ? input.plan
      : JSON.stringify(permission.input, null, 2);
    return (
      <Alert
        type="info"
        showIcon
        message={<><b>Claude 提交了方案，等你确认</b>（同意后才开始执行）</>}
        description={
          <div>
            <div className="perm-plan"><MarkdownView text={plan} /></div>
            <Input.TextArea
              rows={2}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="打回意见（可选）：方案哪里要改，会原样反馈给 Claude"
              style={{ marginTop: 8 }}
            />
          </div>
        }
        action={
          <Space direction="vertical">
            <Button size="small" type="primary" onClick={() => onRespond(true)}>同意并执行</Button>
            <Button
              size="small"
              danger
              onClick={() => onRespond(false, {
                denyMessage: feedback.trim() ? `用户打回了方案，修改意见：${feedback.trim()}` : undefined,
              })}
            >
              打回
            </Button>
          </Space>
        }
      />
    );
  }

  if (permission.toolName === 'AskUserQuestion') {
    const questions = Array.isArray(input.questions) ? (input.questions as AskQuestion[]) : [];
    const allAnswered = questions.length > 0 && questions.every((q) => (answers[q.question] ?? []).length > 0);
    const submit = () => {
      const flat: Record<string, string> = {};
      for (const q of questions) flat[q.question] = (answers[q.question] ?? []).join(', ');
      onRespond(true, { answers: flat });
    };
    return (
      <Alert
        type="info"
        showIcon
        message={<b>Claude 想确认几个问题</b>}
        description={
          <div className="perm-questions">
            {questions.map((q, qi) => (
              <div key={qi} className="perm-question">
                <div className="perm-question-title">
                  {q.header && <Typography.Text type="secondary" style={{ marginRight: 6 }}>{q.header}</Typography.Text>}
                  {q.question}
                </div>
                {q.multiSelect ? (
                  <Checkbox.Group
                    value={answers[q.question] ?? []}
                    onChange={(vs) => setAnswers((a) => ({ ...a, [q.question]: vs as string[] }))}
                    options={(q.options ?? []).map((o) => ({ value: o.label, label: o.description ? `${o.label} — ${o.description}` : o.label }))}
                  />
                ) : (
                  <Radio.Group
                    value={(answers[q.question] ?? [])[0]}
                    onChange={(e) => setAnswers((a) => ({ ...a, [q.question]: [e.target.value as string] }))}
                    options={(q.options ?? []).map((o) => ({ value: o.label, label: o.description ? `${o.label} — ${o.description}` : o.label }))}
                  />
                )}
              </div>
            ))}
          </div>
        }
        action={
          <Space direction="vertical">
            <Button size="small" type="primary" disabled={!allAnswered} onClick={submit}>提交回答</Button>
            <Button size="small" onClick={() => onRespond(false)}>拒绝</Button>
          </Space>
        }
      />
    );
  }

  // 默认：删除命令等其他需确认的工具
  return (
    <Alert
      type="warning"
      showIcon
      message={<>Claude 请求权限：<b>{permission.toolName}</b></>}
      description={<pre className="perm-pre">{JSON.stringify(permission.input, null, 2)?.slice(0, 1000)}</pre>}
      action={
        <Space direction="vertical">
          <Button size="small" type="primary" onClick={() => onRespond(true)}>允许</Button>
          <Button size="small" onClick={() => onRespond(false)}>拒绝</Button>
        </Space>
      }
    />
  );
}

// 归档弹窗独立组件，避免主组件过重
// 交互：单控件同时承担「选已有功能」和「新建功能」——
// 打开时默认预选（归档过的功能，或新建+预填会话标题），多数情况点「归档」即完成
const CREATE_PREFIX = '__create__:';

function ArchiveModal({ open, sessionId, sessionTitle, projectId, onClose }: {
  open: boolean;
  sessionId?: string;
  sessionTitle?: string;
  projectId?: string | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const [value, setValue] = useState('');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    api.get<FeatureInfo[]>(`/api/features?projectId=${projectId}`).then((fs) => {
      setFeatures(fs);
      // 默认预选：本会话归档过的功能；否则新建功能，名称预填会话标题（去掉【任务】前缀）
      const linked = fs.find((f) => f.items?.some((i) => i.kind === 'session' && i.refId === sessionId));
      const cleanTitle = (sessionTitle ?? '').replace(/^[【\[]任务[】\]]\s*/, '').trim() || '未命名会话';
      setValue(linked?.id ?? CREATE_PREFIX + cleanTitle);
      setSearch('');
    });
  }, [open, projectId, sessionId, sessionTitle]);

  // 新建选项的标题：优先取当前选中值里的，其次取搜索输入
  const createTitle = value.startsWith(CREATE_PREFIX) ? value.slice(CREATE_PREFIX.length) : search.trim();
  const exactMatch = features.some((f) => f.title === createTitle);
  const options = [
    ...features
      .filter((f) => !search || f.title.toLowerCase().includes(search.toLowerCase()))
      .map((f) => ({ value: f.id, label: f.title })),
    ...(createTitle && !exactMatch
      ? [{ value: CREATE_PREFIX + createTitle, label: `➕ 新建功能：${createTitle}` }]
      : []),
  ];

  const submit = async () => {
    if (!value) return;
    setSaving(true);
    try {
      let featureId = value;
      if (value.startsWith(CREATE_PREFIX)) {
        const created = await api.post<{ id: string }>('/api/features', {
          projectId,
          title: value.slice(CREATE_PREFIX.length),
        });
        featureId = created.id;
      }
      await api.post(`/api/features/${featureId}/link`, { kind: 'session', refId: sessionId });
      onClose();
      message.success('已归档到功能演进，AI 正在总结本次会话的改进点…');
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="归档到功能演进"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="归档"
      confirmLoading={saving}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        选择已有功能，或直接输入新名称创建；归档后 AI 会自动总结本次会话的改进点。
      </Typography.Paragraph>
      <Select
        style={{ width: '100%' }}
        showSearch
        value={value || undefined}
        searchValue={search}
        onSearch={setSearch}
        onChange={(v) => { setValue(v); setSearch(''); }}
        filterOption={false}
        options={options}
        placeholder="搜索已有功能，或输入新功能名称"
      />
    </Modal>
  );
}
