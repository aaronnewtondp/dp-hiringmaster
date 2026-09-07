import { query, queryOne } from '../db/index.js';

// "Unmatched Candidates" — the union of two previously-separate concepts
// (Candidates.tsx used to show these as two different amber banners,
// "Unlinked candidates" and "Unmatched role submissions"; the dashboard KPI
// only ever counted the second half):
//   1. A Job Application Form submission whose typed role text never
//      matched a real role (activity_log's 'Unmatched Role — Manual
//      Reconciliation' event), still unresolved — no application to the
//      suggested role exists yet. By construction (candidateIngest.ts never
//      creates an application on a no-match), every row here also has zero
//      applications at all.
//   2. Any OTHER candidate with zero applications for any reason (manually
//      added with none yet, or an application later removed) who isn't
//      already counted in (1).
// Shared by both candidates.ts's GET /unmatched (the Candidates page panel)
// and dashboard.ts's candidates_unmatched KPI, so the same term never means
// two different counts on two different pages.
const UNMATCHED_CANDIDATES_CTE = `
  latest AS (
    SELECT DISTINCT ON (al.candidate_id, al.event_detail)
      al.candidate_id, c.full_name, c.email, al.event_detail AS submitted_text, al.created_at,
      (SELECT r.id FROM roles r
         WHERE lower(regexp_replace(translate(trim(r.title), '–—', '--'), '\\s+', ' ', 'g'))
             = lower(regexp_replace(translate(trim(al.event_detail), '–—', '--'), '\\s+', ' ', 'g'))
           AND r.status NOT IN ('Closed – Filled', 'Closed – Cancelled')
         LIMIT 1) AS suggested_role_id,
      (SELECT r.title FROM roles r
         WHERE lower(regexp_replace(translate(trim(r.title), '–—', '--'), '\\s+', ' ', 'g'))
             = lower(regexp_replace(translate(trim(al.event_detail), '–—', '--'), '\\s+', ' ', 'g'))
           AND r.status NOT IN ('Closed – Filled', 'Closed – Cancelled')
         LIMIT 1) AS suggested_role_title
    FROM activity_log al
    JOIN candidates c ON c.id = al.candidate_id
    WHERE al.event_type = 'Unmatched Role — Manual Reconciliation'
    ORDER BY al.candidate_id, al.event_detail, al.created_at DESC
  ),
  resolved_removed AS (
    SELECT * FROM latest l
    WHERE NOT EXISTS (
      SELECT 1 FROM applications a2 WHERE a2.candidate_id = l.candidate_id AND a2.role_id = l.suggested_role_id
    )
  ),
  plain_unlinked AS (
    SELECT c.id AS candidate_id, c.full_name, c.email, NULL::text AS submitted_text, c.created_at,
           NULL::text AS suggested_role_id, NULL::text AS suggested_role_title
    FROM candidates c
    WHERE NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM resolved_removed rr WHERE rr.candidate_id = c.id)
  ),
  unmatched AS (
    SELECT * FROM resolved_removed
    UNION ALL
    SELECT * FROM plain_unlinked
  )
`;

export interface UnmatchedCandidateRow {
  candidate_id:         string;
  full_name:            string;
  email:                string | null;
  submitted_text:       string | null;
  created_at:           string;
  suggested_role_id:    string | null;
  suggested_role_title: string | null;
}

export async function fetchUnmatchedCandidates(limit: number, offset: number): Promise<{ rows: UnmatchedCandidateRow[]; total: number }> {
  const [rows, countResult] = await Promise.all([
    query<UnmatchedCandidateRow>(
      `WITH ${UNMATCHED_CANDIDATES_CTE} SELECT * FROM unmatched ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    queryOne<{ count: string }>(`WITH ${UNMATCHED_CANDIDATES_CTE} SELECT COUNT(*) as count FROM unmatched`),
  ]);
  return { rows, total: parseInt(countResult?.count || '0') };
}

export async function countUnmatchedCandidates(): Promise<number> {
  const countResult = await queryOne<{ count: string }>(`WITH ${UNMATCHED_CANDIDATES_CTE} SELECT COUNT(*) as count FROM unmatched`);
  return parseInt(countResult?.count || '0');
}
