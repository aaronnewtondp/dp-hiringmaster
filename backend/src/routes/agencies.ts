import { Router, Request, Response } from 'express';
import { query, queryOne, transaction } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';

const router = Router();
router.use(authenticate, requireHR);

// A "hire" is counted off the CANDIDATE's own sourced_by_agency_id (Identity
// section's Source = Agency, item added for the agency revamp) — not
// applications.agency_id, a separate, older application-level field that
// never had a working UI to actually set it. Counted per distinct candidate
// (not per application) so a candidate with two applications that both
// reached Offer Accepted+ doesn't count twice, and gated on Offer Accepted
// or Joined specifically — Offer Released isn't a hire yet, the offer could
// still fall through.
const TOTAL_HIRED_SUBQUERY = `(
       SELECT COUNT(DISTINCT c.id) FROM candidates c
       WHERE c.sourced_by_agency_id = a.id
         AND EXISTS (
           SELECT 1 FROM applications app2
           WHERE app2.candidate_id = c.id AND app2.stage IN ('Offer Accepted','Joined')
         )
     )`;

router.get('/', async (_req, res: Response) => {
  const agencies = await query(
    `SELECT a.*,
       COUNT(DISTINCT app.id) FILTER (WHERE app.status NOT IN ('Rejected','Withdrawn')) AS total_submitted,
       ${TOTAL_HIRED_SUBQUERY} AS total_hired
     FROM agencies a
     LEFT JOIN applications app ON app.agency_id = a.id
     GROUP BY a.id
     ORDER BY a.name`
  );
  res.json({ agencies });
});

router.get('/:id', async (req: Request, res: Response) => {
  const agency = await queryOne(
    `SELECT a.*,
       COUNT(DISTINCT app.id) FILTER (WHERE app.status NOT IN ('Rejected','Withdrawn')) AS total_submitted,
       ${TOTAL_HIRED_SUBQUERY} AS total_hired
     FROM agencies a
     LEFT JOIN applications app ON app.agency_id = a.id
     WHERE a.id = $1
     GROUP BY a.id`,
    [req.params.id]
  );
  if (!agency) { res.status(404).json({ error: 'Agency not found' }); return; }
  res.json({ agency });
});

router.post('/', async (req: Request, res: Response) => {
  const {
    name, contact_name, contact_email, contact_phone, contract_status,
    tier1_band, tier1_rate, tier2_band, tier2_rate, tier3_band, tier3_rate,
    replacement_guarantee_days, specialisations, agreement_drive_link, notes,
  } = req.body;
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const agency = await queryOne(
    `INSERT INTO agencies (name,contact_name,contact_email,contact_phone,contract_status,
       tier1_band,tier1_rate,tier2_band,tier2_rate,tier3_band,tier3_rate,
       replacement_guarantee_days,specialisations,agreement_drive_link,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [name,contact_name,contact_email,contact_phone,contract_status||'Active',
     tier1_band,tier1_rate,tier2_band,tier2_rate,tier3_band,tier3_rate,
     replacement_guarantee_days||60,specialisations,agreement_drive_link,notes]
  );
  res.status(201).json({ agency });
});

router.patch('/:id', async (req: Request, res: Response) => {
  const existing = await queryOne<Record<string, unknown>>('SELECT * FROM agencies WHERE id=$1', [req.params.id]);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

  const allowedFields = ['name','contact_name','contact_email','contact_phone','contract_status',
    'tier1_band','tier1_rate','tier2_band','tier2_rate','tier3_band','tier3_rate',
    'replacement_guarantee_days','specialisations','agreement_drive_link','notes',
    'ctc_definition','market_positioning',
    'replacement_triggers','replacement_exclusions','replacement_remedy','replacement_conditions',
    'billing_invoice_trigger','billing_invoice_raised','billing_payment_due',
    'billing_effective_window','billing_late_penalty'];

  const updates: string[] = [];
  const values: unknown[] = [];
  const editLogEntries: Array<{ field: string; old: string; new_val: string }> = [];
  let idx = 1;

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      const oldVal = String(existing[field] ?? '');
      const newVal = String(req.body[field]);
      if (oldVal !== newVal) {
        updates.push(`${field}=$${idx++}`);
        values.push(req.body[field]);
        editLogEntries.push({ field, old: oldVal, new_val: newVal });
      }
    }
  }

  if (updates.length === 0) {
    res.json({ agency: existing, message: 'No changes detected' });
    return;
  }

  values.push(req.params.id);
  const agency = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE agencies SET ${updates.join(',')} WHERE id=$${idx} RETURNING *`,
      values
    );

    for (const entry of editLogEntries) {
      await client.query(
        `INSERT INTO agency_edit_log (agency_id, field_name, old_value, new_value, changed_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.params.id, entry.field, entry.old, entry.new_val, req.user!.userId]
      );
    }

    return result.rows[0];
  });

  res.json({ agency });
});

// ─── GET /api/agencies/:id/edit-log ────────────────────────────────────────────
router.get('/:id/edit-log', async (req: Request, res: Response) => {
  const logs = await query(
    `SELECT el.*, u.name AS changed_by_name
     FROM agency_edit_log el
     LEFT JOIN users u ON u.id = el.changed_by
     WHERE el.agency_id = $1
     ORDER BY el.changed_at DESC`,
    [req.params.id]
  );
  res.json({ logs });
});

export default router;
