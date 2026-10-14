// useLayout — KnockDesk v2 layout hook
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface LayoutContextValue {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  mobileSidebarOpen: boolean;
  openMobileSidebar: () => void;
  closeMobileSidebar: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((v) => !v), []);
  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), []);
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  return (
    <LayoutContext.Provider value={{ sidebarCollapsed, toggleSidebar, mobileSidebarOpen, openMobileSidebar, closeMobileSidebar }}>
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}

export default useLayout;