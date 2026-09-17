import { randomUUID } from 'node:crypto';
import { query, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';

export interface PermissionRequestEvent {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
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
  private permissionResolvers = new Map<string, (allow: boolean) => void>();
  private started = false;
  private closed = false;
  private abortController: AbortController | null = null;

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
    this.abortController?.abort();
  }

  /** 前端权限确认结果回传 */
  respondPermission(requestId: string, allow: boolean): boolean {
    const resolve = this.permissionResolvers.get(requestId);
    if (!resolve) return false;
    this.permissionResolvers.delete(requestId);
    resolve(allow);
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
          // 文件编辑自动放行（低风险高频），Bash/网络等仍需网页确认
          permissionMode: 'acceptEdits',
          canUseTool: (toolName, input, { signal }) => this.handlePermission(toolName, input, signal),
        },
      })) {
        const m = msg as { type: string; subtype?: string; session_id?: string };
        if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
          this.cb.onSessionId(m.session_id);
        }
        this.cb.onEvent(msg);
        if (m.type === 'result') this.cb.onTurnDone();
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
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

  private handlePermission(
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const requestId = randomUUID();
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
        done({ behavior: 'deny', message: '审批超时（120s），自动拒绝' });
      }, config.permissionTimeoutMs);

      const onAbort = () => {
        this.permissionResolvers.delete(requestId);
        done({ behavior: 'deny', message: '会话已中断' });
      };
      signal.addEventListener('abort', onAbort);

      this.permissionResolvers.set(requestId, (allow) => {
        done(allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: '用户拒绝' });
      });

      this.cb.onPermissionRequest({ requestId, toolName, input });
    });
  }
}
