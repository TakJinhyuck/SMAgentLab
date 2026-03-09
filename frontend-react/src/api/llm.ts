import { apiFetch } from './client';

export interface LLMConfig {
  provider: 'ollama' | 'inhouse';
  is_runtime_override: boolean;
  is_connected: boolean;
  ollama: {
    base_url: string;
    model: string;
    timeout: number;
  };
  inhouse: {
    url: string;
    agent_code: string;
    model: string;
    has_api_key: boolean;
    response_mode: string;
    timeout: number;
  };
}

export interface LLMConfigUpdate {
  provider: 'ollama' | 'inhouse';
  ollama_base_url?: string;
  ollama_model?: string;
  ollama_timeout?: number;
  inhouse_llm_url?: string;
  inhouse_llm_agent_code?: string;
  inhouse_llm_model?: string;
  inhouse_llm_response_mode?: string;
  inhouse_llm_timeout?: number;
}

export interface LLMTestResult {
  is_connected: boolean;
  provider: string;
  error?: string;
}

export async function getLLMConfig(): Promise<LLMConfig> {
  return await apiFetch<LLMConfig>('/llm/config');
}

export async function updateLLMConfig(payload: LLMConfigUpdate): Promise<LLMConfig> {
  return await apiFetch<LLMConfig>('/llm/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function testLLMConnection(payload: Omit<LLMConfigUpdate, 'ollama_timeout' | 'inhouse_llm_timeout'>): Promise<LLMTestResult> {
  return await apiFetch<LLMTestResult>('/llm/test', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── 검색 임계값 설정 ──

export interface SearchThresholds {
  glossary_min_similarity: number;
  fewshot_min_similarity: number;
  knowledge_min_score: number;
  knowledge_high_score: number;
  knowledge_mid_score: number;
}

export async function getSearchThresholds(): Promise<SearchThresholds> {
  return await apiFetch<SearchThresholds>('/llm/thresholds');
}

export async function updateSearchThresholds(payload: Partial<SearchThresholds>): Promise<SearchThresholds> {
  return await apiFetch<SearchThresholds>('/llm/thresholds', {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}
