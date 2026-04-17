import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, X, FileText, Upload, Database, List, PenLine, CheckCircle, Clock, AlertCircle, Globe, ChevronDown, ChevronUp } from 'lucide-react';
import {
  getKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  bulkCreateKnowledge,
  previewTextSplit,
  previewFileUpload,
  previewUrl,
  getIngestionJobs,
  type IngestionJob,
} from '../../api/knowledge';
import { getCategories } from '../../api/namespaces';
import { useNamespaceAccess } from '../../utils/useNamespaceAccess';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { TagInput } from '../ui/TagInput';
import { PaginationInfo, PaginationNav, useClientPaging } from '../ui/Pagination';
import type { KnowledgeItem } from '../../types';

// ── 공통 타입 ─────────────────────────────────────────────────────────────────

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

type IngestMethod = 'file' | 'csv' | 'text' | 'manual' | 'url' | null;

// ── KnowledgeTable (메인) ─────────────────────────────────────────────────────

export function KnowledgeTable() {
  const qc = useQueryClient();
  const { selectedNs, setSelectedNs, canModifyNs, sortedNamespaces } = useNamespaceAccess();

  const [subTab, setSubTab] = useState<'list' | 'ingest'>('list');

  // 조회 탭 state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<KnowledgeFormData>(defaultForm);
  const [showEdit, setShowEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

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

  const onIngestSuccess = () => {
    qc.invalidateQueries({ queryKey: ['knowledge', selectedNs] });
    qc.invalidateQueries({ queryKey: ['ingestion-jobs', selectedNs] });
    qc.invalidateQueries({ queryKey: ['stats-ns', selectedNs] });
  };

  return (
    <div className="space-y-4">
      {/* 헤더 + 네임스페이스 */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-200">
          지식 베이스
          {selectedNs && <span className="text-sm font-normal text-slate-500 ml-2">({selectedNs})</span>}
        </h2>
        <select
          value={selectedNs}
          onChange={(e) => { setSelectedNs(e.target.value); setCategoryFilter(''); setPage(1); }}
          className="w-44 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          <option value="">파트 선택...</option>
          {sortedNamespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
      </div>

      {/* 서브탭 */}
      <div className="flex gap-1 border-b border-slate-700 pb-0">
        <button
          onClick={() => setSubTab('list')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
            subTab === 'list'
              ? 'border-indigo-500 text-indigo-400 bg-slate-800/50'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <List className="w-4 h-4" />
          지식 조회
          {items.length > 0 && (
            <span className="ml-1 text-[10px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded-full">{items.length}</span>
          )}
        </button>
        <button
          onClick={() => setSubTab('ingest')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 -mb-px ${
            subTab === 'ingest'
              ? 'border-indigo-500 text-indigo-400 bg-slate-800/50'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Upload className="w-4 h-4" />
          지식 등록
          {jobs.length > 0 && (
            <span className="ml-1 text-[10px] bg-indigo-900/60 text-indigo-400 px-1.5 py-0.5 rounded-full">{jobs.length}</span>
          )}
        </button>
      </div>

      {/* ── 서브탭 1: 조회 ── */}
      {subTab === 'list' && (
        <div className="space-y-3">
          {/* 필터 바 */}
          <div className="flex items-end gap-3 flex-wrap">
            {categoryNames.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">업무구분</label>
                <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
                  className="w-36 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500">
                  <option value="">전체</option>
                  {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">소스</label>
              <select value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); setPage(1); }}
                className="w-36 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500">
                <option value="">전체</option>
                <option value="manual">수동 등록</option>
                <option value="csv_import">CSV 임포트</option>
                <option value="paste_split">텍스트 분할</option>
                <option value="file_upload">파일 업로드</option>
                <option value="web">웹 크롤링</option>
                <option value="confluence">Confluence</option>
              </select>
            </div>
          </div>

          {!selectedNs && <div className="text-center py-16 text-slate-500">파트를 선택하세요.</div>}
          {selectedNs && isLoading && <div className="text-center py-16 text-slate-500 animate-pulse">로딩 중...</div>}
          {selectedNs && error && <div className="text-center py-16 text-rose-400">오류가 발생했습니다.</div>}

          {selectedNs && !isLoading && (
            <div className="space-y-2">
              <PaginationInfo totalItems={totalItems} pageSize={pageSize} onPageSizeChange={setPageSize} />
              {pagedItems.map((item) => (
                <div key={item.id}
                  className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-slate-700/50 transition-colors"
                  onClick={() => startEdit(item)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {(item as any).source_file && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 font-mono">
                          {(item as any).source_type === 'csv_import' ? '📊' : (item as any).source_type === 'paste_split' ? '📋' : '📄'}{' '}
                          {(item as any).source_file}{(item as any).source_chunk_idx != null && ` #${(item as any).source_chunk_idx}`}
                        </span>
                      )}
                      {item.category && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-900/40 text-violet-300 border border-violet-700/40 font-medium">{item.category}</span>
                      )}
                      {item.container_name && (
                        <>
                          <span className="text-[10px] text-slate-500 font-medium">컨테이너</span>
                          {item.container_name.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (
                            <Badge key={c} color="cyan">{c}</Badge>
                          ))}
                        </>
                      )}
                      {(item.target_tables ?? []).length > 0 && (
                        <>
                          <span className="text-[10px] text-slate-500 font-medium">테이블</span>
                          {(item.target_tables ?? []).slice(0, 3).map((t) => <Badge key={t} color="amber">{t}</Badge>)}
                          {(item.target_tables ?? []).length > 3 && <Badge color="slate">+{(item.target_tables ?? []).length - 3}</Badge>}
                        </>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${weightClass(item.base_weight)}`}>
                        우선순위: {weightLabel(item.base_weight)} ({item.base_weight})
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{item.content.slice(0, 100)}...</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 text-[10px] text-slate-500">
                    <span>{new Date(item.updated_at !== item.created_at ? item.updated_at : item.created_at).toISOString().slice(0, 10)}</span>
                    {item.created_by_username && <span>{item.created_by_username}</span>}
                    {item.created_by_part && <Badge color={canModifyNs ? 'emerald' : 'slate'}>{item.created_by_part}</Badge>}
                  </div>
                </div>
              ))}
              {filteredItems.length === 0 && <div className="text-center py-16 text-slate-500">지식 항목이 없습니다.</div>}
              <PaginationNav page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </div>
      )}

      {/* ── 서브탭 2: 등록 ── */}
      {subTab === 'ingest' && (
        <IngestTab
          namespace={selectedNs}
          categoryNames={categoryNames}
          canModify={canModifyNs}
          jobs={jobs}
          onSuccess={onIngestSuccess}
          onGoToList={() => setSubTab('list')}
        />
      )}

      {/* Edit Modal */}
      <Modal isOpen={showEdit} onClose={() => { setShowEdit(false); setEditingId(null); }}
        title={canModifyNs ? '지식 수정' : '지식 상세'} maxWidth="max-w-2xl">
        <div className="space-y-3">
          {canModifyNs && (
            <div className="flex justify-end pb-3 border-b border-slate-700">
              <Button variant="danger" size="sm" onClick={() => editingId !== null && setDeleteTarget(editingId)}>
                <Trash2 className="w-3.5 h-3.5" />삭제
              </Button>
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">컨테이너명</label>
            <TagInput tags={editForm.container_names} onChange={(tags) => setEditForm((f) => ({ ...f, container_names: tags }))}
              placeholder="컨테이너명 입력..." readOnly={!canModifyNs} color="cyan" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">대상 테이블</label>
            <TagInput tags={editForm.target_tables} onChange={(tags) => setEditForm((f) => ({ ...f, target_tables: tags }))}
              placeholder="테이블명 입력..." readOnly={!canModifyNs} color="indigo" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">내용</label>
            <textarea rows={10} value={editForm.content} readOnly={!canModifyNs}
              onChange={(e) => setEditForm((f) => ({ ...f, content: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[260px] read-only:border-slate-700 leading-relaxed" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">쿼리 템플릿 (선택)</label>
            <textarea rows={4} value={editForm.query_template} readOnly={!canModifyNs}
              onChange={(e) => setEditForm((f) => ({ ...f, query_template: e.target.value }))}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[100px] read-only:border-slate-700"
              placeholder="SELECT ..." />
          </div>
          {categoryNames.length > 0 && (
            <div>
              <label className="text-xs font-medium text-slate-400">업무구분</label>
              {canModifyNs ? (
                <select value={editForm.category} onChange={(e) => setEditForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500">
                  <option value="">없음 (파트 공통)</option>
                  {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <div className="mt-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-300">
                  {editForm.category || <span className="text-slate-500">없음</span>}
                </div>
              )}
            </div>
          )}
          {canModifyNs && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">
                문서 우선순위: <span className={`font-medium ${editForm.base_weight >= 2 ? 'text-emerald-400' : editForm.base_weight >= 1.5 ? 'text-indigo-400' : 'text-slate-300'}`}>
                  {editForm.base_weight.toFixed(1)} — {weightLabel(editForm.base_weight)}
                </span>
              </label>
              <input type="range" min={0} max={3} step={0.1} value={editForm.base_weight}
                onChange={(e) => setEditForm((f) => ({ ...f, base_weight: parseFloat(e.target.value) }))}
                className="w-full accent-indigo-500" />
            </div>
          )}
          {updateMutation.error && <p className="text-xs text-rose-400">{String(updateMutation.error)}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="ghost" size="sm" onClick={() => { setShowEdit(false); setEditingId(null); }}>
              <X className="w-3.5 h-3.5" />{canModifyNs ? '취소' : '닫기'}
            </Button>
            {canModifyNs && (
              <Button variant="primary" size="sm" loading={updateMutation.isPending}
                onClick={() => editingId !== null && updateMutation.mutate(editingId)}
                disabled={!editForm.content.trim()}>
                저장
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/* Delete Confirm Modal */}
      <Modal isOpen={deleteTarget !== null} onClose={() => setDeleteTarget(null)} title="지식 삭제">
        <div className="space-y-4">
          <p className="text-sm text-slate-300">이 지식 항목을 삭제하시겠습니까? 되돌릴 수 없습니다.</p>
          {deleteMutation.error && <p className="text-xs text-rose-400">{String(deleteMutation.error)}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>취소</Button>
            <Button variant="danger" size="sm" loading={deleteMutation.isPending}
              onClick={() => deleteTarget !== null && deleteMutation.mutate(deleteTarget)}>
              삭제
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}


// ── 청크 검토 모달 ─────────────────────────────────────────────────────────────

interface ReviewChunk {
  idx: number;
  text: string;
  title: string | null;
  selected: boolean;
}

function ChunkReviewModal({ isOpen, onClose, chunks, onConfirm, loading, sourceName }: {
  isOpen: boolean;
  onClose: () => void;
  chunks: ReviewChunk[];
  onConfirm: (selected: ReviewChunk[]) => Promise<void>;
  loading: boolean;
  sourceName: string;
}) {
  const [rows, setRows] = useState<ReviewChunk[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());

  useEffect(() => {
    setRows(chunks.map(c => ({ ...c, selected: true })));
    setExpandedIdx(new Set());
  }, [chunks]);

  const selectedCount = rows.filter(r => r.selected).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;

  const toggleAll = () => setRows(prev => prev.map(r => ({ ...r, selected: !allSelected })));
  const toggleRow = (idx: number) => setRows(prev => prev.map(r => r.idx === idx ? { ...r, selected: !r.selected } : r));
  const toggleExpand = (idx: number) => setExpandedIdx(prev => {
    const s = new Set(prev);
    s.has(idx) ? s.delete(idx) : s.add(idx);
    return s;
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`청크 검토 — ${sourceName}`} maxWidth="max-w-3xl">
      <div className="space-y-3">
        {/* 전체 선택 / 카운터 */}
        <div className="flex items-center justify-between pb-2 border-b border-slate-700/60">
          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
            <input type="checkbox" checked={allSelected} onChange={toggleAll}
              className="w-4 h-4 rounded accent-indigo-500" />
            전체 선택
          </label>
          <span className="text-sm font-medium text-indigo-400">{selectedCount}/{rows.length} 선택됨</span>
        </div>

        {/* 청크 목록 (스크롤) */}
        <div className="max-h-[55vh] overflow-y-auto space-y-1.5 pr-1">
          {rows.map((chunk) => {
            const expanded = expandedIdx.has(chunk.idx);
            const preview = chunk.text.slice(0, 150);
            const hasMore = chunk.text.length > 150;
            return (
              <div key={chunk.idx}
                className={`rounded-lg border px-3 py-2 transition-colors ${
                  chunk.selected
                    ? 'border-indigo-600/60 bg-indigo-950/30'
                    : 'border-slate-700/60 bg-slate-900/30 opacity-50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <input type="checkbox" checked={chunk.selected} onChange={() => toggleRow(chunk.idx)}
                    className="w-4 h-4 rounded accent-indigo-500 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-[11px] font-mono text-indigo-400 font-medium">#{chunk.idx + 1}</span>
                      {chunk.title && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700/30">
                          {chunk.title}
                        </span>
                      )}
                      <span className="text-[10px] text-slate-600">{chunk.text.length}자</span>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words">
                      {expanded ? chunk.text : preview}{!expanded && hasMore ? '...' : ''}
                    </p>
                    {hasMore && (
                      <button onClick={() => toggleExpand(chunk.idx)}
                        className="flex items-center gap-0.5 text-[10px] text-slate-500 hover:text-slate-300 mt-1">
                        {expanded
                          ? <><ChevronUp className="w-3 h-3" />접기</>
                          : <><ChevronDown className="w-3 h-3" />더보기</>
                        }
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {rows.length === 0 && (
            <p className="text-center py-8 text-slate-500 text-sm">파싱된 청크가 없습니다.</p>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-2 border-t border-slate-700">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>취소</Button>
          <Button variant="primary" size="sm" loading={loading} disabled={selectedCount === 0}
            onClick={() => onConfirm(rows.filter(r => r.selected))}>
            <CheckCircle className="w-3.5 h-3.5" />선택 항목 등록 ({selectedCount}건)
          </Button>
        </div>
      </div>
    </Modal>
  );
}


// ── 서브탭 2: 지식 등록 ───────────────────────────────────────────────────────

function IngestTab({ namespace, categoryNames, canModify, jobs, onSuccess, onGoToList }: {
  namespace: string;
  categoryNames: string[];
  canModify: boolean;
  jobs: IngestionJob[];
  onSuccess: () => void;
  onGoToList: () => void;
}) {
  const [activeMethod, setActiveMethod] = useState<IngestMethod>(null);

  if (!namespace) {
    return <div className="text-center py-16 text-slate-500">파트를 선택하세요.</div>;
  }
  if (!canModify) {
    return <div className="text-center py-16 text-slate-500">이 파트의 지식 등록 권한이 없습니다.</div>;
  }

  const methods: { id: IngestMethod; icon: React.ReactNode; title: string; desc: string; badge?: string }[] = [
    { id: 'file', icon: <Upload className="w-6 h-6" />, title: '파일 업로드', desc: 'PDF · Markdown · TXT 파일을 업로드하면 자동으로 파싱·청킹합니다.', badge: 'AI 분석 지원' },
    { id: 'csv', icon: <Database className="w-6 h-6" />, title: 'CSV 임포트', desc: 'CSV 파일의 컬럼을 매핑하여 여러 건을 한 번에 등록합니다.' },
    { id: 'text', icon: <FileText className="w-6 h-6" />, title: '대량 텍스트', desc: '텍스트를 붙여넣으면 헤더·단락 기준으로 자동 분할해 등록합니다.' },
    { id: 'manual', icon: <PenLine className="w-6 h-6" />, title: '직접 입력', desc: '단건 지식을 직접 작성하여 등록합니다.' },
    { id: 'url', icon: <Globe className="w-6 h-6" />, title: 'URL / Confluence', desc: '웹 페이지 또는 Confluence 페이지 URL을 입력하면 내용을 자동 수집합니다.', badge: 'Confluence 지원' },
  ];

  return (
    <div className="space-y-5">
      {/* 방법 선택 카드 */}
      <div className="grid grid-cols-2 gap-3">
        {methods.map((m) => (
          <button key={m.id}
            onClick={() => setActiveMethod(activeMethod === m.id ? null : m.id)}
            className={`text-left p-4 rounded-xl border transition-all ${
              activeMethod === m.id
                ? 'border-indigo-500 bg-indigo-950/40 text-indigo-300'
                : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500 hover:bg-slate-800'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 ${activeMethod === m.id ? 'text-indigo-400' : 'text-slate-400'}`}>{m.icon}</div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{m.title}</span>
                  {m.badge && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-900/40 text-violet-300 border border-violet-700/40">{m.badge}</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{m.desc}</p>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* 선택된 방법의 인라인 폼 */}
      {activeMethod === 'file' && (
        <FileUploadForm namespace={namespace} categoryNames={categoryNames}
          onSuccess={() => { onSuccess(); onGoToList(); }} onCancel={() => setActiveMethod(null)} />
      )}
      {activeMethod === 'csv' && (
        <CsvImportForm namespace={namespace} categoryNames={categoryNames}
          onSuccess={() => { onSuccess(); onGoToList(); }} onCancel={() => setActiveMethod(null)} />
      )}
      {activeMethod === 'text' && (
        <TextSplitForm namespace={namespace} categoryNames={categoryNames}
          onSuccess={() => { onSuccess(); onGoToList(); }} onCancel={() => setActiveMethod(null)} />
      )}
      {activeMethod === 'manual' && (
        <ManualForm namespace={namespace} categoryNames={categoryNames}
          onSuccess={() => { onSuccess(); onGoToList(); }} onCancel={() => setActiveMethod(null)} />
      )}
      {activeMethod === 'url' && (
        <UrlForm namespace={namespace} categoryNames={categoryNames}
          onSuccess={() => { onSuccess(); onGoToList(); }} onCancel={() => setActiveMethod(null)} />
      )}

      {/* 인제스천 작업 이력 */}
      {jobs.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-slate-400 mb-2">등록 이력</h3>
          <div className="rounded-xl border border-slate-700 overflow-hidden divide-y divide-slate-700/60">
            {jobs.slice(0, 10).map((j: IngestionJob) => (
              <div key={j.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${
                  j.status === 'completed' ? 'bg-emerald-900/30 text-emerald-400' :
                  j.status === 'failed' ? 'bg-rose-900/30 text-rose-400' :
                  'bg-amber-900/30 text-amber-400'
                }`}>
                  {j.status === 'completed' ? <CheckCircle className="w-3 h-3" /> : j.status === 'failed' ? <AlertCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                  {j.status}
                </span>
                <span className="text-slate-400 flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-slate-700/60 rounded">
                  {j.source_type === 'csv_import' ? 'CSV' : j.source_type === 'file_upload' ? '파일' : j.source_type === 'paste_split' ? '텍스트' : j.source_type === 'web' ? '웹' : j.source_type === 'confluence' ? 'Confluence' : '수동'}
                </span>
                <span className="text-slate-300 truncate flex-1">{j.source_file || '-'}</span>
                <span className="text-slate-500 flex-shrink-0">{j.created_chunks}/{j.total_chunks}건</span>
                {j.auto_glossary > 0 && <span className="text-violet-400 flex-shrink-0">용어 +{j.auto_glossary}</span>}
                {j.auto_fewshot > 0 && <span className="text-emerald-400 flex-shrink-0">Q&A +{j.auto_fewshot}</span>}
                <span className="text-slate-600 flex-shrink-0">{new Date(j.created_at).toLocaleDateString('ko-KR')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ── 파일 업로드 인라인 폼 ────────────────────────────────────────────────────

function FileUploadForm({ namespace, categoryNames, onSuccess, onCancel }: {
  namespace: string; categoryNames: string[];
  onSuccess: () => void; onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('');
  const [detectedStrategy, setDetectedStrategy] = useState<string | null>(null);
  const [reviewChunks, setReviewChunks] = useState<ReviewChunk[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleOpenReview = async () => {
    if (!file) return;
    setPreviewing(true); setError('');
    try {
      const result = await previewFileUpload(file);
      setDetectedStrategy((result as any).detected_strategy ?? null);
      setReviewChunks(result.chunks.map(c => ({ ...c, selected: true })));
      setShowReview(true);
    } catch (e: any) { setError(e.message || '파일 분석 실패'); }
    finally { setPreviewing(false); }
  };

  const handleConfirm = async (selected: ReviewChunk[]) => {
    setLoading(true); setError('');
    try {
      const items = selected.map(c => ({ content: c.text, category: category || undefined }));
      const result = await bulkCreateKnowledge(namespace, items, file!.name, 'file_upload');
      setDone(`${result.created}건 등록 완료`);
      setShowReview(false);
      onSuccess();
    } catch (e: any) { setError(e.message || '오류 발생'); }
    finally { setLoading(false); }
  };

  return (
    <div className="bg-slate-800/60 rounded-xl border border-indigo-800/40 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><Upload className="w-4 h-4 text-indigo-400" />파일 업로드</h3>

      <div className="border-2 border-dashed border-slate-600 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-500 transition-colors"
        onClick={() => fileRef.current?.click()}>
        <input ref={fileRef} type="file" accept=".pdf,.md,.txt,.markdown,.log,.text" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setReviewChunks([]); setDetectedStrategy(null); setDone(''); } }} />
        {file ? (
          <div>
            <p className="text-sm text-slate-300 font-medium">{file.name}</p>
            <p className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB · 클릭하여 변경</p>
          </div>
        ) : (
          <div>
            <Upload className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm text-slate-400">PDF · Markdown · TXT 파일을 선택하세요</p>
            <p className="text-[10px] text-slate-600 mt-1">.pdf .md .txt .markdown</p>
          </div>
        )}
      </div>

      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>청킹 전략:</span>
          <span className="px-2 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-700/30">
            {detectedStrategy ? `AI 자동 감지 — ${detectedStrategy}` : 'AI가 파일 분석 후 자동 결정'}
          </span>
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
      </div>

      {done && <p className="text-sm text-emerald-400 font-medium">{done}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button variant="primary" size="sm" onClick={handleOpenReview} disabled={!file || previewing}>
          {previewing ? '분석 중...' : '청크 검토 & 등록'}
        </Button>
      </div>

      <ChunkReviewModal
        isOpen={showReview}
        onClose={() => setShowReview(false)}
        chunks={reviewChunks}
        onConfirm={handleConfirm}
        loading={loading}
        sourceName={file?.name ?? ''}
      />
    </div>
  );
}


// ── CSV 임포트 인라인 폼 ─────────────────────────────────────────────────────

function CsvImportForm({ namespace, categoryNames, onSuccess, onCancel }: {
  namespace: string; categoryNames: string[];
  onSuccess: () => void; onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [allRows, setAllRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [category, setCategory] = useState('');
  const [reviewChunks, setReviewChunks] = useState<ReviewChunk[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (f: File | null) => {
    if (!f) return;
    setFile(f); setError(''); setDone(''); setAllRows([]); setHeaders([]);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length < 2) { setError('데이터가 부족합니다.'); return; }
        const hdrs = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
        const rows = lines.slice(1).map(line => {
          const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
          const obj: Record<string, string> = {};
          hdrs.forEach((h, i) => { obj[h] = vals[i] || ''; });
          return obj;
        });
        setHeaders(hdrs);
        setAllRows(rows);
        setPreviewRows(rows.slice(0, 5));
        const contentCol = hdrs.find(h => /content|내용|설명|description|text/i.test(h));
        if (contentCol) setMapping(prev => ({ ...prev, content: contentCol }));
      } catch { setError('CSV 파싱 실패'); }
    };
    reader.readAsText(f);
  };

  const handleOpenReview = () => {
    if (!mapping.content) { setError('내용 컬럼을 선택해주세요.'); return; }
    setError('');
    const validRows = allRows.filter(row => row[mapping.content]?.trim());
    const chunks: ReviewChunk[] = validRows.map((row, i) => ({
      idx: i,
      text: row[mapping.content],
      title: mapping.category ? row[mapping.category] || null : null,
      selected: true,
    }));
    setReviewChunks(chunks);
    setShowReview(true);
  };

  const handleConfirm = async (selected: ReviewChunk[]) => {
    setLoading(true); setError('');
    try {
      const validRows = allRows.filter(row => row[mapping.content]?.trim());
      const items = selected.map(chunk => {
        const row = validRows[chunk.idx] ?? {};
        return {
          content: row[mapping.content] || chunk.text,
          category: mapping.category ? row[mapping.category] || category || undefined : category || undefined,
          container_name: mapping.container_name ? row[mapping.container_name] || undefined : undefined,
          query_template: mapping.query_template ? row[mapping.query_template] || undefined : undefined,
        };
      });
      const result = await bulkCreateKnowledge(namespace, items, file!.name, 'csv_import');
      setDone(`${result.created}건 등록 완료`);
      setShowReview(false);
      onSuccess();
    } catch (e: any) { setError(e.message || '오류 발생'); }
    finally { setLoading(false); }
  };

  return (
    <div className="bg-slate-800/60 rounded-xl border border-indigo-800/40 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><Database className="w-4 h-4 text-indigo-400" />CSV 임포트</h3>

      <div className="border-2 border-dashed border-slate-600 rounded-xl p-6 text-center cursor-pointer hover:border-indigo-500 transition-colors"
        onClick={() => fileRef.current?.click()}>
        <input ref={fileRef} type="file" accept=".csv,.tsv" className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
        {file
          ? <p className="text-sm text-slate-300">{file.name} ({(file.size / 1024).toFixed(1)} KB) — {allRows.length}행</p>
          : <p className="text-sm text-slate-400">CSV 파일을 선택하세요</p>}
      </div>

      {headers.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {['content', 'category', 'container_name', 'query_template'].map(field => (
              <div key={field}>
                <label className="text-[10px] text-slate-500 mb-1 block">
                  {field === 'content' ? '내용 컬럼 (필수)' : field === 'category' ? '업무구분 컬럼' : field === 'container_name' ? '컨테이너명 컬럼' : '쿼리 컬럼'}
                </label>
                <select value={mapping[field] || ''} onChange={(e) => setMapping(p => ({ ...p, [field]: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
                  <option value="">매핑 안함</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
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
          <div>
            <p className="text-xs text-slate-500 mb-1">미리보기 (처음 5행)</p>
            <div className="overflow-x-auto rounded-lg border border-slate-700 max-h-40">
              <table className="w-full text-xs">
                <thead><tr className="bg-slate-800">
                  {headers.map(h => <th key={h} className="px-2 py-1 text-left text-slate-400 font-medium">{h}</th>)}
                </tr></thead>
                <tbody>{previewRows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-700/60">
                    {headers.map(h => <td key={h} className="px-2 py-1 text-slate-300 truncate max-w-[150px]">{r[h]}</td>)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {done && <p className="text-sm text-emerald-400 font-medium">{done}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button variant="primary" size="sm" onClick={handleOpenReview} disabled={loading || !file || !mapping.content}>
          청크 검토 & 등록 ({allRows.filter(r => r[mapping.content]?.trim()).length}행)
        </Button>
      </div>

      <ChunkReviewModal
        isOpen={showReview}
        onClose={() => setShowReview(false)}
        chunks={reviewChunks}
        onConfirm={handleConfirm}
        loading={loading}
        sourceName={file?.name ?? ''}
      />
    </div>
  );
}


// ── 대량 텍스트 인라인 폼 ────────────────────────────────────────────────────

function TextSplitForm({ namespace, categoryNames, onSuccess, onCancel }: {
  namespace: string; categoryNames: string[];
  onSuccess: () => void; onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [detectedStrategy, setDetectedStrategy] = useState<string | null>(null);
  const [reviewChunks, setReviewChunks] = useState<ReviewChunk[]>([]);
  const [showReview, setShowReview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const handleOpenReview = async () => {
    if (!text.trim()) return;
    setPreviewing(true); setError('');
    try {
      const result = await previewTextSplit(text);
      setDetectedStrategy((result as any).detected_strategy ?? null);
      setReviewChunks(result.chunks.map((c, i) => ({ idx: i, text: c, title: null, selected: true })));
      setShowReview(true);
    } catch (e: any) { setError(e.message || '분할 미리보기 실패'); }
    finally { setPreviewing(false); }
  };

  const handleConfirm = async (selected: ReviewChunk[]) => {
    setLoading(true); setError('');
    try {
      const items = selected.map(c => ({ content: c.text, category: category || undefined }));
      const result = await bulkCreateKnowledge(namespace, items, '텍스트 직접입력', 'paste_split');
      setDone(`${selected.length}개 청크 → ${result.created}건 등록 완료`);
      setShowReview(false);
      onSuccess();
    } catch (e: any) { setError(e.message || '오류 발생'); }
    finally { setLoading(false); }
  };

  return (
    <div className="bg-slate-800/60 rounded-xl border border-indigo-800/40 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><FileText className="w-4 h-4 text-indigo-400" />대량 텍스트 등록</h3>

      <textarea rows={10} value={text} onChange={(e) => { setText(e.target.value); setDetectedStrategy(null); setDone(''); }}
        placeholder={"여기에 긴 텍스트를 붙여넣으세요...\n\nAI가 내용을 분석하여 최적의 분할 방식을 자동으로 결정합니다."}
        className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[200px]" />

      <div className="flex gap-3 items-end flex-wrap">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>분할 전략:</span>
          <span className="px-2 py-0.5 rounded bg-indigo-900/40 text-indigo-300 border border-indigo-700/30">
            {detectedStrategy ? `AI 자동 감지 — ${detectedStrategy}` : 'AI가 텍스트 분석 후 자동 결정'}
          </span>
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
      </div>

      {done && <p className="text-sm text-emerald-400 font-medium">{done}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button variant="primary" size="sm" onClick={handleOpenReview} disabled={!text.trim() || previewing}>
          {previewing ? '분석 중...' : '청크 검토 & 등록'}
        </Button>
      </div>

      <ChunkReviewModal
        isOpen={showReview}
        onClose={() => setShowReview(false)}
        chunks={reviewChunks}
        onConfirm={handleConfirm}
        loading={loading}
        sourceName="텍스트 직접입력"
      />
    </div>
  );
}


// ── 직접 입력 인라인 폼 ──────────────────────────────────────────────────────

function ManualForm({ namespace, categoryNames, onSuccess, onCancel }: {
  namespace: string; categoryNames: string[];
  onSuccess: () => void; onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<KnowledgeFormData>(defaultForm);
  const [done, setDone] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      createKnowledge({
        namespace,
        container_name: form.container_names.join(', '),
        target_tables: form.target_tables,
        content: form.content,
        query_template: form.query_template || null,
        base_weight: form.base_weight,
        category: form.category || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['knowledge', namespace] });
      qc.invalidateQueries({ queryKey: ['stats-ns', namespace] });
      setDone('등록 완료');
      setForm(defaultForm);
      onSuccess();
    },
  });

  return (
    <div className="bg-slate-800/60 rounded-xl border border-indigo-800/40 p-5 space-y-3">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2"><PenLine className="w-4 h-4 text-indigo-400" />직접 입력</h3>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">컨테이너명 <span className="text-slate-600">(Enter 또는 쉼표로 추가)</span></label>
        <TagInput tags={form.container_names} onChange={(tags) => setForm((f) => ({ ...f, container_names: tags }))}
          placeholder="컨테이너명 입력..." color="cyan" />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">대상 테이블 <span className="text-slate-600">(Enter 또는 쉼표로 추가)</span></label>
        <TagInput tags={form.target_tables} onChange={(tags) => setForm((f) => ({ ...f, target_tables: tags }))}
          placeholder="테이블명 입력..." color="indigo" />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">내용 <span className="text-rose-400">*</span></label>
        <textarea rows={8} value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-y min-h-[160px]" />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">쿼리 템플릿 (선택)</label>
        <textarea rows={3} value={form.query_template} onChange={(e) => setForm((f) => ({ ...f, query_template: e.target.value }))}
          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-y"
          placeholder="SELECT ..." />
      </div>
      {categoryNames.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">업무구분</label>
          <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500">
            <option value="">없음 (파트 공통)</option>
            {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          문서 우선순위: <span className={`font-medium ${form.base_weight >= 2 ? 'text-emerald-400' : form.base_weight >= 1.5 ? 'text-indigo-400' : 'text-slate-300'}`}>
            {form.base_weight.toFixed(1)} — {weightLabel(form.base_weight)}
          </span>
        </label>
        <input type="range" min={0} max={3} step={0.1} value={form.base_weight}
          onChange={(e) => setForm((f) => ({ ...f, base_weight: parseFloat(e.target.value) }))}
          className="w-full accent-indigo-500" />
        <p className="text-[11px] text-slate-500 mt-1">1.0=기본 · 1.5+=보통 · 2.0+=높음(핵심 문서)</p>
      </div>

      {done && <p className="text-sm text-emerald-400 font-medium">{done}</p>}
      {createMutation.isError && <p className="text-xs text-rose-400">{String(createMutation.error)}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button variant="primary" size="sm"
          loading={createMutation.isPending}
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || form.container_names.length === 0 || !form.content.trim()}>
          추가
        </Button>
      </div>
    </div>
  );
}


// ── URL / Confluence 인라인 폼 ────────────────────────────────────────────────

function UrlForm({ namespace, categoryNames, onSuccess, onCancel }: {
  namespace: string; categoryNames: string[];
  onSuccess: () => void; onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [category, setCategory] = useState('');
  const [reviewChunks, setReviewChunks] = useState<ReviewChunk[]>([]);
  const [sourceMeta, setSourceMeta] = useState<{ name: string; type: string } | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const isConfluence = url.includes('confluence') || url.includes('confl.');

  const handleOpenReview = async () => {
    if (!url.trim()) return;
    setPreviewing(true); setError('');
    try {
      const result = await previewUrl(namespace, url.trim(), token || undefined);
      setSourceMeta({ name: result.source_name, type: result.source_type });
      setReviewChunks(result.chunks.map(c => ({ ...c, selected: true })));
      setShowReview(true);
    } catch (e: any) { setError(e.message || '수집 실패'); }
    finally { setPreviewing(false); }
  };

  const handleConfirm = async (selected: ReviewChunk[]) => {
    setLoading(true); setError('');
    try {
      const items = selected.map(c => ({ content: c.text, category: category || undefined }));
      const srcName = sourceMeta?.name ?? url;
      const srcType = sourceMeta?.type ?? (isConfluence ? 'confluence' : 'web');
      const result = await bulkCreateKnowledge(namespace, items, srcName, srcType);
      setDone(`"${srcName}" — ${result.created}건 등록 완료`);
      setShowReview(false);
      onSuccess();
    } catch (e: any) { setError(e.message || '오류 발생'); }
    finally { setLoading(false); }
  };

  return (
    <div className="bg-slate-800/60 rounded-xl border border-indigo-800/40 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
        <Globe className="w-4 h-4 text-indigo-400" />URL / Confluence 수집
      </h3>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">URL <span className="text-rose-400">*</span></label>
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setSourceMeta(null); setDone(''); }}
          placeholder="https://confl.sinc.co.kr/display/SPACE/페이지제목"
          className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 placeholder:text-slate-600"
        />
        <p className="text-[11px] text-slate-500 mt-1">
          Confluence: display/SPACE/제목 또는 pages/viewpage.action?pageId=... 형식
        </p>
      </div>

      {isConfluence && (
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Confluence Personal Access Token <span className="text-rose-400">*</span>
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Confluence 계정 → 프로필 → Personal Access Token"
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 placeholder:text-slate-600"
          />
        </div>
      )}

      {categoryNames.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">업무구분</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-2 py-1.5 text-xs text-slate-300">
            <option value="">없음 (파트 공통)</option>
            {categoryNames.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      {done && <p className="text-sm text-emerald-400 font-medium">{done}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}

      <div className="flex gap-2 justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button variant="primary" size="sm" onClick={handleOpenReview}
          disabled={!url.trim() || previewing || (isConfluence && !token)}>
          {previewing ? '수집 중...' : '수집 & 청크 검토'}
        </Button>
      </div>

      <ChunkReviewModal
        isOpen={showReview}
        onClose={() => setShowReview(false)}
        chunks={reviewChunks}
        onConfirm={handleConfirm}
        loading={loading}
        sourceName={sourceMeta?.name ?? url}
      />
    </div>
  );
}
