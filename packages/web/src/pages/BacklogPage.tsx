import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Card, Checkbox, Empty, Form, Input, List, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { PlayCircleOutlined, CommentOutlined, CheckOutlined, DeleteOutlined, BranchesOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
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

interface DraftValues {
  projectId?: string;
  title?: string;
  description?: string;
  autoMerge?: boolean;
}

export default function BacklogPage() {
  const [taskList, setTaskList] = useState<TaskInfo[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [search, setSearch] = useState('');
  const [filterProjectId, setFilterProjectId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [username, setUsername] = useState('');
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const navigate = useNavigate();

  // 草稿缓存按账号隔离
  const draftKey = `cf_task_draft_${username}`;

  useEffect(() => {
    api.get<TaskInfo[]>('/api/tasks').then(setTaskList);
    api.get<ProjectInfo[]>('/api/projects').then(setProjects);
    api.get<{ username: string }>('/api/auth/me').then((me) => setUsername(me.username));
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

  const openModal = () => {
    // 恢复上次未提交的草稿（仅当前账号）
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null') as DraftValues | null;
      form.setFieldsValue(draft ?? { autoMerge: true });
    } catch {
      form.setFieldsValue({ autoMerge: true });
    }
    setModalOpen(true);
  };

  const saveDraft = () => {
    if (!username) return;
    const values = form.getFieldsValue() as DraftValues;
    const empty = !values.title?.trim() && !values.description?.trim();
    if (empty) localStorage.removeItem(draftKey);
    else localStorage.setItem(draftKey, JSON.stringify(values));
  };

  const create = async (v: { projectId: string; title: string; description?: string; autoMerge?: boolean }) => {
    try {
      const t = await api.post<TaskInfo>('/api/tasks', {
        projectId: v.projectId,
        title: v.title.trim(),
        description: v.description ?? '',
        autoMerge: v.autoMerge ?? true,
      });
      setTaskList((l) => [t, ...l]);
      // 提交成功 → 清空草稿
      localStorage.removeItem(draftKey);
      form.resetFields();
      setModalOpen(false);
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

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return taskList.filter((t) => {
      if (filterProjectId && t.projectId !== filterProjectId) return false;
      if (kw && !t.title.toLowerCase().includes(kw) && !t.description.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [taskList, search, filterProjectId]);

  return (
    <div className="page-content">
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>计划</Typography.Title>
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索标题 / 描述"
            style={{ width: 200 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            style={{ minWidth: 160 }}
            value={filterProjectId}
            options={[{ value: '', label: '所有项目' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            onChange={setFilterProjectId}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openModal}>添加计划</Button>
        </Space>
      </Space>

      {filtered.length === 0 ? (
        <Empty description={search || filterProjectId ? '没有匹配的计划' : '队列是空的，记下第一个计划吧'} />
      ) : (
        <List
          dataSource={filtered}
          renderItem={(t) => (
            <Card
              size="small"
              style={{
                marginBottom: 10,
                ...(t.status === 'running' ? { borderColor: '#1677ff' } : t.status === 'conflict' ? { borderColor: '#ef4444' } : {}),
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
                  <BranchesOutlined /> {t.branch}{t.mergeCommit ? ` → ${t.mergeCommit}` : ''}
                </Typography.Text>
              )}
              {t.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{t.error}</Typography.Text>}
              <Space style={{ marginTop: 8 }} wrap>
                {(t.status === 'draft' || t.status === 'queued') && (
                  <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => act(t, 'execute')}>
                    执行
                  </Button>
                )}
                {/* 只要有关联会话就允许打开（含 failed/review，方便排查） */}
                {t.sessionId && t.status !== 'draft' && t.status !== 'queued' && (
                  <Button size="small" icon={<CommentOutlined />} onClick={() => navigate(`/chat/${t.sessionId}`)}>
                    查看会话
                  </Button>
                )}
                {t.status === 'review' && (
                  <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => act(t, 'complete')}>
                    验收{t.autoMerge ? '并合并' : '（保留分支）'}
                  </Button>
                )}
                {/* 除执行中外都可删除（review 也可放弃） */}
                {t.status !== 'running' && (
                  <Popconfirm title={`删除计划「${t.title}」？`} onConfirm={() => remove(t)}>
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

      <Modal
        title="添加计划"
        open={modalOpen}
        onCancel={() => { saveDraft(); setModalOpen(false); }}
        onOk={() => form.submit()}
        okText="加入队列"
        destroyOnHidden={false}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={create}
          initialValues={{ autoMerge: true }}
          onValuesChange={saveDraft}
        >
          <Form.Item name="projectId" label="项目" rules={[{ required: true, message: '请选择项目' }]}>
            <Select options={projects.map((p) => ({ value: p.id, label: p.name }))} placeholder="选择项目" />
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="一句话说清要做什么" />
          </Form.Item>
          <Form.Item name="description" label="详细描述（可选）">
            <Input.TextArea rows={4} placeholder="越具体 Claude 做得越准" />
          </Form.Item>
          <Form.Item name="autoMerge" valuePropName="checked" noStyle>
            <Checkbox>验收后自动合并回主分支并删除任务分支</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
