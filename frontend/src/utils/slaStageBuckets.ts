import { STAGES } from '../types/index.ts';

// The "SLA breaches by role" chart stacks each role's bar by FUNNEL STEP. Eleven stages are
// too many colours for a stack to tell apart (the per-stage hues used by the chevron strip
// above it sit within a few colour-difference units of each other for Interview 1 -> Founders),
// and funnel position is ordered, so the stack uses one hue that gets darker the further along
// the funnel — five steps. Every individual stage is still shown in the tooltip and in the
// role's drill-down, so nothing is hidden by the grouping.
//
// The ramp is blue steps 250/350/450/550/650 of the design system's ordinal ramp, validated with
// the dataviz skill's `validate_palette.js --ordinal` (light mode, white surface): monotone
// lightness, adjacent step gaps >= 0.06, light end 2.11:1 against the surface, single hue.
export interface SlaStageBucket {
  key:    string;
  label:  string;
  color:  string;
  stages: string[];
}

export const SLA_STAGE_BUCKETS: SlaStageBucket[] = [
  { key: 'screening',  label: 'Applied & Screened',  color: '#86b6ef', stages: ['Applied and Screened'] },
  { key: 'interview1', label: 'Interview 1',         color: '#5598e7', stages: ['Interview Round 1'] },
  { key: 'interview2', label: 'Interview 2',         color: '#2a78d6', stages: ['Interview Round 2'] },
  { key: 'assessment', label: 'Assignment & Founders', color: '#1c5cab', stages: ['Assignment Round', 'Founders Round'] },
  { key: 'closing',    label: 'Reference → Offer',   color: '#104281', stages: ['Reference Check', 'Pre-Joining Documents', 'Offer Discussion', 'Offer Released', 'Offer Accepted', 'Joined'] },
];

/** A breach whose stage is not a funnel stage (e.g. its application was removed). Neutral on purpose. */
export const OTHER_BUCKET: SlaStageBucket = { key: 'other', label: 'Other', color: '#a8a7a2', stages: [] };

export function bucketForStage(stage: string): SlaStageBucket {
  return SLA_STAGE_BUCKETS.find(b => b.stages.includes(stage)) ?? OTHER_BUCKET;
}

/** Sum a role's per-stage counts into the buckets, in funnel order (empty buckets omitted). */
export function bucketCounts(byStage: Array<{ stage: string; count: number }>): Array<{ bucket: SlaStageBucket; count: number; stages: Array<{ stage: string; count: number }> }> {
  const out = new Map<string, { bucket: SlaStageBucket; count: number; stages: Array<{ stage: string; count: number }> }>();
  for (const s of byStage) {
    if (s.count <= 0) continue;
    const bucket = bucketForStage(s.stage);
    const cur = out.get(bucket.key) ?? { bucket, count: 0, stages: [] };
    cur.count += s.count;
    cur.stages.push({ stage: s.stage, count: s.count });
    out.set(bucket.key, cur);
  }
  const order = [...SLA_STAGE_BUCKETS, OTHER_BUCKET].map(b => b.key);
  return [...out.values()].sort((a, b) => order.indexOf(a.bucket.key) - order.indexOf(b.bucket.key));
}

// Guard: if a stage is ever added to / renamed in STAGES, it must be put in a bucket here.
export const UNBUCKETED_STAGES = STAGES.filter(s => !SLA_STAGE_BUCKETS.some(b => b.stages.includes(s)));
