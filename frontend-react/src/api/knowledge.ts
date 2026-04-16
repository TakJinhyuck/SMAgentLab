import { apiFetch } from './client';
import type {
  KnowledgeItem,
  KnowledgeCreatePayload,
  KnowledgeUpdatePayload,
  GlossaryItem,
  GlossaryCreatePayload,
  GlossaryUpdatePayload,
} from '../types';

// Knowledge CRUD

export async function getKnowledge(namespace: string): Promise<KnowledgeItem[]> {
  try {
    return await apiFetch<KnowledgeItem[]>(`/knowledge?namespace=${encodeURIComponent(namespace)}`);
  } catch (err) {
    console.error('getKnowledge error:', err);
    throw err;
  }
}

export async function createKnowledge(payload: KnowledgeCreatePayload): Promise<KnowledgeItem> {
  try {
    return await apiFetch<KnowledgeItem>('/knowledge', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('createKnowledge error:', err);
    throw err;
  }
}

export async function updateKnowledge(id: number, payload: KnowledgeUpdatePayload): Promise<KnowledgeItem> {
  try {
    return await apiFetch<KnowledgeItem>(`/knowledge/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('updateKnowledge error:', err);
    throw err;
  }
}

export async function deleteKnowledge(id: number): Promise<void> {
  try {
    await apiFetch<void>(`/knowledge/${id}`, { method: 'DELETE' });
  } catch (err) {
    console.error('deleteKnowledge error:', err);
    throw err;
  }
}

// Glossary CRUD

export async function getGlossary(namespace: string): Promise<GlossaryItem[]> {
  try {
    return await apiFetch<GlossaryItem[]>(`/knowledge/glossary?namespace=${encodeURIComponent(namespace)}`);
  } catch (err) {
    console.error('getGlossary error:', err);
    throw err;
  }
}

export async function createGlossaryItem(payload: GlossaryCreatePayload): Promise<GlossaryItem> {
  try {
    return await apiFetch<GlossaryItem>('/knowledge/glossary', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('createGlossaryItem error:', err);
    throw err;
  }
}

export async function updateGlossaryItem(id: number, payload: GlossaryUpdatePayload): Promise<GlossaryItem> {
  try {
    return await apiFetch<GlossaryItem>(`/knowledge/glossary/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('updateGlossaryItem error:', err);
    throw err;
  }
}

export async function deleteGlossaryItem(id: number): Promise<void> {
  try {
    await apiFetch<void>(`/knowledge/glossary/${id}`, { method: 'DELETE' });
  } catch (err) {
    console.error('deleteGlossaryItem error:', err);
    throw err;
  }
}

// ─── Bulk / Ingestion ───────────────────────────────────────────────────────

export async function bulkCreateKnowledge(
  namespace: string,
  items: Array<{ content: string; category?: string; container_name?: string; target_tables?: string[]; query_template?: string }>,
  sourceFile?: string,
  sourceType = 'manual',
): Promise<{ created: number; job_id: number | null }> {
  return apiFetch('/knowledge/bulk', {
    method: 'POST',
    body: JSON.stringify({ namespace, items, source_file: sourceFile, source_type: sourceType }),
  });
}

export async function importCsv(
  file: File,
  namespace: string,
  columnMapping: Record<string, string>,
  category?: string,
): Promise<{ created: number; job_id: number | null }> {
  const form = new FormData();
  form.append('file', file);
  form.append('namespace', namespace);
  form.append('column_mapping', JSON.stringify(columnMapping));
  if (category) form.append('category', category);
  return apiFetch('/knowledge/import/csv', { method: 'POST', body: form });
}

export async function importTextSplit(
  namespace: string,
  rawText: string,
  strategy = 'auto',
  category?: string,
): Promise<{ created: number; job_id: number | null; chunks: number }> {
  return apiFetch('/knowledge/import/text-split', {
    method: 'POST',
    body: JSON.stringify({ namespace, raw_text: rawText, strategy, category }),
  });
}

export async function previewTextSplit(
  rawText: string,
  strategy = 'auto',
): Promise<{ chunks: string[]; count: number }> {
  return apiFetch('/knowledge/import/text-split/preview', {
    method: 'POST',
    body: JSON.stringify({ raw_text: rawText, strategy }),
  });
}

export interface IngestionJob {
  id: number;
  namespace_id: number;
  source_file: string | null;
  source_type: string | null;
  status: string;
  total_chunks: number;
  created_chunks: number;
  auto_glossary: number;
  auto_fewshot: number;
  chunk_strategy: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function getIngestionJobs(namespace: string): Promise<IngestionJob[]> {
  return apiFetch<IngestionJob[]>(`/knowledge/ingestion-jobs?namespace=${encodeURIComponent(namespace)}`);
}

// ─── File Upload (Tier 2) ───────────────────────────────────────────────────

export interface FileUploadResult {
  created: number;
  job_id: number | null;
  chunks: number;
  auto_glossary: number;
  auto_fewshot: number;
  analyzer: Record<string, unknown> | null;
  source_name: string;
  page_count: number | null;
}

export async function importFile(
  file: File,
  namespace: string,
  opts?: { chunkStrategy?: string; category?: string; autoAnalyze?: boolean; autoTag?: boolean; autoGlossary?: boolean; autoFewshot?: boolean },
): Promise<FileUploadResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('namespace', namespace);
  form.append('chunk_strategy', opts?.chunkStrategy ?? 'auto');
  if (opts?.category) form.append('category', opts.category);
  if (opts?.autoAnalyze) form.append('auto_analyze', 'true');
  if (opts?.autoTag) form.append('auto_tag', 'true');
  if (opts?.autoGlossary) form.append('auto_glossary', 'true');
  if (opts?.autoFewshot) form.append('auto_fewshot', 'true');
  return apiFetch('/knowledge/import/file', { method: 'POST', body: form });
}

export interface FilePreviewResult {
  source_name: string;
  source_type: string;
  page_count: number | null;
  total_chars: number;
  sections: number;
  tables: number;
  chunks: Array<{ idx: number; text: string; title: string | null }>;
  chunk_count: number;
}

export async function previewFileUpload(
  file: File,
  chunkStrategy = 'auto',
): Promise<FilePreviewResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('chunk_strategy', chunkStrategy);
  return apiFetch('/knowledge/import/file/preview', { method: 'POST', body: form });
}

// Glossary AI Suggestions

export async function suggestGlossaryTerms(namespace: string, limit: number = 50): Promise<{ suggestions: Array<{ term: string; description: string }>; message: string }> {
  return apiFetch(`/admin/glossary/suggest?namespace=${encodeURIComponent(namespace)}&limit=${limit}`, { method: 'POST' });
}

export async function applyGlossarySuggestion(namespace: string, term: string, description: string): Promise<void> {
  return apiFetch('/admin/glossary/suggest/apply', {
    method: 'POST',
    body: JSON.stringify({ namespace, term, description }),
  });
}
