import { NavLink, Route, Routes } from 'react-router-dom';
import ProjectsPage from './pages/ProjectsPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import ChatPage from './pages/ChatPage';

export default function App() {
  return (
    <div className="app">
      <nav className="topnav">
        <span className="logo">CodeForeman</span>
        <NavLink to="/projects">项目</NavLink>
        <NavLink to="/chat">会话</NavLink>
      </nav>
      <div className="page">
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
      </div>
    </div>
  );
}
