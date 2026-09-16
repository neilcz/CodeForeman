import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { FileNode, GitState, ProjectInfo, SessionInfo } from '@codeforeman/shared';
import { api } from '../api';
import { Editor, langOf, monaco } from '../monaco';

function TreeNode({ node, depth, selected, onSelect }: {
  node: FileNode; depth: number; selected: string | null; onSelect: (p: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === 'dir') {
    return (
      <div>
        <div className="tree-row" style={{ paddingLeft: depth * 14 + 8 }} onClick={() => setOpen(!open)}>
          <span className="tree-icon">{open ? '▾' : '▸'}</span> {node.name}
        </div>
        {open && node.children?.map((c) => (
          <TreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    );
  }
  return (
    <div
      className={`tree-row file ${selected === node.path ? 'selected' : ''}`}
      style={{ paddingLeft: depth * 14 + 8 }}
      onClick={() => onSelect(node.path)}
    >
      <span className="tree-icon">·</span> {node.name}
    </div>
  );
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [gitState, setGitState] = useState<GitState | { isRepo: false } | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [treeOpen, setTreeOpen] = useState(true);

  useEffect(() => {
    if (!id) return;
    api.get<ProjectInfo[]>('/api/projects').then((ps) => setProject(ps.find((p) => p.id === id) ?? null));
    api.get<FileNode[]>(`/api/projects/${id}/tree`).then(setTree);
    api.get<GitState | { isRepo: false }>(`/api/projects/${id}/git`).then(setGitState);
  }, [id]);

  const openPath = async (p: string) => {
    if (dirty && !confirm('当前文件有未保存修改，切换将丢弃，继续？')) return;
    const res = await api.get<{ content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(p)}`);
    setOpenFile(p);
    setContent(res.content);
    setDirty(false);
    if (window.innerWidth <= 768) setTreeOpen(false);
  };

  const save = async () => {
    if (!openFile) return;
    await api.put(`/api/projects/${id}/file`, { path: openFile, content });
    setDirty(false);
    setNotice('已保存');
    setTimeout(() => setNotice(''), 1500);
    api.get<GitState | { isRepo: false }>(`/api/projects/${id}/git`).then(setGitState);
  };

  const startChat = async () => {
    const s = await api.post<SessionInfo>('/api/sessions', { projectId: id });
    navigate(`/chat/${s.id}`);
  };

  const refreshGit = () => api.get<GitState | { isRepo: false }>(`/api/projects/${id}/git`).then(setGitState);

  if (!project) return <div className="page-content">加载中…</div>;

  return (
    <div className="project-detail">
      <header className="pd-header">
        <button className="tree-toggle" onClick={() => setTreeOpen(!treeOpen)}>☰</button>
        <b>{project.name}</b>
        {gitState?.isRepo && (
          <span className="git-bar">
            <span className="branch">⎇ {gitState.branch}</span>
            {gitState.changes.length > 0 && <span className="changes">{gitState.changes.length} 个改动</span>}
          </span>
        )}
        <span className="spacer" />
        {notice && <span className="notice">{notice}</span>}
        {dirty && <button className="save-btn" onClick={save}>保存</button>}
        <button className="chat-btn" onClick={startChat}>💬 对话</button>
      </header>
      <div className="pd-body">
        {treeOpen && (
          <div className="file-tree">
            {tree.map((n) => (
              <TreeNode key={n.path} node={n} depth={0} selected={openFile} onSelect={openPath} />
            ))}
          </div>
        )}
        <div className="editor-area">
          {openFile ? (
            <Editor
              path={openFile}
              language={langOf(openFile)}
              value={content}
              theme="vs-dark"
              onChange={(v) => { setContent(v ?? ''); setDirty(true); }}
              onMount={(editor) => {
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
              }}
              options={{ fontSize: 13, minimap: { enabled: false }, automaticLayout: true }}
            />
          ) : (
            <div className="empty-tip">从左侧选择文件开始编辑</div>
          )}
        </div>
      </div>
      {gitState?.isRepo && gitState.changes.length > 0 && (
        <footer className="pd-git-footer" onClick={refreshGit} title="点击刷新">
          {gitState.changes.slice(0, 8).map((c) => (
            <span key={c.path} className="git-change">{c.status} {c.path}</span>
          ))}
          {gitState.changes.length > 8 && <span>…共 {gitState.changes.length} 项</span>}
        </footer>
      )}
    </div>
  );
}
