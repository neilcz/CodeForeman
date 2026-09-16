import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TIMEOUT = 30_000;

export interface GitChange {
  path: string;
  status: string; // M/A/D/?? 等 porcelain 状态码
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** 静默判断是否为 git 仓库 */
export async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--git-dir'], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  try {
    return await git(['branch', '--show-current'], cwd);
  } catch {
    return '';
  }
}

export async function branches(cwd: string): Promise<string[]> {
  const out = await git(['branch', '--format=%(refname:short)'], cwd);
  return out ? out.split('\n') : [];
}

export async function status(cwd: string): Promise<GitChange[]> {
  const out = await git(['status', '--porcelain'], cwd);
  if (!out) return [];
  return out.split('\n').map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3),
  }));
}

/** 默认主分支名：优先 main，其次 master，否则当前分支 */
export async function defaultBranch(cwd: string): Promise<string> {
  const all = await branches(cwd);
  if (all.includes('main')) return 'main';
  if (all.includes('master')) return 'master';
  return (await currentBranch(cwd)) || 'main';
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  await git(['checkout', branch], cwd);
}

export async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', 'HEAD'], cwd);
    return true;
  } catch {
    return false;
  }
}

const COMMIT_ENV = ['-c', 'user.name=CodeForeman', '-c', 'user.email=codeforeman@local'];

export async function createBranch(cwd: string, branch: string, from: string): Promise<void> {
  // 空仓库（尚无任何提交）先落一个空初始提交，否则 from 分支还不存在
  if (!(await hasCommits(cwd))) {
    await git([...COMMIT_ENV, 'commit', '--allow-empty', '-m', 'chore: initial commit'], cwd);
  }
  await git(['checkout', from], cwd);
  await git(['checkout', '-b', branch], cwd);
}

/** 提交全部改动；无改动时返回 false */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if ((await status(cwd)).length === 0) return false;
  await git(['add', '-A'], cwd);
  await git([...COMMIT_ENV, 'commit', '-m', message], cwd);
  return true;
}

/** 合并分支（--no-ff）；冲突时抛错 */
export async function merge(cwd: string, branch: string): Promise<void> {
  await git(['merge', '--no-ff', '-m', `Merge branch '${branch}'`, branch], cwd);
}

export async function mergeAbort(cwd: string): Promise<void> {
  await git(['merge', '--abort'], cwd);
}

export async function deleteBranch(cwd: string, branch: string): Promise<void> {
  await git(['branch', '-d', branch], cwd);
}

export async function headCommit(cwd: string): Promise<string> {
  return git(['rev-parse', '--short', 'HEAD'], cwd);
}

