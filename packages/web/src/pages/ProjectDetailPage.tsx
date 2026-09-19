import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App, Button, Input, Modal, Select, Space, Tag, Tree, Typography } from 'antd';
import type { TreeDataNode } from 'antd';
import { CommentOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SaveOutlined, BranchesOutlined } from '@ant-design/icons';
import type { FileNode, GitState, ProjectInfo, SessionInfo } from '@codeforeman/shared';
import { api } from '../api';
import { Editor, langOf, monaco } from '../monaco';

function toTreeData(nodes: FileNode[]): TreeDataNode[] {
  return nodes.map((n) => ({
    key: n.path,
    title: n.name,
    isLeaf: n.type === 'file',
    children: n.type === 'dir' ? toTreeData(n.children ?? []) : undefined,
  }));
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [gitState, setGitState] = useState<GitState | { isRepo: false } | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState<'manual' | 'ai' | null>(null);

  const refreshGit = () => id && api.get<GitState | { isRepo: false }>(`/api/projects/${id}/git`).then(setGitState);

  useEffect(() => {
    if (!id) return;
    api.get<ProjectInfo[]>('/api/projects').then((ps) => setProject(ps.find((p) => p.id === id) ?? null));
    api.get<FileNode[]>(`/api/projects/${id}/tree`).then(setTree);
    refreshGit();
  }, [id]);

  const treeData = useMemo(() => toTreeData(tree), [tree]);

  const openPath = async (p: string) => {
    if (dirty && !confirm('当前文件有未保存修改，切换将丢弃，继续？')) return;
    try {
      const res = await api.get<{ content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(p)}`);
      setOpenFile(p);
      setContent(res.content);
      setDirty(false);
      if (window.innerWidth <= 768) setTreeOpen(false);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const save = async () => {
    if (!openFile) return;
    await api.put(`/api/projects/${id}/file`, { path: openFile, content });
    setDirty(false);
    message.success('已保存');
    refreshGit();
  };

  const startChat = async () => {
    const s = await api.post<SessionInfo>('/api/sessions', { projectId: id });
    navigate(`/chat/${s.id}`);
  };

  /** 提交全部改动：manual 用输入框的 message；ai 让 Claude 看 diff 生成 */
  const commitChanges = async (mode: 'manual' | 'ai') => {
    setCommitting(mode);
    try {
      const res = await api.post<{ message: string }>(`/api/projects/${id}/git/commit`,
        mode === 'ai' ? { ai: true } : { message: commitMsg.trim() });
      message.success(`已提交：${res.message}`);
      setCommitOpen(false);
      setCommitMsg('');
      refreshGit();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCommitting(null);
    }
  };

  const switchBranch = async (branch: string) => {
    if (!gitState?.isRepo || branch === gitState.branch) return;
    try {
      await api.post(`/api/projects/${id}/git/checkout`, { branch });
      message.success(`已切换到 ${branch}`);
      // 分支切换后文件树和打开的文件内容都可能变化
      const res = await api.get<FileNode[]>(`/api/projects/${id}/tree`);
      setTree(res);
      if (openFile) {
        try {
          const f = await api.get<{ content: string }>(`/api/projects/${id}/file?path=${encodeURIComponent(openFile)}`);
          setContent(f.content);
          setDirty(false);
        } catch {
          setOpenFile(null); // 新分支上没有这个文件
        }
      }
      refreshGit();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (!project) return <div className="page-content">加载中…</div>;

  return (
    <div className="project-detail">
      <div className="pd-header">
        <Button
          type="text"
          icon={treeOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
          onClick={() => setTreeOpen(!treeOpen)}
        />
        <Typography.Text strong>{project.name}</Typography.Text>
        {gitState?.isRepo && (
          <>
            <Select
              size="small"
              variant="filled"
              value={gitState.branch}
              suffixIcon={<BranchesOutlined />}
              style={{ minWidth: 140, maxWidth: 260 }}
              options={gitState.branches.map((b) => ({ value: b, label: b }))}
              onChange={switchBranch}
              popupMatchSelectWidth={false}
            />
            {gitState.changes.length > 0 && (
              <Tag color="orange" style={{ cursor: 'pointer' }} onClick={() => setCommitOpen(true)}>
                {gitState.changes.length} 个改动
              </Tag>
            )}
          </>
        )}
        {gitState && !gitState.isRepo && (
          <Button
            size="small"
            onClick={async () => { await api.post(`/api/projects/${id}/git-init`); refreshGit(); }}
          >
            非 git 仓库，点击初始化
          </Button>
        )}
        <span className="spacer" />
        <Space>
          {dirty && <Button type="primary" size="small" icon={<SaveOutlined />} onClick={save}>保存</Button>}
          <Button size="small" icon={<CommentOutlined />} onClick={startChat}>对话</Button>
        </Space>
      </div>

      <div className="pd-body">
        {treeOpen && (
          <div className="file-tree">
            <Tree
              treeData={treeData}
              selectedKeys={openFile ? [openFile] : []}
              defaultExpandedKeys={tree.filter((n) => n.type === 'dir').slice(0, 3).map((n) => n.path)}
              onSelect={(keys, info) => {
                const key = keys[0] as string | undefined;
                if (key && info.node.isLeaf) openPath(key);
              }}
              showIcon={false}
              blockNode
            />
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
        <div className="pd-git-footer" onClick={refreshGit} title="点击刷新">
          {gitState.changes.slice(0, 8).map((c) => (
            <Typography.Text key={c.path} type="secondary" style={{ fontSize: 12 }}>
              {c.status} {c.path}
            </Typography.Text>
          ))}
          {gitState.changes.length > 8 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>…共 {gitState.changes.length} 项</Typography.Text>
          )}
        </div>
      )}

      <Modal
        title="提交工作区改动"
        open={commitOpen}
        onCancel={() => setCommitOpen(false)}
        footer={null}
      >
        <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 12 }}>
          {gitState?.isRepo && gitState.changes.map((c) => (
            <Typography.Text key={c.path} type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {c.status} {c.path}
            </Typography.Text>
          ))}
        </div>
        <Input
          placeholder="commit message（留空可用 AI 生成）"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onPressEnter={() => commitMsg.trim() && commitChanges('manual')}
          style={{ marginBottom: 12 }}
        />
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button
            loading={committing === 'ai'}
            disabled={committing === 'manual'}
            onClick={() => commitChanges('ai')}
          >
            AI 生成并提交
          </Button>
          <Button
            type="primary"
            loading={committing === 'manual'}
            disabled={!commitMsg.trim() || committing === 'ai'}
            onClick={() => commitChanges('manual')}
          >
            提交
          </Button>
        </Space>
      </Modal>
    </div>
  );
}
