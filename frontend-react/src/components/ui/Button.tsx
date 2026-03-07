import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 font-medium transition-colors rounded-xl disabled:opacity-50 disabled:cursor-not-allowed',
        {
          'bg-indigo-600 hover:bg-indigo-500 text-white': variant === 'primary',
          'bg-slate-700 hover:bg-slate-600 text-slate-200': variant === 'secondary',
          'bg-rose-600 hover:bg-rose-500 text-white': variant === 'danger',
          'text-slate-400 hover:text-slate-200 hover:bg-slate-800': variant === 'ghost',
          'px-2 py-1 text-xs': size === 'sm',
          'px-4 py-2 text-sm': size === 'md',
          'px-6 py-3 text-base': size === 'lg',
        },
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}
