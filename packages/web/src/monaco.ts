import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

// 使用本地打包的 monaco（不走 CDN，服务器内网可用）；基础语法高亮无需语言 worker
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

export { Editor, monaco };

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  json: 'json', md: 'markdown', py: 'python', go: 'go', rs: 'rust', java: 'java',
  html: 'html', css: 'css', scss: 'scss', vue: 'html', yml: 'yaml', yaml: 'yaml',
  sh: 'shell', sql: 'sql', xml: 'xml', dockerfile: 'dockerfile', toml: 'ini',
};

export function langOf(filePath: string): string {
  const name = filePath.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  return EXT_TO_LANG[ext] ?? 'plaintext';
}
