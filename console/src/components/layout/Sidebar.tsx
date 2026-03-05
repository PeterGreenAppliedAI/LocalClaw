import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, MessageSquare, ScrollText, ListTodo,
  Clock, Brain, Radio, Wrench, Settings,
} from 'lucide-react';

const links = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat', icon: MessageSquare, label: 'Chat' },
  { to: '/sessions', icon: ScrollText, label: 'Sessions' },
  { to: '/tasks', icon: ListTodo, label: 'Tasks' },
  { to: '/cron', icon: Clock, label: 'Cron' },
  { to: '/memory', icon: Brain, label: 'Memory' },
  { to: '/channels', icon: Radio, label: 'Channels' },
  { to: '/tools', icon: Wrench, label: 'Tools' },
  { to: '/config', icon: Settings, label: 'Config' },
];

export default function Sidebar() {
  return (
    <aside className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col">
      <div className="p-4 border-b border-zinc-800">
        <h1 className="text-lg font-bold text-white">LocalClaw</h1>
        <p className="text-xs text-zinc-500">Management Console</p>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {links.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-white'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800/50'
              }`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
