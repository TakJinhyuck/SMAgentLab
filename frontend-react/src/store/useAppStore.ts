import { create } from 'zustand';
import type { Conversation } from '../types';

interface SearchConfig {
  wVector: number;
  wKeyword: number;
  topK: number;
}

// 백엔드 fetch 전 임시 fallback (API 응답으로 즉시 덮어씀)
const FALLBACK_SEARCH_CONFIG: SearchConfig = { wVector: 0.7, wKeyword: 0.3, topK: 3 };

interface AppState {
  namespace: string;
  setNamespace: (ns: string) => void;
  conversationId: number | null;
  setConversationId: (id: number | null) => void;
  conversations: Conversation[];
  setConversations: (convs: Conversation[]) => void;
  searchConfig: SearchConfig;
  setSearchConfig: (cfg: Partial<SearchConfig>) => void;
  searchConfigLoaded: boolean;
  initSearchConfig: (cfg: SearchConfig) => void;
  chatRefreshKey: number;
  bumpChatRefresh: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  namespace: '',
  setNamespace: (namespace) => set({ namespace, conversationId: null, conversations: [] }),
  conversationId: null,
  setConversationId: (conversationId) =>
    set((state) => (state.conversationId === conversationId ? state : { conversationId })),
  conversations: [],
  setConversations: (conversations) => set({ conversations }),
  searchConfig: FALLBACK_SEARCH_CONFIG,
  setSearchConfig: (cfg: Partial<SearchConfig>) =>
    set((state) => ({ searchConfig: { ...state.searchConfig, ...cfg } })),
  searchConfigLoaded: false,
  initSearchConfig: (cfg) => set({ searchConfig: cfg, searchConfigLoaded: true }),
  chatRefreshKey: 0,
  bumpChatRefresh: () => set((state) => ({ chatRefreshKey: state.chatRefreshKey + 1 })),
}));
