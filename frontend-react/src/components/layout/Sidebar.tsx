import { useEffect, useRef, useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  MessageSquare,
  Settings,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
  Activity,
  Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../../store/useAppStore';
import { stopChatStream, clearStreamState, useStreamStore } from '../../store/useStreamStore';
import { getNamespaces } from '../../api/namespaces';
import { getConversations, deleteConversation } from '../../api/conversations';
import { healthCheck } from '../../api/client';

export function Sidebar() {
  const location = useLocation();
  const isChatPage = location.pathname === '/';

  const { namespace, setNamespace, conversationId, setConversationId, conversations, setConversations } = useAppStore();
  const searchConfig = useAppStore((s) => s.searchConfig);
  const setSearchConfig = useAppStore((s) => s.setSearchConfig);

  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [showSearchConfig, setShowSearchConfig] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(false);

  // Health check on mount and every 30s
  useEffect(() => {
    const check = async () => {
      const ok = await healthCheck();
      setBackendOk(ok);
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Load namespaces
  useEffect(() => {
    getNamespaces()
      .then((data) => {
        setNamespaces(data);
        if (!namespace && data.length > 0) {
          setNamespace(data[0]);
        }
      })
      .catch(console.error);
  }, [namespace, setNamespace]);

  // Load conversations when namespace changes (only on chat page)
  const refreshConversations = useCallback(async () => {
    if (!namespace || !isChatPage) return;
    setLoadingConvs(true);
    try {
      const data = await getConversations(namespace);
      setConversations(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingConvs(false);
    }
  }, [namespace, isChatPage, setConversations]);

  // Refresh on namespace or page change
  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  // Also refresh when conversationId changes (new conv created, or user navigated)
  // Skip refresh during streaming — conversation should appear only after answer completes
  const streamActive = useStreamStore((s) => s.active);
  const prevConvIdRef = useRef(conversationId);
  useEffect(() => {
    if (prevConvIdRef.current !== conversationId) {
      prevConvIdRef.current = conversationId;
      if (!streamActive) {
        refreshConversations();
      }
    }
  }, [conversationId, refreshConversations, streamActive]);

  // Refresh conversation list when stream finishes (new conversation now has answer)
  const prevStreamActiveRef = useRef(streamActive);
  useEffect(() => {
    if (prevStreamActiveRef.current && !streamActive) {
      refreshConversations();
    }
    prevStreamActiveRef.current = streamActive;
  }, [streamActive, refreshConversations]);

  const handleDeleteConversation = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      await deleteConversation(id);
      setConversations(conversations.filter((c) => c.id !== id));
      if (conversationId === id) setConversationId(null);
    } catch (err) {
      console.error(err);
    }
  };

  const handleNewChat = () => {
    if (useStreamStore.getState().active) {
      stopChatStream();
    }
    clearStreamState();
    setConversationId(null);
  };

  return (
    <aside className="w-64 flex-shrink-0 bg-[#1E293B] border-r border-slate-700 flex flex-col h-full">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-slate-100 text-sm">Ops-Navigator</span>
        </div>
        {/* Backend health indicator */}
        {backendOk === null && (
          <Activity className="w-4 h-4 text-slate-500 animate-pulse" />
        )}
        {backendOk === true && (
          <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" title="백엔드 정상" />
        )}
        {backendOk === false && (
          <span className="w-2 h-2 rounded-full bg-rose-500 flex-shrink-0" title="백엔드 연결 실패" />
        )}
      </div>

      {/* Navigation */}
      <nav className="px-3 py-3 border-b border-slate-700 flex gap-1">
        <NavLink
          to="/"
          end
          className={({ isActive }) =>
            clsx(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
              isActive
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700',
            )
          }
        >
          <MessageSquare className="w-4 h-4" />
          Chat
        </NavLink>
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            clsx(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
              isActive
                ? 'bg-indigo-600 text-white'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700',
            )
          }
        >
          <Settings className="w-4 h-4" />
          Admin
        </NavLink>
      </nav>

      {/* Namespace selector — Chat only */}
      {isChatPage && (
        <div className="px-3 py-3 border-b border-slate-700">
          <label className="text-xs font-medium text-slate-500 uppercase tracking-wider block mb-1.5">
            네임스페이스
          </label>
          {namespaces.length === 0 ? (
            <div className="text-xs text-slate-500 px-1">네임스페이스 없음</div>
          ) : (
            <select
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 cursor-pointer"
            >
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Chat-only section */}
      {isChatPage && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* New chat button */}
          <div className="px-3 py-2 border-b border-slate-700">
            <button
              onClick={handleNewChat}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              새 대화
            </button>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {loadingConvs && (
              <div className="text-xs text-slate-500 text-center py-4 animate-pulse">
                대화 목록 로딩 중...
              </div>
            )}
            {!loadingConvs && conversations.length === 0 && (
              <div className="text-xs text-slate-500 text-center py-4">
                대화 없음
              </div>
            )}
            {!loadingConvs &&
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => setConversationId(conv.id)}
                  className={clsx(
                    'group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors mb-0.5',
                    conversationId === conv.id
                      ? 'bg-indigo-600/20 border border-indigo-600/40'
                      : 'hover:bg-slate-700',
                  )}
                >
                  <MessageSquare className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                  <span className="flex-1 text-xs text-slate-300 truncate">{conv.title}</span>
                  <button
                    onClick={(e) => handleDeleteConversation(e, conv.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded text-slate-500 hover:text-rose-400 transition-all"
                    title="대화 삭제"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
          </div>

          {/* Search config collapsible */}
          <div className="border-t border-slate-700">
            <button
              onClick={() => setShowSearchConfig((p) => !p)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Settings className="w-3.5 h-3.5" />
                검색 설정
              </span>
              {showSearchConfig ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
            {showSearchConfig && (
              <div className="px-4 pb-3 space-y-3 bg-slate-900/50">
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>벡터 가중치</span>
                    <span className="text-indigo-400 font-mono">{searchConfig.wVector.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={searchConfig.wVector}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setSearchConfig({ wVector: v, wKeyword: parseFloat((1 - v).toFixed(1)) });
                    }}
                    className="w-full accent-indigo-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>키워드 가중치</span>
                    <span className="text-indigo-400 font-mono">{searchConfig.wKeyword.toFixed(1)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={searchConfig.wKeyword}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setSearchConfig({ wKeyword: v, wVector: parseFloat((1 - v).toFixed(1)) });
                    }}
                    className="w-full accent-indigo-500"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>검색 결과 수 (Top-K)</span>
                    <span className="text-indigo-400 font-mono">{searchConfig.topK}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={1}
                    value={searchConfig.topK}
                    onChange={(e) => setSearchConfig({ topK: parseInt(e.target.value, 10) })}
                    className="w-full accent-indigo-500"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* If admin page, show nothing extra */}
      {!isChatPage && <div className="flex-1" />}

      {/* Copyright */}
      <div className="px-5 py-3 border-t border-slate-700/50">
        <p className="text-xs text-slate-600">© 김태훈</p>
      </div>
    </aside>
  );
}
