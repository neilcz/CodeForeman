import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * 一次性轻量文本生成（如 commit message、摘要）。
 * 纯问答无工具需求，失败返回 null 由调用方兜底，不抛错打断主流程。
 */
export async function oneShotText(cwd: string, prompt: string): Promise<string | null> {
  try {
    let text = '';
    for await (const msg of query({ prompt, options: { cwd } })) {
      const m = msg as { type: string; message?: { content?: { type: string; text?: string }[] } };
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) text += b.text;
        }
      }
      if (m.type === 'result') break;
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}
