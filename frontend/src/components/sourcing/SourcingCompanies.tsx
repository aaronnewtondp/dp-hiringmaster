import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Upload } from 'lucide-react';
import { Spinner } from '../shared/Badges.tsx';
import { useAuth } from '../../contexts/AuthContext.tsx';
import { sourcingApi } from '../../services/api.ts';
import { CompanyDetail, CompanyRow } from '../../types/sourcing.ts';
import { apiError } from './SourcingModals.tsx';

const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

function CompanyForm({ initial, onSaved, onCancel }: { initial?: CompanyRow; onSaved: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: initial?.name ?? '', segment: initial?.segment ?? '', size: initial?.size ?? '', cities: (initial?.cities ?? []).join(', '), what: initial?.what_they_do ?? '',
    url: initial?.source_url ?? '', notes: initial?.notes ?? '', lists: (initial?.lists ?? []).join(', ') });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }));
  const split = (v: string) => v.split(',').map(x => x.trim()).filter(Boolean);
  const save = async () => {
    setSaving(true);
    const body = { name: f.name, segment: f.segment, size: f.size, cities: split(f.cities), what_they_do: f.what, source_url: f.url, notes: f.notes, lists: split(f.lists) };
    try { if (initial) await sourcingApi.editCompany(initial.id, body); else await sourcingApi.addCompany(body); toast.success(initial ? 'Company saved' : 'Company added'); onSaved(); }
    catch (err) { toast.error(apiError(err, 'Could not save the company')); }
    setSaving(false);
  };
  const field = (label: string, k: keyof typeof f, wide = false) => (
    <label className={`text-[11px] text-gray-500 ${wide ? 'sm:col-span-2' : ''}`}>{label}<input className="input text-sm w-full" value={f[k]} onChange={e => set(k, e.target.value)} /></label>
  );
  return (
    <div className="card p-4 space-y-2" data-testid="company-form">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{field('Company name', 'name', true)}{field('Segment', 'segment')}{field('Size', 'size')}{field('Cities (comma separated)', 'cities')}{field('Lists (comma separated)', 'lists')}{field('What they do', 'what', true)}{field('Source link', 'url', true)}{field('Notes (e.g. “don’t approach: client”)', 'notes', true)}</div>
      <div className="flex justify-end gap-2"><button type="button" className="btn-secondary text-xs py-1 px-3" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn-primary text-xs py-1 px-3" disabled={saving || !f.name.trim()} onClick={save}>{saving ? <Spinner size="sm" /> : 'Save'}</button></div>
    </div>
  );
}

