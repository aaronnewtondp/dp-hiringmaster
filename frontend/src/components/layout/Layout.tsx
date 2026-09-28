import { ReactNode, useState } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar.tsx';

export default function Layout({ children }: { children: ReactNode }) {
  // Sidebar starts closed below `lg:` so it doesn't eat most of the screen
  // on phone/tablet — see Sidebar.tsx for why `lg:` specifically (below it
  // covers phone AND tablet widths, e.g. an iPad portrait at 768-834px).
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="flex-1 overflow-y-auto min-w-0">
        {/* Mobile/tablet-only top bar carrying the sidebar toggle — hidden
            at `lg:` and up, where the sidebar is always visible instead. */}
        <div className="lg:hidden sticky top-0 z-30 flex items-center gap-3 bg-white border-b border-gray-200 px-4 py-3">
          <button
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            aria-expanded={sidebarOpen}
            className="p-2 -ml-2 rounded-lg text-navy-800 hover:bg-gray-100"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-display font-semibold text-navy-800 text-sm">Hiring Master System</span>
        </div>
        <div className="max-w-7xl mx-auto px-6 py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
