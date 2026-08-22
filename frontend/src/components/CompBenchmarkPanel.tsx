import { useState } from 'react';
import { Calculator } from 'lucide-react';
import toast from 'react-hot-toast';
import { rolesApi } from '../services/api.ts';
import { Spinner } from './shared/Badges.tsx';

interface BenchmarkResult {
  source:        'internal_data' | 'ai_estimate';
  range_min:     number;
  range_max:     number;
  currency:      string;
  rationale:     string;
  benchmark_id?: string;
}

// Item #26 — HR/Admin only (rendered conditionally by the caller). Role-level,
// not tied to any one candidate/application — benchmarks the ROLE itself
// using its own JD requirements (yoe_required, must_have_skills, etc.),
// housed on Role Detail.
export default function CompBenchmarkPanel({ roleId }: { roleId: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BenchmarkResult | null>(null);

  const run = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await rolesApi.compBenchmark(roleId);
      setResult(res.data.benchmark);
    } catch {
      toast.error('Benchmarking failed — please try again');
    }
    setLoading(false);
  };

  return (
    <div className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
        <Calculator className="w-4 h-4 text-gray-400" /> Internal Compensation Benchmarking
      </h2>
      <button onClick={run} disabled={loading} className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5">
        {loading && <Spinner size="sm" />} Run benchmark
      </button>
      {result && (
        <div className="bg-dp-50 border border-dp-100 rounded-lg p-3">
          <div className="text-lg font-mono font-semibold text-dp-800">
            {result.range_min}–{result.range_max} {result.currency}
          </div>
          <div className="text-xs text-gray-500 mt-1">{result.rationale}</div>
          <div className="text-[10px] text-gray-400 mt-1.5 uppercase tracking-wide">
            {result.source === 'internal_data' ? 'Source: internal benchmark data' : 'Source: AI estimate — no internal data on file'}
          </div>
        </div>
      )}
    </div>
  );
}
