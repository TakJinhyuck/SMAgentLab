import { useState, useEffect, useCallback } from 'react';
import { Globe, Plus, Trash2, Pencil, Sparkles, ToggleLeft, ToggleRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { listHttpTools, createHttpTool, updateHttpTool, deleteHttpTool, toggleHttpTool, autocompleteHttpTool } from '../../api/httpTools';
import type { HttpTool, HttpToolParam, HttpToolCreatePayload } from '../../types';

const PLACEHOLDER_TEXT = `엘라스틱서치에서 서버별 로그를 조회하는 API.
URL: https://log.internal/api/logs
Method: GET
Headers: Authorization: Bearer {token}
Parameters:
 - server (필수): 서버명 (예: web-01)
 - date (필수): 조회일자 (예: 2026-03-13)
 - level (선택): 로그레벨 (예: error, warn)
Response 예시:
 { "logs": [{"time":"..","msg":".."}] }

※ URL, 필수 파라미터, 응답 형태를 정확히 입력해주셔야 정상적으로 등록됩니다`;

interface FormState {
  name: string;
  description: string;
  method: string;
  url: string;
  headers: string;
  param_schema: HttpToolParam[];
  response_example: string;
  timeout_sec: number;
  max_response_kb: number;
}

const EMPTY_FORM: FormState = {
  name: '', description: '', method: 'GET', url: '',
  headers: '{}', param_schema: [], response_example: '',
  timeout_sec: 10, max_response_kb: 50,
};

const EMPTY_PARAM: HttpToolParam = { name: '', type: 'string', required: true, description: '', example: '' };

export function HttpToolManager() {
  const namespace = useAppStore((s) => s.namespace);
  const [tools, setTools] = useState<HttpTool[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [rawText, setRawText] = useState('');
  const [autoCompleting, setAutoCompleting] = useState(false);
  const [error, setError] = useState('');

  const fetchTools = useCallback(async () => {
    if (!namespace) return;
    setLoading(true);
    try {
      setTools(await listHttpTools(namespace));
    } finally {
      setLoading(false);
    }
  }, [namespace]);

  useEffect(() => { fetchTools(); }, [fetchTools]);

  const handleAutoComplete = async () => {
    if (!namespace || rawText.trim().length < 10) return;
    setAutoCompleting(true);
    setError('');
    try {
      const result = await autocompleteHttpTool(namespace, rawText);
      if (result.status === 'ok' && result.tool) {
        const t = result.tool as Record<string, unknown>;
        setForm({
          name: (t.name as string) || '',
          description: (t.description as string) || '',
          method: (t.method as string) || 'GET',
          url: (t.url as string) || '',
          headers: JSON.stringify(t.headers || {}, null, 2),
          param_schema: (t.param_schema as HttpToolParam[]) || [],
          response_example: t.response_example ? JSON.stringify(t.response_example, null, 2) : '',
          timeout_sec: 10,
          max_response_kb: 50,
        });
        setShowForm(true);
      } else {
        setError(result.message || 'LLM 자동완성 실패');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setAutoCompleting(false);
    }
  };

  const handleSubmit = async () => {
    if (!namespace) return;
    setError('');
    try {
      let parsedHeaders: Record<string, string> = {};
      try { parsedHeaders = JSON.parse(form.headers); } catch { /* ignore */ }

      let parsedResponse: Record<string, unknown> | undefined;
      if (form.response_example.trim()) {
        try { parsedResponse = JSON.parse(form.response_example); } catch { /* ignore */ }
      }

      if (editingId) {
        await updateHttpTool(editingId, {
          name: form.name, description: form.description, method: form.method,
          url: form.url, headers: parsedHeaders, param_schema: form.param_schema,
          response_example: parsedResponse ?? null, timeout_sec: form.timeout_sec,
          max_response_kb: form.max_response_kb,
        });
      } else {
        const payload: HttpToolCreatePayload = {
          namespace, name: form.name, description: form.description,
          method: form.method, url: form.url, headers: parsedHeaders,
          param_schema: form.param_schema, response_example: parsedResponse ?? null,
          timeout_sec: form.timeout_sec, max_response_kb: form.max_response_kb,
        };
        await createHttpTool(payload);
      }
      setForm(EMPTY_FORM);
      setShowForm(false);
      setEditingId(null);
      setRawText('');
      fetchTools();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleEdit = (tool: HttpTool) => {
    setEditingId(tool.id);
    setForm({
      name: tool.name,
      description: tool.description,
      method: tool.method,
      url: tool.url,
      headers: JSON.stringify(tool.headers, null, 2),
      param_schema: tool.param_schema,
      response_example: tool.response_example ? JSON.stringify(tool.response_example, null, 2) : '',
      timeout_sec: tool.timeout_sec,
      max_response_kb: tool.max_response_kb,
    });
    setShowForm(true);
  };

  const handleDelete = async (id: number) => {
    if (!confirm('이 도구를 삭제하시겠습니까?')) return;
    await deleteHttpTool(id);
    fetchTools();
  };

  const handleToggle = async (tool: HttpTool) => {
    await toggleHttpTool(tool.id, !tool.is_active);
    fetchTools();
  };

  const addParam = () => setForm((f) => ({ ...f, param_schema: [...f.param_schema, { ...EMPTY_PARAM }] }));
  const removeParam = (idx: number) => setForm((f) => ({
    ...f, param_schema: f.param_schema.filter((_, i) => i !== idx),
  }));
  const updateParam = (idx: number, key: keyof HttpToolParam, value: unknown) => {
    setForm((f) => ({
      ...f,
      param_schema: f.param_schema.map((p, i) => i === idx ? { ...p, [key]: value } : p),
    }));
  };

  if (!namespace) return <p className="text-slate-400 text-center py-12">네임스페이스를 먼저 선택해주세요.</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Globe className="w-5 h-5 text-emerald-400" />
          HTTP 도구 관리
        </h2>
        <button
          onClick={() => { setShowForm(true); setEditingId(null); setForm(EMPTY_FORM); setRawText(''); }}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> 새 도구
        </button>
      </div>

      {/* LLM 자동완성 입력 */}
      {showForm && !editingId && (
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-3">
          <label className="text-sm font-medium text-slate-300">자연어로 API 정보 입력</label>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={PLACEHOLDER_TEXT}
            rows={8}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
          />
          <button
            onClick={handleAutoComplete}
            disabled={autoCompleting || rawText.trim().length < 10}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            {autoCompleting ? 'LLM 분석 중...' : 'LLM 자동완성'}
          </button>
        </div>
      )}

      {/* 구조화된 폼 */}
      {showForm && (form.name || editingId) && (
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
          <h3 className="text-sm font-medium text-slate-300">
            {editingId ? '도구 수정' : '자동완성 결과 확인'}
          </h3>
          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400">이름</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-slate-400">Method</label>
              <select value={form.method} onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none">
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-slate-400">URL</label>
            <input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none" />
          </div>

          <div>
            <label className="text-xs text-slate-400">설명</label>
            <input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none" />
          </div>

          <div>
            <label className="text-xs text-slate-400">Headers (JSON)</label>
            <textarea value={form.headers} onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
              rows={2}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none" />
          </div>

          {/* 파라미터 스키마 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-slate-400">파라미터</label>
              <button onClick={addParam} className="text-xs text-emerald-400 hover:text-emerald-300">+ 추가</button>
            </div>
            {form.param_schema.map((p, idx) => (
              <div key={idx} className="flex gap-2 mb-2 items-center">
                <input value={p.name} onChange={(e) => updateParam(idx, 'name', e.target.value)}
                  placeholder="이름" className="w-24 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none" />
                <select value={p.type} onChange={(e) => updateParam(idx, 'type', e.target.value)}
                  className="w-20 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none">
                  <option>string</option><option>number</option><option>boolean</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  <input type="checkbox" checked={p.required} onChange={(e) => updateParam(idx, 'required', e.target.checked)} />
                  필수
                </label>
                <input value={p.description} onChange={(e) => updateParam(idx, 'description', e.target.value)}
                  placeholder="설명" className="flex-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none" />
                <input value={p.example ?? ''} onChange={(e) => updateParam(idx, 'example', e.target.value)}
                  placeholder="예시" className="w-24 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none" />
                <button onClick={() => removeParam(idx)} className="text-red-400 hover:text-red-300">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div>
            <label className="text-xs text-slate-400">Response 예시 (JSON)</label>
            <textarea value={form.response_example} onChange={(e) => setForm((f) => ({ ...f, response_example: e.target.value }))}
              rows={3}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-400">타임아웃 (초)</label>
              <input type="number" value={form.timeout_sec} onChange={(e) => setForm((f) => ({ ...f, timeout_sec: +e.target.value }))}
                min={1} max={60}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-slate-400">최대 응답 (KB)</label>
              <input type="number" value={form.max_response_kb} onChange={(e) => setForm((f) => ({ ...f, max_response_kb: +e.target.value }))}
                min={1} max={500}
                className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none" />
            </div>
          </div>

          <div className="flex gap-2">
            <button onClick={handleSubmit}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors">
              {editingId ? '수정' : '저장'}
            </button>
            <button onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); setError(''); }}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium transition-colors">
              취소
            </button>
          </div>
        </div>
      )}

      {/* 도구 목록 */}
      {loading ? (
        <p className="text-slate-400 text-center py-8">불러오는 중...</p>
      ) : tools.length === 0 ? (
        <p className="text-slate-500 text-center py-8">등록된 HTTP 도구가 없습니다.</p>
      ) : (
        <div className="space-y-3">
          {tools.map((tool) => (
            <div key={tool.id} className="bg-slate-800 border border-slate-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <Globe className="w-4 h-4 text-emerald-400" />
                  <span className="text-white font-medium">{tool.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    tool.is_active ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-700 text-slate-400'
                  }`}>
                    {tool.is_active ? '활성' : '비활성'}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">{tool.method}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleToggle(tool)} className="text-slate-400 hover:text-white" title={tool.is_active ? '비활성화' : '활성화'}>
                    {tool.is_active ? <ToggleRight className="w-5 h-5 text-emerald-400" /> : <ToggleLeft className="w-5 h-5" />}
                  </button>
                  <button onClick={() => handleEdit(tool)} className="text-slate-400 hover:text-indigo-400">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => handleDelete(tool.id)} className="text-slate-400 hover:text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <p className="text-sm text-slate-400 mb-1">{tool.description}</p>
              <p className="text-xs text-slate-500 font-mono truncate">{tool.url}</p>
              <div className="flex gap-2 mt-2">
                {tool.param_schema.map((p) => (
                  <span key={p.name} className={`text-xs px-1.5 py-0.5 rounded ${
                    p.required ? 'bg-amber-900/30 text-amber-400' : 'bg-slate-700 text-slate-400'
                  }`}>
                    {p.name}{p.required ? '*' : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
