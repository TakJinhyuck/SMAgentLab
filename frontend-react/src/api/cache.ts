import { apiFetch } from './client';

export interface CacheStats {
  connected: boolean;
  total_entries: number;
  total_hits: number;
  enabled: boolean;
}

export interface CacheEntry {
  key: string;
  query: string;
  mapped_term: string | null;
  ttl_seconds: number;
  hits: number;
}

export async function getCacheStats(namespace: string): Promise<CacheStats> {
  return apiFetch<CacheStats>(`/admin/cache/stats?namespace=${encodeURIComponent(namespace)}`);
}

export async function getCacheEntries(namespace: string): Promise<CacheEntry[]> {
  return apiFetch<CacheEntry[]>(`/admin/cache/entries?namespace=${encodeURIComponent(namespace)}`);
}

export async function invalidateCache(namespace: string): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>(
    `/admin/cache?namespace=${encodeURIComponent(namespace)}`,
    { method: 'DELETE' },
  );
}

export async function deleteCacheEntry(key: string): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean }>('/admin/cache/entry', {
    method: 'DELETE',
    body: JSON.stringify({ key }),
  });
}

export interface CacheConfig {
  enabled: boolean;
  similarity_threshold: number;
  cache_ttl: number;
}

export async function getCacheConfig(): Promise<CacheConfig> {
  return apiFetch<CacheConfig>('/admin/cache/config');
}

export async function setCacheConfig(patch: Partial<CacheConfig>): Promise<CacheConfig> {
  return apiFetch<CacheConfig>('/admin/cache/config', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}