function CompanyPage({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { user } = useAuth();
  const [c, setC] = useState<CompanyDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(async () => { try { setC((await sourcingApi.company(id)).data.company as CompanyDetail); setError(false); } catch { setError(true); } }, [id]);
  useEffect(() => { void load(); }, [load]);
  const canDelete = user?.persona === 'leadership' || user?.persona === 'super_admin';
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast.success(ok); await load(); onChanged(); } catch (err) { toast.error(apiError(err, 'Could not do that')); } };
  if (error) return <div className="card p-4 text-sm text-gray-500" role="alert">Couldn't load the company. <button type="button" className="text-dp-600 hover:underline" onClick={onClose}>Back</button></div>;
  if (!c) return <div className="card p-6 flex justify-center"><Spinner /></div>;
  if (editing) return <CompanyForm initial={c} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); onChanged(); }} />;
  return (
    <div className="card p-4 space-y-3" data-testid="company-page">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div><h3 className="text-base font-semibold text-gray-900">{c.name}{c.excluded && <span className="ml-2 text-xs font-normal text-red-600">Excluded: {c.excluded_reason}</span>}</h3>
          <p className="text-xs text-gray-500">{[c.segment, c.size].filter(Boolean).join(' · ')}{c.cities.length ? ` · ${c.cities.join(', ')}` : ''}</p></div>
        <div className="flex gap-2 text-xs">
          <button type="button" className="btn-secondary py-1 px-2.5" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="btn-secondary py-1 px-2.5" onClick={() => void act(() => sourcingApi.checkedCompany(c.id), 'Marked as checked')}>Still correct</button>
          {c.excluded
            ? <button type="button" className="btn-secondary py-1 px-2.5" onClick={() => void act(() => sourcingApi.excludeCompany(c.id, false), 'Company is back in the lists')}>Include again</button>
            : <button type="button" className="btn-secondary py-1 px-2.5" onClick={() => { const r = window.prompt('Why exclude it? (for example “client” or “partner”)'); if (r && r.trim().length >= 2) void act(() => sourcingApi.excludeCompany(c.id, true, r.trim()), 'Company excluded'); }}>Exclude…</button>}
          {canDelete && <button type="button" className="py-1 px-2.5 rounded-md border border-red-200 text-red-700 hover:bg-red-50" onClick={() => { if (window.confirm(`Delete ${c.name} from the directory? Its outreach history stays but is no longer linked.`)) void act(async () => { await sourcingApi.deleteCompany(c.id); onClose(); }, 'Company deleted'); }}>Delete</button>}
          <button type="button" className="text-gray-500 hover:underline" onClick={onClose}>Close</button>
        </div>
      </div>
      {c.what_they_do && <p className="text-sm text-gray-700">{c.what_they_do}</p>}
      {c.source_url && <p className="text-xs"><a href={c.source_url} target="_blank" rel="noreferrer noopener" className="text-dp-600 hover:underline">Source link</a></p>}
      {c.notes && <p className="text-xs text-gray-600 bg-gray-50 rounded-md px-2.5 py-1.5">{c.notes}</p>}
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><dt className="text-[11px] text-gray-400 uppercase">Lists</dt><dd>{c.lists.join(', ') || '—'}</dd></div>
        <div><dt className="text-[11px] text-gray-400 uppercase">Roles targeting it</dt><dd>{c.roles_targeting.join(', ') || '—'}</dd></div>
        <div><dt className="text-[11px] text-gray-400 uppercase">People contacted</dt><dd className="font-mono">{c.people_contacted} <span className="text-gray-400 font-sans">of {c.people_found} found</span></dd></div>
        <div><dt className="text-[11px] text-gray-400 uppercase">Candidates · hires</dt><dd className="font-mono">{c.candidates} · {c.hires}</dd></div>
      </dl>
      <p className="text-[11px] text-gray-400">Last contacted {dayOf(c.last_contacted)} · last checked {dayOf(c.last_checked_at)}{c.needs_recheck && <span className="text-amber-700"> · due for a quick re-check</span>}</p>
      {c.outreach_by_role.length > 0 && (
        <table className="w-full text-xs"><thead><tr className="text-left text-gray-400"><th className="font-medium py-1">Role</th><th className="font-medium py-1 text-right">Found</th><th className="font-medium py-1 text-right">Contacted</th><th className="font-medium py-1 text-right">Replied</th></tr></thead>
          <tbody className="divide-y divide-gray-50">{c.outreach_by_role.map(r => <tr key={r.role_id}><td className="py-1">{r.role_id}</td><td className="py-1 text-right font-mono">{r.people}</td><td className="py-1 text-right font-mono">{r.contacted}</td><td className="py-1 text-right font-mono">{r.replied}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

/** Screen 6 — the company directory: one shared list of target companies, used by every plan. */
export default function SourcingCompanies() {
  const [q, setQ] = useState(''); const [list, setList] = useState(''); const [contacted, setContacted] = useState(''); const [recheck, setRecheck] = useState(false); const [excluded, setExcluded] = useState(false);
  const [rows, setRows] = useState<CompanyRow[] | null>(null); const [total, setTotal] = useState(0); const [recheckCount, setRecheckCount] = useState(0);
  const [lists, setLists] = useState<Array<{ id: string; name: string; companies: number }>>([]);
  const [failed, setFailed] = useState(false); const [selected, setSelected] = useState<string | null>(null); const [adding, setAdding] = useState(false); const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (q.trim()) params.q = q.trim(); if (list) params.list = list; if (contacted) params.contacted = contacted; if (recheck) params.recheck = 'true'; if (excluded) params.excluded = 'true';
      const { data } = await sourcingApi.companies(params);
      setRows(data.companies as CompanyRow[]); setTotal(data.total); setRecheckCount(data.recheck_count); setFailed(false);
    } catch { setFailed(true); }
  }, [q, list, contacted, recheck, excluded]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { void sourcingApi.companyLists().then(r => setLists(r.data.lists ?? [])).catch(() => undefined); }, []);

  const importFile = async (f: File | undefined) => {
    if (!f) return; setBusy(true);
    try {
      const { data } = await sourcingApi.importCompanies(await f.text());
      toast.success(`${data.companies_new} added, ${data.companies_merged} merged into existing records${data.rejected_total ? `, ${data.rejected_total} rows skipped` : ''}`);
      await load(); void sourcingApi.companyLists().then(r => setLists(r.data.lists ?? []));
    } catch (err) { toast.error(apiError(err, 'Could not import the file')); }
    setBusy(false); if (file.current) file.current.value = '';
  };

  return (
    <div className="space-y-3" data-testid="sourcing-companies">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input text-sm w-56" placeholder="Search companies" aria-label="Search companies" value={q} onChange={e => setQ(e.target.value)} />
        <select className="input text-xs py-1" aria-label="List" value={list} onChange={e => setList(e.target.value)}><option value="">All lists</option>{lists.map(l => <option key={l.id} value={l.name}>{l.name} ({l.companies})</option>)}</select>
        <select className="input text-xs py-1" aria-label="Contacted" value={contacted} onChange={e => setContacted(e.target.value)}><option value="">Contacted or not</option><option value="yes">Contacted</option><option value="no">Not contacted</option></select>
        <label className="text-xs text-gray-600 inline-flex items-center gap-1"><input type="checkbox" checked={recheck} onChange={e => setRecheck(e.target.checked)} />Due a re-check{recheckCount > 0 && ` (${recheckCount})`}</label>
        <label className="text-xs text-gray-600 inline-flex items-center gap-1"><input type="checkbox" checked={excluded} onChange={e => setExcluded(e.target.checked)} />Excluded</label>
        <span className="flex-1" />
        <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" data-testid="company-file" onChange={e => void importFile(e.target.files?.[0])} />
        <button type="button" className="btn-secondary text-xs py-1 px-2.5 inline-flex items-center gap-1" disabled={busy} onClick={() => file.current?.click()} title="A CSV with the columns: company list, company, city / area, segment, size, what they do, already contacted, source url">{busy ? <Spinner size="sm" /> : <Upload className="w-3 h-3" aria-hidden="true" />}Import from CSV</button>
        <button type="button" className="btn-primary text-xs py-1 px-3" onClick={() => setAdding(true)}>Add company</button>
      </div>
      {adding && <CompanyForm onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); void load(); }} />}
      {selected && <CompanyPage id={selected} onClose={() => setSelected(null)} onChanged={() => void load()} />}
      {failed ? <div role="alert" className="card p-6 text-sm text-gray-500">Couldn't load the companies.</div> : rows === null ? <div className="card p-8 flex justify-center"><Spinner /></div> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-400"><th className="font-medium px-3 py-2">Company</th><th className="font-medium px-3 py-2">Segment</th><th className="font-medium px-3 py-2">Size</th><th className="font-medium px-3 py-2">Cities</th>
              <th className="font-medium px-3 py-2">Roles targeting it</th><th className="font-medium px-3 py-2 text-right">People contacted</th><th className="font-medium px-3 py-2 text-right">Candidates</th><th className="font-medium px-3 py-2">Last contacted</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No companies yet. Import the workbook's Company Lists tab as CSV, or add one.</td></tr>}
              {rows.map(c => (
                <tr key={c.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => setSelected(c.id)} data-testid={`company-row-${c.id}`}>
                  <td className="px-3 py-2 font-medium text-gray-900">{c.name}{c.needs_recheck && <span className="ml-1 text-[10px] text-amber-700" title="Not checked for six months">re-check</span>}</td>
                  <td className="px-3 py-2 text-gray-600">{c.segment ?? '—'}</td><td className="px-3 py-2 text-gray-600">{c.size ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-600 max-w-[14rem] truncate" title={c.cities.join(', ')}>{c.cities.join(', ') || '—'}</td>
                  <td className="px-3 py-2 text-gray-600">{c.roles_targeting.join(', ') || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.people_contacted}</td><td className="px-3 py-2 text-right font-mono">{c.candidates}</td><td className="px-3 py-2 text-gray-500">{dayOf(c.last_contacted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > rows.length && <p className="px-3 py-2 text-[11px] text-gray-400">Showing {rows.length} of {total}. Narrow the search to see the rest.</p>}
        </div>
      )}
      <p className="text-[11px] text-gray-400">One record per company, however many cities or lists it is in. “People contacted”, “Candidates” and “Last contacted” are filled in from outreach uploads and candidate records; nobody types them.</p>
    </div>
  );
}
