import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sshKeysDir } from '../config.js';
import type { SshKeyInfo } from '@codeforeman/shared';

const execFileAsync = promisify(execFile);

/** key 名称即文件名，严格限制字符防止路径越界 */
const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/;

/** 应用自管的 ssh config：所有管理的 key 都登记为 IdentityFile，ssh 会依次尝试 */
const configPath = path.join(sshKeysDir, 'config');

/**
 * 启动时初始化：
 * - 生成/刷新自管 ssh config
 * - GIT_SSH_COMMAND 指向该 config，server 自身及派生的 git / claude 子进程都走它；
 *   accept-new 让首次连接自动信任主机 key（之后仍会校验），避免卡在交互确认上。
 *   注意：-F 会取代 ~/.ssh/config，但 ssh 默认的 id_ed25519/id_rsa 仍会自动尝试，
 *   所以宿主机 ~/.ssh 里已有的 key（裸服务）或 entrypoint 复制进容器的 key（Docker）依然有效。
 */
export function initSshKeys() {
  rewriteConfig();
  process.env.GIT_SSH_COMMAND = `ssh -F ${configPath} -o StrictHostKeyChecking=accept-new`;
}

function keyNames(): string[] {
  return fs.readdirSync(sshKeysDir).filter((f) => NAME_RE.test(f) && fs.existsSync(path.join(sshKeysDir, `${f}.pub`)));
}

function rewriteConfig() {
  const lines = keyNames().map((n) => `  IdentityFile ${path.join(sshKeysDir, n)}`);
  fs.writeFileSync(configPath, `Host *\n${lines.join('\n')}\n`, { mode: 0o600 });
}

async function sshKeygen(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ssh-keygen', args, { timeout: 30_000 });
    return stdout.trim();
  } catch (err) {
    // 抛出 ssh-keygen 的实际 stderr（如 "invalid format"），而不是 Node 的包装信息
    const e = err as { stderr?: string; message: string };
    throw new Error(e.stderr?.trim() || e.message);
  }
}

export async function listKeys(): Promise<SshKeyInfo[]> {
  const keys: SshKeyInfo[] = [];
  for (const name of keyNames()) {
    const file = path.join(sshKeysDir, name);
    const publicKey = fs.readFileSync(`${file}.pub`, 'utf8').trim();
    const fingerprint = await sshKeygen(['-lf', file]).catch(() => '');
    const stat = fs.statSync(file);
    keys.push({
      name,
      type: publicKey.split(' ')[0]?.replace('ssh-', '') ?? '',
      fingerprint,
      publicKey,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
    });
  }
  return keys.sort((a, b) => b.createdAt - a.createdAt);
}

function assertName(name: string) {
  if (!NAME_RE.test(name)) throw new Error('名称只能包含字母、数字、-、_（1-40 字符）');
  if (fs.existsSync(path.join(sshKeysDir, name))) throw new Error(`已存在同名 key: ${name}`);
}

/** 生成无密码密钥对（Claude 子进程非交互执行，不能带 passphrase） */
export async function generateKey(name: string, keyType: 'ed25519' | 'rsa'): Promise<SshKeyInfo> {
  assertName(name);
  const file = path.join(sshKeysDir, name);
  const args = keyType === 'rsa'
    ? ['-t', 'rsa', '-b', '4096', '-N', '', '-f', file, '-C', `codeforeman:${name}`]
    : ['-t', 'ed25519', '-N', '', '-f', file, '-C', `codeforeman:${name}`];
  await sshKeygen(args);
  rewriteConfig();
  return (await listKeys()).find((k) => k.name === name)!;
}

/**
 * 导入已有私钥。公钥可不填——ssh-keygen -y 能从私钥推导，
 * 反正 git server 那边早已配好对应公钥，本地只要私钥有效即可用。
 * 带 passphrase 的私钥会在校验时失败被拒绝。
 */
export async function importKey(name: string, privateKey: string, publicKey?: string): Promise<SshKeyInfo> {
  assertName(name);
  const pem = privateKey.trim();
  if (!pem.startsWith('-----BEGIN') || !pem.includes('PRIVATE KEY-----')) {
    throw new Error('私钥格式不正确（应为 PEM/OpenSSH 格式，以 -----BEGIN ... PRIVATE KEY----- 开头）');
  }
  const file = path.join(sshKeysDir, name);
  fs.writeFileSync(file, pem + '\n', { mode: 0o600 });
  try {
    // 顺带校验私钥有效（无效/带密码会在这里报错）
    const derived = await sshKeygen(['-y', '-f', file]);
    fs.writeFileSync(`${file}.pub`, (publicKey?.trim() || derived) + '\n', { mode: 0o644 });
  } catch (err) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.pub`, { force: true });
    throw new Error(`私钥无效或带 passphrase（Claude 子进程非交互执行，无法输入密码）：${(err as Error).message}`);
  }
  rewriteConfig();
  return (await listKeys()).find((k) => k.name === name)!;
}

export function deleteKey(name: string) {
  const file = path.join(sshKeysDir, name);
  if (!NAME_RE.test(name) || !fs.existsSync(file)) throw new Error('key not found');
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.pub`, { force: true });
  rewriteConfig();
}
