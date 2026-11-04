import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// The sign-in page. Login.tsx reads VITE_GOOGLE_CLIENT_ID once, when the module loads, so every test sets the variable first,
// resets the module registry and imports the page afresh (a developer's own .env would otherwise decide the outcome). Google's
// script is never really loaded: jsdom does not fetch scripts, and the tests play Google's part by setting window.google and
// firing the script's onload themselves. The spies are hoisted so the mock factories hand the SAME spies to every fresh import.
const h = vi.hoisted(() => ({ loginWithGoogle: vi.fn(), toastError: vi.fn() }));
vi.mock('../contexts/AuthContext.tsx', () => ({ useAuth: () => ({ loginWithGoogle: h.loginWithGoogle }) }));
vi.mock('react-hot-toast', () => ({ default: Object.assign(vi.fn(), { error: h.toastError, success: vi.fn() }) }));

const GSI = 'https://accounts.google.com/gsi/client';
const gsiScripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src*="accounts.google.com/gsi/client"]'));

async function loadLogin(clientId: string) {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  vi.resetModules();
  return (await import('./Login.tsx')).default;
}
function renderLogin(Login: () => JSX.Element) {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<div data-testid="dashboard" />} />
      </Routes>
    </MemoryRouter>,
  );
}

// What Google's script puts on the window, as far as the page uses it.
const initialize = vi.fn();
const renderButton = vi.fn();
const installGoogle = () => { window.google = { accounts: { id: { initialize, renderButton } } }; };
const firstConfig = () => initialize.mock.calls[0][0] as { client_id: string; callback: (r: { credential: string }) => Promise<void>; auto_select: boolean; cancel_on_tap_outside: boolean };

beforeEach(() => {
  h.loginWithGoogle.mockReset(); h.toastError.mockReset(); initialize.mockReset(); renderButton.mockReset();
  h.loginWithGoogle.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  gsiScripts().forEach(s => s.remove());
  delete window.google;
});

