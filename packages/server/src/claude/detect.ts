import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 检测容器内 Claude Code CLI 是否可用，返回版本号或 null */
export async function detectClaude(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10_000 });
    return stdout.trim() || 'unknown';
  } catch {
    return null;
  }
}
