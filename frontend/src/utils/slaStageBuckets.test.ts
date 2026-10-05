import { describe, it, expect } from 'vitest';
import { STAGES } from '../types/index.ts';
import { bucketCounts, bucketForStage, OTHER_BUCKET, SLA_STAGE_BUCKETS, UNBUCKETED_STAGES } from './slaStageBuckets.ts';

describe('SLA stage buckets', () => {
  it('every funnel stage belongs to exactly one bucket (fails if a stage is added without one)', () => {
    expect(UNBUCKETED_STAGES).toEqual([]);
    for (const stage of STAGES) {
      expect(SLA_STAGE_BUCKETS.filter(b => b.stages.includes(stage))).toHaveLength(1);
    }
  });

  it('no bucket lists a stage that does not exist', () => {
    for (const b of SLA_STAGE_BUCKETS) for (const s of b.stages) expect(STAGES).toContain(s);
  });

  it('buckets run in funnel order', () => {
    const flat = SLA_STAGE_BUCKETS.flatMap(b => b.stages);
    expect(flat).toEqual([...STAGES].filter(s => flat.includes(s)));
  });

  it('uses the validated blue ordinal ramp: five distinct colours, getting darker down the funnel', () => {
    const colors = SLA_STAGE_BUCKETS.map(b => b.color);
    expect(new Set(colors).size).toBe(colors.length);
    const lum = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
    for (let i = 1; i < colors.length; i++) expect(lum(colors[i])).toBeLessThan(lum(colors[i - 1]));
  });

  it('unknown stages fall into the neutral Other bucket', () => {
    expect(bucketForStage('Not A Stage')).toBe(OTHER_BUCKET);
    expect(bucketForStage('Interview Round 2').key).toBe('interview2');
  });
});

describe('bucketCounts', () => {
  it('sums stages into buckets, keeps the stage split, and orders by funnel', () => {
    const out = bucketCounts([
      { stage: 'Founders Round', count: 2 }, { stage: 'Applied and Screened', count: 5 }, { stage: 'Assignment Round', count: 1 }, { stage: 'Mystery', count: 3 },
    ]);
    expect(out.map(o => [o.bucket.key, o.count])).toEqual([['screening', 5], ['assessment', 3], ['other', 3]]);
    expect(out[1].stages).toEqual([{ stage: 'Founders Round', count: 2 }, { stage: 'Assignment Round', count: 1 }]);
  });
  it('omits empty buckets and zero counts', () => {
    expect(bucketCounts([{ stage: 'Interview Round 1', count: 0 }])).toEqual([]);
  });
  it('conserves the total', () => {
    const input = [{ stage: 'Applied and Screened', count: 7 }, { stage: 'Joined', count: 2 }, { stage: 'Offer Released', count: 4 }];
    expect(bucketCounts(input).reduce((n, b) => n + b.count, 0)).toBe(13);
  });
});
