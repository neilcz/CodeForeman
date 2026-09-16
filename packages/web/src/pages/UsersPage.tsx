import { useEffect, useState } from 'react';
import { api } from '../api';

interface UserItem {
  id: string;
  username: string;
  role: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserItem[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState('');

  const load = () => api.get<UserItem[]>('/api/users').then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      await api.post('/api/users', { username, password, role });
      setUsername('');
      setPassword('');
      setError('');
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page-content">
      <h2>用户管理</h2>
      <div className="create-form">
        <input placeholder="用户名（字母数字-_）" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="初始密码" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select value={role} onChange={(e) => setRole(e.target.value as 'user' | 'admin')}>
          <option value="user">普通用户</option>
          <option value="admin">管理员</option>
        </select>
        <button onClick={create} disabled={!username || !password}>创建用户</button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="user-list">
        {users.map((u) => (
          <div key={u.id} className="user-row">
            <b>{u.username}</b>
            <span className="project-tag">{u.role === 'admin' ? '管理员' : '普通用户'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
