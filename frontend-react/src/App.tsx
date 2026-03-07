import { useEffect, useRef } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './components/layout/Sidebar';
import { useAppStore } from './store/useAppStore';
import Chat from './pages/Chat';
import Admin from './pages/Admin';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

// Chat은 항상 mount 유지 (스트리밍 중 화면 이동해도 끊기지 않도록)
function AppContent() {
  const location = useLocation();
  const isAdmin = location.pathname.startsWith('/admin');
  const bumpChatRefresh = useAppStore((s) => s.bumpChatRefresh);

  // admin → chat 전환 시 메시지 재로드 트리거
  const prevAdminRef = useRef(isAdmin);
  useEffect(() => {
    const wasAdmin = prevAdminRef.current;
    prevAdminRef.current = isAdmin;
    if (wasAdmin && !isAdmin) {
      bumpChatRefresh();
    }
  }, [isAdmin, bumpChatRefresh]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#0F172A]">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <div className={isAdmin ? 'hidden' : 'h-full'}>
          <Chat />
        </div>
        {isAdmin && <Admin />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
