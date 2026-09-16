import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectInfo } from '@codeforeman/shared';
import { api } from '../api';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const load = () => api.get<ProjectInfo[]>('/api/projects').then(setProjects);
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const p = await api.post<ProjectInfo>('/api/projects', {
        name: name.trim(),
        gitUrl: gitUrl.trim() || undefined,
        visibility: isPublic ? 'public' : 'private',
      });
      navigate(`/projects/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="page-content">
      <h2>项目</h2>
      <div className="create-form">
        <input placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="git 仓库地址（可选，留空则新建空项目）" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} />
        <label className="auto-merge">
          <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
          公共项目（所有用户可见，协作时用不同分支隔离）
        </label>
        <button onClick={create} disabled={creating || !name.trim()}>{creating ? '创建中…' : '创建项目'}</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className="project-card" onClick={() => navigate(`/projects/${p.id}`)}>
            <div className="project-name">
              {p.name}
              <span className={`vis-tag ${p.visibility}`}>{p.visibility === 'public' ? '公共' : '私有'}</span>
            </div>
            <div className="project-path">{p.path}</div>
          </div>
        ))}
        {projects.length === 0 && <div className="empty-tip">还没有项目，创建一个吧</div>}
      </div>
    </div>
  );
}
