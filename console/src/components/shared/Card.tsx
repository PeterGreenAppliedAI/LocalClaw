import type { ReactNode } from 'react';

export default function Card({ title, value, subtitle, children }: {
  title: string;
  value?: string | number;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <p className="text-sm text-zinc-400">{title}</p>
      {value !== undefined && <p className="text-2xl font-bold mt-1">{value}</p>}
      {subtitle && <p className="text-xs text-zinc-500 mt-1">{subtitle}</p>}
      {children}
    </div>
  );
}
