import { Routes, Route, Navigate } from 'react-router-dom';
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
import HMQueue from './pages/HMQueue.tsx';
import { Spinner } from './components/shared/Badges.tsx';

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
        <Route path="/dashboard"               element={<Dashboard />} />
        <Route path="/roles"                   element={<Roles />} />
        <Route path="/roles/new"               element={<NewRole />} />
        <Route path="/roles/:id"               element={<RoleDetail />} />
        <Route path="/candidates"              element={<Candidates />} />
        <Route path="/candidates/new"          element={<NewCandidate />} />
        <Route path="/candidates/:id"          element={<CandidateDetail />} />
        <Route path="/talent-pool"             element={<TalentPool />} />
        <Route path="/agencies"                element={<Agencies />} />
        <Route path="/agencies/:id"            element={<AgencyDetail />} />
        <Route path="/hm-queue"                element={<HMQueue />} />
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
