import { useState, useEffect, Component, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Database, BookOpen, BarChart2, Search, Layers, Zap, Settings, Users, Wrench, GitMerge, Network, BookMarked, ListOrdered, Workflow, FileText } from 'lucide-react';
import { NamespaceManager } from '../components/admin/NamespaceManager';
import { KnowledgeTable } from '../components/admin/KnowledgeTable';
import { GlossaryTable } from '../components/admin/GlossaryTable';
import { StatsPanel } from '../components/admin/StatsPanel';
import { DebugPanel } from '../components/admin/DebugPanel';
import { FewshotTable } from '../components/admin/FewshotTable';
import { LLMSettings } from '../components/admin/LLMSettings';
import { UserManager } from '../components/admin/UserManager';
import { McpToolManager } from '../components/admin/McpToolManager';
import { CachePanel } from '../components/admin/CachePanel';
import {
  SqlTargetDbTab,
  SqlSchemaTab,
  SqlErdTab,
  SqlSynonymTab,
  SqlFewshotTab,
  SqlPipelineTab,
  SqlAuditLogTab,
} from '../components/admin/Text2SqlAdmin';
import { useAuthStore } from '../store/useAuthStore';
import { useAppStore } from '../store/useAppStore';

// ── ErrorBoundary ─────────────────────────────────────────────────────────────

class TabErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
          <p className="text-rose-400 font-medium text-sm">탭 렌더링 오류</p>
          <pre className="text-xs text-slate-500 max-w-lg whitespace-pre-wrap">{this.state.error.message}</pre>
          <button className="text-xs text-indigo-400 hover:text-indigo-300" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

type TabId =
  // knowledge_rag
  | 'namespaces' | 'knowledge' | 'glossary' | 'fewshots' | 'mcp_tools' | 'debug'
  // text2sql
  | 'sql_db' | 'sql_schema' | 'sql_erd' | 'sql_synonyms' | 'sql_fewshots' | 'sql_pipeline' | 'sql_audit'
  // common
  | 'cache' | 'stats' | 'llm' | 'users';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
  agentScope?: 'knowledge_rag' | 'text2sql' | 'all';
}

const TABS: Tab[] = [
  // knowledge_rag 전용 탭
  { id: 'namespaces',   label: '기준 정보 관리',    icon: <Layers className="w-4 h-4" />,     agentScope: 'knowledge_rag' },
  { id: 'knowledge',    label: '지식 베이스',        icon: <BookOpen className="w-4 h-4" />,   agentScope: 'knowledge_rag' },
  { id: 'glossary',     label: '용어집',              icon: <Database className="w-4 h-4" />,   agentScope: 'knowledge_rag' },
  { id: 'fewshots',     label: 'Few-shot 예시',       icon: <ListOrdered className="w-4 h-4" />, agentScope: 'knowledge_rag' },
  { id: 'mcp_tools',    label: '도구 프롬프트',        icon: <Wrench className="w-4 h-4" />,    agentScope: 'knowledge_rag', adminOnly: true },
  { id: 'debug',        label: '디버그',               icon: <Zap className="w-4 h-4" />,       agentScope: 'knowledge_rag', adminOnly: true },
  // text2sql 전용 탭
  { id: 'sql_db',        label: 'DB 설정',           icon: <Database className="w-4 h-4" />,   agentScope: 'text2sql' },
  { id: 'sql_schema',    label: '스키마 분석',        icon: <BarChart2 className="w-4 h-4" />, agentScope: 'text2sql' },
  { id: 'sql_erd',       label: 'ERD',               icon: <Workflow className="w-4 h-4" />,   agentScope: 'text2sql' },
  { id: 'sql_synonyms',  label: '동의어 관리',        icon: <BookMarked className="w-4 h-4" />,agentScope: 'text2sql' },
  { id: 'sql_fewshots',  label: 'Few-shot 예시',      icon: <ListOrdered className="w-4 h-4" />,agentScope: 'text2sql' },
  { id: 'sql_pipeline',  label: 'SQL 파이프라인',     icon: <GitMerge className="w-4 h-4" />,   agentScope: 'text2sql', adminOnly: true },
  { id: 'sql_audit',     label: '감사 로그',          icon: <FileText className="w-4 h-4" />,   agentScope: 'text2sql', adminOnly: true },
  // 공통 탭
  { id: 'cache',         label: '캐시',               icon: <Network className="w-4 h-4" />,    agentScope: 'all', adminOnly: true },
  { id: 'stats',         label: '통계',               icon: <BarChart2 className="w-4 h-4" />,  agentScope: 'all', adminOnly: true },
  { id: 'llm',           label: 'LLM 설정',           icon: <Settings className="w-4 h-4" />,    agentScope: 'all', adminOnly: true },
  { id: 'users',         label: '유저 관리',           icon: <Users className="w-4 h-4" />,      agentScope: 'all', adminOnly: true },
];

// ... 이하 기존 코드 유지 ...
