import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Search, AlertCircle, ChevronDown, ChevronUp,
  Layers, Database, BookOpen, Zap, MessageSquare, Brain, Target,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { debugSearch } from '../../api/chat';
import { getNamespaces } from '../../api/namespaces';
import { getSearchThresholds } from '../../api/llm';
import { Button } from '../ui/Button';
import { CodeBlock } from '../ui/CodeBlock';
import { Badge } from '../ui/Badge';
import type { DebugSearchResponse } from '../../types';

type TabId = 'namespaces' | 'knowledge' | 'glossary' | 'fewshots' | 'stats' | 'debug' | 'llm';

interface PipelineStep {
  id: string;
  label: string;
  icon: React.ReactNode;
  activeIcon: React.ReactNode;
  color: string;
  navigateTo?: TabId;
}

const PIPELINE_STEPS: PipelineStep[] = [
  {
    id: 'question',
    label: '질문 입력',
    icon: <MessageSquare className="w-7 h-7" />,
    activeIcon: <MessageSquare className="w-7 h-7" />,
    color: 'text-sky-400',
  },
  {
    id: 'namespace',
    label: '네임스페이스',
    icon: <Layers className="w-7 h-7" />,
    activeIcon: <Layers className="w-7 h-7" />,
    color: 'text-violet-400',
    navigateTo: 'namespaces',
  },
  {
    id: 'glossary',
    label: '용어 매핑',
    icon: <Database className="w-7 h-7" />,
    activeIcon: <Database className="w-7 h-7" />,
    color: 'text-indigo-400',
    navigateTo: 'glossary',
  },
  {
    id: 'knowledge',
    label: '지식 검색',
    icon: <BookOpen className="w-7 h-7" />,
    activeIcon: <BookOpen className="w-7 h-7" />,
    color: 'text-emerald-400',
    navigateTo: 'knowledge',
  },
  {
    id: 'fewshot',
    label: 'Few-shot',
    icon: <Zap className="w-7 h-7" />,
    activeIcon: <Zap className="w-7 h-7" />,
    color: 'text-amber-400',
    navigateTo: 'fewshots',
  },
  {
    id: 'context',
    label: 'LLM 컨텍스트',
    icon: <Brain className="w-7 h-7" />,
    activeIcon: <Brain className="w-7 h-7" />,
    color: 'text-rose-400',
  },
  {
    id: 'result',
    label: '결과',
    icon: <Target className="w-7 h-7" />,
    activeIcon: <Target className="w-7 h-7" />,
    color: 'text-teal-400',
  },
];

