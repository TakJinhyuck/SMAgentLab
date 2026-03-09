import { Accordion } from '../ui/Accordion';
import { CodeBlock } from '../ui/CodeBlock';
import type { KnowledgeResult } from '../../types';
import { clsx } from 'clsx';

interface SearchResultCardProps {
  result: KnowledgeResult;
  defaultOpen?: boolean;
  index: number;
}

function getScoreInfo(score: number) {
  if (score >= 0.7) return { label: '높음', barColor: 'bg-emerald-500', textColor: 'text-emerald-400' };
  if (score >= 0.4) return { label: '보통', barColor: 'bg-amber-500', textColor: 'text-amber-400' };
  return { label: '낮음', barColor: 'bg-slate-500', textColor: 'text-slate-400' };
}

export function SearchResultCard({ result, defaultOpen = false, index }: SearchResultCardProps) {
  const scoreInfo = getScoreInfo(result.final_score);
  const displayName = result.container_name || `문서 #${result.id}`;
  const pct = Math.min(Math.round(result.final_score * 100), 100);

  const header = (
    <div className="flex items-center gap-3 min-w-0 w-full">
      <span className="text-xs text-slate-500 flex-shrink-0">#{index + 1}</span>
      {result.container_name && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-900/40 text-cyan-400 border border-cyan-800/40 flex-shrink-0">컨테이너</span>
      )}
      <span className="text-sm text-slate-200 truncate font-medium flex-1">{displayName}</span>
      {/* 유사도 프로그레스 바 + 라벨 */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-[10px] text-slate-500">유사도</span>
        <div className="w-16 h-1.5 bg-slate-700 rounded-full overflow-hidden">
          <div className={clsx('h-full rounded-full', scoreInfo.barColor)} style={{ width: `${pct}%` }} />
        </div>
        <span className={clsx('text-xs font-medium whitespace-nowrap', scoreInfo.textColor)}>
          {scoreInfo.label} {pct}%
        </span>
      </div>
      <span className="text-[10px] text-slate-500 flex-shrink-0 hidden sm:inline">click</span>
    </div>
  );

  return (
    <Accordion
      title={header}
      defaultOpen={defaultOpen}
      className="bg-slate-900/60 border border-slate-700/50"
      headerClassName="hover:bg-slate-800/50"
    >
      <div className="px-4 pb-4 space-y-3">
        {/* Content */}
        <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">
          {result.content}
        </p>

        {/* Target tables */}
        {result.target_tables && result.target_tables.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-800/40">테이블</span>
            {result.target_tables.map((table) => (
              <span
                key={table}
                className={clsx(
                  'px-2 py-0.5 rounded text-xs font-mono',
                  'bg-indigo-900/40 text-indigo-300 border border-indigo-700/40',
                )}
              >
                {table}
              </span>
            ))}
          </div>
        )}

        {/* SQL query template */}
        {result.query_template && (
          <div>
            <p className="text-xs text-slate-500 mb-1.5">쿼리 템플릿</p>
            <CodeBlock code={result.query_template} language="sql" />
          </div>
        )}
      </div>
    </Accordion>
  );
}
