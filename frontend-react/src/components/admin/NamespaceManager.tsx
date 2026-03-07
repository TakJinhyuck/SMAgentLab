import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Database } from 'lucide-react';
import { getNamespacesDetail, createNamespace, deleteNamespace } from '../../api/namespaces';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

export function NamespaceManager() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const { data: namespaces = [], isLoading, error } = useQuery({
    queryKey: ['namespaces-detail'],
    queryFn: getNamespacesDetail,
    staleTime: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; description: string }) => createNamespace(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespaces-detail'] });
      qc.invalidateQueries({ queryKey: ['namespaces'] });
      setShowCreate(false);
      setNewName('');
      setNewDescription('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteNamespace(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['namespaces-detail'] });
      qc.invalidateQueries({ queryKey: ['namespaces'] });
      setDeleteTarget(null);
    },
  });

  const handleCreate = () => {
    if (!newName.trim()) return;
    createMutation.mutate({ name: newName.trim(), description: newDescription.trim() });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-200">네임스페이스 관리</h2>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="w-4 h-4" />
          새 네임스페이스
        </Button>
      </div>

      {isLoading && (
        <div className="text-center py-10 text-slate-500 animate-pulse">로딩 중...</div>
      )}
      {error && (
        <div className="text-center py-10 text-rose-400">오류가 발생했습니다.</div>
      )}

      <div className="grid gap-3">
        {namespaces.map((ns) => (
          <div
            key={ns.name}
            className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex items-center gap-4"
          >
            <div className="w-10 h-10 rounded-xl bg-indigo-900/40 border border-indigo-700/40 flex items-center justify-center flex-shrink-0">
              <Database className="w-5 h-5 text-indigo-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-200">{ns.name}</span>
                <span className="text-xs text-slate-500 bg-slate-700 px-2 py-0.5 rounded-full">
                  지식 {ns.knowledge_count}건
                </span>
                <span className="text-xs text-slate-500 bg-slate-700 px-2 py-0.5 rounded-full">
                  용어 {ns.glossary_count}건
                </span>
              </div>
              {ns.description && (
                <p className="text-sm text-slate-400 mt-0.5 truncate">{ns.description}</p>
              )}
              <p className="text-xs text-slate-600 mt-0.5">
                생성: {new Date(ns.created_at).toLocaleDateString('ko-KR')}
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeleteTarget(ns.name)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        {!isLoading && namespaces.length === 0 && (
          <div className="text-center py-10 text-slate-500">네임스페이스가 없습니다.</div>
        )}
      </div>

      {/* Create Modal */}
      <Modal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        title="새 네임스페이스 생성"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              이름 <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="예: billing, infra, support"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">설명</label>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="네임스페이스 설명"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={() => setShowCreate(false)}>
              취소
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={createMutation.isPending}
              onClick={handleCreate}
              disabled={!newName.trim()}
            >
              생성
            </Button>
          </div>
          {createMutation.isError && (
            <p className="text-xs text-rose-400">{String(createMutation.error)}</p>
          )}
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="네임스페이스 삭제"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-300">
            <span className="font-semibold text-rose-400">{deleteTarget}</span> 네임스페이스를
            삭제하면 모든 지식과 용어도 함께 삭제됩니다. 계속하시겠습니까?
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
              취소
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
            >
              삭제
            </Button>
          </div>
          {deleteMutation.isError && (
            <p className="text-xs text-rose-400">{String(deleteMutation.error)}</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
