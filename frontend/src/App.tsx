import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import Layout from './components/layout/Layout.tsx';
import Login from './pages/Login.tsx';
import Dashboard from './pages/Dashboard.tsx';
import Roles from './pages/Roles.tsx';
import RoleDetail from './pages/RoleDetail.tsx';
import NewRole from './pages/NewRole.tsx';
import Candidates from './pages/Candidates.tsx';
import CandidateDetail from './pages/CandidateDetail.tsx';
import NewCandidate from './pages/NewCandidate.tsx';
import TalentPool from './pages/TalentPool.tsx';
import Agencies from './pages/Agencies.tsx';
import AgencyDetail from './pages/AgencyDetail.tsx';
import MyTasks from './pages/MyTasks.tsx';
import UserManagement from './pages/UserManagement.tsx';
import Help from './pages/Help.tsx';
import Sourcing from './pages/Sourcing.tsx';
import RequireSuperAdmin from './components/shared/RequireSuperAdmin.tsx';
import { Spinner } from './components/shared/Badges.tsx';

/**
 * The Sourcing plans used to be the last section of the Dashboard. Links made then (a role page chip in a tab that was already open, a bookmark,
 * a message) point at `/dashboard?sourcing_role=…#sourcing-workspace` — send them to the Sourcing page instead of leaving them on the Dashboard.
 */
export function DashboardRoute() {
  const { search, hash } = useLocation();
  const role = new URLSearchParams(search).get('sourcing_role');
  if (role || hash === '#sourcing-workspace') return <Navigate to={role ? `/sourcing?sourcing_role=${encodeURIComponent(role)}` : '/sourcing'} replace />;
  return <Dashboard />;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/"                        element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"               element={<DashboardRoute />} />
        <Route path="/sourcing"                element={<Sourcing />} />
        <Route path="/roles"                   element={<Roles />} />
        <Route path="/roles/new"               element={<NewRole />} />
        <Route path="/roles/:id"               element={<RoleDetail />} />
        <Route path="/candidates"              element={<Candidates />} />
        <Route path="/candidates/new"          element={<NewCandidate />} />
        <Route path="/candidates/:id"          element={<CandidateDetail />} />
        <Route path="/talent-pool"             element={<TalentPool />} />
        <Route path="/agencies"                element={<Agencies />} />
        <Route path="/agencies/:id"            element={<AgencyDetail />} />
        <Route path="/my-tasks"                element={<MyTasks />} />
        <Route path="/users"                   element={<RequireSuperAdmin><UserManagement /></RequireSuperAdmin>} />
        <Route path="/help"                    element={<Help />} />
        <Route path="*"                        element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
