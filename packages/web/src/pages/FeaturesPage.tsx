import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FeatureInfo, ProjectInfo } from '@codeforeman/shared';
import { api } from '../api';

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function FeaturesPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState('');
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<ProjectInfo[]>('/api/projects').then((ps) => {
      setProjects(ps);
      if (ps.length > 0) setProjectId((cur) => cur || ps[0].id);
    });
  }, []);

  useEffect(() => {
    if (projectId) api.get<FeatureInfo[]>(`/api/features?projectId=${projectId}`).then(setFeatures);
  }, [projectId]);

  return (
    <div className="page-content">
      <div className="features-head">
        <h2>功能演进</h2>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div className="feature-list">
        {features.map((f) => (
          <div key={f.id} className="feature-card">
            <div className="feature-title">{f.title}</div>
            {f.summary && <div className="feature-summary">{f.summary}</div>}
            <div className="feature-timeline">
              {f.items.map((item) => (
                <div key={item.id} className="timeline-item">
                  <span className="timeline-time">{formatTime(item.createdAt)}</span>
                  <span className="timeline-kind">{item.kind === 'task' ? '🎯 任务' : '💬 会话'}</span>
                  <span className="timeline-label">{item.label}</span>
                  {item.firstPrompt && <span className="timeline-prompt">「{item.firstPrompt}」</span>}
                  {item.mergeCommit && <span className="timeline-commit">⎇ {item.mergeCommit}</span>}
                  {item.kind === 'session' && (
                    <button className="link-btn" onClick={() => navigate(`/chat/${item.refId}`)}>查看</button>
                  )}
                </div>
              ))}
              {f.items.length === 0 && <div className="timeline-item empty">暂无迭代记录</div>}
            </div>
          </div>
        ))}
        {features.length === 0 && (
          <div className="empty-tip">
            还没有功能归档。<br />
            任务验收后会自动归档；也可以在会话页点「📁 归档」手动整理。
          </div>
        )}
      </div>
    </div>
  );
}
