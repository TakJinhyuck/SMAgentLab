import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X, Download, FileText, Upload, ChevronDown } from 'lucide-react';
import {
  getKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  importCsv,
  importTextSplit,
  previewTextSplit,
  importFile,
  previewFileUpload,
  getIngestionJobs,
  type IngestionJob,
  type FilePreviewResult,
} from '../../api/knowledge';
import { getCategories } from '../../api/namespaces';
import { useNamespaceAccess } from '../../utils/useNamespaceAccess';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { TagInput } from '../ui/TagInput';
import { PaginationInfo, PaginationNav, useClientPaging } from '../ui/Pagination';
import type { KnowledgeItem } from '../../types';

// ── KnowledgeTable ────────────────────────────────────────────────────────────

interface KnowledgeFormData {
  container_names: string[];
  target_tables: string[];
  content: string;
  query_template: string;
  base_weight: number;
  category: string;
}

const defaultForm: KnowledgeFormData = {
  container_names: [],
  target_tables: [],
  content: '',
  query_template: '',
  base_weight: 1.0,
  category: '',
};

function weightLabel(w: number) {
  return w >= 2 ? '높음' : w >= 1.5 ? '보통' : '기본';
}
function weightClass(w: number) {
  return w >= 2
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
    : w >= 1.5
    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
    : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-600/40 dark:text-zinc-300';
}

