import WebSocket from 'ws';
const TID = process.argv[2];
const ws = new WebSocket('ws://localhost:3780/ws');
let sessionId = null;
async function post(url, body) {
  const r = await fetch(`http://localhost:3780${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return r.json();
}
ws.on('open', async () => {
  const t = await post(`/api/tasks/${TID}/execute`);
  if (!t.id) { console.log('[execute] FAILED:', t.error); process.exit(1); }
  console.log('[execute]', t.status, '| branch:', t.branch);
  sessionId = t.sessionId;
  ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
});
ws.on('message', async (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.type === 'permission.request') {
    console.log('[permission]', msg.toolName, '→ allow');
    ws.send(JSON.stringify({ type: 'permission.respond', sessionId, requestId: msg.requestId, allow: true }));
  }
  if (msg.type === 'task.updated') {
    console.log('[task]', msg.task.status, msg.task.error ?? '');
    if (msg.task.status === 'review') {
      const done = await post(`/api/tasks/${TID}/complete`);
      console.log('[final]', done.status, '| mergeCommit:', done.mergeCommit, '| error:', done.error);
      ws.close();
      process.exit(done.status === 'done' ? 0 : 1);
    }
    if (msg.task.status === 'failed' || msg.task.status === 'conflict') process.exit(1);
  }
  if (msg.type === 'claude.event' && msg.event.type === 'assistant') {
    for (const b of msg.event.message?.content ?? []) {
      if (b.type === 'text') console.log('[claude]', b.text.slice(0, 100));
      if (b.type === 'tool_use') console.log('[tool]', b.name);
    }
  }
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 300000);
