import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, XCircle, CheckCircle } from 'lucide-react';
import { listPrompts, updatePrompt } from '../../api/prompts';
import type { Prompt, PromptUpdate } from '../../api/prompts';
import { Button } from '../ui/Button';

export function PromptManager() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<PromptUpdate>({});
  const [saved, setSaved] = useState(false);

  const { data: prompts, isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: listPrompts,
    staleTime: 10_000,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: PromptUpdate }) => updatePrompt(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prompts'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const selectedPrompt = prompts?.find((p) => p.id === selectedId) ?? null;

  const handleSelect = (p: Prompt) => {
    setSelectedId(p.id);
    setEditForm({ func_name: p.func_name, content: p.content, description: p.description });
    saveMutation.reset();
    setSaved(false);
  };

  const handleSave = () => {
    if (!selectedPrompt) return;
    saveMutation.mutate({ id: selectedPrompt.id, payload: editForm });
  };

  if (isLoading) {
    return <div className="text-center py-10 text-slate-500 animate-pulse text-sm">프롬프트 로딩 중...</div>;
  }

  return (
    <div className="flex gap-6">
      {/* ── 좌측 리스트 ── */}
      <div className="w-80 flex-shrink-0 flex flex-col gap-1 overflow-y-auto pr-2 max-h-[600px]">
        {prompts?.map((p) => (
          <button
            key={p.id}
            onClick={() => handleSelect(p)}
            className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors border ${
              selectedId === p.id
                ? 'bg-indigo-500/15 border-indigo-500/50 text-indigo-300'
                : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500 hover:text-slate-200'
            }`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-[10px] font-mono text-slate-500">#{p.id}</span>
              <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                selectedId === p.id ? 'text-indigo-300 bg-indigo-500/20' : 'text-slate-400 bg-slate-700'
              }`}>
                {p.func_key}
              </span>
            </div>
            <p className="text-xs font-medium truncate">{p.func_name}</p>
          </button>
        ))}
      </div>

      {/* ── 우측 편집 패널 ── */}
      <div className="flex-1 min-w-0">
        {!selectedPrompt ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            좌측에서 프롬프트를 선택하세요
          </div>
        ) : (
          <div className="h-full flex flex-col gap-4">
            {/* 헤더 */}
            <div className="flex items-center gap-3 bg-slate-800 border border-slate-700 rounded-xl px-4 py-3">
              <span className="text-xs font-mono text-slate-500 bg-slate-900 px-2 py-0.5 rounded">
                #{selectedPrompt.id}
              </span>
              <span className="text-xs font-mono text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded">
                {selectedPrompt.func_key}
              </span>
              <span className="text-xs text-slate-500 ml-auto">
                최종 수정: {new Date(selectedPrompt.updated_at).toLocaleString('ko-KR')}
              </span>
            </div>

            {/* 상태 메시지 */}
            {saveMutation.isError && (
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs border bg-rose-500/10 border-rose-500/30 text-rose-300">
                <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> 저장 실패: {String(saveMutation.error)}
              </div>
            )}
            {saved && (
              <div className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs border bg-emerald-500/10 border-emerald-500/30 text-emerald-300">
                <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> 저장되었습니다
              </div>
            )}

            {/* 기능명 */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">기능명</label>
              <input
                type="text"
                value={editForm.func_name ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, func_name: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* 설명 */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">설명</label>
              <input
                type="text"
                value={editForm.description ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* 프롬프트 내용 */}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">프롬프트 내용</label>
              <textarea
                value={editForm.content ?? ''}
                onChange={(e) => setEditForm((f) => ({ ...f, content: e.target.value }))}
                rows={16}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono leading-relaxed focus:outline-none focus:border-indigo-500 resize-y overflow-y-auto"
              />
            </div>

            {/* 저장 버튼 */}
            <div className="flex justify-end pt-1 border-t border-slate-700/50">
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                loading={saveMutation.isPending}
              >
                <Save className="w-3.5 h-3.5" /> 저장
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
