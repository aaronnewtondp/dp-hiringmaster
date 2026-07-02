import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireHR } from '../middleware/auth.js';

// ─── Eval Questions ───────────────────────────────────────────────────────────
export const evalQuestionsRouter = Router();
evalQuestionsRouter.use(authenticate);

// GET /api/eval-questions?role_category=Technical&experience_level=Senior
evalQuestionsRouter.get('/', async (req: Request, res: Response) => {
  const { role_category, experience_level, area } = req.query;
  let sql = `SELECT * FROM eval_questions WHERE approved=true`;
  const params: unknown[] = [];
  let i = 1;
  if (role_category) { sql += ` AND (role_category=$${i++} OR role_category='All')`; params.push(role_category); }
  if (experience_level) { sql += ` AND (experience_level=$${i++} OR experience_level='All')`; params.push(experience_level); }
  if (area) { sql += ` AND evaluation_area=$${i++}`; params.push(area); }
  sql += ' ORDER BY priority DESC, evaluation_area';
  const questions = await query(sql, params);
  res.json({ questions });
});

// POST /api/eval-questions — add a new question (HR only)
evalQuestionsRouter.post('/', requireHR, async (req: Request, res: Response) => {
  const { evaluation_area, role_category, experience_level, question_text,
          question_type, priority } = req.body;
  if (!evaluation_area || !question_text) {
    res.status(400).json({ error: 'evaluation_area and question_text required' }); return;
  }
  const q = await queryOne(
    `INSERT INTO eval_questions
       (evaluation_area, role_category, experience_level, question_text,
        question_type, priority, source, approved, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,'HR-Curated',true,$7) RETURNING *`,
    [evaluation_area, role_category || 'All', experience_level || 'All',
     question_text, question_type || 'Behavioural', priority || 'Recommended',
     (req as any).user!.userId]
  );
  res.status(201).json({ question: q });
});

// ─── Comp Benchmarks ─────────────────────────────────────────────────────────
export const compBenchmarksRouter = Router();
compBenchmarksRouter.use(authenticate, requireHR);

// GET /api/comp-benchmarks?role_category=Sr. Backend Developer
compBenchmarksRouter.get('/', async (req: Request, res: Response) => {
  const { role_category } = req.query;
  let sql = 'SELECT * FROM comp_benchmarks';
  const params: unknown[] = [];
  if (role_category) { sql += ' WHERE role_category=$1'; params.push(role_category); }
  sql += ' ORDER BY role_category, experience_range';
  const benchmarks = await query(sql, params);
  res.json({ benchmarks });
});

// PATCH /api/comp-benchmarks/:id — update band ranges
compBenchmarksRouter.patch('/:id', async (req: Request, res: Response) => {
  const allowed = ['internal_band_min','internal_band_max','market_band_min',
    'market_band_max','notes','last_updated'];
  const updates: string[] = []; const values: unknown[] = []; let i = 1;
  for (const f of allowed) {
    if (req.body[f] !== undefined) { updates.push(`${f}=$${i++}`); values.push(req.body[f]); }
  }
  if (!updates.length) { res.status(400).json({ error: 'No fields' }); return; }
  updates.push(`updated_by=$${i++}`); values.push((req as any).user!.userId);
  values.push(req.params.id);
  const b = await queryOne(
    `UPDATE comp_benchmarks SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, values
  );
  if (!b) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ benchmark: b });
});
