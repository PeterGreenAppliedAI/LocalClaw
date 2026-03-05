import { useState } from 'react';
import { setToken } from '../api/client';

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (key.trim()) {
      setToken(key.trim());
      onLogin();
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-950">
      <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 w-96">
        <h1 className="text-xl font-bold text-white mb-1">LocalClaw Console</h1>
        <p className="text-sm text-zinc-400 mb-6">Enter your API key to continue</p>
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="API Key"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          autoFocus
        />
        <button
          type="submit"
          className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-2 font-medium transition-colors"
        >
          Login
        </button>
        <button
          type="button"
          onClick={onLogin}
          className="w-full mt-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Skip (open access mode)
        </button>
      </form>
    </div>
  );
}
