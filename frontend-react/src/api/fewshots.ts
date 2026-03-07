import { apiFetch } from './client';
import type { FewshotItem, FewshotCreatePayload, FewshotUpdatePayload, FewshotSearchResponse } from '../types';

export async function getFewshots(namespace: string): Promise<FewshotItem[]> {
  return await apiFetch<FewshotItem[]>(`/fewshots?namespace=${encodeURIComponent(namespace)}`);
}

export async function createFewshot(payload: FewshotCreatePayload): Promise<FewshotItem> {
  return await apiFetch<FewshotItem>('/fewshots', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateFewshot(id: number, payload: FewshotUpdatePayload): Promise<FewshotItem> {
  return await apiFetch<FewshotItem>(`/fewshots/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function deleteFewshot(id: number): Promise<void> {
  await apiFetch<void>(`/fewshots/${id}`, { method: 'DELETE' });
}

export async function searchFewshots(namespace: string, question: string): Promise<FewshotSearchResponse> {
  return await apiFetch<FewshotSearchResponse>('/fewshots/search', {
    method: 'POST',
    body: JSON.stringify({ namespace, question }),
  });
}
