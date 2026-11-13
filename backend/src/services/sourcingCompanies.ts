// The company directory (Spec Screen 6): ONE shared list of target companies, used by every plan (a plan picks companies from it; it never keeps
// its own copy). One record per company however many cities or lists it is in. "People contacted", "Candidates" and "Last contacted" are
// computed here from outreach uploads and candidate records — nobody types them.
import { query, queryOne, transaction } from '../db/index.js';
import { JwtPayload } from '../types/index.js';
import { cleanProfileLink, companyKey, CompanyImportRow, mergeCompanyRows, needsRecheck, parseCompanyRows, parseCsv, RejectedRow } from '../utils/sourcingOutreach.js';
import { SourcingError } from './sourcingPlans.js';

export interface CompanyRow {
  id: string; name: string; segment: string | null; size: string | null; cities: string[]; what_they_do: string | null; source_url: string | null; notes: string | null;
  excluded: boolean; excluded_reason: string | null; last_checked_at: string; needs_recheck: boolean; legacy_contacted: boolean;
  lists: string[]; roles_targeting: string[]; people_contacted: number; people_found: number; candidates: number; last_contacted: string | null;
}

export interface CompanyFilters { q?: string; list?: string; segment?: string; size?: string; city?: string; contacted?: 'yes' | 'no'; role?: string; excluded?: boolean; recheck?: boolean; limit?: number; offset?: number }

/** Candidates per company key, from the candidate table's free-text current company, normalised the same way as the directory's names. */
async function candidateCounts(): Promise<{ all: Map<string, number>; joined: Map<string, number> }> {
  const rows = await query<{ c: string; n: string; joined: string }>(
    `SELECT lower(trim(current_company)) AS c, count(DISTINCT cand.id)::text AS n,
            count(DISTINCT cand.id) FILTER (WHERE EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = cand.id AND a.stage = 'Joined'))::text AS joined
       FROM candidates cand WHERE current_company IS NOT NULL AND trim(current_company) <> '' GROUP BY 1`);
  const all = new Map<string, number>(); const joined = new Map<string, number>();
  for (const r of rows) {
    const k = companyKey(r.c); if (!k) continue;
    all.set(k, (all.get(k) ?? 0) + Number(r.n)); joined.set(k, (joined.get(k) ?? 0) + Number(r.joined));
  }
  return { all, joined };
}

const SELECT_BASE = `
  SELECT c.id::text AS id, c.name, c.name_key, c.segment, c.size, c.cities, c.what_they_do, c.source_url, c.notes, c.excluded, c.excluded_reason, c.legacy_contacted,
         c.last_checked_at,
         COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM sourcing_company_list_members m JOIN sourcing_company_lists l ON l.id = m.list_id WHERE m.company_id = c.id), '{}') AS lists,
         COALESCE((SELECT array_agg(DISTINCT p.role_id ORDER BY p.role_id) FROM sourcing_plan_details d JOIN sourcing_plans p ON p.id = d.plan_id
                    WHERE d.company_list_ids && ARRAY(SELECT m.list_id FROM sourcing_company_list_members m WHERE m.company_id = c.id) AND p.status IN ('draft','active','paused')), '{}') AS roles_targeting,
         (SELECT count(*) FROM sourcing_outreach_people o WHERE o.company_id = c.id AND o.first_contacted IS NOT NULL)::text AS people_contacted,
         (SELECT count(*) FROM sourcing_outreach_people o WHERE o.company_id = c.id)::text AS people_found,
         (SELECT to_char(max(o.last_contacted),'YYYY-MM-DD') FROM sourcing_outreach_people o WHERE o.company_id = c.id) AS last_contacted
    FROM sourcing_companies c`;

type Raw = Omit<CompanyRow, 'people_contacted' | 'people_found' | 'candidates' | 'needs_recheck' | 'last_checked_at'> & { name_key: string; people_contacted: string; people_found: string; last_checked_at: Date };

function shape(r: Raw, cand: Map<string, number>, now: Date): CompanyRow {
  return {
    id: r.id, name: r.name, segment: r.segment, size: r.size, cities: r.cities, what_they_do: r.what_they_do, source_url: r.source_url, notes: r.notes, excluded: r.excluded,
    excluded_reason: r.excluded_reason, legacy_contacted: r.legacy_contacted, lists: r.lists, roles_targeting: r.roles_targeting, last_contacted: r.last_contacted,
    people_contacted: Number(r.people_contacted), people_found: Number(r.people_found), candidates: cand.get(r.name_key) ?? 0,
    last_checked_at: new Date(r.last_checked_at).toISOString(), needs_recheck: needsRecheck(r.last_checked_at, now),
  };
}

