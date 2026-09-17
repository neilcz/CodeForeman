import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Select, Space, Tag, Timeline, Typography } from 'antd';
import { AimOutlined, CommentOutlined, BranchesOutlined } from '@ant-design/icons';
import type { FeatureInfo, ProjectInfo } from '@codeforeman/shared';
import { api } from '../api';

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function FeaturesPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState(''); // '' = 所有项目
  const [features, setFeatures] = useState<FeatureInfo[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<ProjectInfo[]>('/api/projects').then(setProjects);
  }, []);

  useEffect(() => {
    const url = projectId ? `/api/features?projectId=${projectId}` : '/api/features';
    api.get<FeatureInfo[]>(url).then(setFeatures);
  }, [projectId]);

  return (
    <div className="page-content">
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>功能演进</Typography.Title>
        <Select
          style={{ minWidth: 200 }}
          value={projectId}
          placeholder="按项目筛选"
          options={[{ value: '', label: '所有项目' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={setProjectId}
        />
      </Space>

      {features.length === 0 ? (
        <Empty description={
          <>
            还没有功能归档。<br />
            <Typography.Text type="secondary">任务验收后会自动归档；也可以在会话页点「归档」手动整理。</Typography.Text>
          </>
        } />
      ) : (
        features.map((f) => (
          <Card
            key={f.id}
            size="small"
            style={{ marginBottom: 12 }}
            title={
              <Space>
                {f.title}
                {!projectId && f.projectName && <Tag>{f.projectName}</Tag>}
              </Space>
            }
          >
            {f.summary && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>{f.summary}</Typography.Paragraph>
            )}
            <Timeline
              items={f.items.length === 0
                ? [{ children: <Typography.Text type="secondary">暂无迭代记录</Typography.Text> }]
                : f.items.map((item) => ({
                    children: (
                      <Space wrap size={8}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatTime(item.createdAt)}</Typography.Text>
                        <Tag icon={item.kind === 'task' ? <AimOutlined /> : <CommentOutlined />}>
                          {item.kind === 'task' ? '任务' : '会话'}
                        </Tag>
                        <span>{item.label}</span>
                        {item.firstPrompt && (
                          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 300 }}>
                            「{item.firstPrompt}」
                          </Typography.Text>
                        )}
                        {item.mergeCommit && (
                          <Typography.Text style={{ fontSize: 12, color: '#4ade80' }}>
                            <BranchesOutlined /> {item.mergeCommit}
                          </Typography.Text>
                        )}
                        {item.kind === 'session' && (
                          <Button size="small" type="link" onClick={() => navigate(`/chat/${item.refId}`)}>查看</Button>
                        )}
                      </Space>
                    ),
                  }))}
            />
          </Card>
        ))
      )}
    </div>
  );
}
