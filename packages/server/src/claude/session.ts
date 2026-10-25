import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { autoAllow, claudeSpawnOptions, instructionPrompt } from '../settings/index.js';

export interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** 前端确认结果的可选附加信息 */
export interface PermissionResponseOpts {
  /** AskUserQuestion 的回答（{ 问题原文: 选项 }），allow 时并入 updatedInput 回传 */
  answers?: Record<string, string>;
  /** 打回/拒绝原因（如 ExitPlanMode 打回意见），作为 deny message 回传给 Claude */
  denyMessage?: string;
}

export interface ClaudeSessionCallbacks {
  /** 每条 SDK 消息（assistant/user/system/result…） */
  onEvent: (event: unknown) => void;
  /** 捕获到 Claude 侧 session id（init 消息） */
  onSessionId: (claudeSessionId: string) => void;
  /** 一轮对话结束（result 消息） */
  onTurnDone: () => void;
  /** 工具权限请求，需转交前端确认 */
  onPermissionRequest: (req: PermissionRequestEvent) => void;
  /** 权限请求已被处理（用于前端清除卡片） */
  onPermissionResolved: (requestId: string, allow: boolean) => void;
  /** 会话进程流结束（中断/崩溃/正常退出），无论原因 */
  onEnded: () => void;
  onError: (err: Error) => void;
}

/**
 * 一个 Claude 会话 = 一个长驻 query() 流。
 * 通过 streaming input 持续投喂用户消息；resume 支持服务重启后接续。
 */
export class ClaudeSession {
  private queue: SDKUserMessage[] = [];
  private wakeup: (() => void) | null = null;
  private permissionResolvers = new Map<string, (allow: boolean, opts?: PermissionResponseOpts) => void>();
  private started = false;
  private closed = false;
  private abortController: AbortController | null = null;
  /** 用户显式中断标记（SDK 在进程启动失败时也会 abort 控制器，不能信 signal.aborted） */
  private interruptRequested = false;
  /**
   * 本会话中 Claude 通过 Write 创建的文件（绝对路径）。其中临时测试文件的删除属于
   * 收尾清理，按权限策略无需人工确认（见 policy.ts 的 sessionFiles + isTempTestFile）
   */
  private sessionFiles = new Set<string>();

  constructor(
    private opts: { cwd: string; resume?: string | null },
    private cb: ClaudeSessionCallbacks,
  ) {}

  /** 用户发消息（可在对话进行中追加，SDK 会排队处理） */
  send(text: string) {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.wakeup?.();
  }

  /** 中断当前轮次（进程将被终止，下次发言凭 resume 重续） */
  interrupt() {
    this.interruptRequested = true;
    this.abortController?.abort();
  }

