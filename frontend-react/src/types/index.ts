// Auth types
export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
  part: string;
  is_active: boolean;
  has_api_key: boolean;
  created_at: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: User;
}

export interface Part {
  id: number;
  name: string;
  created_at: string;
  user_count?: number;
}

// Namespace types
export interface Namespace {
  name: string;
  description: string;
  created_at: string;
}

export interface KnowledgeCategory {
  id: number;
  namespace: string;
  name: string;
  created_at: string;
}

export interface NamespaceDetail extends Namespace {
  owner_part?: string | null;
  knowledge_count: number;
  glossary_count: number;
  created_by_username?: string | null;
}

// Knowledge types
export interface KnowledgeItem {
  id: number;
  namespace: string;
  container_name: string;
  target_tables: string[] | null;
  content: string;
  query_template: string | null;
  base_weight: number;
  category?: string | null;
  created_by_part?: string | null;
  created_by_user_id?: number | null;
  created_by_username?: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeCreatePayload {
  namespace: string;
  container_name: string;
  target_tables: string[];
  content: string;
  query_template?: string | null;
  base_weight?: number;
  category?: string | null;
}

export interface KnowledgeUpdatePayload {
  container_name?: string;
  target_tables?: string[];
  content?: string;
  query_template?: string | null;
  base_weight?: number;
  category?: string | null;
}

// Glossary types
export interface GlossaryItem {
  id: number;
  namespace: string;
  term: string;
  description: string;
  created_by_part?: string | null;
  created_by_user_id?: number | null;
  created_by_username?: string | null;
  created_at: string;
}

export interface GlossaryCreatePayload {
  namespace: string;
  term: string;
  description: string;
}

export interface GlossaryUpdatePayload {
  term?: string;
  description?: string;
}

// Chat / Conversation types
export interface Conversation {
  id: number;
  namespace: string;
  title: string;
  trimmed?: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  mapped_term?: string | null;
  results?: KnowledgeResult[] | null;
  status?: string;
  has_feedback?: boolean;
  created_at: string;
}

export interface KnowledgeResult {
  id: number;
  container_name: string;
  target_tables: string[];
  content: string;
  query_template: string | null;
  final_score: number;
  v_score?: number;
  k_score?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  mapped_term?: string | null;
  results?: KnowledgeResult[];
  isStreaming?: boolean;
  question?: string;
  has_feedback?: boolean;
  messageId?: number;
  toolError?: string | null;
  status?: string;
}

// SSE Event types
export interface SSEStatusEvent {
  type: 'status';
  step: 'embedding' | 'context' | 'search' | 'llm' | 'tool_select' | 'http_call';
  message: string;
}

export interface SSEMetaEvent {
  type: 'meta';
  conversation_id: number | null;
  mapped_term: string | null;
  results: KnowledgeResult[];
}

export interface SSETokenEvent {
  type: 'token';
  data: string;
}

export interface SSEDoneEvent {
  type: 'done';
  message_id?: number;
  status?: string;
}

export type SSEEvent = SSEStatusEvent | SSEMetaEvent | SSETokenEvent | SSEDoneEvent | SSEToolRequestEvent | SSEToolResultEvent | SSEToolErrorEvent;

// Chat request
export interface ApprovedTool {
  tool_id: number;
  params: Record<string, string>;
}

export interface ChatRequest {
  namespace: string;
  question: string;
  agentType?: string;
  wVector?: number;
  wKeyword?: number;
  topK?: number;
  conversationId?: number | null;
  category?: string | null;
  approvedTool?: ApprovedTool | null;
  selectedToolId?: number | null;
  signal?: AbortSignal;
}

// Feedback types
export interface FeedbackPayload {
  namespace: string;
  question: string;
  answer: string;
  knowledge_id?: number | null;
  is_positive: boolean;
  comment?: string | null;
  message_id?: number | null;
}

// Few-shot types
export interface FewshotItem {
  id: number;
  namespace: string;
  question: string;
  answer: string;
  knowledge_id: number | null;
  created_by_part?: string | null;
  created_by_user_id?: number | null;
  created_by_username?: string | null;
  created_at: string;
  status: string;
}

export interface FewshotCreatePayload {
  namespace: string;
  question: string;
  answer: string;
  knowledge_id?: number | null;
}

export interface FewshotUpdatePayload {
  question?: string;
  answer?: string;
}

export interface FewshotSearchResult {
  question: string;
  answer: string;
  similarity: number;
}

export interface FewshotSearchResponse {
  question: string;
  namespace: string;
  fewshots: FewshotSearchResult[];
  prompt_section: string;
}

// Query log item from /stats/namespace/{name}/queries
export type QueryStatus = 'pending' | 'resolved' | 'unresolved';

export interface QueryLog {
  id: number;
  question: string;
  mapped_term: string | null;
  status: QueryStatus;
  created_at: string;
  answer: string | null;
}

// Stats types — matches backend NamespaceDetailStats
export interface NamespaceStats {
  namespace: string;
  total_queries: number;
  resolved: number;
  pending: number;
  unresolved: number;
  term_distribution: Array<{ term: string; total: number; pending: number; unresolved: number }>;
  unresolved_cases: Array<{ id: number; question: string; mapped_term: string | null; created_at: string }>;
}

// matches backend StatsResponse
export interface GlobalStats {
  namespaces: Array<{
    namespace: string;
    total_queries: number;
    resolved: number;
    pending: number;
    unresolved: number;
    positive_feedback: number;
    negative_feedback: number;
    knowledge_count: number;
    glossary_count: number;
  }>;
  unresolved_cases: Array<{ namespace: string; question: string; created_at: string }>;
}

// MCP Tool types
export interface McpToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
  example?: string | null;
}

