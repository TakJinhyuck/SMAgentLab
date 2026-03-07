import { motion } from 'framer-motion';

interface TypingIndicatorProps {
  message: string;
}

export function TypingIndicator({ message }: TypingIndicatorProps) {
  return (
    <div className="flex items-center gap-3 text-slate-400 text-sm px-1">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-2 h-2 bg-indigo-500 rounded-full"
            animate={{ y: [0, -6, 0] }}
            transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
      <span className="text-slate-400">{message}</span>
    </div>
  );
}
