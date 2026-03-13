import { apiFetch } from './client';
import type { HttpTool, HttpToolCreatePayload, HttpToolUpdatePayload } from '../types';

export async function listHttpTools(namespace: string): Promise<HttpTool[]> {
  return apiFetch<HttpTool[]>(`/http-tools?namespace=${encodeURIComponent(namespace)}`);
}

export async function createHttpTool(payload: HttpToolCreatePayload): Promise<HttpTool> {
  return apiFetch<HttpTool>('/http-tools', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateHttpTool(toolId: number, payload: HttpToolUpdatePayload): Promise<HttpTool> {
  return apiFetch<HttpTool>(`/http-tools/${toolId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function toggleHttpTool(toolId: number, isActive: boolean): Promise<HttpTool> {
  return apiFetch<HttpTool>(`/http-tools/${toolId}/toggle`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: isActive }),
  });
}

export async function deleteHttpTool(toolId: number): Promise<void> {
  await apiFetch(`/http-tools/${toolId}`, { method: 'DELETE' });
}

export async function autocompleteHttpTool(namespace: string, rawText: string): Promise<{
  status: string;
  tool?: Record<string, unknown>;
  message?: string;
  raw?: string;
}> {
  return apiFetch('/http-tools/autocomplete', {
    method: 'POST',
    body: JSON.stringify({ namespace, raw_text: rawText }),
  });
}