export async function listCompanies(f: CompanyFilters = {}, now: Date = new Date()): Promise<{ companies: CompanyRow[]; total: number; recheck_count: number }> {
  const where: string[] = []; const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('$$', `$${vals.length}`)); };
  where.push(f.excluded ? 'c.excluded' : 'NOT c.excluded');
  if (f.q) add(`(c.name ILIKE $$ OR c.what_they_do ILIKE $$)`, `%${f.q.replace(/[%_]/g, ' ').slice(0, 80)}%`);
  if (f.segment) add(`c.segment ILIKE $$`, `%${f.segment.slice(0, 60)}%`);
  if (f.size) add(`c.size ILIKE $$`, `%${f.size.slice(0, 40)}%`);
  if (f.city) add(`EXISTS (SELECT 1 FROM unnest(c.cities) ct WHERE ct ILIKE $$)`, `%${f.city.slice(0, 60)}%`);
  if (f.list) add(`EXISTS (SELECT 1 FROM sourcing_company_list_members m JOIN sourcing_company_lists l ON l.id = m.list_id WHERE m.company_id = c.id AND l.name = $$)`, f.list);
  if (f.contacted === 'yes') where.push(`EXISTS (SELECT 1 FROM sourcing_outreach_people o WHERE o.company_id = c.id AND o.first_contacted IS NOT NULL)`);
  if (f.contacted === 'no') where.push(`NOT EXISTS (SELECT 1 FROM sourcing_outreach_people o WHERE o.company_id = c.id AND o.first_contacted IS NOT NULL)`);
  if (f.role) add(`EXISTS (SELECT 1 FROM sourcing_plan_details d JOIN sourcing_plans p ON p.id = d.plan_id WHERE p.role_id = $$ AND d.company_list_ids && ARRAY(SELECT m.list_id FROM sourcing_company_list_members m WHERE m.company_id = c.id))`, f.role);
  if (f.recheck) where.push(`c.last_checked_at < NOW() - INTERVAL '183 days'`);
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500); const offset = Math.max(f.offset ?? 0, 0);
  const [rows, count, rc, cand] = await Promise.all([
    query<Raw>(`${SELECT_BASE} WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT ${limit} OFFSET ${offset}`, vals),
    queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM sourcing_companies c WHERE ${where.join(' AND ')}`, vals),
    queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM sourcing_companies WHERE NOT excluded AND last_checked_at < NOW() - INTERVAL '183 days'`),
    candidateCounts(),
  ]);
  return { companies: rows.map(r => shape(r, cand.all, now)), total: Number(count?.n ?? 0), recheck_count: Number(rc?.n ?? 0) };
}

export async function getCompany(id: string, now: Date = new Date()): Promise<(CompanyRow & {
  outreach_by_role: Array<{ role_id: string; people: number; contacted: number; replied: number }>; hires: number; recent_people: Array<{ job_title: string | null; role_id: string; status: string | null; outcome: string | null; last_contacted: string | null }>;
}) | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  const r = await queryOne<Raw>(`${SELECT_BASE} WHERE c.id = $1::bigint`, [id]);
  if (!r) return null;
  const cand = await candidateCounts();
  const byRole = await query<{ role_id: string; people: string; contacted: string; replied: string }>(
    `SELECT role_id, count(*)::text AS people, count(first_contacted)::text AS contacted, count(*) FILTER (WHERE replied)::text AS replied
       FROM sourcing_outreach_people WHERE company_id = $1::bigint GROUP BY role_id ORDER BY role_id`, [id]);
  // Names of the people are NOT listed (profile links stay in the recruiter's sheet): only role, title, status and outcome.
  const recent = await query<{ job_title: string | null; role_id: string; status: string | null; outcome: string | null; last_contacted: string | null }>(
    `SELECT job_title, role_id, status, outcome, to_char(last_contacted,'YYYY-MM-DD') AS last_contacted FROM sourcing_outreach_people WHERE company_id = $1::bigint ORDER BY last_contacted DESC NULLS LAST, id DESC LIMIT 25`, [id]);
  return {
    ...shape(r, cand.all, now), hires: cand.joined.get(r.name_key) ?? 0,
    outreach_by_role: byRole.map(b => ({ role_id: b.role_id, people: Number(b.people), contacted: Number(b.contacted), replied: Number(b.replied) })), recent_people: recent,
  };
}

