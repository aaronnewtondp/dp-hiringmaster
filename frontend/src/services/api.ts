import axios from 'axios';

/**
 * Local dev:  VITE_API_URL = http://localhost:4000/api  (set in docker-compose.yml)
 * Vercel:     VITE_API_URL = https://dp-hms-backend.vercel.app/api  (set in Vercel dashboard)
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api',
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('hms_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear auth and redirect to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('hms_token');
      localStorage.removeItem('hms_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;

// ─── Typed API helpers ────────────────────────────────────────────────────────
export const authApi = {
  login:           (email: string, password: string) => api.post('/auth/login', { email, password }),
  loginWithGoogle: (credential: string)              => api.post('/auth/google', { credential }),
  me:              ()                                => api.get('/auth/me'),
  logout:          ()                                => api.post('/auth/logout'),
};

export const rolesApi = {
  list:      (params?: Record<string, string>) => api.get('/roles', { params }),
  get:       (id: string)                      => api.get(`/roles/${id}`),
  create:    (data: Record<string, unknown>)   => api.post('/roles', data),
  update:    (id: string, data: Record<string, unknown>) => api.patch(`/roles/${id}`, data),
  editLog:   (id: string)                      => api.get(`/roles/${id}/edit-log`),
  pipeline:  (id: string)                      => api.get(`/roles/${id}/pipeline`),
};

export const candidatesApi = {
  list:     (params?: Record<string, string>)  => api.get('/candidates', { params }),
  get:      (id: string)                       => api.get(`/candidates/${id}`),
  create:   (data: Record<string, unknown>)    => api.post('/candidates', data),
  update:   (id: string, data: Record<string, unknown>) => api.patch(`/candidates/${id}`, data),
  activity: (id: string)                       => api.get(`/candidates/${id}/activity`),
  linkRole: (id: string, data: { role_id: string; source_channel?: string }) => api.post(`/candidates/${id}/applications`, data),
};

export const applicationsApi = {
  list:            (params?: Record<string, string>)  => api.get('/applications', { params }),
  get:             (id: string)                       => api.get(`/applications/${id}`),
  advanceStage:    (id: string, newStage: string, skipReason?: string) =>
    api.post(`/applications/${id}/stage`, { new_stage: newStage, skip_reason: skipReason }),
  updateStatus:    (id: string, data: Record<string, unknown>) => api.post(`/applications/${id}/status`, data),
  updateScreening: (id: string, status: string)       => api.post(`/applications/${id}/screening`, { new_screening_status: status }),
  updateNotes:     (id: string, data: Record<string, unknown>) => api.patch(`/applications/${id}/notes`, data),
  setFounderFlag:  (id: string, set: boolean, note?: string)   => api.post(`/applications/${id}/founder-flag`, { set, note }),
};

export const interviewsApi = {
  list:             (applicationId: string)                      => api.get('/interviews', { params: { application_id: applicationId } }),
  schedule:         (data: Record<string, unknown>)              => api.post('/interviews', data),
  feedback:         (id: string, data: Record<string, unknown>)  => api.patch(`/interviews/${id}/feedback`, data),
  sendAssignment:   (id: string, data: Record<string, unknown>)  => api.post(`/interviews/${id}/assignment-send`, data),
  submitAssignment: (id: string, link: string)                   => api.post(`/interviews/${id}/assignment-submit`, { submission_link: link }),
};

export const dashboardApi = {
  get:     () => api.get('/dashboard'),
  pending: () => api.get('/dashboard/pending'),
};

export const assignmentRepoApi = {
  list: () => api.get('/assignment-repo'),
};

export const agenciesApi = {
  list:   ()                                          => api.get('/agencies'),
  get:    (id: string)                                => api.get(`/agencies/${id}`),
  create: (data: Record<string, unknown>)             => api.post('/agencies', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/agencies/${id}`, data),
};
