import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-plan-queue-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.PROJECTS_DIR = path.join(tempRoot, 'projects');
process.env.ANTHROPIC_AUTH_TOKEN = 'test-only';
fs.mkdirSync(process.env.PROJECTS_DIR, { recursive: true });

const { db } = await import('./packages/server/dist/db/index.js');
const { sessionManager } = await import('./packages/server/dist/sessions/manager.js');

// 在 tasks 模块注册监听前替换 Claude 边界：仍走真实队列、SQLite、会话和 git，只模拟一轮 AI 输出。
const turnDoneListeners = new Set();
const turnErrorListeners = new Set();
sessionManager.onTurnDone = (fn) => turnDoneListeners.add(fn);
sessionManager.onTurnError = (fn) => turnErrorListeners.add(fn);

let activeTurns = 0;
let maxActiveTurns = 0;
const runs = [];
sessionManager.send = (sessionId, text, _attachments, opts = {}) => {
  const title = text.match(/^【执行计划】(.+)$/m)?.[1] ?? 'unknown';
  const cwd = opts.cwd ?? sessionManager.get(sessionId).cwd;
  activeTurns += 1;
  maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
  runs.push({ title, sessionId, cwd });
  db.prepare("UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
  setTimeout(() => {
    fs.writeFileSync(path.join(cwd, `${title}.txt`), `${title}\n${cwd}\n`);
    db.prepare("UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
    activeTurns -= 1;
    for (const fn of turnDoneListeners) fn(sessionId);
  }, 80);
};

const tasks = await import('./packages/server/dist/tasks/index.js');
const projects = await import('./packages/server/dist/projects/index.js');
const features = await import('./packages/server/dist/features/index.js');
const settings = await import('./packages/server/dist/settings/index.js');
const git = await import('./packages/server/dist/git/index.js');

async function makeProject(name) {
  const cwd = path.join(tempRoot, name);
  fs.mkdirSync(cwd);
  await exec('git', ['init', '-b', 'main'], { cwd });
  await exec('git', ['config', 'user.name', 'CF Test'], { cwd });
  await exec('git', ['config', 'user.email', 'cf-test@local'], { cwd });
  fs.writeFileSync(path.join(cwd, 'README.md'), `# ${name}\n`);
  await exec('git', ['add', 'README.md'], { cwd });
  await exec('git', ['commit', '-m', 'chore: initial'], { cwd });
  return projects.createProject({ name, existingPath: cwd });
}

async function waitFor(check, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时：${label}`);
}

async function waitReview(id) {
  await waitFor(() => ['review', 'failed'].includes(tasks.getTask(id)?.status), `任务 ${id} 收尾`);
  const task = tasks.getTask(id);
  assert.equal(task.status, 'review', task.error ?? undefined);
  assert.ok(task.taskCommit, '应记录任务 HEAD');
  return task;
}

function resetTurnStats() {
  runs.length = 0;
  maxActiveTurns = 0;
}

// completeTask 会自动归档；预先放入任务条目走其幂等早退，避免测试触发真实 AI 摘要调用。
function markArchived(projectId, taskId) {
  const feature = features.createFeature(projectId, `test-${taskId}`);
  features.linkItem(feature.id, 'task', taskId);
}

try {
  assert.equal(settings.getTaskExecutionMode(), 'parallel', '默认应保持并行模式');

  // 1. 串行：来源会话复用、同分支 FIFO、每条任务收尾时提交再推进。
  {
    resetTurnStats();
    settings.setTaskExecutionMode('serial');
    const project = await makeProject('serial-repo');
    const origin = sessionManager.create(project.path, '来源会话', project.id);
    const first = tasks.createTask({ projectId: project.id, title: 'serial-first', originSessionId: origin.id, source: 'chat' });
    const second = tasks.createTask({ projectId: project.id, title: 'serial-second', originSessionId: origin.id, source: 'chat' });

    await tasks.executeTask(first.id);
    await tasks.executeTask(second.id);
    assert.equal(tasks.getTask(second.id).status, 'queued');
    const firstDone = await waitReview(first.id);
    const secondDone = await waitReview(second.id);
    await waitFor(() => runs.length === 2, '两个串行任务都已启动');

    assert.deepEqual(runs.map((r) => r.title), ['serial-first', 'serial-second']);
    assert.ok(runs.every((r) => r.sessionId === origin.id), '来源计划必须回到原会话');
    assert.ok(runs.every((r) => r.cwd === project.path));
    assert.equal(maxActiveTurns, 1, '串行不能并发');
    assert.equal(firstDone.branch, 'main');
    assert.equal(secondDone.branch, 'main');
    assert.equal(firstDone.worktreePath, null);
    assert.notEqual(firstDone.taskCommit, secondDone.taskCommit);
    assert.deepEqual(await git.branches(project.path), ['main'], '串行不能创建 feature 分支');
    const log = (await exec('git', ['log', '--format=%s', '-3'], { cwd: project.path })).stdout.trim().split('\n');
    assert.deepEqual(log.slice(0, 2), ['feat: serial-second', 'feat: serial-first']);
    assert.equal((await git.status(project.path)).length, 0);

    // 串行验收只确认状态：即使工作区已有后续改动，也不能在验收旧任务时误提交。
    fs.writeFileSync(path.join(project.path, 'later-uncommitted.txt'), 'later\n');
    const headBeforeReview = await git.headCommit(project.path);
    markArchived(project.id, first.id);
    const accepted = await tasks.completeTask(first.id);
    assert.equal(accepted.status, 'done');
    assert.equal(await git.headCommit(project.path), headBeforeReview);
    assert.ok((await git.status(project.path)).some((c) => c.path === 'later-uncommitted.txt'));
    fs.rmSync(path.join(project.path, 'later-uncommitted.txt'));
    console.log('✓ 串行 FIFO / 来源会话 / 当前分支逐条提交');
  }

  // 2. 并行：两个手动计划真正并发，分支与 worktree 隔离，主工作区不动。
  {
    resetTurnStats();
    settings.setTaskExecutionMode('parallel');
    const project = await makeProject('parallel-repo');
    const mainHead = await git.headCommit(project.path);
    const first = tasks.createTask({ projectId: project.id, title: 'parallel-first' });
    const second = tasks.createTask({ projectId: project.id, title: 'parallel-second', autoMerge: false });
    await tasks.executeTask(first.id);
    await tasks.executeTask(second.id);
    const firstDone = await waitReview(first.id);
    const secondDone = await waitReview(second.id);

    assert.equal(maxActiveTurns, 2, '不同会话的并行计划应同时执行');
    assert.notEqual(firstDone.sessionId, secondDone.sessionId);
    assert.notEqual(firstDone.branch, secondDone.branch);
    assert.notEqual(firstDone.worktreePath, secondDone.worktreePath);
    assert.ok(firstDone.branch.startsWith('feature/'));
    assert.ok(fs.existsSync(firstDone.worktreePath));
    assert.ok(fs.existsSync(secondDone.worktreePath));
    assert.equal(await git.currentBranch(project.path), 'main');
    assert.equal(await git.headCommit(project.path), mainHead, '并行任务不能改主工作区 HEAD');
    assert.equal(fs.existsSync(path.join(project.path, 'parallel-first.txt')), false);
    assert.equal(fs.existsSync(path.join(project.path, 'parallel-second.txt')), false);
    assert.equal(fs.readFileSync(path.join(firstDone.worktreePath, 'parallel-first.txt'), 'utf8').trim(), `parallel-first\n${firstDone.worktreePath}`);

    markArchived(project.id, first.id);
    markArchived(project.id, second.id);
    const merged = await tasks.completeTask(first.id);
    assert.equal(merged.status, 'done');
    assert.ok(merged.mergeCommit);
    assert.equal(merged.worktreePath, null);
    assert.equal((await git.branches(project.path)).includes(firstDone.branch), false, '自动合并后删除任务分支');
    assert.equal(fs.existsSync(firstDone.worktreePath), false);
    assert.equal(fs.existsSync(path.join(project.path, 'parallel-first.txt')), true);

    const retained = await tasks.completeTask(second.id);
    assert.equal(retained.status, 'done');
    assert.equal(retained.mergeCommit, null);
    assert.equal(retained.worktreePath, null);
    assert.equal((await git.branches(project.path)).includes(secondDone.branch), true, '不自动合并时保留任务分支');
    assert.equal(fs.existsSync(secondDone.worktreePath), false);
    assert.equal(fs.existsSync(path.join(project.path, 'parallel-second.txt')), false);
    console.log('✓ 并行并发 / 独立分支与 worktree / 主工作区隔离 / 验收合并');
  }

  // 3. 并行设置下，同一来源会话的计划仍按会话串行，避免上下文交叉。
  {
    resetTurnStats();
    const project = await makeProject('same-session-repo');
    const origin = sessionManager.create(project.path, '并行来源会话', project.id);
    const first = tasks.createTask({ projectId: project.id, title: 'same-first', originSessionId: origin.id });
    const second = tasks.createTask({ projectId: project.id, title: 'same-second', originSessionId: origin.id });
    await tasks.executeTask(first.id);
    await tasks.executeTask(second.id);
    assert.equal(tasks.getTask(second.id).status, 'queued');
    await waitReview(first.id);
    await waitReview(second.id);
    await waitFor(() => runs.length === 2, '同来源会话两个任务都已启动');
    assert.equal(maxActiveTurns, 1);
    assert.ok(runs.every((r) => r.sessionId === origin.id));
    assert.notEqual(runs[0].cwd, runs[1].cwd, '每条并行计划仍有自己的 worktree');
    console.log('✓ 并行模式下同一来源会话仍顺序执行');
  }

  console.log('计划队列回归测试全部通过');
} finally {
  sessionManager.shutdownAll();
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
