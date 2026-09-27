import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { initScrollbarFade } from './utils/scrollbarFade.ts';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

initScrollbarFade();
// autoUpdate: a new deployed build takes over silently on the next load —
// no "update available" prompt UI, since this app shell has no meaningful
// offline value to preserve mid-session and a stuck-on-stale-bundle install
// is a worse failure mode than an unannounced refresh for an internal tool.
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-right" toastOptions={{ duration: 4000 }} />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>
);
