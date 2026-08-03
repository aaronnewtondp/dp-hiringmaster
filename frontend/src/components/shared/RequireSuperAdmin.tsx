import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.tsx';

// No route-level guard exists elsewhere in the app — every other page
// renders for any logged-in persona regardless of URL, restricted only by
// hidden nav links/buttons. User Management is the first page that needs a
// real one, since it's the one place unauthorized access is meaningfully
// dangerous (granting/revoking system access), not just visual clutter.
export default function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { isSuperAdmin } = useAuth();
  if (!isSuperAdmin) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
