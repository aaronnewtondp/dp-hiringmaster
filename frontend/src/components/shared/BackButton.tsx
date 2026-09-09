import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
  fallback: string;
  label: string;
  className?: string;
}

// Real browser-history back navigation, not a fixed listing-page link — a
// detail page reached from Dashboard/My Tasks/Talent Pool/etc. should return
// to wherever the user actually came from, not always the same hardcoded
// route. `location.key === 'default'` is react-router's own signal that this
// page was entered directly (URL/bookmark/refresh) with no in-app history to
// go back to — only then does `fallback` apply.
export default function BackButton({ fallback, label, className = 'mb-3' }: BackButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(fallback);
  };

  return (
    <button
      onClick={goBack}
      className={`inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 ${className}`}
    >
      <ArrowLeft className="w-4 h-4" /> {label}
    </button>
  );
}
