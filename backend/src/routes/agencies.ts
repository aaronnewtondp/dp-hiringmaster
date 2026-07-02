import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';

const router = Router();
router.use(authenticate, requireHR);

router.get('/', async (_req, res: Response) => {
  const agencies = await query(
    `SELECT a.*,
       COUNT(DISTINCT app.id) FILTER (WHERE app.status NOT IN ('Rejected','Withdrawn')) AS total_submitted,
       COUNT(DISTINCT app.id) FILTER (WHERE app.stage = 'Joined') AS total_hired
     FROM agencies a
     LEFT JOIN applications app ON app.agency_id = a.id
     GROUP BY a.id
     ORDER BY a.name`
  );
  res.json({ agencies });
});

router.get('/:id', async (req: Request, res: Response) => {
  const agency = await queryOne('SELECT * FROM agencies WHERE id=$1', [req.params.id]);
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
  const allowed = ['name','contact_name','contact_email','contact_phone','contract_status',
    'tier1_band','tier1_rate','tier2_band','tier2_rate','tier3_band','tier3_rate',
    'replacement_guarantee_days','specialisations','agreement_drive_link','notes'];
  const updates: string[] = []; const values: unknown[] = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); values.push(req.body[f]); }
  }
  if (!updates.length) { res.status(400).json({ error: 'No fields' }); return; }
  values.push(req.params.id);
  const agency = await queryOne(`UPDATE agencies SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, values);
  if (!agency) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ agency });
});

export default router;