export async function listCompanyLists(): Promise<Array<{ id: string; name: string; segment_group: string | null; companies: number }>> {
  const rows = await query<{ id: string; name: string; segment_group: string | null; companies: string }>(
    `SELECT l.id::text AS id, l.name, l.segment_group, (SELECT count(*) FROM sourcing_company_list_members m JOIN sourcing_companies c ON c.id = m.company_id WHERE m.list_id = l.id AND NOT c.excluded)::text AS companies
       FROM sourcing_company_lists l ORDER BY l.name`);
  return rows.map(r => ({ ...r, companies: Number(r.companies) }));
}

const txt = (v: unknown, n: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

export async function saveCompany(id: string | null, input: Record<string, unknown>, user: JwtPayload): Promise<string> {
  const name = txt(input.name, 200);
  if (!id && !name) throw new SourcingError(400, 'A company needs a name');
  const cities = Array.isArray(input.cities) ? [...new Set((input.cities as unknown[]).filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, 80)).filter(Boolean))].slice(0, 30) : undefined;
  const url = input.source_url === undefined ? undefined : (input.source_url === null || input.source_url === '' ? null : cleanProfileLink(String(input.source_url)));
  if (url === null && typeof input.source_url === 'string' && input.source_url.trim()) throw new SourcingError(400, 'The source link must be a web address');
  const listNames = Array.isArray(input.lists) ? (input.lists as unknown[]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 20) : undefined;

  return transaction(async (client) => {
    let companyId = id;
    if (!companyId) {
      const key = companyKey(name!);
      if (!key) throw new SourcingError(400, 'A company needs a name');
      const dup = await client.query(`SELECT id::text AS id FROM sourcing_companies WHERE name_key = $1`, [key]);
      if (dup.rows[0]) throw new SourcingError(409, 'This company is already in the directory');
      const ins = await client.query(
        `INSERT INTO sourcing_companies (name, name_key, segment, size, cities, what_they_do, source_url, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9::uuid,$9::uuid) RETURNING id::text AS id`,
        [name, key, txt(input.segment, 80), txt(input.size, 40), cities ?? [], txt(input.what_they_do, 500), url ?? null, txt(input.notes, 1000), user.userId]);
      companyId = ins.rows[0].id as string;
    } else {
      const sets: string[] = ['updated_by = $2::uuid']; const vals: unknown[] = [companyId, user.userId];
      const add = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
      if (name) { const key = companyKey(name); if (!key) throw new SourcingError(400, 'A company needs a name'); const dup = await client.query(`SELECT id::text AS id FROM sourcing_companies WHERE name_key = $1 AND id <> $2::bigint`, [key, companyId]); if (dup.rows[0]) throw new SourcingError(409, 'Another company in the directory has this name'); add('name', name); add('name_key', key); }
      if (input.segment !== undefined) add('segment', txt(input.segment, 80));
      if (input.size !== undefined) add('size', txt(input.size, 40));
      if (cities) add('cities', cities, '::text[]');
      if (input.what_they_do !== undefined) add('what_they_do', txt(input.what_they_do, 500));
      if (url !== undefined) add('source_url', url);
      if (input.notes !== undefined) add('notes', txt(input.notes, 1000));
      const r = await client.query(`UPDATE sourcing_companies SET ${sets.join(', ')} WHERE id = $1::bigint RETURNING id`, vals);
      if (!r.rows[0]) throw new SourcingError(404, 'Company not found');
    }
    if (listNames) {
      await client.query(`DELETE FROM sourcing_company_list_members WHERE company_id = $1::bigint`, [companyId]);
      for (const ln of listNames) {
        const l = await client.query(`INSERT INTO sourcing_company_lists (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id::text AS id`, [ln.slice(0, 120)]);
        await client.query(`INSERT INTO sourcing_company_list_members (list_id, company_id) VALUES ($1::bigint, $2::bigint) ON CONFLICT DO NOTHING`, [l.rows[0].id, companyId]);
      }
    }
    return companyId!;
  });
}

