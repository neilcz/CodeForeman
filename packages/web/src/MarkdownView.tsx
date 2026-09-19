import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 常见文件扩展名白名单：行内代码/相对链接命中才视为文件路径，避免把 `config.version` 之类误判为文件 */
const KNOWN_EXTS = new Set([
  'md', 'txt', 'log', 'json', 'lock', 'env', 'ini', 'conf', 'toml', 'xml', 'csv', 'sql',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'html', 'css', 'scss', 'less', 'vue', 'svelte', 'yml', 'yaml', 'sh', 'bash', 'zsh',
  'dockerfile', 'makefile', 'gitignore', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
]);

/** 判断一段文本是否像项目内文件路径（含 CJK 文件名，不含空格，扩展名在白名单内） */
export function looksLikeFilePath(text: string): boolean {
  if (!text || text.length > 200 || /\s/.test(text)) return false;
  if (!/^[\w./\-~一-龥]+$/.test(text)) return false;
  const name = text.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    // 无扩展名的特殊文件名：Dockerfile / Makefile / .gitignore 等
    return KNOWN_EXTS.has(name.toLowerCase());
  }
  const ext = name.slice(dot + 1).toLowerCase();
  // `.env` 这类隐藏文件 name 以 . 开头，lastIndexOf('.') === 0，整体即扩展名
  return KNOWN_EXTS.has(ext);
}

interface Props {
  text: string;
  /** 点击文件路径时回调（传入项目内相对路径） */
  onFileClick?: (path: string) => void;
}

/**
 * Markdown 渲染：
 * - 行内代码若像文件路径（如 `docs/01-产品功能文档.md`）→ 渲染为可点击链接
 * - 相对路径的 markdown 链接同样视为文件链接；http(s) 链接新窗口打开
 */
export default function MarkdownView({ text, onFileClick }: Props) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const h = href ?? '';
            const isExternal = /^(https?:)?\/\//.test(h) || h.startsWith('mailto:') || h.startsWith('#');
            if (!isExternal && onFileClick && looksLikeFilePath(h)) {
              return <a href={h} onClick={(e) => { e.preventDefault(); onFileClick(h); }}>{children}</a>;
            }
            return <a href={h} target="_blank" rel="noreferrer">{children}</a>;
          },
          code({ className, children }) {
            const isBlock = /language-/.test(className ?? '');
            const inline = String(children ?? '').trim();
            if (!isBlock && onFileClick && looksLikeFilePath(inline)) {
              return (
                <a className="file-link" title="点击查看文件" onClick={() => onFileClick(inline)}>
                  <code>{inline}</code>
                </a>
              );
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
