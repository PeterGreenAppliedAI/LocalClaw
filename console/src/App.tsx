import { useState, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import { getToken } from './api/client';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Chat from './pages/Chat';
import Sessions from './pages/Sessions';
import Tasks from './pages/Tasks';
import Cron from './pages/Cron';
import Memory from './pages/Memory';
import Channels from './pages/Channels';
import Tools from './pages/Tools';
import Config from './pages/Config';
import Research from './pages/Research';

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [checking, setChecking] = useState(!authed);

  // If no token stored, probe the API — if it responds 200 without auth, skip login
  useEffect(() => {
    if (authed) return;
    fetch('/console/api/status')
      .then(res => {
        if (res.ok) setAuthed(true);
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [authed]);

  if (checking) return null;

  if (!authed) {
    return <Login onLogin={() => setAuthed(true)} />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<Chat />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="cron" element={<Cron />} />
        <Route path="memory" element={<Memory />} />
        <Route path="channels" element={<Channels />} />
        <Route path="tools" element={<Tools />} />
        <Route path="config" element={<Config />} />
        <Route path="research" element={<Research />} />
      </Route>
    </Routes>
  );
}
