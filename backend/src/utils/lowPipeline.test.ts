import { describe, it, expect } from 'vitest';
import { isLowPipeline, LOW_PIPELINE_MAX_ACTIVE, LOW_PIPELINE_MAX_SHORTLISTED } from './lowPipeline.js';

const role = (shortlisted_count: number, active_count: number) => ({ shortlisted_count, active_count });

describe('isLowPipeline — fewer than 3 shortlisted AND fewer than 8 active', () => {
  it('uses the agreed thresholds', () => {
    expect(LOW_PIPELINE_MAX_SHORTLISTED).toBe(3);
    expect(LOW_PIPELINE_MAX_ACTIVE).toBe(8);
  });

  it('an empty pipeline is low', () => {
    expect(isLowPipeline(role(0, 0))).toBe(true);
  });

  it('is low only when BOTH counts are under their limits', () => {
    expect(isLowPipeline(role(2, 7))).toBe(true);
    expect(isLowPipeline(role(0, 7))).toBe(true);
    expect(isLowPipeline(role(2, 2))).toBe(true);
  });

  it('exactly 3 shortlisted is NOT low (the rule is "fewer than 3")', () => {
    expect(isLowPipeline(role(3, 3))).toBe(false);
    expect(isLowPipeline(role(3, 5))).toBe(false);
  });

  it('exactly 8 active is NOT low (the rule is "fewer than 8")', () => {
    expect(isLowPipeline(role(0, 8))).toBe(false);
    expect(isLowPipeline(role(2, 8))).toBe(false);
  });

  it('a big pool of unshortlisted applicants is NOT low — that is a process problem, not thin sourcing', () => {
    expect(isLowPipeline(role(0, 200))).toBe(false);
  });

  it('plenty shortlisted is not low even if the pipeline is otherwise small', () => {
    expect(isLowPipeline(role(5, 6))).toBe(false);
  });

  it('the old score-based number no longer matters', () => {
    // 2 shortlisted, 7 active: low regardless of how many of them scored above 60.
    expect(isLowPipeline({ ...role(2, 7), shortlisted_scored_count: 0 } as never)).toBe(true);
    expect(isLowPipeline({ ...role(2, 7), shortlisted_scored_count: 2 } as never)).toBe(true);
  });
});
