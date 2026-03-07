import { clsx } from 'clsx';
import type { ReactNode } from 'react';

interface BadgeProps {
  children: ReactNode;
  color?: 'indigo' | 'emerald' | 'rose' | 'slate' | 'yellow';
  className?: string;
}

export function Badge({ children, color = 'slate', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
        {
          'bg-indigo-900/50 text-indigo-300 border border-indigo-700/50': color === 'indigo',
          'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50': color === 'emerald',
          'bg-rose-900/50 text-rose-300 border border-rose-700/50': color === 'rose',
          'bg-slate-700 text-slate-300': color === 'slate',
          'bg-yellow-900/50 text-yellow-300 border border-yellow-700/50': color === 'yellow',
        },
        className,
      )}
    >
      {children}
    </span>
  );
}
