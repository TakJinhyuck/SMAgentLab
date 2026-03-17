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
