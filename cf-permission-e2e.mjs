/**
 * 权限修复端到端验证（需要运行中的服务 + 临时 token，由人工/维护脚本传入）：
 *   阶段1：AskUserQuestion 不再被自动放行，必须走到 permission.request，回答能回传
 *   阶段3：删除 /tmp 临时文件被自动放行（不再弹确认）
 *   阶段4：删除项目文件仍需确认；故意不点，600s 超时后对话里必须留下 permission.timeout 痕迹（且已落库）
 *
 * 运行：node cf-permission-e2e.mjs <token>
 */
import WebSocket from 'ws';

const TOKEN = process.argv[2];
if (!TOKEN) { console.log('用法: node cf-permission-e2e.mjs <token>'); process.exit(1); }
const BASE = 'http://localhost:3780';
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };

async function api(method, url, body) {
  const r = await fetch(`${BASE}${url}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status}: ${j.error}`);
  return j;
}

let phase = 1;
let done = false;
const fail = (why) => { console.log(`E2E FAIL: ${why}`); cleanup(1); };

const projects = await api('GET', '/api/projects');
if (!projects.length) fail('没有可用项目');
const session = await api('POST', '/api/sessions', { projectId: projects[0].id });
console.log('[setup] session:', session.id, '| project:', projects[0].name);

const ws = new WebSocket(`ws://localhost:3780/ws?token=${TOKEN}`);
const send = (m) => ws.send(JSON.stringify(m));

ws.on('open', () => {
  send({ type: 'session.subscribe', sessionId: session.id });
  send({
    type: 'chat.send', sessionId: session.id,
    text: '这是一个权限流程自动化测试。请立即调用 AskUserQuestion 工具向我提一个问题（问题自拟，给两个选项即可）。只调用这一个工具，不要做其他任何事，不要用文字回复代替工具调用。',
  });
  console.log('[phase1] 已发送：要求 Claude 调用 AskUserQuestion');
});

ws.on('message', async (d) => {
  const msg = JSON.parse(d.toString());

  if (msg.type === 'permission.request') {
    if (phase === 1 && msg.toolName === 'AskUserQuestion') {
      const questions = msg.input?.questions ?? [];
      console.log('[phase1] 收到 AskUserQuestion 确认请求（未被自动放行 ✓），问题数:', questions.length);
      const answers = {};
      for (const q of questions) answers[q.question] = q.options?.[0]?.label ?? '可以';
      console.log('[phase1] 回传答案:', JSON.stringify(answers));
      send({ type: 'permission.respond', sessionId: session.id, requestId: msg.requestId, allow: true, answers });
      phase = 2;
      return;
    }
    if (phase === 3 && msg.toolName === 'Bash') {
      fail('删除 /tmp 临时文件应自动放行，却弹出了确认请求');
      return;
    }
    if (phase === 4 && msg.toolName === 'Bash') {
      console.log('[phase4] 收到删除项目文件确认请求 ✓:', JSON.stringify(msg.input?.command ?? msg.input).slice(0, 100));
      console.log('[phase4] 故意不响应，等待 600s 超时留痕…');
      phase = 5;
      return;
    }
    fail(`意外的权限请求: phase=${phase} tool=${msg.toolName}`);
    return;
  }

  if (msg.type === 'claude.event') {
    const ev = msg.event;
    // 阶段2：AskUserQuestion 的 tool_result 回来且本轮结束 → 回答回传成功
    if (phase === 2 && ev.type === 'result') {
      console.log('[phase2] AskUserQuestion 轮次正常结束，回答回传链路 ✓');
      phase = 3;
      send({
        type: 'chat.send', sessionId: session.id,
        text: '请执行这个 Bash 命令：rm -f /tmp/cf-perm-timeout-test-dummy（仅测试用）。只执行这一条命令。',
      });
      console.log('[phase3] 已发送：要求删除 /tmp 临时文件（应自动放行，不弹确认）');
      return;
    }
    // 阶段3：删除 /tmp 文件的轮次直接结束（中途没有弹确认）→ 自动放行 ✓
    if (phase === 3 && ev.type === 'result') {
      console.log('[phase3] 删除 /tmp 临时文件未弹确认、轮次直接结束 ✓');
      phase = 4;
      send({
        type: 'chat.send', sessionId: session.id,
        text: '请执行这个 Bash 命令：rm -f cf-perm-e2e-dummy.txt（仅测试用，该文件不存在也没关系）。只执行这一条命令。',
      });
      console.log('[phase4] 已发送：要求删除项目文件（应弹确认）');
      return;
    }
    // 阶段5：超时留痕系统消息
    if (phase === 5 && ev.type === 'system' && ev.subtype === 'permission.timeout') {
      console.log('[phase5] 对话流中出现超时痕迹 ✓:', ev.message);
      // 验证已落库（刷新/重进会话也能看到）
      const rows = await api('GET', `/api/sessions/${session.id}/messages`);
      const persisted = rows.some((r) => r.event?.type === 'system' && r.event?.subtype === 'permission.timeout');
      console.log(persisted ? '[phase5] 超时痕迹已落库 ✓' : '[phase5] 落库缺失 ✗');
      console.log(persisted ? '\nE2E 全部通过' : '\nE2E 部分失败：落库缺失');
      cleanup(persisted ? 0 : 1);
    }
  }

  if (msg.type === 'chat.error') fail(`chat.error: ${msg.error}`);
});

async function cleanup(code) {
  if (done) return;
  done = true;
  try { await api('DELETE', `/api/sessions/${session.id}`); } catch { /* 忽略 */ }
  try { ws.close(); } catch { /* 忽略 */ }
  setTimeout(() => process.exit(code), 300);
}

// 全程要覆盖 600s 权限超时 + 各轮 LLM 响应时间，总超时放宽到 15 分钟
setTimeout(() => fail(`总超时（phase=${phase}）`), 900_000);
