import { create } from 'zustand';
import type { Conversation } from '../types';

interface SearchConfig {
  wVector: number;
  wKeyword: number;
  topK: number;
}

interface AppState {
  namespace: string;
  setNamespace: (ns: string) => void;
  conversationId: number | null;
  setConversationId: (id: number | null) => void;
  conversations: Conversation[];
  setConversations: (convs: Conversation[]) => void;
  searchConfig: SearchConfig;
  setSearchConfig: (cfg: Partial<SearchConfig>) => void;
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
  searchConfig: { wVector: 0.7, wKeyword: 0.3, topK: 5 },
  setSearchConfig: (cfg) =>
    set((state) => ({ searchConfig: { ...state.searchConfig, ...cfg } })),
  chatRefreshKey: 0,
  bumpChatRefresh: () => set((state) => ({ chatRefreshKey: state.chatRefreshKey + 1 })),
}));