  /** 前端权限确认结果回传 */
  respondPermission(requestId: string, allow: boolean, opts?: PermissionResponseOpts): boolean {
    const resolve = this.permissionResolvers.get(requestId);
    if (!resolve) return false;
    this.permissionResolvers.delete(requestId);
    resolve(allow, opts);
    this.cb.onPermissionResolved(requestId, allow);
    return true;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.abortController = new AbortController();

    const stream = this.messageStream();
    let interrupted = false;
    let errored = false;
    try {
      for await (const msg of query({
        prompt: stream,
        options: {
          cwd: this.opts.cwd,
          resume: this.opts.resume ?? undefined,
          abortController: this.abortController,
          // 生效的 Claude 接入配置（设置页可切多套）：进程启动时取一次；未选配置时不传，一切照旧
          ...claudeSpawnOptions(),
          // 全局指令（设置页维护：环境约束、团队约定等），追加到默认系统提示词。
          // 进程启动时读取一次；改指令后已运行的进程不受影响，下次重起的进程生效
          systemPrompt: { type: 'preset', preset: 'claude_code', append: instructionPrompt() },
          // 文件编辑始终自动放行（低风险高频）；其余工具由 canUseTool 按全局权限策略决定：
          // 自动放行或转网页人工确认
          permissionMode: 'acceptEdits',
          canUseTool: (toolName, input, { signal }) => this.handlePermission(toolName, input, signal),
        },
      })) {
        const m = msg as { type: string; subtype?: string; session_id?: string; num_turns?: number };
        // resume 冷启动时 SDK 会先吐一个空 result（num_turns:0 / $0 / 0ms）再重新 init，
        // 并非真实轮次结束：跳过，否则前端出现幽灵「本轮结束」分隔线和负成本增量
        if (m.type === 'result' && m.num_turns === 0) continue;
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
          this.cb.onSessionId(m.session_id);
        }
        this.trackCreatedFiles(msg);
        this.cb.onEvent(msg);
        if (m.type === 'result') this.cb.onTurnDone();
      }
    } catch (err) {
      // 注意：进程启动失败等异常时 SDK 也会 abort 控制器，不能靠 signal.aborted 判断中断，
      // 只有用户显式点了「中断」（interrupt()）才算用户中断，其余一律按错误上报
      if (this.interruptRequested) {
        interrupted = true;
      } else if (!this.closed) {
        errored = true;
        this.cb.onError(err as Error);
      }
    } finally {
      this.closed = true;
      if (interrupted) {
        this.cb.onEvent({ type: 'system', subtype: 'interrupted', message: '用户中断，本轮终止' });
      }
      // 出错路径已由 onError 处理状态（error），不再覆盖为 idle
      if (!errored) this.cb.onEnded();
    }
  }

  close() {
    this.closed = true;
    // 唤醒阻塞中的消息流：generator 得以 return → 输入流结束 → CLI 子进程退出。
    // 只置 closed 是不够的：它正停在 await wakeup 上，没人唤醒就永远不会 return，
    // 进程会一直挂着（常驻会话回收不掉的根因）。abort 是兜底，防止卡在读流/权限等待里。
    this.wakeup?.();
    this.abortController?.abort();
    for (const resolve of this.permissionResolvers.values()) resolve(false);
    this.permissionResolvers.clear();
  }

  private async *messageStream(): AsyncIterable<SDKUserMessage> {
    while (!this.closed) {
      const msg = this.queue.shift();
      if (msg) {
        yield msg;
      } else {
        await new Promise<void>((r) => { this.wakeup = r; });
        this.wakeup = null;
      }
    }
  }

  /**
   * 从 assistant 消息里摘出 Write 工具调用，记录本会话创建的文件。
   * 后续删除其中的临时测试文件（收尾清理测试脚本等）按策略无需人工确认。
   */
  private trackCreatedFiles(msg: unknown) {
    const m = msg as { type?: string; message?: { content?: unknown } };
    if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) return;
    for (const block of m.message.content as { type?: string; name?: string; input?: { file_path?: unknown } }[]) {
      if (block?.type !== 'tool_use' || block.name !== 'Write') continue;
      if (typeof block.input?.file_path === 'string' && block.input.file_path) {
        this.sessionFiles.add(path.resolve(this.opts.cwd, block.input.file_path));
      }
    }
  }

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    // 按全局权限策略自动放行（默认：方案确认/提问、删除项目文件转人工；
    // 删除 /tmp 临时目录和本会话创建的临时测试文件等安全清理直接通过），不走人工确认
    if (autoAllow(toolName, input, { cwd: this.opts.cwd, sessionFiles: this.sessionFiles })) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const requestId = randomUUID();
    const timeoutMs = config.permissionTimeoutMs;
    return new Promise<PermissionResult>((resolve) => {
      let settled = false;
      const done = (result: PermissionResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        this.permissionResolvers.delete(requestId);
        // 超时必须留痕：清掉前端确认卡片 + 在对话流里落一条系统消息（会持久化），
        // 否则像结尾清理临时文件的 rm 超时一样，对话里什么都看不到
        this.cb.onPermissionResolved(requestId, false);
        this.cb.onEvent({
          type: 'system',
          subtype: 'permission.timeout',
          message: `权限确认超时（${Math.round(timeoutMs / 60000)} 分钟无响应），已自动拒绝：${toolName} — ${inputBrief(input)}`,
        });
        done({ behavior: 'deny', message: `审批超时（${Math.round(timeoutMs / 1000)}s 无响应），自动拒绝` });
      }, timeoutMs);

      const onAbort = () => {
        this.permissionResolvers.delete(requestId);
        this.cb.onPermissionResolved(requestId, false);
        done({ behavior: 'deny', message: '会话已中断' });
      };
      signal.addEventListener('abort', onAbort);

      this.permissionResolvers.set(requestId, (allow, opts) => {
        done(allow
          ? { behavior: 'allow', updatedInput: opts?.answers ? { ...input, answers: opts.answers } : input }
          : { behavior: 'deny', message: opts?.denyMessage?.trim() || '用户拒绝' });
      });

      this.cb.onPermissionRequest({ requestId, toolName, input });
    });
  }
}

/** 权限请求的输入摘要（用于超时留痕消息，取命令/文件路径等关键参数） */
function inputBrief(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'description']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  const s = JSON.stringify(input);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
