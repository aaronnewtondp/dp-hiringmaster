import { NavLink } from 'react-router-dom';
import { useEffect } from 'react';
import { LayoutDashboard, Briefcase, Users, Building2, LogOut, Droplets, ListChecks, Archive, ShieldCheck, HelpCircle, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { PERSONAS } from '../../types/index.ts';

// "My Tasks" (formerly "My Queue") is now visible to every persona — its
// own contents are scoped per-persona server/client-side (see MyTasks.tsx),
// same principle as GET /dashboard/pending, rather than the whole nav item
// being hidden from HR/Admin the way it used to be.
const NAV = [
  { to: '/dashboard',  icon: LayoutDashboard, label: 'Dashboard',   hrOnly: false, superAdminOnly: false },
  { to: '/roles',      icon: Briefcase,       label: 'Roles',       hrOnly: false, superAdminOnly: false },
  { to: '/candidates', icon: Users,           label: 'Active Candidates',  hrOnly: false, superAdminOnly: false },
  { to: '/talent-pool',icon: Archive,         label: 'Archived Pipeline', hrOnly: false, superAdminOnly: false },
  { to: '/my-tasks',   icon: ListChecks,      label: 'My Tasks',    hrOnly: false, superAdminOnly: false },
  { to: '/agencies',   icon: Building2,       label: 'Agencies',    hrOnly: true,  superAdminOnly: false },
  { to: '/users',      icon: ShieldCheck,     label: 'User Management', hrOnly: false, superAdminOnly: true },
  { to: '/help',       icon: HelpCircle,      label: 'Help / FAQ',  hrOnly: false, superAdminOnly: false },
];

interface SidebarProps {
  // Below `lg:` the sidebar is a collapsible overlay drawer, closed by
  // default, so it doesn't eat most of the screen on phone/tablet widths —
  // `open` controls that drawer only. At `lg:` and up it's always visible
  // exactly as before, regardless of this prop.
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { user, logout, canHR, isSuperAdmin } = useAuth();

  const visible = NAV.filter(n => {
    if (n.hrOnly && !canHR) return false;
    if (n.superAdminOnly && !isSuperAdmin) return false;
    return true;
  });

  // Escape-to-close and background scroll lock while the drawer is open —
  // only matters below `lg:`, since `open` has no visual effect above it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — only exists below `lg:`, only while the drawer is open */}
      {open && (
        <div className="fixed inset-0 bg-black/40 z-40 lg:hidden" onClick={onClose} aria-hidden="true" />
      )}

      <aside
        role={open ? 'dialog' : undefined}
        aria-modal={open || undefined}
        aria-label="Main navigation"
        className={`w-56 shrink-0 bg-navy-800 flex flex-col h-screen fixed lg:sticky top-0 z-50 lg:z-auto transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-white/10">
          <div className="w-7 h-7 rounded-lg bg-dp-600 flex items-center justify-center shrink-0">
            <Droplets className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-white text-sm font-display font-semibold leading-tight">Hiring Master System</div>
            <div className="text-navy-200 text-xs">DigitalPaani</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="lg:hidden p-1.5 -mr-1.5 rounded-lg text-navy-200 hover:bg-white/10 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav — active state mirrors the brand book's own sidenav treatment:
            a teal left border + a faint teal wash on the navy field, rather
            than a solid fill block. */}
        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {visible.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm border-l-2 transition-colors ${
                  isActive
                    ? 'bg-dp-600/10 border-dp-200 text-white font-medium'
                    : 'border-transparent text-navy-200 hover:bg-white/5 hover:text-white'
                }`
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        <div className="px-3 py-4 border-t border-white/10">
          <div className="flex items-center gap-3 px-3 py-2 mb-1">
            <div className="w-7 h-7 rounded-full bg-dp-600 flex items-center justify-center text-white text-xs font-medium shrink-0">
              {user?.name?.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="text-white text-xs font-medium truncate">{user?.name}</div>
              <div className="text-navy-200 text-xs truncate">{user ? PERSONAS[user.persona] : ''}</div>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-navy-200 hover:bg-white/5 hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
