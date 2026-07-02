import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Droplets } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import toast from 'react-hot-toast';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: 'outline' | 'filled_blue' | 'filled_black';
              size?: 'large' | 'medium' | 'small';
              width?: number | string;
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
              logo_alignment?: 'left' | 'center';
            }
          ) => void;
        };
      };
    };
  }
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

export default function Login() {
  const { loginWithGoogle } = useAuth();
  const navigate      = useNavigate();
  const googleBtnRef  = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const loadAndInit = () => {
      if (!window.google?.accounts) return;

      window.google.accounts.id.initialize({
        client_id:             GOOGLE_CLIENT_ID,
        callback:              handleGoogleCredential,
        auto_select:           false,
        cancel_on_tap_outside: true,
      });

      if (googleBtnRef.current) {
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme:          'outline',
          size:           'large',
          width:          '100%',
          text:           'signin_with',
          logo_alignment: 'left',
        });
      }
    };

    if (!document.querySelector('script[src*="accounts.google.com/gsi"]')) {
      const script  = document.createElement('script');
      script.src    = 'https://accounts.google.com/gsi/client';
      script.async  = true;
      script.onload = loadAndInit;
      document.head.appendChild(script);
    } else {
      const interval = setInterval(() => {
        if (window.google?.accounts) { loadAndInit(); clearInterval(interval); }
      }, 100);
      return () => clearInterval(interval);
    }
  }, []);

  const handleGoogleCredential = async (response: { credential: string }) => {
    try {
      await loginWithGoogle(response.credential);
      navigate('/dashboard');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })
        ?.response?.data?.error ?? 'Sign-in failed. Try again.';
      toast.error(msg);
    }
  };

  return (
    <div className="min-h-screen bg-dp-800 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-xl bg-dp-600 flex items-center justify-center">
            <Droplets className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="text-white text-lg font-semibold">DigitalPaani</div>
            <div className="text-dp-300 text-sm">Hiring Management System</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">Sign in</h1>
          <p className="text-sm text-gray-400 mb-6">Use your @digitalpaani.com account</p>

          {/* Google Sign-In button */}
          <div ref={googleBtnRef} className="w-full min-h-[44px]" />

          {!GOOGLE_CLIENT_ID && (
            <p className="mt-4 text-xs text-red-400 text-center">
              VITE_GOOGLE_CLIENT_ID is not set. Check your .env file.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}