import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Empty, Select, Space, Tag, Timeline, Typography } from 'antd';
import { AimOutlined, CommentOutlined, BranchesOutlined } from '@ant-design/icons';
import type { FeatureInfo, FeatureItemInfo, ProjectInfo } from '@codeforeman/shared';
import { api } from '../api';

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface Point { title: string; desc: string }

/** 会话条目的 summary 是节点 JSON：{title, desc}（或旧格式的数组）；空串 = 被跳过/待生成 */
function parsePoints(summary?: string): Point[] | null {
  if (!summary) return null;
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object') {
      return parsed as Point[];
    }
    if (parsed && typeof parsed === 'object' && 'title' in parsed) {
      return [parsed as Point];
    }
  } catch { /* 纯文本摘要（旧数据） */ }
  return null;
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

  /** 一个条目的时间线节点：任务条目只作 meta（节点由其会话产出）；会话无节点（被跳过/待生成）不渲染 */
  const timelineNodes = (item: FeatureItemInfo) => {
    if (item.kind === 'task') return [];
    const points = parsePoints(item.summary);
    if (!points) {
      // 旧数据兼容：非 JSON 的纯文本摘要按单节点渲染
      if (item.summary) {
        return [{
          key: item.id,
          children: (
            <div>
              <Typography.Text style={{ fontSize: 13 }}>{item.label}</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                {item.summary}
              </Typography.Paragraph>
            </div>
          ),
        }];
      }
      return [];
    }
    return points.map((p, i) => ({
      key: `${item.id}-${i}`,
      children: (
        <div>
          <Typography.Text style={{ fontSize: 13 }}>{p.title}</Typography.Text>
          {p.desc && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              {p.desc}
            </Typography.Paragraph>
          )}
        </div>
      ),
    }));
  };

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
            {/* 关联的任务/会话 meta 行 */}
            <Space wrap size={12} style={{ marginBottom: 8 }}>
              {f.items.map((item) => (
                <Space key={item.id} size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatTime(item.createdAt)}</Typography.Text>
                  <Tag icon={item.kind === 'task' ? <AimOutlined /> : <CommentOutlined />}>
                    {item.kind === 'task' ? '任务' : '会话'}
                  </Tag>
                  {item.mergeCommit && (
                    <Typography.Text style={{ fontSize: 12, color: '#4ade80' }}>
                      <BranchesOutlined /> {item.mergeCommit}
                    </Typography.Text>
                  )}
                  {item.kind === 'session' && (
                    <Button size="small" type="link" style={{ padding: 0 }} onClick={() => navigate(`/chat/${item.refId}`)}>
                      查看会话
                    </Button>
                  )}
                </Space>
              ))}
            </Space>
            <Timeline
              items={(() => {
                const nodes = f.items.flatMap(timelineNodes);
                return nodes.length > 0
                  ? nodes
                  : [{ children: <Typography.Text type="secondary">暂无迭代记录</Typography.Text> }];
              })()}
            />
          </Card>
        ))
      )}
    </div>
  );
}
