import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Upload } from 'lucide-react';
import { Spinner } from '../shared/Badges.tsx';
import InfoTooltip from '../shared/InfoTooltip.tsx';
import { useSourcingDetail } from '../../hooks/useSourcingDetail.ts';
import { sourcingApi } from '../../services/api.ts';
import { HealthColour, PlanDetail, PlanLine, TemplateSummary, UploadSummary } from '../../types/sourcing.ts';
import { apiError } from './SourcingModals.tsx';

export const COLOUR_CLASS: Record<HealthColour, string> = {
  green: 'border-green-300 bg-green-50 text-green-800', amber: 'border-amber-300 bg-amber-50 text-amber-800',
  red: 'border-red-300 bg-red-50 text-red-800', grey: 'border-gray-200 bg-gray-50 text-gray-600',
};
export const COLOUR_WORD: Record<HealthColour, string> = { green: 'On track', amber: 'Slipping', red: 'Behind', grey: 'Too few to judge' };

export function HealthBoxView({ title, info, colour, text }: { title: string; info: string; colour: HealthColour; text: string }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${COLOUR_CLASS[colour]}`} data-testid={`health-${title}`}>
      <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">{title}<InfoTooltip align="left" text={info} /></div>
      <div className="mt-0.5 text-sm font-semibold">{COLOUR_WORD[colour]}</div>
      <div className="mt-0.5 text-xs leading-snug">{text}</div>
    </div>
  );
}

const QUESTION_LABEL: Record<string, string> = {
  post_refreshed: 'Job post refreshed?', referral_push: 'Referral push sent this week?', agency_followup: 'Agency followed up?', outreach_uploaded: 'Outreach sheet uploaded?',
};
const STATUS_WORD: Record<string, string> = { live: 'Live', backup: 'Backup', not_used: 'Not used' };

/** Weekly check-in (about two minutes): yes/no for what the system cannot see. */
function CheckinBox({ planId, detail, onDone }: { planId: string; detail: PlanDetail; onDone: () => void }) {
  const c = detail.checkin!;
  const [answers, setAnswers] = useState<Record<string, string>>(c.answers);
  const [blocker, setBlocker] = useState(c.blocker_text ?? '');
  const [saving, setSaving] = useState(false);
  const set = (k: string, v: string) => setAnswers(a => ({ ...a, [k]: v }));
  const save = async () => {
    setSaving(true);
    try { await sourcingApi.checkin(planId, { week_start: c.week_of, answers, blocker_text: blocker.trim() || null }); toast.success('Check-in saved'); onDone(); }
    catch (err) { toast.error(apiError(err, 'Could not save the check-in')); }
    setSaving(false);
  };
  return (
    <div className="rounded-lg border border-gray-200 p-3" data-testid="checkin-box">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-medium text-gray-900">Weekly check-in <span className="text-xs font-normal text-gray-400">· week of {c.week_of}, due {c.due}</span></h4>
        {c.done && <span className="text-xs text-green-700">Done — you can still change it</span>}
      </div>
      {c.questions.length === 0 ? <p className="text-xs text-gray-400 mt-1">Nothing to ask for this plan yet — the system tracks the live channels itself.</p> : (
        <div className="mt-2 space-y-1.5">
          {c.questions.map(q => (
            <div key={q} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-700">{QUESTION_LABEL[q] ?? q}</span>
              <span role="radiogroup" aria-label={QUESTION_LABEL[q]} className="inline-flex rounded-md border border-gray-200 overflow-hidden text-xs">
                {(['yes', 'no'] as const).map(v => (
                  <button key={v} type="button" role="radio" aria-checked={answers[q] === v} onClick={() => set(q, v)}
                    className={`px-3 py-1 ${answers[q] === v ? (v === 'yes' ? 'bg-green-600 text-white' : 'bg-red-600 text-white') : 'bg-white text-gray-600 hover:bg-gray-50'}`}>{v === 'yes' ? 'Yes' : 'No'}</button>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
      <label className="block mt-2 text-xs text-gray-500">Anything blocking sourcing? <span className="text-gray-400">(optional)</span>
        <textarea className="input text-sm h-12 resize-none mt-0.5 w-full" value={blocker} maxLength={500} onChange={e => setBlocker(e.target.value)} />
      </label>
      <div className="mt-2 flex justify-end"><button type="button" className="btn-primary text-xs py-1 px-3" disabled={saving} onClick={save}>{saving ? <Spinner size="sm" /> : c.done ? 'Update check-in' : 'Save check-in'}</button></div>
    </div>
  );
}

/** Weekly outreach sheet: the recruiter keeps tracking people in Google Sheets and uploads it once a week as CSV. */
function OutreachBox({ detail, onDone }: { detail: PlanDetail; onDone: () => void }) {
  const o = detail.outreach;
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadSummary | null>(null);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setResult(null);
    try { const { data } = await sourcingApi.uploadOutreach(await f.text(), f.name); setResult(data as UploadSummary); toast.success('Outreach sheet read'); onDone(); }
    catch (err) { toast.error(apiError(err, 'Could not read the file')); }
    setBusy(false); if (file.current) file.current.value = '';
  };
  return (
    <div className="rounded-lg border border-gray-200 p-3" data-testid="outreach-box">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-medium text-gray-900 flex items-center gap-1">Outbound progress
          <InfoTooltip align="left" text="From the weekly outreach sheet (a CSV with: role ID, company, job title, profile link, date contacted, status, next follow-up, outcome). A person is one profile link per role: the first message makes them a new person contacted, later dates count as follow-ups, and uploading the same file again changes nothing. This is separate from the form-based channel numbers above." /></h4>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          {o.last_upload ? <span>Last upload {o.last_upload}</span> : <span>No upload yet</span>}
          <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" data-testid="outreach-file" onChange={e => void pick(e.target.files?.[0])} />
          <button type="button" className="btn-secondary text-xs py-1 px-2.5 inline-flex items-center gap-1" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? <Spinner size="sm" /> : <Upload className="w-3 h-3" aria-hidden="true" />}Upload sheet</button>
        </div>
      </div>
      <p className="mt-1.5 text-sm text-gray-700" data-testid="outreach-summary">
        {o.companies_listed > 0 ? <>{o.companies_listed} companies in the list · {o.companies_worked} worked so far{o.worked_share !== null ? ` (${Math.round(o.worked_share * 100)}%)` : ''} · </> : null}
        {o.people_found} people found · {o.people_contacted} contacted · {o.followups} follow-ups · {o.replied} replied
      </p>
      {o.by_title.length > 0 && (
        <table className="mt-2 w-full text-xs">
          <thead><tr className="text-left text-gray-400"><th className="font-medium py-1">Job title</th><th className="font-medium py-1 text-right">Found</th><th className="font-medium py-1 text-right">Contacted</th><th className="font-medium py-1 text-right">Replied</th></tr></thead>
          <tbody className="divide-y divide-gray-50">{o.by_title.map(t => <tr key={t.job_title}><td className="py-1 text-gray-700">{t.job_title}</td><td className="py-1 text-right font-mono">{t.found}</td><td className="py-1 text-right font-mono">{t.contacted}</td><td className="py-1 text-right font-mono">{t.replied}</td></tr>)}</tbody>
        </table>
      )}
      {result && (
        <div role="status" className="mt-2 rounded-md bg-gray-50 border border-gray-200 px-2.5 py-2 text-xs text-gray-700" data-testid="upload-result">
          {result.people_new} new {result.people_new === 1 ? 'person' : 'people'}, {result.followups} follow-up{result.followups === 1 ? '' : 's'}, {result.merged} already known.
          {result.unlisted_companies > 0 && <> {result.unlisted_companies} row{result.unlisted_companies === 1 ? '' : 's'} named a company that is not in the directory.</>}
          {result.rejected_total > 0 && (
            <details className="mt-1"><summary className="cursor-pointer text-amber-700">{result.rejected_total} row{result.rejected_total === 1 ? '' : 's'} not used</summary>
              <ul className="list-disc pl-4 mt-1">{result.rejected.slice(0, 10).map(r => <li key={r.row}>Row {r.row}: {r.reason}</li>)}</ul></details>
          )}
        </div>
      )}
    </div>
  );
}

const BLANK_LINE: PlanLine = { workbook_channel: '', platform: null, status: 'live', owner_label: 'Recruiter', tracked_as: null, weekly_work: null, work_unit: null, expected_applicants: null, expected_qualified: null, start_condition: null, first_task: null, repeats: null, reason: null };

/** The plan's lines as the recruiter reviews them: channel, weekly work, owner label, status — editable on a draft or running plan. */
function PlanLines({ planId, detail, canEdit, onDone }: { planId: string; detail: PlanDetail; canEdit: boolean; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<PlanLine[]>(detail.rows);
  const [titles, setTitles] = useState(detail.job_titles.join('\n'));
  const [why, setWhy] = useState('');
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const patch = (i: number, p: Partial<PlanLine>) => setRows(r => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const missing = rows.some(r => !r.workbook_channel.trim() || (r.status === 'not_used' && !(r.reason ?? '').trim()));
  const save = async () => {
    setSaving(true);
    try {
      await sourcingApi.saveDetail(planId, { rows, job_titles: titles.split('\n').map(t => t.trim()).filter(Boolean), reason: why.trim() || undefined });
      toast.success('Plan details saved'); setEditing(false); onDone();
    } catch (err) { toast.error(apiError(err, 'Could not save')); }
    setSaving(false);
  };
  const loadTemplates = async () => { if (!templates) { try { setTemplates(((await sourcingApi.templates()).data.templates ?? []) as TemplateSummary[]); } catch { toast.error('Could not load templates'); } } };
  const apply = async (key: string) => {
    if (!key) return;
    try { await sourcingApi.applyTemplate(planId, key); toast.success('Template applied'); setEditing(false); onDone(); } catch (err) { toast.error(apiError(err, 'Could not apply the template')); }
  };
  const channelsOf = (r: PlanLine) => (r.mapped_channels ?? []).join(' + ');
  return (
    <div className="rounded-lg border border-gray-200 p-3" data-testid="plan-lines">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h4 className="text-sm font-medium text-gray-900">The plan{detail.template && <span className="text-xs font-normal text-gray-400"> · from the “{detail.template.name}” template</span>}</h4>
        <div className="flex items-center gap-2">
          {canEdit && detail.plan_status === 'draft' && (
            <select className="input text-xs py-1" aria-label="Use a different template" value="" onFocus={() => void loadTemplates()} onChange={e => void apply(e.target.value)}>
              <option value="">{detail.template ? 'Switch template…' : 'Pick a template…'}</option>
              {(templates ?? []).filter(t => t.is_active).map(t => <option key={t.key} value={t.key}>{t.name}</option>)}
            </select>
          )}
          {canEdit && !editing && <button type="button" className="btn-secondary text-xs py-1 px-2.5" onClick={() => { setRows(detail.rows); setTitles(detail.job_titles.join('\n')); setEditing(true); }}>Edit</button>}
        </div>
      </div>

      {!editing ? (
        <>
          {detail.job_titles.length > 0 && <p className="mt-1.5 text-xs text-gray-600"><span className="text-gray-400">Job titles to target:</span> {detail.job_titles.join(' · ')}</p>}
          {detail.company_lists.length > 0 && <p className="mt-0.5 text-xs text-gray-600"><span className="text-gray-400">Company lists:</span> {detail.company_lists.map(l => `${l.name} (${l.companies})`).join(' · ')}</p>}
          {detail.rows.length === 0 ? <p className="mt-2 text-xs text-gray-400">No lines yet{canEdit ? ' — pick a template or press Edit to add the channels and weekly work.' : '.'}</p> : (
            <table className="mt-2 w-full text-xs">
              <thead><tr className="text-left text-gray-400"><th className="font-medium py-1">Channel</th><th className="font-medium py-1">Weekly work</th><th className="font-medium py-1">Owner</th><th className="font-medium py-1">Status</th></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {detail.rows.map((r, i) => (
                  <tr key={r.id ?? i} className={r.status === 'not_used' ? 'text-gray-400' : ''}>
                    <td className="py-1 pr-2"><span className="text-gray-800">{r.workbook_channel}</span>{r.platform && <span className="text-gray-400"> · {r.platform}</span>}
                      {channelsOf(r) ? <span className="ml-1 text-[10px] rounded bg-gray-100 text-gray-500 px-1">{channelsOf(r)}</span> : <span className="ml-1 text-[10px] rounded bg-gray-50 text-gray-400 px-1" title="A supporting activity: it is not measured automatically">not tracked automatically</span>}</td>
                    <td className="py-1 pr-2">{r.status === 'not_used' ? <span>{r.reason}</span> : r.weekly_work ? `${r.weekly_work} ${r.work_unit ?? ''}` : (r.work_unit ?? r.start_condition ?? '—')}</td>
                    <td className="py-1 pr-2">{r.owner_label ?? '—'}</td>
                    <td className="py-1"><span className={r.status === 'live' ? 'text-green-700' : r.status === 'backup' ? 'text-amber-700' : ''}>{STATUS_WORD[r.status]}</span>{r.status === 'backup' && r.start_condition && <span className="text-gray-400"> · {r.start_condition}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <div className="mt-2 space-y-2">
          <label className="block text-xs text-gray-500">Job titles to target (one per line)
            <textarea className="input text-sm h-20 w-full mt-0.5" value={titles} onChange={e => setTitles(e.target.value)} /></label>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 sm:grid-cols-6 gap-1.5 items-end border-b border-gray-100 pb-2">
              <label className="text-[11px] text-gray-500 sm:col-span-2">Channel<input className="input text-xs w-full" value={r.workbook_channel} onChange={e => patch(i, { workbook_channel: e.target.value })} /></label>
              <label className="text-[11px] text-gray-500">Status
                <select className="input text-xs w-full" value={r.status} onChange={e => patch(i, { status: e.target.value as PlanLine['status'] })}><option value="live">Live</option><option value="backup">Backup</option><option value="not_used">Not used</option></select></label>
              <label className="text-[11px] text-gray-500">Owner<input className="input text-xs w-full" value={r.owner_label ?? ''} onChange={e => patch(i, { owner_label: e.target.value || null })} /></label>
              <label className="text-[11px] text-gray-500">Weekly work<input type="number" min={0} className="input text-xs w-full" value={r.weekly_work ?? ''} onChange={e => patch(i, { weekly_work: e.target.value === '' ? null : Number(e.target.value) })} /></label>
              <button type="button" className="text-xs text-red-600 hover:underline pb-1.5" onClick={() => setRows(x => x.filter((_, j) => j !== i))}>Remove</button>
              {r.status === 'not_used' && <label className="text-[11px] text-gray-500 col-span-2 sm:col-span-6">Why is it not used?<input className="input text-xs w-full" value={r.reason ?? ''} onChange={e => patch(i, { reason: e.target.value })} /></label>}
            </div>
          ))}
          <button type="button" className="text-xs text-dp-600 hover:underline" onClick={() => setRows(r => [...r, { ...BLANK_LINE }])}>+ Add a line</button>
          <label className="block text-xs text-gray-500">Why are you changing it? <span className="text-gray-400">(saved in the plan's history)</span>
            <input className="input text-sm w-full mt-0.5" value={why} maxLength={300} onChange={e => setWhy(e.target.value)} /></label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary text-xs py-1 px-3" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn-primary text-xs py-1 px-3" disabled={saving || missing} title={missing ? 'Every line needs a channel name; a line that is not used needs a reason' : undefined} onClick={save}>{saving ? <Spinner size="sm" /> : 'Save'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Plan detailing on the role's plan (HR-tier): the three sourcing health boxes, results by channel, the pre-filled plan lines, the outbound
 * progress with its weekly upload, and the weekly check-in. All additive — the channels, weekly trackers and form attribution below it are unchanged.
 */
export default function SourcingDetailPanel({ roleId, canEdit }: { roleId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useSourcingDetail(roleId, true);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['sourcing-detail', roleId] }); void qc.invalidateQueries({ queryKey: ['sourcing-plan', roleId] }); void qc.invalidateQueries({ queryKey: ['sourcing-reminders'] }); };
  if (isLoading) return <div className="py-2 flex justify-center"><Spinner size="sm" /></div>;
  const d = data && data.enabled ? data.detail : null;
  if (!d) return null;
  const h = d.health;
  const active = d.plan_status === 'active';
  return (
    <div className="space-y-3" data-testid="detail-panel">
      {active && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <HealthBoxView title="Enough candidates?" colour={h.enough.colour} text={h.enough.text} info="Qualified candidates in the last 7 days against this role's target. Green: at or above target · amber: 50–99% · red: under 50%. It always shows how many candidates still await screening, so a screening backlog is not mistaken for a sourcing problem." />
            <HealthBoxView title="Right candidates?" colour={h.right.colour} text={h.right.text} info="Of the candidates who applied since the plan went live, the share who qualify (shortlisted by a person, or scored above 60). Green: 20% or more · amber: 15–20% · red: under 15%. Judged only once there are 20 or more." />
            <HealthBoxView title="Plan being worked?" colour={h.worked.colour} text={h.worked.text} info="Weekly work done against the plan: the outreach count from the uploaded sheet, and the yes/no answers in the weekly check-in. Green: all done · amber: 70–99% · red: under 70% or any answer of No." />
          </div>
          {d.untagged_warning && (
            <p role="status" className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2" data-testid="untagged-warning">
              {h.source.untagged} of {h.source.total} candidates have no source ({Math.round(h.source.share * 100)}%), so the channel numbers cannot be trusted yet.
            </p>
          )}
          {d.channel_results.length > 0 && (
            <table className="w-full text-xs" data-testid="channel-results">
              <thead><tr className="text-left text-gray-400"><th className="font-medium py-1">Channel</th><th className="font-medium py-1 text-right">Candidates</th><th className="font-medium py-1 text-right">Qualified</th><th className="font-medium py-1 text-right">Last activity</th></tr></thead>
              <tbody className="divide-y divide-gray-50">
                {d.channel_results.map(c => (
                  <tr key={c.channel}><td className="py-1 text-gray-700">{c.channel}</td><td className="py-1 text-right font-mono">{c.candidates}</td>
                    <td className="py-1 text-right font-mono">{c.too_few ? <span className="text-gray-400 font-sans">too few to judge</span> : `${c.qualified} (${Math.round((c.share ?? 0) * 100)}%)`}</td>
                    <td className="py-1 text-right text-gray-500">{c.last_activity ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      <PlanLines key={`${d.plan_status}-${d.rows.length}-${d.template?.key ?? ''}`} planId={d.plan_id} detail={d} canEdit={canEdit} onDone={refresh} />
      {active && canEdit && <CheckinBox key={d.checkin?.week_of} planId={d.plan_id} detail={d} onDone={refresh} />}
      {active && d.rows.some(r => r.status === 'live' && (r.mapped_channels ?? []).includes('Direct Outreach')) && <OutreachBox detail={d} onDone={refresh} />}
    </div>
  );
}
