import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Card, Checkbox, Col, Empty, Form, Input, Row, Space, Tag, Typography } from 'antd';
import { ReloadOutlined, FolderOutlined } from '@ant-design/icons';
import type { ProjectInfo } from '@codeforeman/shared';
import { api } from '../api';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const navigate = useNavigate();

  const load = () => api.get<ProjectInfo[]>('/api/projects').then(setProjects);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);

  const create = async (values: { name: string; gitUrl?: string; existingPath?: string; isPublic?: boolean }) => {
    setCreating(true);
    try {
      const p = await api.post<ProjectInfo>('/api/projects', {
        name: values.name.trim(),
        gitUrl: values.gitUrl?.trim() || undefined,
        existingPath: values.existingPath?.trim() || undefined,
        visibility: values.isPublic ? 'public' : 'private',
      });
      navigate(`/projects/${p.id}`);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const scan = async () => {
    try {
      const res = await api.post<{ added: number; skipped: number }>('/api/projects/scan');
      message.success(res.added > 0 ? `新发现 ${res.added} 个项目` : '没有新目录（已注册的会跳过）');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page-content">
      <Space style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>项目</Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={scan}>扫描项目目录</Button>
      </Space>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical" onFinish={create} requiredMark={false} size="middle">
          <Form.Item name="name" rules={[{ required: true, message: '请输入项目名称' }]} style={{ marginBottom: 8 }}>
            <Input placeholder="项目名称" />
          </Form.Item>
          <Form.Item name="gitUrl" style={{ marginBottom: 8 }}>
            <Input placeholder="git 仓库地址（可选，留空则新建空项目）" />
          </Form.Item>
          <Form.Item name="existingPath" style={{ marginBottom: 8 }}>
            <Input placeholder="纳管已有目录的绝对路径（可选，如 /Users/you/dev/xxx）" />
          </Form.Item>
          <Space>
            <Form.Item name="isPublic" valuePropName="checked" noStyle>
              <Checkbox>公共项目（所有用户可见）</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={creating}>创建项目</Button>
          </Space>
        </Form>
      </Card>

      {projects.length === 0 ? (
        <Empty description="还没有项目，创建一个吧" />
      ) : (
        <Row gutter={[12, 12]}>
          {projects.map((p) => (
            <Col xs={24} sm={12} md={8} key={p.id}>
              <Card
                hoverable
                onClick={() => navigate(`/projects/${p.id}`)}
                title={
                  <Space>
                    <FolderOutlined />
                    {p.name}
                    <Tag color={p.visibility === 'public' ? 'green' : 'default'}>
                      {p.visibility === 'public' ? '公共' : '私有'}
                    </Tag>
                  </Space>
                }
              >
                <Typography.Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                  {p.path}
                </Typography.Text>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  );
}
