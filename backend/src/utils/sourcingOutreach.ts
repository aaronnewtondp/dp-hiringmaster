// Weekly outreach upload + company directory import — pure parsing, validation and merge rules (no I/O, unit-tested).
// Outbound stays in Google Sheets (Spec "Behind the scenes"): once a week the recruiter uploads the sheet as a CSV with fixed columns
//   role ID · company · job title · profile link · date contacted · status · next follow-up · outcome
// and the system reads it, counts UNIQUE people contacted versus follow-ups, rejects wrong role ids and merges duplicates.
// A person is one (role, profile link). The first message to a person for a role is a "new person contacted"; a later message is a follow-up.

/** Minimal RFC-4180 CSV reader: quotes, escaped quotes, CRLF/LF, a BOM. Rows of only blanks are dropped. Never throws. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  return rows;
}

export type OutreachField = 'role_id' | 'company' | 'job_title' | 'profile_link' | 'date_contacted' | 'status' | 'next_followup' | 'outcome';
const HEADER_ALIASES: Record<OutreachField, string[]> = {
  role_id: ['role id', 'role', 'roleid', 'role_id', 'req id'],
  company: ['company', 'company name', 'organisation', 'organization'],
  job_title: ['job title', 'title', 'designation', 'role title', 'job_title'],
  profile_link: ['profile link', 'profile', 'link', 'url', 'linkedin', 'profile url', 'profile_link', 'linkedin url'],
  date_contacted: ['date contacted', 'contacted on', 'contacted', 'date', 'date_contacted', 'last contacted'],
  status: ['status'],
  next_followup: ['next follow-up', 'next follow up', 'next followup', 'follow-up', 'follow up', 'next_followup', 'next follow-up date'],
  outcome: ['outcome', 'result', 'notes'],
};
const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/** Which column holds which field. Unknown columns are ignored; a missing REQUIRED column is reported. */
export function mapOutreachHeader(header: string[]): { index: Partial<Record<OutreachField, number>>; missing: OutreachField[] } {
  const index: Partial<Record<OutreachField, number>> = {};
  header.forEach((h, i) => {
    const k = headerKey(h);
    for (const f of Object.keys(HEADER_ALIASES) as OutreachField[]) {
      if (index[f] === undefined && HEADER_ALIASES[f].includes(k)) index[f] = i;
    }
  });
  const required: OutreachField[] = ['role_id', 'company', 'profile_link'];
  return { index, missing: required.filter(f => index[f] === undefined) };
}

/** ISO (2026-11-09), dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, "9 Nov 2026" / "Nov 9, 2026" → 'YYYY-MM-DD', else null. Indian day-first order. */
export function parseSheetDate(v: string | undefined | null): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  const valid = (y: number, m: number, d: number): string | null => {
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); return mi >= 0 ? valid(+m[3], mi + 1, +m[1]) : null; }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()); return mi >= 0 ? valid(+m[3], mi + 1, +m[2]) : null; }
  return null;
}

/** One person = one profile link. Lower-case host+path, no protocol / www / query / fragment / trailing slash. null when it is not a link. */
export function profileKey(link: string): string | null {
  const raw = link.trim();
  if (!raw || raw.length > 600) return null;
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withProto); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname.includes('.')) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '').toLowerCase();
  return `${host}${path}`;
}

/** http(s) only — what is stored and shown as a link. */
export function cleanProfileLink(link: string): string | null {
  const raw = link.trim();
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const u = new URL(withProto); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString().slice(0, 600) : null; } catch { return null; }
}

const COMPANY_NOISE = new Set(['ltd', 'limited', 'pvt', 'private', 'inc', 'incorporated', 'llp', 'corp', 'corporation', 'co', 'company', 'india', 'the', 'plc', 'gmbh']);
/** A company's identity: lower-case words without legal suffixes, punctuation and "(…)" asides — "VA Tech Wabag Ltd" = "va tech wabag". */
export function companyKey(name: string): string {
  const base = name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  const words = base.split(' ').filter(w => w && !COMPANY_NOISE.has(w));
  return words.join(' ').slice(0, 160);
}

/** A reply is read from the sheet's own status / outcome words. Documented in the spec; the recruiter's sheet stays the source of truth. */
export function isReplied(status: string | null, outcome: string | null): boolean {
  const t = `${status ?? ''} ${outcome ?? ''}`.toLowerCase();
  return /repl|respond|interested|not interested|declin|call|screen|qualif|shortlist|interview|applied|referred|busy|later/.test(t) && !/no (reply|response)|not replied|awaiting|pending|no answer/.test(t);
}
export function isQualifiedOutcome(status: string | null, outcome: string | null): boolean {
  const t = `${status ?? ''} ${outcome ?? ''}`.toLowerCase();
  return /qualif|shortlist|interview|applied|offer|joined/.test(t) && !/not qualif|unqualif|disqualif|not shortlist/.test(t);
}