describe('Login — without a Google client id', () => {
  it('says so in red, loads no Google script and never starts Google sign-in, even if Google is already on the page', async () => {
    const Login = await loadLogin('');
    installGoogle();
    renderLogin(Login);
    expect(screen.getByText(/VITE_GOOGLE_CLIENT_ID is not set/)).toBeInTheDocument();
    expect(gsiScripts()).toHaveLength(0);
    expect(initialize).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('Login — with a Google client id', () => {
  it('shows no warning and injects Google\'s script, once', async () => {
    const Login = await loadLogin('test-client-id.example');
    renderLogin(Login);
    expect(screen.queryByText(/VITE_GOOGLE_CLIENT_ID/)).toBeNull();
    const scripts = gsiScripts();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].src).toBe(GSI);
    expect(scripts[0].async).toBe(true);
    expect(initialize).not.toHaveBeenCalled();               // not before the script has loaded
  });

  it('once the script has loaded it initialises Google sign-in for that client and draws the button in the page', async () => {
    const Login = await loadLogin('test-client-id.example');
    const { container } = renderLogin(Login);
    installGoogle();
    gsiScripts()[0].onload?.(new Event('load'));
    expect(initialize).toHaveBeenCalledTimes(1);
    const config = firstConfig();
    expect(config.client_id).toBe('test-client-id.example');
    expect(config.auto_select).toBe(false);
    expect(config.cancel_on_tap_outside).toBe(true);
    expect(typeof config.callback).toBe('function');
    expect(renderButton).toHaveBeenCalledTimes(1);
    const [target, options] = renderButton.mock.calls[0];
    expect(container.contains(target)).toBe(true);           // drawn inside the page, not somewhere else
    expect(options).toEqual({ theme: 'outline', size: 'large', text: 'signin_with', logo_alignment: 'left' });
  });

  it('a script that "loads" without Google being there does nothing and does not break the page', async () => {
    const Login = await loadLogin('test-client-id.example');
    renderLogin(Login);
    expect(() => gsiScripts()[0].onload?.(new Event('load'))).not.toThrow();
    expect(initialize).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  it('coming back to the page with the script already there does not add a second one', async () => {
    const Login = await loadLogin('test-client-id.example');
    renderLogin(Login).unmount();
    expect(gsiScripts()).toHaveLength(1);
    renderLogin(Login);
    expect(gsiScripts()).toHaveLength(1);
  });
});

describe('Login — the script is already on the page', () => {
  // the first visit left the script in the head, so this visit waits for Google to be ready, checking every 100 ms
  const withScriptPresent = async () => {
    const Login = await loadLogin('test-client-id.example');
    const script = document.createElement('script');
    script.src = GSI;
    document.head.appendChild(script);
    vi.useFakeTimers();
    return Login;
  };

  it('waits for Google to be ready, polling every 100 ms, then initialises once and stops polling', async () => {
    const Login = await withScriptPresent();
    renderLogin(Login);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(initialize).not.toHaveBeenCalled();                  // Google is still not there
    expect(gsiScripts()).toHaveLength(1);                       // and no second script was added

    installGoogle();
    act(() => { vi.advanceTimersByTime(99); });
    expect(initialize).not.toHaveBeenCalled();                  // the next look is at the 100 ms mark
    act(() => { vi.advanceTimersByTime(1); });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(firstConfig().client_id).toBe('test-client-id.example');
    expect(renderButton).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(5000); });
    expect(initialize).toHaveBeenCalledTimes(1);                // the polling stopped
    expect(renderButton).toHaveBeenCalledTimes(1);
  });

  it('leaving the page stops the polling: Google turning up afterwards starts nothing', async () => {
    const Login = await withScriptPresent();
    const view = renderLogin(Login);
    act(() => { vi.advanceTimersByTime(300); });
    view.unmount();
    installGoogle();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(initialize).not.toHaveBeenCalled();
    expect(renderButton).not.toHaveBeenCalled();
  });

  it('Google already being ready when the page opens is picked up by the first look', async () => {
    const Login = await withScriptPresent();
    installGoogle();
    renderLogin(Login);
    expect(initialize).not.toHaveBeenCalled();                  // not synchronously: the first look is after 100 ms
    act(() => { vi.advanceTimersByTime(100); });
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});

describe('Login — after Google hands back a credential', () => {
  const signInAttempt = async (credential = 'credential-abc') => {
    const Login = await loadLogin('test-client-id.example');
    renderLogin(Login);
    installGoogle();
    gsiScripts()[0].onload?.(new Event('load'));
    const { callback } = firstConfig();
    return async (c = credential) => { await act(async () => { await callback({ credential: c }); }); };
  };

  it('signs in with that credential and goes to the dashboard', async () => {
    const attempt = await signInAttempt();
    await attempt('credential-xyz');
    expect(h.loginWithGoogle).toHaveBeenCalledTimes(1);
    expect(h.loginWithGoogle).toHaveBeenCalledWith('credential-xyz');
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('a refusal shows the server\'s own message and stays on the sign-in page', async () => {
    h.loginWithGoogle.mockImplementation(async () => {
      throw Object.assign(new Error('Forbidden'), { response: { data: { error: 'Only @digitalpaani.com accounts can sign in' } } });
    });
    const attempt = await signInAttempt();
    await attempt();
    expect(h.toastError).toHaveBeenCalledWith('Only @digitalpaani.com accounts can sign in');
    expect(screen.queryByTestId('dashboard')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });

  it('a failure with no message from the server says "Sign-in failed. Try again."', async () => {
    h.loginWithGoogle.mockImplementation(async () => { throw new Error('Network Error'); });
    const attempt = await signInAttempt();
    await attempt();
    expect(h.toastError).toHaveBeenCalledWith('Sign-in failed. Try again.');
    expect(screen.queryByTestId('dashboard')).toBeNull();
  });

  it('can be tried again after a failure', async () => {
    h.loginWithGoogle.mockImplementationOnce(async () => { throw new Error('Network Error'); });
    const attempt = await signInAttempt();
    await attempt('first');
    expect(screen.queryByTestId('dashboard')).toBeNull();
    await attempt('second');
    expect(h.loginWithGoogle).toHaveBeenLastCalledWith('second');
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });
});
