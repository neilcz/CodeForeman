import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, Dropdown, Avatar, Space, Typography } from 'antd';
import { LogoutOutlined, UserOutlined } from '@ant-design/icons';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import ChatPage from './pages/ChatPage';
import BacklogPage from './pages/BacklogPage';
import FeaturesPage from './pages/FeaturesPage';
import LoginPage from './pages/LoginPage';
import UsersPage from './pages/UsersPage';
import { api, getToken, setToken } from './api';

interface Me {
  id: string;
  username: string;
  role: string;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const loggedIn = !!getToken();

  useEffect(() => {
    if (!loggedIn) {
      setReady(true);
      return;
    }
    api.get<Me>('/api/auth/me').then(setMe).catch(() => {}).finally(() => setReady(true));
  }, [loggedIn]);

  if (!ready) return null;

  if (!loggedIn) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setToken(null);
    window.location.href = '/login';
  };

  const menuItems = [
    { key: '/projects', label: '项目' },
    { key: '/chat', label: '会话' },
    { key: '/backlog', label: '想法' },
    { key: '/features', label: '功能' },
    ...(me?.role === 'admin' ? [{ key: '/users', label: '用户' }] : []),
  ];
  const selectedKey = '/' + (location.pathname.split('/')[1] || 'projects');

  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24, borderBottom: '1px solid #303030' }}>
        <Typography.Text strong style={{ color: '#fff', fontSize: 16, whiteSpace: 'nowrap' }}>
          CodeForeman
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selectedKey]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0, background: 'transparent', borderBottom: 'none' }}
        />
        <Dropdown
          menu={{
            items: [{ key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: logout }],
          }}
        >
          <Space style={{ cursor: 'pointer', color: '#fff' }}>
            <Avatar size="small" icon={<UserOutlined />} />
            <span>{me?.username}</span>
          </Space>
        </Dropdown>
      </Layout.Header>
      <Layout.Content style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="/backlog" element={<BacklogPage />} />
          <Route path="/features" element={<FeaturesPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}