export async function setExcluded(id: string, excluded: boolean, reason: string | null, user: JwtPayload): Promise<void> {
  if (excluded && !(reason && reason.trim().length >= 2)) throw new SourcingError(400, 'A reason is required to exclude a company (for example “client” or “partner”)');
  const r = await query(`UPDATE sourcing_companies SET excluded = $2, excluded_reason = $3, updated_by = $4::uuid WHERE id = $1::bigint RETURNING id`, [id, excluded, excluded ? reason!.trim().slice(0, 200) : null, user.userId]);
  if (!r.length) throw new SourcingError(404, 'Company not found');
}

export async function markChecked(id: string, user: JwtPayload): Promise<void> {
  const r = await query(`UPDATE sourcing_companies SET last_checked_at = NOW(), updated_by = $2::uuid WHERE id = $1::bigint RETURNING id`, [id, user.userId]);
  if (!r.length) throw new SourcingError(404, 'Company not found');
}

export async function deleteCompany(id: string): Promise<void> {
  const r = await query(`DELETE FROM sourcing_companies WHERE id = $1::bigint RETURNING id`, [id]);
  if (!r.length) throw new SourcingError(404, 'Company not found');
}

export interface ImportResult { companies_new: number; companies_merged: number; lists: number; rejected: RejectedRow[]; rejected_total: number }

/** Import rows (the workbook's "Company Lists" tab, or a CSV with the same columns). Duplicates merge into one record: the cities and lists are added,
    nothing the team typed (notes, an exclusion) is overwritten, and a field that is already filled is kept. */
export async function importCompanies(table: string[][] | CompanyImportRow[], user: JwtPayload): Promise<ImportResult> {
  let rows: CompanyImportRow[]; let rejected: RejectedRow[] = [];
  if (table.length && Array.isArray(table[0])) {
    const p = parseCompanyRows(table as string[][]);
    if (p.fatal) throw new SourcingError(400, p.fatal);
    rows = p.rows; rejected = p.rejected;
  } else rows = table as CompanyImportRow[];
  if (!rows.length) throw new SourcingError(400, 'No usable rows to import');
  const merged = mergeCompanyRows(rows);
  let created = 0, updated = 0; const listNames = new Set<string>();
  await transaction(async (client) => {
    for (const c of merged) {
      const ex = await client.query(`SELECT id::text AS id FROM sourcing_companies WHERE name_key = $1 FOR UPDATE`, [c.key]);
      let id: string;
      if (ex.rows[0]) {
        id = ex.rows[0].id;
        await client.query(
          `UPDATE sourcing_companies SET segment = COALESCE(segment, $2), size = COALESCE(size, $3), what_they_do = COALESCE(what_they_do, $4), source_url = COALESCE(source_url, $5),
                  cities = (SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(cities || $6::text[]) x), legacy_contacted = legacy_contacted OR $7, updated_by = $8::uuid
            WHERE id = $1::bigint`, [id, c.segment, c.size, c.what_they_do, c.source_url, c.cities, c.legacy_contacted, user.userId]);
        updated++;
      } else {
        const ins = await client.query(
          `INSERT INTO sourcing_companies (name, name_key, segment, size, cities, what_they_do, source_url, legacy_contacted, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$9::uuid,$9::uuid) RETURNING id::text AS id`,
          [c.name, c.key, c.segment, c.size, c.cities, c.what_they_do, c.source_url, c.legacy_contacted, user.userId]);
        id = ins.rows[0].id; created++;
      }
      for (const ln of c.lists) {
        listNames.add(ln);
        const l = await client.query(
          `INSERT INTO sourcing_company_lists (name, segment_group) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id::text AS id`,
          [ln, /saas|iot/i.test(ln) ? 'SaaS / IoT' : /water/i.test(ln) ? 'Water and wastewater' : null]);
        await client.query(`INSERT INTO sourcing_company_list_members (list_id, company_id) VALUES ($1::bigint, $2::bigint) ON CONFLICT DO NOTHING`, [l.rows[0].id, id]);
      }
    }
  });
  return { companies_new: created, companies_merged: updated, lists: listNames.size, rejected: rejected.slice(0, 50), rejected_total: rejected.length };
}

export async function importCompaniesCsv(csv: string, user: JwtPayload): Promise<ImportResult> {
  if (typeof csv !== 'string' || !csv.trim()) throw new SourcingError(400, 'The file is empty');
  if (csv.length > 1_500_000) throw new SourcingError(400, 'The file is too large (1.5 MB at most)');
  return importCompanies(parseCsv(csv), user);
}
