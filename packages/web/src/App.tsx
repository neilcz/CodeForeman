import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
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
    location.href = '/login';
  };

  return (
    <div className="app">
      <nav className="topnav">
        <span className="logo">CodeForeman</span>
        <NavLink to="/projects">项目</NavLink>
        <NavLink to="/chat">会话</NavLink>
        <NavLink to="/backlog">想法</NavLink>
        <NavLink to="/features">功能</NavLink>
        <span className="spacer" />
        {me?.role === 'admin' && <NavLink to="/users">用户</NavLink>}
        <span className="me">{me?.username}</span>
        <button className="logout-btn" onClick={logout}>退出</button>
      </nav>
      <div className="page">
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
      </div>
    </div>
  );
}
