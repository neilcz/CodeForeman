import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, List, Select, Space, Tag, Typography } from 'antd';
import { UserOutlined } from '@ant-design/icons';
import { api } from '../api';

interface UserItem {
  id: string;
  username: string;
  role: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const { message } = App.useApp();
  const [form] = Form.useForm();

  const load = () => api.get<UserItem[]>('/api/users').then(setUsers).catch((e) => message.error(e.message));
  useEffect(() => { load(); }, []);

  const create = async (v: { username: string; password: string; role: string }) => {
    try {
      await api.post('/api/users', v);
      form.resetFields(['username', 'password']);
      message.success('用户已创建');
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="page-content">
      <Typography.Title level={4}>用户管理</Typography.Title>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Form form={form} layout="inline" onFinish={create} initialValues={{ role: 'user' }}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="用户名（字母数字-_）" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input placeholder="初始密码" />
          </Form.Item>
          <Form.Item name="role">
            <Select
              style={{ width: 120 }}
              options={[{ value: 'user', label: '普通用户' }, { value: 'admin', label: '管理员' }]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit">创建用户</Button>
        </Form>
      </Card>

      <List
        dataSource={users}
        renderItem={(u) => (
          <List.Item>
            <Space>
              <UserOutlined />
              <b>{u.username}</b>
              <Tag color={u.role === 'admin' ? 'purple' : 'default'}>{u.role === 'admin' ? '管理员' : '普通用户'}</Tag>
            </Space>
          </List.Item>
        )}
      />
    </div>
  );
}
