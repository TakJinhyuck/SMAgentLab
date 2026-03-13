import { useState } from 'react';
import { Globe, Check, X, AlertCircle } from 'lucide-react';
import type { SSEToolRequestEvent, HttpToolParam } from '../../types';

interface ToolRequestCardProps {
  event: SSEToolRequestEvent;
  onApprove: (toolId: number, params: Record<string, string>) => void;
  onReject: () => void;
}

export function ToolRequestCard({ event, onApprove, onReject }: ToolRequestCardProps) {
  const [editParams, setEditParams] = useState<Record<string, string>>(event.params || {});
  const [missingFilled, setMissingFilled] = useState<Record<string, string>>({});

  if (event.action === 'no_tools') {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 my-2">
        <div className="flex items-center gap-2 text-amber-400 mb-2">
          <AlertCircle className="w-4 h-4" />
          <span className="text-sm font-medium">{event.message}</span>
        </div>
      </div>
    );
  }

  if (event.action === 'no_tool_needed') {
    return (
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 my-2">
        <div className="flex items-center gap-2 text-slate-300 mb-2">
          <Globe className="w-4 h-4 text-emerald-400" />
          <span className="text-sm">{event.message}</span>
        </div>
        {event.tools && event.tools.length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-slate-500 mb-1">사용 가능한 도구:</p>
            {event.tools.map((t) => (
              <span key={t.id} className="inline-block text-xs bg-slate-700 text-slate-400 px-2 py-0.5 rounded mr-1 mb-1">
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  const isMissing = event.action === 'missing_params';
  const missingParams = event.missing_params || [];

  const handleApprove = () => {
    if (!event.tool_id) return;
    const finalParams = { ...editParams, ...missingFilled };
    // 누락 파라미터가 채워졌는지 확인
    const stillMissing = missingParams.filter((p) => !finalParams[p]?.trim());
    if (stillMissing.length > 0) return;
    onApprove(event.tool_id, finalParams);
  };

  return (
    <div className="bg-slate-800 border border-emerald-800/50 rounded-lg p-4 my-2">
      {/* 헤더 */}
      <div className="flex items-center gap-2 mb-3">
        <Globe className="w-4 h-4 text-emerald-400" />
        <span className="text-sm font-medium text-white">
          {isMissing ? '추가 정보가 필요합니다' : '도구 실행 확인'}
        </span>
      </div>

      {/* 선택된 도구 */}
      <div className="bg-slate-900 rounded-lg p-3 mb-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium text-emerald-400">{event.tool_name}</span>
          <span className="text-xs text-slate-500 font-mono">{event.tool_url}</span>
        </div>

        {/* 파라미터 */}
        <div className="space-y-1.5 mt-2">
          {Object.entries(editParams).map(([key, value]) => {
            const isThisMissing = missingParams.includes(key);
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="text-slate-400 w-24 text-right">{key}:</span>
                {isThisMissing ? (
                  <input
                    value={missingFilled[key] || ''}
                    onChange={(e) => setMissingFilled((f) => ({ ...f, [key]: e.target.value }))}
                    placeholder={_getParamHint(key, event.param_schema)}
                    className="flex-1 bg-slate-800 border border-amber-600/50 rounded px-2 py-1 text-white focus:border-emerald-500 focus:outline-none"
                  />
                ) : (
                  <>
                    <span className="text-white">{value}</span>
                    <span className="text-emerald-400">✓</span>
                  </>
                )}
              </div>
            );
          })}

          {/* 누락 파라미터 중 editParams에 없는 것들 */}
          {missingParams.filter((p) => !(p in editParams)).map((key) => (
            <div key={key} className="flex items-center gap-2 text-xs">
              <span className="text-amber-400 w-24 text-right">{key}:</span>
              <input
                value={missingFilled[key] || ''}
                onChange={(e) => setMissingFilled((f) => ({ ...f, [key]: e.target.value }))}
                placeholder={_getParamHint(key, event.param_schema)}
                className="flex-1 bg-slate-800 border border-amber-600/50 rounded px-2 py-1 text-white focus:border-emerald-500 focus:outline-none"
              />
              <span className="text-amber-400">⚠</span>
            </div>
          ))}
        </div>
      </div>

      {/* 전체 도구 목록 */}
      {event.tools && event.tools.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-slate-500 mb-1">전체 도구 목록:</p>
          <div className="flex flex-wrap gap-1">
            {event.tools.map((t) => (
              <span key={t.id} className={`text-xs px-2 py-0.5 rounded ${
                t.id === event.tool_id
                  ? 'bg-emerald-900/50 text-emerald-400 font-medium'
                  : 'bg-slate-700 text-slate-400'
              }`}>
                {t.id === event.tool_id ? '● ' : '○ '}{t.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 버튼 */}
      <div className="flex gap-2">
        <button
          onClick={handleApprove}
          disabled={isMissing && missingParams.some((p) => {
            const val = missingFilled[p] || editParams[p];
            return !val?.trim();
          })}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Check className="w-4 h-4" />
          승인
        </button>
        <button
          onClick={onReject}
          className="flex items-center gap-1.5 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <X className="w-4 h-4" />
          거절
        </button>
      </div>
    </div>
  );
}

function _getParamHint(name: string, schema?: HttpToolParam[]): string {
  if (!schema) return `${name} 입력`;
  const param = schema.find((p) => p.name === name);
  if (!param) return `${name} 입력`;
  return param.example ? `예: ${param.example}` : param.description || `${name} 입력`;
}
