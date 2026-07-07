import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Briefcase, Users, Building2, LogOut, Droplets, ListChecks } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { PERSONAS } from '../../types/index.ts';

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard',  hrOnly: false, queueOnly: false },
  { to: '/roles',     icon: Briefcase,       label: 'Roles',      hrOnly: false, queueOnly: false },
  { to: '/candidates',icon: Users,           label: 'Candidates', hrOnly: false, queueOnly: false },
  { to: '/hm-queue',  icon: ListChecks,      label: 'My Queue',   hrOnly: false, queueOnly: true  },
  { to: '/agencies',  icon: Building2,       label: 'Agencies',   hrOnly: true,  queueOnly: false },
];

export default function Sidebar() {
  const { user, logout, canHR } = useAuth();
  const isHM = user?.persona === 'hiring_manager' || user?.persona === 'interviewer' || user?.persona === 'leadership';

  const visible = NAV.filter(n => {
    if (n.hrOnly && !canHR) return false;
    if (n.queueOnly && !isHM) return false;
    return true;
  });

  return (
    <aside className="w-56 shrink-0 bg-dp-800 flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-dp-700">
        <div className="w-7 h-7 rounded-lg bg-dp-600 flex items-center justify-center">
          <Droplets className="w-4 h-4 text-white" />
        </div>
        <div>
          <div className="text-white text-sm font-semibold leading-tight">DigitalPaani</div>
          <div className="text-dp-200 text-xs">HMS</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {visible.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-dp-600 text-white font-medium'
                  : 'text-dp-200 hover:bg-dp-700 hover:text-white'
              }`
            }
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User */}
      <div className="px-3 py-4 border-t border-dp-700">
        <div className="flex items-center gap-3 px-3 py-2 mb-1">
          <div className="w-7 h-7 rounded-full bg-dp-600 flex items-center justify-center text-white text-xs font-medium shrink-0">
            {user?.name?.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-white text-xs font-medium truncate">{user?.name}</div>
            <div className="text-dp-300 text-xs truncate">{user ? PERSONAS[user.persona] : ''}</div>
          </div>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm text-dp-200 hover:bg-dp-700 hover:text-white transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