function PipelineFlow({
  activeStepIndex,
  onNavigate,
}: {
  activeStepIndex: number;
  onNavigate?: (tab: TabId) => void;
}) {
  return (
    <div className="flex flex-col items-center py-4 px-1">
      <p className="text-[10px] text-slate-500 font-medium mb-4 tracking-wider uppercase">Pipeline</p>
      <div className="flex flex-col items-center gap-0">
        {PIPELINE_STEPS.map((step, i) => {
          const isActive = i <= activeStepIndex;
          const isCurrent = i === activeStepIndex && activeStepIndex >= 0;
          const canNavigate = !!step.navigateTo && onNavigate;

          return (
            <div key={step.id} className="flex flex-col items-center">
              {/* Connector line above (except first) */}
              {i > 0 && (
                <div
                  className={`w-0.5 h-3 transition-colors duration-500 ${
                    isActive ? 'bg-slate-500' : 'bg-slate-700/50'
                  }`}
                  style={{ transitionDelay: isActive ? `${i * 150}ms` : '0ms' }}
                />
              )}

              {/* Icon node */}
              <button
                onClick={() => canNavigate && onNavigate(step.navigateTo!)}
                disabled={!canNavigate}
                title={step.navigateTo ? `${step.label} 탭으로 이동` : step.label}
                className={`
                  relative w-12 h-12 rounded-xl flex items-center justify-center
                  transition-all duration-300 group hover:scale-125 hover:shadow-lg
                  ${isActive
                    ? `bg-slate-800 border border-slate-600 ${step.color} shadow-sm hover:brightness-125`
                    : 'bg-slate-800/40 border border-slate-700/40 text-slate-600 hover:text-slate-400 hover:border-slate-600'
                  }
                  ${isCurrent ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-indigo-500/50 scale-110' : ''}
                  ${canNavigate ? 'cursor-pointer' : 'cursor-default'}
                `}
                style={{ transitionDelay: isActive ? `${i * 150}ms` : '0ms' }}
              >
                {isActive ? step.activeIcon : step.icon}
              </button>

              {/* Label below icon */}
              <p
                className={`mt-1 text-[10px] leading-tight text-center transition-colors duration-500 ${
                  isActive ? 'text-slate-300' : 'text-slate-600'
                }`}
                style={{ transitionDelay: isActive ? `${i * 150}ms` : '0ms' }}
              >
                {step.label}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DebugPanelProps {
  onNavigate?: (tab: TabId) => void;
}

export function DebugPanel({ onNavigate }: DebugPanelProps) {
  const { searchConfig, namespace: storeNamespace } = useAppStore();

  const { data: namespaces = [] } = useQuery({
    queryKey: ['namespaces'],
    queryFn: getNamespaces,
    staleTime: 30_000,
  });

  const { data: th } = useQuery({
    queryKey: ['search-thresholds'],
    queryFn: getSearchThresholds,
    staleTime: 10_000,
  });
  const gMin = th?.glossary_min_similarity ?? 0.5;
  const fsMin = th?.fewshot_min_similarity ?? 0.6;
  const kMin = th?.knowledge_min_score ?? 0.35;
  const kHigh = th?.knowledge_high_score ?? 0.8;
  const kMid = th?.knowledge_mid_score ?? 0.55;

  const [namespace, setNamespace] = useState(storeNamespace || '');
  const [question, setQuestion] = useState('');
  const [wVector, setWVector] = useState(searchConfig.wVector);
  const [wKeyword, setWKeyword] = useState(searchConfig.wKeyword);
  const [topK, setTopK] = useState(searchConfig.topK);

  const [result, setResult] = useState<DebugSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);

  // Pipeline step animation
  const [pipelineStep, setPipelineStep] = useState(-1);
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearAnimTimers = () => {
    animTimers.current.forEach(clearTimeout);
    animTimers.current = [];
  };

  useEffect(() => clearAnimTimers, []);

  const animatePipeline = (stepCount: number) => {
    clearAnimTimers();
    for (let i = 0; i <= stepCount; i++) {
      const t = setTimeout(() => setPipelineStep(i), i * 300);
      animTimers.current.push(t);
    }
  };

  const handleSearch = async () => {
    if (!namespace.trim() || !question.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setShowContext(false);

    // Start pipeline animation: question(0) → namespace(1)
    setPipelineStep(0);
    animatePipeline(1);

    try {
      const data = await debugSearch({
        namespace: namespace.trim(),
        question: question.trim(),
        w_vector: wVector,
        w_keyword: wKeyword,
        top_k: topK,
      });
      setResult(data);
      // Animate remaining steps: glossary(2) → knowledge(3) → fewshot(4) → context(5) → result(6)
      const startFrom = 2;
      clearAnimTimers();
      for (let i = startFrom; i < PIPELINE_STEPS.length; i++) {
        const t = setTimeout(() => setPipelineStep(i), (i - startFrom) * 300);
        animTimers.current.push(t);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      setPipelineStep(-1);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSearch();
  };

  return (
    <div className="flex gap-4">
      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-200 mb-1">벡터 검색 테스트</h2>
          <p className="text-sm text-slate-500">하이브리드 검색 결과를 디버깅합니다.</p>
        </div>

        {/* Search form */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                네임스페이스 <span className="text-rose-400">*</span>
              </label>
              <select
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">선택...</option>
                {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">결과 수 (top_k)</label>
              <input
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(e) => setTopK(Math.max(1, parseInt(e.target.value, 10) || 5))}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              질문 <span className="text-rose-400">*</span>
            </label>
            <textarea
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="검색할 질문을 입력하세요... (Ctrl+Enter)"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1.5">
                <span>벡터 가중치 (w_vector)</span>
                <span className="font-mono text-indigo-400">{wVector.toFixed(2)}</span>
              </div>
              <input
                type="range" min={0} max={1} step={0.05} value={wVector}
                onChange={(e) => { const v = parseFloat(e.target.value); setWVector(v); setWKeyword(parseFloat((1 - v).toFixed(2))); }}
                className="w-full accent-indigo-500"
              />
            </div>
            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1.5">
                <span>키워드 가중치 (w_keyword)</span>
                <span className="font-mono text-indigo-400">{wKeyword.toFixed(2)}</span>
              </div>
              <input
                type="range" min={0} max={1} step={0.05} value={wKeyword}
                onChange={(e) => { const v = parseFloat(e.target.value); setWKeyword(v); setWVector(parseFloat((1 - v).toFixed(2))); }}
                className="w-full accent-indigo-500"
              />
            </div>
          </div>

          <Button
            variant="primary"
            onClick={handleSearch}
            loading={loading}
            disabled={!namespace.trim() || !question.trim()}
            className="w-full"
          >
            <Search className="w-4 h-4" />
            검색 실행
          </Button>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 bg-rose-900/20 border border-rose-700/40 rounded-xl p-4">
            <AlertCircle className="w-5 h-5 text-rose-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-rose-300">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4">
            {/* Pipeline summary */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-300">파이프라인 요약</h3>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-slate-500 mb-0.5">원본 질문</p>
                  <p className="text-slate-200">{result.question}</p>
                </div>
                <div>
                  <p className="text-slate-500 mb-0.5">보강된 질문</p>
                  <p className="text-slate-200">{result.enriched_query}</p>
                </div>
              </div>
              {result.glossary_match ? (
                <div className="bg-indigo-900/20 border border-indigo-700/30 rounded-lg px-3 py-2.5">
                  <p className="text-xs text-slate-500 mb-1">용어 매핑 성공</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge color="indigo">{result.glossary_match.term}</Badge>
                    <span className="text-xs text-slate-400">{result.glossary_match.description}</span>
                    <span className="text-xs text-slate-500 ml-auto">
                      유사도: <span className={`font-mono ${result.glossary_match.similarity >= gMin + 0.2 ? 'text-emerald-400' : result.glossary_match.similarity >= gMin ? 'text-indigo-400' : 'text-rose-400'}`}>{result.glossary_match.similarity.toFixed(4)}</span>
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1.5">
                    기준: {gMin.toFixed(2)}+ 매핑 활성 · {(gMin + 0.2).toFixed(2)}+ 높은 신뢰 · {gMin.toFixed(2)}~{(gMin + 0.2).toFixed(2)} 약한 매핑 (용어집 보강 권장)
                  </p>
                </div>
              ) : (
                <div className="bg-slate-700/30 rounded-lg px-3 py-2 space-y-1">
                  <p className="text-xs text-slate-500">용어 매핑 없음 (유사도 {gMin.toFixed(2)} 미만)</p>
                  <p className="text-[10px] text-slate-600">용어집에 관련 용어를 추가하면 검색 정확도가 높아집니다.</p>
                </div>
              )}
            </div>

            {/* Few-shots */}
            <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-slate-300">
                  Few-shot 후보 ({result.fewshots.filter(f => f.similarity >= fsMin).length}/{result.fewshots.length}건 통과)
                </h3>
                <span className="text-[10px] text-slate-500">{fsMin.toFixed(2)}+ 적용 · {(fsMin + 0.2).toFixed(2)}+ 고품질 매칭</span>
              </div>
              {result.fewshots.length > 0 ? (
                <div className="space-y-2">
                  {result.fewshots.map((fs, i) => {
                    const passed = fs.similarity >= fsMin;
                    return (
                      <div key={i} className={`rounded-lg px-3 py-2.5 space-y-1.5 ${passed ? 'bg-slate-900/60' : 'bg-slate-900/30 border border-dashed border-slate-700'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            {!passed && <span className="text-[10px] text-rose-400 bg-rose-400/10 px-1.5 py-0.5 rounded font-medium flex-shrink-0">미달</span>}
                            <p className={`text-xs font-medium ${passed ? 'text-slate-300' : 'text-slate-500'}`}>{fs.question}</p>
                          </div>
                          <span className={`text-xs font-mono flex-shrink-0 ${passed ? (fs.similarity >= fsMin + 0.2 ? 'text-emerald-400' : fs.similarity >= fsMin + 0.1 ? 'text-violet-400' : 'text-amber-400') : 'text-rose-400'}`}>
                            {fs.similarity.toFixed(4)}
                          </span>
                        </div>
                        <p className={`text-xs line-clamp-2 ${passed ? 'text-slate-500' : 'text-slate-600'}`}>{fs.answer}</p>
                        {!passed && (
                          <p className="text-[10px] text-rose-400/70">유사도 {fs.similarity.toFixed(4)} &lt; 기준 {fsMin.toFixed(2)} → 컨텍스트 미포함</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="bg-slate-700/30 rounded-lg px-3 py-2 space-y-1">
                  <p className="text-xs text-slate-500">등록된 Few-shot 없음</p>
                  <p className="text-[10px] text-slate-600">Few-shot 탭에서 양질의 Q&A 예시를 등록하면 답변 품질이 향상됩니다.</p>
                </div>
              )}
            </div>

            {/* Search results */}
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-300">
                    검색 결과 ({result.results.length}건)
                  </h3>
                  <span className="text-xs text-slate-500">
                    w_vec={result.w_vector.toFixed(2)} · w_kw={result.w_keyword.toFixed(2)} · top_k={topK}
                  </span>
                </div>
                <p className="text-[10px] text-slate-500 mt-1">
                  최종 점수 기준: <span className="text-emerald-400/70">{kHigh.toFixed(2)}+</span> 높은 신뢰 · <span className="text-indigo-400/70">{kMid.toFixed(2)}+</span> 보통 · <span className="text-amber-400/70">{kMin.toFixed(2)}~{kMid.toFixed(2)}</span> 낮음 · {kMin.toFixed(2)} 미만은 컨텍스트에서 제외
                </p>
              </div>

              {result.results.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-sm">검색 결과가 없습니다.</div>
              )}

              {result.results.map((r, i) => (
                <div key={r.id} className="bg-slate-800 border border-slate-700 rounded-xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">#{i + 1}</span>
                        <span className="font-semibold text-slate-200">{r.container_name}</span>
                        <span className="text-xs bg-indigo-900/40 text-indigo-300 border border-indigo-700/40 px-2 py-0.5 rounded-full">
                          ID: {r.id}
                        </span>
                      </div>
                      {r.target_tables.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {r.target_tables.map((t) => (
                            <span key={t} className="text-xs font-mono bg-slate-700 text-slate-300 px-2 py-0.5 rounded">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs text-slate-500 mb-0.5">최종 점수</p>
                      <p className={`text-xl font-bold ${r.final_score >= kHigh ? 'text-emerald-400' : r.final_score >= kMid ? 'text-indigo-400' : r.final_score >= kMin ? 'text-amber-400' : 'text-rose-400'}`}>{r.final_score.toFixed(4)}</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {[
                      { label: '벡터 점수 (v_score)', value: r.v_score, color: 'bg-emerald-500', textColor: 'text-emerald-400' },
                      { label: '키워드 점수 (k_score)', value: r.k_score, color: 'bg-yellow-500', textColor: 'text-yellow-400' },
                    ].map(({ label, value, color, textColor }) => (
                      <div key={label}>
                        <div className="flex justify-between text-xs text-slate-500 mb-1">
                          <span>{label}</span>
                          <span className={`font-mono ${textColor}`}>{value.toFixed(4)}</span>
                        </div>
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                          <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${Math.min(value * 100, 100)}%` }} />
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-between text-xs text-slate-500">
                      <span>기본 가중치 (base_weight)</span>
                      <span className="font-mono text-slate-300">{r.base_weight}</span>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs text-slate-500 mb-1.5">내용</p>
                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{r.content}</p>
                  </div>

                  {r.query_template && (
                    <div>
                      <p className="text-xs text-slate-500 mb-1.5">쿼리 템플릿</p>
                      <CodeBlock code={r.query_template} language="sql" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Context preview */}
            {result.context_preview && (
              <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowContext((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-700/50 transition-colors"
                >
                  <span>LLM 컨텍스트 미리보기</span>
                  {showContext ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>
                {showContext && (
                  <div className="border-t border-slate-700 px-4 py-3">
                    <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
                      {result.context_preview}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pipeline flow sidebar */}
      <div className="flex-shrink-0 w-[80px]">
        <div className="sticky top-0">
          <PipelineFlow activeStepIndex={pipelineStep} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}
