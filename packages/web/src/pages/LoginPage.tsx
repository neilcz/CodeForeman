import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Form, Input, Typography } from 'antd';
import { api, setToken } from '../api';

interface LoginRes {
  token: string;
  user: { id: string; username: string; role: string };
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const submit = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post<LoginRes>('/api/auth/login', values);
      setToken(res.token);
      navigate('/projects');
      location.reload(); // 重建带 token 的 WS 连接
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <Card style={{ width: 360 }}>
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 4 }}>
          CodeForeman
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          服务端代码 Agent 管理平台
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="用户名" autoFocus size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="密码" size="large" />
          </Form.Item>
          {error && <Typography.Text type="danger">{error}</Typography.Text>}
          <Form.Item style={{ marginTop: 12, marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block size="large" loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
