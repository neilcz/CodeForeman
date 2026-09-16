import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api';

interface LoginRes {
  token: string;
  user: { id: string; username: string; role: string };
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const submit = async () => {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.post<LoginRes>('/api/auth/login', { username, password });
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
      <div className="login-card">
        <h1>CodeForeman</h1>
        <p className="login-sub">服务端代码 Agent 管理平台</p>
        <input
          placeholder="用户名"
          value={username}
          autoFocus
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="error">{error}</div>}
        <button onClick={submit} disabled={loading || !username || !password}>
          {loading ? '登录中…' : '登录'}
        </button>
      </div>
    </div>
  );
}