export function KnowledgeTable() {
  const qc = useQueryClient();
  const { selectedNs, setSelectedNs, canModifyNs, sortedNamespaces, user } = useNamespaceAccess();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<KnowledgeFormData>(defaultForm);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [createForm, setCreateForm] = useState<KnowledgeFormData>(defaultForm);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [sourceFilter, setSourceFilter] = useState('');

  // ── Ingestion 관련 state ──
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [showTextSplit, setShowTextSplit] = useState(false);
  const [showFileUpload, setShowFileUpload] = useState(false);
  const [showImportMenu, setShowImportMenu] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);

  const { data: categories = [] } = useQuery({
    queryKey: ['categories', selectedNs],
    queryFn: () => getCategories(selectedNs),
    enabled: !!selectedNs,
    staleTime: 30_000,
  });

  const categoryNames = categories.map((c) => c.name);

  const { data: jobs = [] } = useQuery({
    queryKey: ['ingestion-jobs', selectedNs],
    queryFn: () => getIngestionJobs(selectedNs),
    enabled: !!selectedNs,
    staleTime: 10_000,
  });

  const { data: items = [], isLoading, error } = useQuery({
    queryKey: ['knowledge', selectedNs],
    queryFn: () => getKnowledge(selectedNs),
    enabled: !!selectedNs,
    staleTime: 15_000,
    refetchOnMount: 'always',
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createKnowledge({
        namespace: selectedNs,
        container_name: createForm.container_names.join(', '),
        target_tables: createForm.target_tables,
        content: createForm.content,
        query_template: createForm.query_template || null,
        base_weight: createForm.base_weight,
        category: createForm.category || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] });
      qc.invalidateQueries({ queryKey: ['stats-ns', selectedNs] });
      setShowCreate(false);
      setCreateForm(defaultForm);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (id: number) =>
      updateKnowledge(id, {
        container_name: editForm.container_names.join(', '),
        target_tables: editForm.target_tables,
        content: editForm.content,
        query_template: editForm.query_template || null,
        base_weight: editForm.base_weight,
        category: editForm.category || '',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] });
      setEditingId(null);
      setShowEdit(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteKnowledge(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] });
      qc.invalidateQueries({ queryKey: ['stats-ns', selectedNs] });
      setDeleteTarget(null);
      setShowEdit(false);
    },
  });

  const startEdit = (item: KnowledgeItem) => {
    setEditingId(item.id);
    setEditForm({
      container_names: item.container_name
        ? item.container_name.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
      target_tables: item.target_tables ?? [],
      content: item.content,
      query_template: item.query_template ?? '',
      base_weight: item.base_weight,
      category: item.category ?? '',
    });
    setShowEdit(true);
  };

  const filteredItems = items.filter((item) => {
    if (categoryFilter && item.category !== categoryFilter) return false;
    if (sourceFilter) {
      const st = (item as any).source_type || 'manual';
      if (sourceFilter !== st) return false;
    }
    return true;
  });
  const { totalPages, totalItems, slice } = useClientPaging(filteredItems, pageSize);
  const pagedItems = slice(page);

  useEffect(() => { setPage(1); }, [categoryFilter, pageSize]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-200">
          지식 베이스
          {selectedNs && <span className="text-sm font-normal text-slate-500 ml-2">({selectedNs})</span>}
        </h2>
        <div className="flex gap-2">
          <div className="relative" ref={importMenuRef}>
            <Button variant="secondary" size="sm" onClick={() => setShowImportMenu(!showImportMenu)} disabled={!selectedNs || !canModifyNs}>
              <Download className="w-4 h-4" />
              지식 가져오기
              <ChevronDown className="w-3 h-3 ml-1" />
            </Button>
            {showImportMenu && (
              <div className="absolute right-0 top-full mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl py-1 z-50 w-52">
                <button onClick={() => { setShowFileUpload(true); setShowImportMenu(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 flex items-center gap-2">
                  <Upload className="w-3.5 h-3.5" /> 파일 업로드 (.pdf .md .txt)
                </button>
                <button onClick={() => { setShowCsvImport(true); setShowImportMenu(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 flex items-center gap-2">
                  <Upload className="w-3.5 h-3.5" /> CSV/Excel 임포트
                </button>
                <button onClick={() => { setShowTextSplit(true); setShowImportMenu(false); }}
                  className="w-full text-left px-3 py-2 text-sm text-slate-300 hover:bg-slate-700 flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5" /> 대량 텍스트 등록
                </button>
              </div>
            )}
          </div>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)} disabled={!selectedNs || !canModifyNs}>
            <Plus className="w-4 h-4" />
            지식 추가
          </Button>
        </div>
      </div>

      {/* 파트 selector + Category filter */}
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">파트</label>
          <select
            value={selectedNs}
            onChange={(e) => { setSelectedNs(e.target.value); setCategoryFilter(''); }}
            className="w-48 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="">선택...</option>
            {sortedNamespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
          </select>
        </div>
        {categoryNames.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">업무구분</label>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-40 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="">전체</option>
              {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">소스</label>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="w-36 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="">전체</option>
            <option value="manual">수동 등록</option>
            <option value="csv_import">CSV 임포트</option>
            <option value="paste_split">텍스트 분할</option>
            <option value="file_upload">파일 업로드</option>
          </select>
        </div>
      </div>

      {!selectedNs && (
        <div className="text-center py-10 text-slate-500">파트를 선택하세요.</div>
      )}
      {selectedNs && isLoading && (
        <div className="text-center py-10 text-slate-500 animate-pulse">로딩 중...</div>
      )}
      {selectedNs && error && (
        <div className="text-center py-10 text-rose-400">오류가 발생했습니다.</div>
      )}

      {selectedNs && !isLoading && (
        <div className="space-y-2">
          <PaginationInfo totalItems={totalItems} pageSize={pageSize} onPageSizeChange={setPageSize} />
          {pagedItems.map((item) => (
            <div
              key={item.id}
              className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-slate-700/50 transition-colors"
              onClick={() => startEdit(item)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  {(item as any).source_file && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 font-mono">
                      {(item as any).source_type === 'csv_import' ? '📊' : (item as any).source_type === 'paste_split' ? '📋' : '📄'}{' '}
                      {(item as any).source_file}
                      {(item as any).source_chunk_idx != null && ` #${(item as any).source_chunk_idx}`}
                    </span>
                  )}
                  {item.category && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-300 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/40 font-medium">{item.category}</span>
                  )}
                  {item.container_name && (
                    <span className="flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] text-slate-500 font-medium flex-shrink-0">컨테이너</span>
                      {item.container_name.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (
                        <Badge key={c} color="cyan">{c}</Badge>
                      ))}
                    </span>
                  )}
                  {(item.target_tables ?? []).length > 0 && (
                    <span className="flex items-center gap-1 flex-wrap">
                      <span className="text-[10px] text-slate-500 font-medium flex-shrink-0">테이블</span>
                      {(item.target_tables ?? []).slice(0, 3).map((t) => (
                        <Badge key={t} color="amber">{t}</Badge>
                      ))}
                      {(item.target_tables ?? []).length > 3 && (
                        <Badge color="slate">+{(item.target_tables ?? []).length - 3}</Badge>
                      )}
                    </span>
                  )}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${weightClass(item.base_weight)}`}>
                    우선순위: {weightLabel(item.base_weight)} ({item.base_weight})
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5 truncate">{item.content.slice(0, 100)}...</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 text-[10px] text-slate-500">
                <span>
                  {item.updated_at !== item.created_at
                    ? new Date(item.updated_at).toISOString().slice(0, 10)
                    : new Date(item.created_at).toISOString().slice(0, 10)}
                </span>
                {item.created_by_username && <span>{item.created_by_username}</span>}
                {item.created_by_part && (
                  <Badge color={canModifyNs ? 'emerald' : 'slate'}>{item.created_by_part}</Badge>
                )}
              </div>
            </div>
          ))}
          {filteredItems.length === 0 && (
            <div className="text-center py-10 text-slate-500">지식 항목이 없습니다.</div>
          )}
          <PaginationNav page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}

      {/* Create Modal */}
      <Modal isOpen={showCreate} onClose={() => setShowCreate(false)} title="지식 추가" maxWidth="max-w-xl">
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              컨테이너명 <span className="text-rose-400">*</span>
              <span className="text-slate-600 font-normal ml-1">(Enter 또는 쉼표로 추가)</span>
            </label>
            <TagInput
              tags={createForm.container_names}
              onChange={(tags) => setCreateForm((f) => ({ ...f, container_names: tags }))}
              placeholder="컨테이너명 입력..."
              color="cyan"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              대상 테이블
              <span className="text-slate-600 font-normal ml-1">(Enter 또는 쉼표로 추가)</span>
            </label>
            <TagInput
              tags={createForm.target_tables}
              onChange={(tags) => setCreateForm((f) => ({ ...f, target_tables: tags }))}
              placeholder="테이블명 입력..."
              color="indigo"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              내용 <span className="text-rose-400">*</span>
            </label>
            <textarea
              rows={10}
              value={createForm.content}
              onChange={(e) => setCreateForm((f) => ({ ...f, content: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[260px]"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">쿼리 템플릿 (선택)</label>
            <textarea
              rows={4}
              value={createForm.query_template}
              onChange={(e) => setCreateForm((f) => ({ ...f, query_template: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[100px]"
              placeholder="SELECT ..."
            />
          </div>
          {categoryNames.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">업무구분</label>
              <select
                value={createForm.category}
                onChange={(e) => setCreateForm((f) => ({ ...f, category: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">없음 (파트 공통)</option>
                {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <p className="text-[10px] text-slate-600 mt-0.5">미설정 시 모든 업무구분 검색에 공통으로 포함됩니다</p>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              문서 우선순위: <span className={`font-medium ${
                createForm.base_weight >= 2 ? 'text-emerald-400' :
                createForm.base_weight >= 1.5 ? 'text-indigo-400' :
                'text-slate-300'
              }`}>{createForm.base_weight.toFixed(1)} — {weightLabel(createForm.base_weight)}</span>
            </label>
            <input
              type="range" min={0} max={3} step={0.1} value={createForm.base_weight}
              onChange={(e) => setCreateForm((f) => ({ ...f, base_weight: parseFloat(e.target.value) }))}
              className="w-full accent-indigo-500"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              1.0=기본 · 1.5+=보통(검색 시 우선 노출) · 2.0+=높음(핵심 문서, 항상 상위 노출) · 피드백 시 자동 상승
            </p>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>취소</Button>
            <Button
              variant="primary" size="sm"
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
              disabled={createForm.container_names.length === 0 || !createForm.content.trim()}
            >
              추가
            </Button>
          </div>
          {createMutation.isError && (
            <p className="text-xs text-rose-400">{String(createMutation.error)}</p>
          )}
        </div>
      </Modal>

      {/* Edit / View Modal */}
      <Modal
        isOpen={showEdit}
        onClose={() => { setShowEdit(false); setEditingId(null); }}
        title={canModifyNs ? '지식 수정' : '지식 상세'}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-3">
          {canModifyNs && (
            <div className="flex justify-end pb-3 border-b border-slate-700">
              <Button
                variant="danger" size="sm"
                onClick={() => editingId !== null && setDeleteTarget(editingId)}
              >
                <Trash2 className="w-3.5 h-3.5" />삭제
              </Button>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              컨테이너명
              {canModifyNs && <span className="text-slate-600 font-normal ml-1">(Enter 또는 쉼표로 추가)</span>}
            </label>
            <TagInput
              tags={editForm.container_names}
              onChange={(tags) => setEditForm((f) => ({ ...f, container_names: tags }))}
              placeholder="컨테이너명 입력..."
              readOnly={!canModifyNs}
              color="cyan"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              대상 테이블
              {canModifyNs && <span className="text-slate-600 font-normal ml-1">(Enter 또는 쉼표로 추가)</span>}
            </label>
            <TagInput
              tags={editForm.target_tables}
              onChange={(tags) => setEditForm((f) => ({ ...f, target_tables: tags }))}
              placeholder="테이블명 입력..."
              readOnly={!canModifyNs}
              color="indigo"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">내용</label>
            <textarea
              rows={10}
              value={editForm.content}
              onChange={(e) => setEditForm((f) => ({ ...f, content: e.target.value }))}
              readOnly={!canModifyNs}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[260px] read-only:border-slate-700 read-only:outline-none leading-relaxed"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">쿼리 템플릿 (선택)</label>
            <textarea
              rows={4}
              value={editForm.query_template}
              onChange={(e) => setEditForm((f) => ({ ...f, query_template: e.target.value }))}
              readOnly={!canModifyNs}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[100px] read-only:border-slate-700"
              placeholder="SELECT ..."
            />
          </div>
          {categoryNames.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-400">업무구분</label>
              {canModifyNs ? (
                <select
                  value={editForm.category}
                  onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">없음 (파트 공통)</option>
                  {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <div className="mt-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300">
                  {editForm.category || <span className="text-slate-500">없음 (파트 공통)</span>}
                </div>
              )}
              {canModifyNs && <p className="text-[10px] text-slate-600 mt-0.5">미설정 시 모든 업무구분 검색에 공통으로 포함됩니다</p>}
            </div>
          )}
          {canModifyNs && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                문서 우선순위: <span className={`font-medium ${
                  editForm.base_weight >= 2 ? 'text-emerald-400' :
                  editForm.base_weight >= 1.5 ? 'text-indigo-400' :
                  'text-slate-300'
                }`}>{editForm.base_weight.toFixed(1)} — {weightLabel(editForm.base_weight)}</span>
              </label>
              <input
                type="range" min={0} max={3} step={0.1} value={editForm.base_weight}
                onChange={(e) => setEditForm((f) => ({ ...f, base_weight: parseFloat(e.target.value) }))}
                className="w-full accent-indigo-500"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                1.0=기본 · 1.5+=보통(검색 시 우선 노출) · 2.0+=높음(핵심 문서, 항상 상위 노출) · 피드백 시 자동 상승
              </p>
            </div>
          )}
          {!canModifyNs && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">문서 우선순위</label>
              <div className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${weightClass(editForm.base_weight)}`}>
                  {editForm.base_weight.toFixed(1)} — {weightLabel(editForm.base_weight)}
                </span>
              </div>
            </div>
          )}
          {updateMutation.error && (
            <p className="text-xs text-rose-400">{String(updateMutation.error)}</p>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="ghost" size="sm" onClick={() => { setShowEdit(false); setEditingId(null); }}>
              <X className="w-3.5 h-3.5" />{canModifyNs ? '취소' : '닫기'}
            </Button>
            {canModifyNs && (
              <Button
                variant="primary" size="sm"
                loading={updateMutation.isPending}
                onClick={() => editingId !== null && updateMutation.mutate(editingId)}
                disabled={editForm.container_names.length === 0 || !editForm.content.trim()}
              >
                저장
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal isOpen={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="지식 삭제">
        <div className="space-y-4">
          <p className="text-sm text-slate-300">이 지식 항목을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.</p>
          {deleteMutation.error && (
            <p className="text-xs text-rose-400">{String(deleteMutation.error)}</p>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>취소</Button>
            <Button
              variant="danger" size="sm"
              loading={deleteMutation.isPending}
              onClick={() => deleteTarget !== null && deleteMutation.mutate(deleteTarget)}
            >
              삭제
            </Button>
          </div>
        </div>
      </Modal>

      {/* CSV Import Modal */}
      <CsvImportModal
        isOpen={showCsvImport}
        onClose={() => setShowCsvImport(false)}
        namespace={selectedNs}
        categoryNames={categoryNames}
        user={user}
        onSuccess={() => { qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] }); qc.invalidateQueries({ queryKey: ['ingestion-jobs', selectedNs] }); }}
      />

      {/* File Upload Modal */}
      <FileUploadModal
        isOpen={showFileUpload}
        onClose={() => setShowFileUpload(false)}
        namespace={selectedNs}
        categoryNames={categoryNames}
        user={user}
        onSuccess={() => { qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] }); qc.invalidateQueries({ queryKey: ['ingestion-jobs', selectedNs] }); }}
      />

      {/* Text Split Modal */}
      <TextSplitModal
        isOpen={showTextSplit}
        onClose={() => setShowTextSplit(false)}
        namespace={selectedNs}
        categoryNames={categoryNames}
        user={user}
        onSuccess={() => { qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] }); qc.invalidateQueries({ queryKey: ['ingestion-jobs', selectedNs] }); }}
      />

      {/* Ingestion Job History */}
      {selectedNs && jobs.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-medium text-slate-400 mb-2">가져오기 이력</h3>
          <div className="rounded-xl border border-slate-700 overflow-hidden divide-y divide-slate-700/60">
            {jobs.slice(0, 5).map((j: IngestionJob) => (
              <div key={j.id} className="flex items-center gap-3 px-4 py-2 text-xs">
                <span className={`px-1.5 py-0.5 rounded font-medium ${
                  j.status === 'completed' ? 'bg-emerald-900/30 text-emerald-400' :
                  j.status === 'failed' ? 'bg-rose-900/30 text-rose-400' :
                  'bg-amber-900/30 text-amber-400'
                }`}>{j.status}</span>
                <span className="text-slate-300 truncate flex-1">{j.source_file || j.source_type}</span>
                <span className="text-slate-500">{j.created_chunks}/{j.total_chunks} 건</span>
                <span className="text-slate-500">{new Date(j.created_at).toLocaleDateString('ko-KR')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ── CSV Import Modal ────────────────────────────────────────────────────────

function CsvImportModal({ isOpen, onClose, namespace, categoryNames, user, onSuccess }: {
  isOpen: boolean; onClose: () => void; namespace: string; categoryNames: string[];
  user: any; onSuccess: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ headers: string[]; rows: Record<string, string>[] }>({ headers: [], rows: [] });
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File | null) => {
    if (!f) return;
    setFile(f);
    setError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { setError('데이터가 부족합니다.'); return; }
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const rows = lines.slice(1, 6).map(line => {
          const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
          const obj: Record<string, string> = {};
          headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
          return obj;
        });
        setPreview({ headers, rows });
        // 자동 매핑: content 컬럼 추측
        const contentCol = headers.find(h => /content|내용|설명|description|text/i.test(h));
        if (contentCol) setMapping(prev => ({ ...prev, content: contentCol }));
      } catch { setError('CSV 파싱 실패'); }
    };
    reader.readAsText(f);
  };

  const handleSubmit = async () => {
    if (!file || !mapping.content) return;
    setLoading(true);
    setError('');
    try {
      const result = await importCsv(file, namespace, mapping, category || undefined);
      alert(`${result.created}건 등록 완료`);
      onSuccess();
      onClose();
      setFile(null); setPreview({ headers: [], rows: [] }); setMapping({});
    } catch (e: any) {
      setError(e.message || '오류 발생');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="CSV 임포트" maxWidth="max-w-2xl">
      <div className="space-y-4">
        <div className="border-2 border-dashed border-slate-600 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-500 transition-colors"
          onClick={() => fileRef.current?.click()}>
          <input ref={fileRef} type="file" accept=".csv,.tsv" className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
          {file ? (
            <p className="text-sm text-slate-300">{file.name} ({(file.size / 1024).toFixed(1)} KB)</p>
          ) : (
            <p className="text-sm text-slate-500">CSV 파일을 선택하세요</p>
          )}
        </div>

        {preview.headers.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {['content', 'category', 'container_name', 'query_template'].map(field => (
                <div key={field}>
                  <label className="text-[10px] text-slate-500 mb-1 block">
                    {field === 'content' ? '내용 (필수)' : field === 'category' ? '업무구분' : field === 'container_name' ? '컨테이너명' : '쿼리'}
                  </label>
                  <select value={mapping[field] || ''} onChange={(e) => setMapping(p => ({ ...p, [field]: e.target.value }))}
                    className="w-full bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
                    <option value="">매핑 안함</option>
                    {preview.headers.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>

            {categoryNames.length > 0 && !mapping.category && (
              <div>
                <label className="text-[10px] text-slate-500 mb-1 block">기본 업무구분 (CSV에 없을 때)</label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
                  <option value="">없음</option>
                  {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}

            <div className="text-xs text-slate-500">미리보기 (처음 5행)</div>
            <div className="overflow-x-auto rounded-lg border border-slate-700 max-h-40">
              <table className="w-full text-xs">
                <thead><tr className="bg-slate-800">
                  {preview.headers.map(h => <th key={h} className="px-2 py-1 text-left text-slate-400 font-medium">{h}</th>)}
                </tr></thead>
                <tbody>{preview.rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-700/60">
                    {preview.headers.map(h => <td key={h} className="px-2 py-1 text-slate-300 truncate max-w-[200px]">{r[h]}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>취소</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}
            disabled={loading || !file || !mapping.content}>
            {loading ? '등록 중...' : '임포트'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}


// ── Text Split Modal ────────────────────────────────────────────────────────

function TextSplitModal({ isOpen, onClose, namespace, categoryNames, user, onSuccess }: {
  isOpen: boolean; onClose: () => void; namespace: string; categoryNames: string[];
  user: any; onSuccess: () => void;
}) {
  const [text, setText] = useState('');
  const [strategy, setStrategy] = useState('auto');
  const [category, setCategory] = useState('');
  const [previewChunks, setPreviewChunks] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handlePreview = async () => {
    if (!text.trim()) return;
    try {
      const result = await previewTextSplit(text, strategy);
      setPreviewChunks(result.chunks);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await importTextSplit(namespace, text, strategy, category || undefined);
      alert(`${result.chunks}개 청크, ${result.created}건 등록 완료`);
      onSuccess();
      onClose();
      setText(''); setPreviewChunks([]);
    } catch (e: any) {
      setError(e.message || '오류 발생');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="대량 텍스트 등록" maxWidth="max-w-2xl">
      <div className="space-y-4">
        <textarea
          rows={12}
          value={text}
          onChange={(e) => { setText(e.target.value); setPreviewChunks([]); }}
          placeholder="여기에 긴 텍스트를 붙여넣으세요...&#10;&#10;## 헤더나 빈 줄, --- 구분선으로 자동 분할됩니다."
          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[200px]"
        />

        <div className="flex gap-3 items-end">
          <div>
            <label className="text-[10px] text-slate-500 mb-1 block">분할 기준</label>
            <select value={strategy} onChange={(e) => { setStrategy(e.target.value); setPreviewChunks([]); }}
              className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
              <option value="auto">자동 감지</option>
              <option value="heading">## 헤더 기준</option>
              <option value="blank_line">빈 줄 기준</option>
              <option value="separator">--- 구분선 기준</option>
              <option value="none">분할 안함 (1건)</option>
            </select>
          </div>
          {categoryNames.length > 0 && (
            <div>
              <label className="text-[10px] text-slate-500 mb-1 block">업무구분</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
                <option value="">없음</option>
                {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <Button variant="secondary" size="sm" onClick={handlePreview} disabled={!text.trim()}>
            미리보기
          </Button>
        </div>

        {previewChunks.length > 0 && (
          <div>
            <div className="text-xs text-slate-500 mb-1">{previewChunks.length}개 청크로 분할됨</div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {previewChunks.map((c, i) => (
                <div key={i} className="bg-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300">
                  <span className="text-indigo-400 font-medium">#{i + 1}</span>
                  <span className="ml-2">{c.slice(0, 120)}{c.length > 120 ? '...' : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>취소</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}
            disabled={loading || !text.trim()}>
            {loading ? '등록 중...' : `등록${previewChunks.length > 0 ? ` (${previewChunks.length}건)` : ''}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}


// ── File Upload Modal (Tier 2) ──────────────────────────────────────────────

function FileUploadModal({ isOpen, onClose, namespace, categoryNames, user, onSuccess }: {
  isOpen: boolean; onClose: () => void; namespace: string; categoryNames: string[];
  user: any; onSuccess: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [strategy, setStrategy] = useState('auto');
  const [category, setCategory] = useState('');
  const [autoAnalyze, setAutoAnalyze] = useState(false);
  const [autoTag, setAutoTag] = useState(false);
  const [autoGlossary, setAutoGlossary] = useState(false);
  const [autoFewshot, setAutoFewshot] = useState(false);
  const [preview, setPreview] = useState<FilePreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePreview = async () => {
    if (!file) return;
    setPreviewing(true);
    setError('');
    try {
      const result = await previewFileUpload(file, strategy);
      setPreview(result);
    } catch (e: any) {
      setError(e.message || '미리보기 실패');
    } finally {
      setPreviewing(false);
    }
  };

  const handleSubmit = async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const result = await importFile(file, namespace, {
        chunkStrategy: autoAnalyze ? 'auto' : strategy,
        category: category || undefined,
        autoAnalyze,
        autoTag,
        autoGlossary,
        autoFewshot,
      });
      const parts = [`${result.chunks}개 청크, ${result.created}건 등록 완료`];
      if (result.auto_glossary > 0) parts.push(`용어 ${result.auto_glossary}건 자동 추출`);
      if (result.auto_fewshot > 0) parts.push(`Q&A ${result.auto_fewshot}건 자동 생성`);
      if (result.analyzer?.doc_type) parts.push(`문서 유형: ${result.analyzer.doc_type}`);
      if (result.page_count) parts.push(`(${result.page_count}페이지)`);
      alert(parts.join('\n'));
      onSuccess();
      onClose();
      setFile(null); setPreview(null);
    } catch (e: any) {
      setError(e.message || '오류 발생');
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setFile(null); setPreview(null); setError('');
  };

  return (
    <Modal isOpen={isOpen} onClose={() => { onClose(); reset(); }} title="파일 업로드" maxWidth="max-w-2xl">
      <div className="space-y-4">
        {/* 파일 선택 영역 */}
        <div className="border-2 border-dashed border-slate-600 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-500 transition-colors"
          onClick={() => fileRef.current?.click()}>
          <input ref={fileRef} type="file" accept=".pdf,.md,.txt,.markdown,.log,.text" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setPreview(null); } }} />
          {file ? (
            <div>
              <p className="text-sm text-slate-300">{file.name}</p>
              <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
          ) : (
            <div>
              <Upload className="w-8 h-8 text-slate-500 mx-auto mb-2" />
              <p className="text-sm text-slate-500">PDF, Markdown, 텍스트 파일을 선택하세요</p>
              <p className="text-[10px] text-slate-600 mt-1">.pdf .md .txt</p>
            </div>
          )}
        </div>

        {/* 옵션 */}
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="text-[10px] text-slate-500 mb-1 block">청킹 전략</label>
            <select value={autoAnalyze ? 'auto' : strategy}
              onChange={(e) => { setStrategy(e.target.value); setPreview(null); }}
              disabled={autoAnalyze}
              className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300 disabled:opacity-50">
              <option value="auto">{autoAnalyze ? 'AI가 자동 결정' : '자동 감지'}</option>
              <option value="section">섹션 기반 (헤더)</option>
              <option value="paragraph">단락 기반 (빈 줄)</option>
              <option value="fixed">고정 크기</option>
            </select>
          </div>
          {categoryNames.length > 0 && (
            <div>
              <label className="text-[10px] text-slate-500 mb-1 block">업무구분</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
                <option value="">자동 / 없음</option>
                {categoryNames.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <Button variant="secondary" size="sm" onClick={handlePreview} disabled={!file || previewing}>
            {previewing ? '분석 중...' : '미리보기'}
          </Button>
        </div>

        {/* LLM 자동화 옵션 */}
        <div className="grid grid-cols-2 gap-2 text-xs text-slate-400">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={autoAnalyze} onChange={(e) => setAutoAnalyze(e.target.checked)}
              className="w-3 h-3 rounded accent-violet-500" />
            AI 문서 분석 (전략 자동 결정)
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={autoTag} onChange={(e) => setAutoTag(e.target.checked)}
              className="w-3 h-3 rounded accent-indigo-500" />
            LLM 자동 태깅 (카테고리/시스템명)
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={autoGlossary} onChange={(e) => setAutoGlossary(e.target.checked)}
              className="w-3 h-3 rounded accent-indigo-500" />
            용어집 자동 추출
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={autoFewshot} onChange={(e) => setAutoFewshot(e.target.checked)}
              className="w-3 h-3 rounded accent-emerald-500" />
            Q&A 자동 생성 (Few-shot)
          </label>
        </div>

        {/* 미리보기 결과 */}
        {preview && (
          <div className="bg-slate-800/60 rounded-xl p-3 space-y-2">
            <div className="flex gap-4 text-xs text-slate-400">
              <span>유형: <span className="text-slate-300">{preview.source_type}</span></span>
              {preview.page_count && <span>페이지: <span className="text-slate-300">{preview.page_count}</span></span>}
              <span>섹션: <span className="text-slate-300">{preview.sections}개</span></span>
              <span>표: <span className="text-slate-300">{preview.tables}개</span></span>
              <span>청크: <span className="text-indigo-400 font-medium">{preview.chunk_count}개</span></span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {preview.chunks.slice(0, 10).map((c) => (
                <div key={c.idx} className="bg-slate-900 rounded-lg px-3 py-2 text-xs text-slate-300">
                  <span className="text-indigo-400 font-medium">#{c.idx + 1}</span>
                  {c.title && <span className="text-amber-400 ml-2">[{c.title}]</span>}
                  <span className="ml-2">{c.text}{c.text.length >= 200 ? '...' : ''}</span>
                </div>
              ))}
              {preview.chunk_count > 10 && (
                <p className="text-[10px] text-slate-500 text-center">외 {preview.chunk_count - 10}개 더...</p>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-rose-400">{error}</p>}

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" size="sm" onClick={() => { onClose(); reset(); }}>취소</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}
            disabled={loading || !file}>
            {loading ? '등록 중...' : `등록${preview ? ` (${preview.chunk_count}건)` : ''}`}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
