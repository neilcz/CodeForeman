import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectInfo, TaskInfo, TaskStatus } from '@codeforeman/shared';
import { api } from '../api';
import { onWsMessage } from '../ws';

const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: '草稿',
  queued: '排队中',
  running: '执行中',
  review: '待验收',
  done: '已完成',
  failed: '失败',
  conflict: '合并冲突',
};

export default function BacklogPage() {
  const [taskList, setTaskList] = useState<TaskInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [autoMerge, setAutoMerge] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    api.get<TaskInfo[]>('/api/tasks').then(setTaskList);
    api.get<ProjectInfo[]>('/api/projects').then((ps) => {
      setProjects(ps);
      if (ps.length > 0) setProjectId(ps[0].id);
    });
  }, []);

  // 任务状态变化实时刷新
  useEffect(() => onWsMessage((msg) => {
    if (msg.type === 'task.updated') {
      setTaskList((list) => {
        const i = list.findIndex((t) => t.id === msg.task.id);
        if (i === -1) return [msg.task, ...list];
        const next = [...list];
        next[i] = msg.task;
        return next;
      });
    }
  }), []);

  const create = async () => {
    if (!projectId || !title.trim()) return;
    try {
      const t = await api.post<TaskInfo>('/api/tasks', { projectId, title: title.trim(), description, autoMerge });
      setTaskList((l) => [t, ...l]);
      setTitle('');
      setDescription('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const execute = async (t: TaskInfo) => {
    try {
      await api.post(`/api/tasks/${t.id}/execute`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const complete = async (t: TaskInfo) => {
    try {
      await api.post(`/api/tasks/${t.id}/complete`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (t: TaskInfo) => {
    if (!confirm(`删除任务「${t.title}」？`)) return;
    await api.del(`/api/tasks/${t.id}`);
    setTaskList((l) => l.filter((x) => x.id !== t.id));
  };

  return (
    <div className="page-content">
      <h2>想法 / 计划</h2>
      <div className="create-form">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input placeholder="标题（一句话说清要做什么）" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea
          placeholder="详细描述（可选，越具体 Claude 做得越准）"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <label className="auto-merge">
          <input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} />
          验收后自动合并回主分支并删除任务分支
        </label>
        <button onClick={create} disabled={!projectId || !title.trim()}>加入队列</button>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="task-list">
        {taskList.map((t) => (
          <div key={t.id} className={`task-card status-${t.status}`}>
            <div className="task-head">
              <span className={`task-status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>
              <b className="task-title">{t.title}</b>
              <span className="project-tag">{t.projectName}</span>
            </div>
            {t.description && <div className="task-desc">{t.description}</div>}
            {t.branch && <div className="task-branch">⎇ {t.branch}{t.mergeCommit ? ` → ${t.mergeCommit}` : ''}</div>}
            {t.error && <div className="error">{t.error}</div>}
            <div className="task-actions">
              {(t.status === 'draft' || t.status === 'queued') && (
                <button className="exec-btn" onClick={() => execute(t)}>▶ 执行</button>
              )}
              {(t.status === 'review' || t.status === 'running') && t.sessionId && (
                <button className="chat-btn" onClick={() => navigate(`/chat/${t.sessionId}`)}>💬 查看会话</button>
              )}
              {(t.status === 'review') && (
                <button className="save-btn" onClick={() => complete(t)}>
                  ✓ 验收{t.autoMerge ? '并合并' : '（保留分支）'}
                </button>
              )}
              {(t.status === 'draft' || t.status === 'queued' || t.status === 'failed' || t.status === 'conflict') && (
                <button className="del-btn" onClick={() => remove(t)}>删除</button>
              )}
              {t.status === 'conflict' && t.branch && (
                <span className="conflict-tip">请到服务器上手动处理分支 {t.branch} 的合并</span>
              )}
            </div>
          </div>
        ))}
        {taskList.length === 0 && <div className="empty-tip">队列是空的，记下第一个想法吧</div>}
      </div>
    </div>
  );
}
