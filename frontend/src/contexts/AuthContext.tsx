import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { AuthUser, Persona } from '../types/index.ts';
import { authApi } from '../services/api.ts';

interface AuthContextType {
  user:             AuthUser | null;
  token:            string | null;
  loading:          boolean;
  login:            (email: string, password: string) => Promise<void>;
  loginWithGoogle:  (credential: string) => Promise<void>;
  logout:           () => void;
  is:               (persona: Persona) => boolean;
  canHR:            boolean;
  canLead:          boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null);
  const [token,   setToken]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('hms_token');
    const storedUser  = localStorage.getItem('hms_user');
    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
    }
    setLoading(false);
  }, []);

  // ── shared session setup ───────────────────────────────────────────────────
  function applySession(t: string, u: AuthUser) {
    setToken(t);
    setUser(u);
    localStorage.setItem('hms_token', t);
    localStorage.setItem('hms_user', JSON.stringify(u));
  }

  // ── email + password ───────────────────────────────────────────────────────
  const login = async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    applySession(res.data.token, res.data.user);
  };

  // ── Google ID token ────────────────────────────────────────────────────────
  const loginWithGoogle = async (credential: string) => {
    const res = await authApi.loginWithGoogle(credential);
    applySession(res.data.token, res.data.user);
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('hms_token');
    localStorage.removeItem('hms_user');
  };

  const is      = (p: Persona) => user?.persona === p;
  const canHR   = user?.persona === 'hr_recruiter' || user?.persona === 'leadership';
  const canLead = user?.persona === 'leadership';

  return (
    <AuthContext.Provider value={{ user, token, loading, login, loginWithGoogle, logout, is, canHR, canLead }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
