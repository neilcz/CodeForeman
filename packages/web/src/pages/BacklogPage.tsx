import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Card, Checkbox, Empty, Form, Input, List, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { PlayCircleOutlined, CommentOutlined, CheckOutlined, DeleteOutlined } from '@ant-design/icons';
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

const STATUS_COLOR: Record<TaskStatus, string> = {
  draft: 'default',
  queued: 'default',
  running: 'processing',
  review: 'warning',
  done: 'success',
  failed: 'error',
  conflict: 'error',
};

export default function BacklogPage() {
  const [taskList, setTaskList] = useState<TaskInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const navigate = useNavigate();

  useEffect(() => {
    api.get<TaskInfo[]>('/api/tasks').then(setTaskList);
    api.get<ProjectInfo[]>('/api/projects').then((ps) => {
      setProjects(ps);
      if (ps.length > 0) form.setFieldValue('projectId', ps[0].id);
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

  const create = async (v: { projectId: string; title: string; description?: string; autoMerge?: boolean }) => {
    try {
      const t = await api.post<TaskInfo>('/api/tasks', {
        projectId: v.projectId,
        title: v.title.trim(),
        description: v.description ?? '',
        autoMerge: v.autoMerge ?? true,
      });
      setTaskList((l) => [t, ...l]);
      form.setFieldsValue({ title: '', description: '' });
      message.success('已加入队列');
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const act = async (t: TaskInfo, action: 'execute' | 'complete') => {
    try {
      await api.post(`/api/tasks/${t.id}/${action}`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (t: TaskInfo) => {
    await api.del(`/api/tasks/${t.id}`);
    setTaskList((l) => l.filter((x) => x.id !== t.id));
  };

  return (
    <div className="page-content">
      <Typography.Title level={4}>想法 / 计划</Typography.Title>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical" onFinish={create} initialValues={{ autoMerge: true }}>
          <Form.Item name="projectId" rules={[{ required: true, message: '请选择项目' }]} style={{ marginBottom: 8 }}>
            <Select options={projects.map((p) => ({ value: p.id, label: p.name }))} placeholder="选择项目" />
          </Form.Item>
          <Form.Item name="title" rules={[{ required: true, message: '请输入标题' }]} style={{ marginBottom: 8 }}>
            <Input placeholder="标题（一句话说清要做什么）" />
          </Form.Item>
          <Form.Item name="description" style={{ marginBottom: 8 }}>
            <Input.TextArea rows={3} placeholder="详细描述（可选，越具体 Claude 做得越准）" />
          </Form.Item>
          <Space>
            <Form.Item name="autoMerge" valuePropName="checked" noStyle>
              <Checkbox>验收后自动合并回主分支并删除任务分支</Checkbox>
            </Form.Item>
            <Button type="primary" htmlType="submit">加入队列</Button>
          </Space>
        </Form>
      </Card>

      {taskList.length === 0 ? (
        <Empty description="队列是空的，记下第一个想法吧" />
      ) : (
        <List
          dataSource={taskList}
          renderItem={(t) => (
            <Card
              size="small"
              style={{
                marginBottom: 10,
                ...(t.status === 'running' ? { borderColor: '#6366f1' } : t.status === 'conflict' ? { borderColor: '#ef4444' } : {}),
              }}
            >
              <Space wrap style={{ marginBottom: 4 }}>
                <Tag color={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Tag>
                <Typography.Text strong>{t.title}</Typography.Text>
                <Tag>{t.projectName}</Tag>
              </Space>
              {t.description && (
                <Typography.Paragraph type="secondary" style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 4 }}>
                  {t.description}
                </Typography.Paragraph>
              )}
              {t.branch && (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                  ⎇ {t.branch}{t.mergeCommit ? ` → ${t.mergeCommit}` : ''}
                </Typography.Text>
              )}
              {t.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{t.error}</Typography.Text>}
              <Space style={{ marginTop: 8 }} wrap>
                {(t.status === 'draft' || t.status === 'queued') && (
                  <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => act(t, 'execute')}>
                    执行
                  </Button>
                )}
                {(t.status === 'review' || t.status === 'running') && t.sessionId && (
                  <Button size="small" icon={<CommentOutlined />} onClick={() => navigate(`/chat/${t.sessionId}`)}>
                    查看会话
                  </Button>
                )}
                {t.status === 'review' && (
                  <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => act(t, 'complete')}>
                    验收{t.autoMerge ? '并合并' : '（保留分支）'}
                  </Button>
                )}
                {['draft', 'queued', 'failed', 'conflict'].includes(t.status) && (
                  <Popconfirm title={`删除任务「${t.title}」？`} onConfirm={() => remove(t)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />}>删除</Button>
                  </Popconfirm>
                )}
                {t.status === 'conflict' && t.branch && (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    请到服务器上手动处理分支 {t.branch} 的合并
                  </Typography.Text>
                )}
              </Space>
            </Card>
          )}
        />
      )}
    </div>
  );
}
