from typing import Optional
from pydantic import BaseModel, Field


# ─── Chat ────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    namespace: str
    question: str
    w_vector: float = Field(default=0.7, ge=0.0, le=1.0)
    w_keyword: float = Field(default=0.3, ge=0.0, le=1.0)
    top_k: int = Field(default=5, ge=1, le=20)
    conversation_id: Optional[int] = None


class KnowledgeResult(BaseModel):
    id: int
    container_name: Optional[str]
    target_tables: Optional[list[str]]
    content: str
    query_template: Optional[str]
    final_score: float


class ChatResponse(BaseModel):
    conversation_id: int
    question: str
    mapped_term: Optional[str]
    results: list[KnowledgeResult]
    answer: str


# ─── Knowledge ───────────────────────────────────────────────────────────────

class KnowledgeCreate(BaseModel):
    namespace: str
    container_name: Optional[str] = None
    target_tables: Optional[list[str]] = None
    content: str
    query_template: Optional[str] = None
    base_weight: float = Field(default=1.0, ge=0.0)


class KnowledgeUpdate(BaseModel):
    container_name: Optional[str] = None
    target_tables: Optional[list[str]] = None
    content: Optional[str] = None
    query_template: Optional[str] = None
    base_weight: Optional[float] = Field(default=None, ge=0.0)


class KnowledgeOut(BaseModel):
    id: int
    namespace: str
    container_name: Optional[str]
    target_tables: Optional[list[str]]
    content: str
    query_template: Optional[str]
    base_weight: float
    created_at: str
    updated_at: str


# ─── Glossary ────────────────────────────────────────────────────────────────

class GlossaryCreate(BaseModel):
    namespace: str
    term: str
    description: str


class GlossaryUpdate(BaseModel):
    term: str
    description: str


class GlossaryOut(BaseModel):
    id: int
    namespace: str
    term: str
    description: str


# ─── Feedback ────────────────────────────────────────────────────────────────

class FeedbackCreate(BaseModel):
    knowledge_id: Optional[int] = None
    namespace: str
    question: str
    answer: Optional[str] = None
    is_positive: bool


# ─── Debug Search ────────────────────────────────────────────────────────────

class GlossaryMatchInfo(BaseModel):
    term: str
    description: str
    similarity: float  # 0~1, 높을수록 유사


class DebugResult(BaseModel):
    id: int
    container_name: Optional[str]
    target_tables: Optional[list[str]]
    content: str
    query_template: Optional[str]
    base_weight: float
    v_score: float
    k_score: float
    final_score: float


class DebugSearchResponse(BaseModel):
    question: str
    namespace: str
    enriched_query: str
    glossary_match: Optional[GlossaryMatchInfo]
    w_vector: float
    w_keyword: float
    results: list[DebugResult]
    context_preview: str


# ─── Namespace ───────────────────────────────────────────────────────────────

class NamespaceCreate(BaseModel):
    name: str
    description: str = ""


class NamespaceInfo(BaseModel):
    name: str
    description: str
    knowledge_count: int
    glossary_count: int
    created_at: str


# ─── Conversation ────────────────────────────────────────────────────────────

class ConversationCreate(BaseModel):
    namespace: str
    title: str = ""


class ConversationResponse(BaseModel):
    id: int
    namespace: str
    title: str
    created_at: str


class MessageResponse(BaseModel):
    id: int
    conversation_id: int
    role: str
    content: str
    mapped_term: Optional[str]
    results: Optional[list]
    created_at: str


# ─── Stats ───────────────────────────────────────────────────────────────────

class NamespaceStats(BaseModel):
    namespace: str
    total_queries: int
    resolved: int
    unresolved: int
    positive_feedback: int
    negative_feedback: int
    knowledge_count: int = 0
    glossary_count: int = 0


class StatsResponse(BaseModel):
    namespaces: list[NamespaceStats]
    unresolved_cases: list[dict]


class TermStat(BaseModel):
    term: str
    total: int
    unresolved: int


class NamespaceDetailStats(BaseModel):
    namespace: str
    total_queries: int
    resolved: int
    unresolved: int
    term_distribution: list[TermStat]
    unresolved_cases: list[dict]