export interface McpTool {
  id: number;
  namespace: string;
  name: string;
  description: string;
  method: string;
  hub_base_url: string;
  tool_path: string;
  url: string; // hub_base_url + tool_path (서버에서 조합)
  headers: Record<string, string>;
  param_schema: McpToolParam[];
  response_example: Record<string, unknown> | null;
  timeout_sec: number;
  max_response_kb: number;
  is_active: boolean;
  created_at: string;
}

export interface McpToolCreatePayload {
  namespace: string;
  name: string;
  description: string;
  method: string;
  hub_base_url: string;
  tool_path: string;
  headers: Record<string, string>;
  param_schema: McpToolParam[];
  response_example?: Record<string, unknown> | null;
  timeout_sec?: number;
  max_response_kb?: number;
}

export interface McpToolUpdatePayload {
  name?: string;
  description?: string;
  method?: string;
  hub_base_url?: string;
  tool_path?: string;
  headers?: Record<string, string>;
  param_schema?: McpToolParam[];
  response_example?: Record<string, unknown> | null;
  timeout_sec?: number;
  max_response_kb?: number;
}

// SSE Tool events
export interface SSEToolRequestEvent {
  type: 'tool_request';
  action: 'confirm' | 'missing_params' | 'no_tool_needed' | 'no_tools';
  tool_id?: number;
  tool_name?: string;
  tool_url?: string;
  params?: Record<string, string>;
  missing_params?: string[];
  param_schema?: McpToolParam[];
  tools?: Array<{ id: number; name: string; description: string }>;
  message?: string;
}

export interface SSEToolResultEvent {
  type: 'tool_result';
  data: string;
}

export interface SSEToolErrorEvent {
  type: 'tool_error';
  message: string;
}

// Debug search types
export interface DebugSearchRequest {
  namespace: string;
  question: string;
  w_vector?: number;
  w_keyword?: number;
  top_k?: number;
}

export interface DebugSearchResult {
  id: number;
  container_name: string;
  target_tables: string[];
  content: string;
  query_template: string | null;
  v_score: number;
  k_score: number;
  final_score: number;
  base_weight: number;
}

export interface DebugGlossaryMatch {
  term: string;
  description: string;
  similarity: number;
}

export interface DebugFewshot {
  question: string;
  answer: string;
  similarity: number;
}

export interface DebugSearchResponse {
  question: string;
  namespace: string;
  enriched_query: string;
  glossary_match: DebugGlossaryMatch | null;
  w_vector: number;
  w_keyword: number;
  fewshots: DebugFewshot[];
  results: DebugSearchResult[];
  context_preview: string;
}