export interface OutreachRow {
  role_id: string; company: string; job_title: string | null; profile_link: string; profile_key: string;
  date_contacted: string | null; status: string | null; next_followup: string | null; outcome: string | null;
}
export interface RejectedRow { row: number; reason: string }

export const MAX_UPLOAD_ROWS = 5000;

/** Validate every data row. `validRoleIds` = roles that can take outreach (anything else is rejected, never guessed). */
export function validateOutreachRows(
  table: string[][], validRoleIds: ReadonlySet<string>, today: string,
): { rows: OutreachRow[]; rejected: RejectedRow[]; fatal: string | null } {
  if (table.length === 0) return { rows: [], rejected: [], fatal: 'The file is empty' };
  const { index, missing } = mapOutreachHeader(table[0]);
  if (missing.length) return { rows: [], rejected: [], fatal: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.map(m => m.replace('_', ' ')).join(', ')}` };
  const data = table.slice(1);
  if (data.length > MAX_UPLOAD_ROWS) return { rows: [], rejected: [], fatal: `At most ${MAX_UPLOAD_ROWS} rows per upload` };
  const cell = (r: string[], f: OutreachField): string => (index[f] === undefined ? '' : (r[index[f]!] ?? '')).trim();
  const rows: OutreachRow[] = []; const rejected: RejectedRow[] = [];
  data.forEach((r, i) => {
    const n = i + 2;                                             // spreadsheet row number (header = 1)
    const role = cell(r, 'role_id').toUpperCase();
    if (!role) { rejected.push({ row: n, reason: 'No role ID' }); return; }
    if (!validRoleIds.has(role)) { rejected.push({ row: n, reason: `Unknown or closed role ID "${role.slice(0, 20)}"` }); return; }
    const company = cell(r, 'company').slice(0, 200);
    if (!company) { rejected.push({ row: n, reason: 'No company' }); return; }
    const link = cell(r, 'profile_link');
    const key = link ? profileKey(link) : null;
    const clean = link ? cleanProfileLink(link) : null;
    if (!key || !clean) { rejected.push({ row: n, reason: 'No valid profile link' }); return; }
    const dateRaw = cell(r, 'date_contacted');
    const date = parseSheetDate(dateRaw);
    if (dateRaw && !date) { rejected.push({ row: n, reason: 'Date contacted is not a date' }); return; }
    if (date && date > today) { rejected.push({ row: n, reason: 'Date contacted is in the future' }); return; }
    const nextRaw = cell(r, 'next_followup');
    const next = parseSheetDate(nextRaw);
    if (nextRaw && !next) { rejected.push({ row: n, reason: 'Next follow-up is not a date' }); return; }
    rows.push({
      role_id: role, company, job_title: cell(r, 'job_title').slice(0, 160) || null, profile_link: clean, profile_key: key,
      date_contacted: date, status: cell(r, 'status').slice(0, 80) || null, next_followup: next, outcome: cell(r, 'outcome').slice(0, 300) || null,
    });
  });
  return { rows, rejected, fatal: null };
}

export interface StoredPerson {
  first_contacted: string | null; last_contacted: string | null; followups: number;
  status: string | null; next_followup: string | null; outcome: string | null; job_title: string | null; company_text: string;
}
export interface MergeResult {
  person: StoredPerson & { replied: boolean; qualified: boolean };
  kind: 'new' | 'followup' | 'merged';
}

/**
 * Fold one uploaded row into what is stored for that (role, profile).
 *  - no stored person → a new person (contacted if the row has a date, else only "found")
 *  - row date later than the stored last contact → one more follow-up (a first message to a person that was only "found" is the first contact, not a follow-up)
 *  - same date or earlier → the same message again: merged (fields refreshed, nothing counted twice), so re-uploading a file is harmless
 * A second row for the same person INSIDE one file is folded in order, so the earliest date is the first contact.
 */
export function mergePerson(stored: StoredPerson | null, row: OutreachRow): MergeResult {
  const fields = (base: StoredPerson): StoredPerson => ({
    ...base,
    status: row.status ?? base.status, next_followup: row.next_followup ?? base.next_followup,
    outcome: row.outcome ?? base.outcome, job_title: row.job_title ?? base.job_title, company_text: row.company || base.company_text,
  });
  const finish = (p: StoredPerson, kind: MergeResult['kind']): MergeResult => ({
    person: { ...p, replied: isReplied(p.status, p.outcome), qualified: isQualifiedOutcome(p.status, p.outcome) }, kind,
  });
  if (!stored) {
    return finish({
      first_contacted: row.date_contacted, last_contacted: row.date_contacted, followups: 0, status: row.status, next_followup: row.next_followup,
      outcome: row.outcome, job_title: row.job_title, company_text: row.company,
    }, 'new');
  }
  if (!row.date_contacted) return finish(fields(stored), 'merged');
  if (!stored.last_contacted) return finish({ ...fields(stored), first_contacted: row.date_contacted, last_contacted: row.date_contacted }, 'new');
  if (row.date_contacted > stored.last_contacted) {
    return finish({ ...fields(stored), last_contacted: row.date_contacted, followups: stored.followups + 1 }, 'followup');
  }
  const first = stored.first_contacted && stored.first_contacted <= row.date_contacted ? stored.first_contacted : row.date_contacted;
  return finish({ ...fields(stored), first_contacted: first }, 'merged');
}

// ─── Company directory import ─────────────────────────────────────────────────────────────────────
export interface CompanyImportRow {
  list: string | null; company: string; city: string | null; segment: string | null; size: string | null;
  what_they_do: string | null; already_contacted: boolean; source_url: string | null;
}
const COMPANY_HEADERS: Record<keyof CompanyImportRow, string[]> = {
  list: ['company list', 'list'], company: ['company', 'company name', 'name'], city: ['city / area', 'city', 'cities', 'city/area', 'location'],
  segment: ['segment'], size: ['size'], what_they_do: ['what they do', 'about', 'description'],
  already_contacted: ['already contacted', 'contacted'], source_url: ['source url', 'source', 'url', 'link'],
};

export function parseCompanyRows(table: string[][]): { rows: CompanyImportRow[]; rejected: RejectedRow[]; fatal: string | null } {
  if (table.length === 0) return { rows: [], rejected: [], fatal: 'The file is empty' };
  const idx: Partial<Record<keyof CompanyImportRow, number>> = {};
  table[0].forEach((h, i) => {
    const k = headerKey(h);
    for (const f of Object.keys(COMPANY_HEADERS) as Array<keyof CompanyImportRow>) if (idx[f] === undefined && COMPANY_HEADERS[f].includes(k)) idx[f] = i;
  });
  if (idx.company === undefined) return { rows: [], rejected: [], fatal: 'Missing column: company' };
  const rows: CompanyImportRow[] = []; const rejected: RejectedRow[] = [];
  const get = (r: string[], f: keyof CompanyImportRow) => (idx[f] === undefined ? '' : (r[idx[f]!] ?? '')).trim();
  table.slice(1, MAX_UPLOAD_ROWS + 1).forEach((r, i) => {
    const company = get(r, 'company').slice(0, 200);
    if (!company || !companyKey(company)) { rejected.push({ row: i + 2, reason: 'No company name' }); return; }
    const url = get(r, 'source_url');
    rows.push({
      list: get(r, 'list').slice(0, 120) || null, company, city: get(r, 'city').slice(0, 200) || null,
      segment: get(r, 'segment').slice(0, 80) || null, size: get(r, 'size').slice(0, 40) || null,
      what_they_do: get(r, 'what_they_do').slice(0, 500) || null,
      already_contacted: /^(y|yes|true|1)$/i.test(get(r, 'already_contacted')),
      source_url: url && cleanProfileLink(url) ? cleanProfileLink(url) : null,
    });
  });
  return { rows, rejected, fatal: null };
}

/** Group import rows into ONE record per company (a firm in several lists or cities appears once) with the lists it belongs to. */
export interface MergedCompany {
  name: string; key: string; segment: string | null; size: string | null; cities: string[]; what_they_do: string | null;
  source_url: string | null; legacy_contacted: boolean; lists: string[];
}
export function mergeCompanyRows(rows: CompanyImportRow[]): MergedCompany[] {
  const by = new Map<string, MergedCompany>();
  for (const r of rows) {
    const key = companyKey(r.company);
    const cur = by.get(key) ?? {
      name: r.company, key, segment: null, size: null, cities: [], what_they_do: null, source_url: null, legacy_contacted: false, lists: [],
    };
    cur.segment = cur.segment ?? r.segment; cur.size = cur.size ?? r.size; cur.what_they_do = cur.what_they_do ?? r.what_they_do;
    cur.source_url = cur.source_url ?? r.source_url; cur.legacy_contacted = cur.legacy_contacted || r.already_contacted;
    if (r.city && !cur.cities.some(c => c.toLowerCase() === r.city!.toLowerCase())) cur.cities.push(r.city);
    if (r.list && !cur.lists.includes(r.list)) cur.lists.push(r.list);
    if (r.company.length > cur.name.length && !/\(/.test(cur.name)) cur.name = r.company;     // prefer the fuller spelling
    by.set(key, cur);
  }
  return [...by.values()];
}

/** Six months. Companies not checked for this long are flagged for a quick re-check (small firms change often). */
export const COMPANY_RECHECK_DAYS = 183;
export function needsRecheck(lastChecked: Date | string, now: Date = new Date()): boolean {
  const t = lastChecked instanceof Date ? lastChecked.getTime() : new Date(lastChecked).getTime();
  return Number.isFinite(t) && now.getTime() - t > COMPANY_RECHECK_DAYS * 86400000;
}
