import { describe, it, expect } from 'vitest';
import { BUDGET, BudgetTracker, type BudgetLimits } from './budget.js';

const MB = 1024 * 1024;
const limits = (over: Partial<BudgetLimits> = {}): BudgetLimits => ({ ...BUDGET, ...over });

describe('BUDGET', () => {
  it('keeps its documented relationships (a change that breaks one of these breaks the request-size or time plan)', () => {
    expect(BUDGET.maxFileBytes).toBeLessThanOrEqual(BUDGET.maxRawBytes);
    expect(BUDGET.maxPdfPagesPerFile).toBeLessThanOrEqual(BUDGET.maxPdfPagesTotal);
    expect(BUDGET.maxCharsPerItem).toBeLessThanOrEqual(BUDGET.maxCharsTotal);
    expect(BUDGET.maxImageBytes).toBeLessThanOrEqual(BUDGET.maxFileBytes);
    // Raw bytes grow by 4/3 as base64 and the whole request must stay under the 32 MB request limit.
    expect(Math.ceil(BUDGET.maxRawBytes / 3) * 4).toBeLessThan(32 * MB);
    // One fetch must fit inside the phase, and acquisition inside the job's 270 s with the model call after it.
    expect(BUDGET.perItemMs).toBeLessThan(BUDGET.fetchPhaseMs);
    expect(BUDGET.fetchPhaseMs).toBeLessThan(BUDGET.acquireMs);
    expect(BUDGET.acquireMs).toBeLessThan(270_000);
  });
});

describe('BudgetTracker.reserveBytes', () => {
  it('accepts a file up to the per-file cap and refuses one byte more, reserving nothing for the refusal', () => {
    const t = new BudgetTracker();
    expect(t.reserveBytes(BUDGET.maxFileBytes + 1)).toBe(false);
    expect(t.snapshot().bytes).toBe(0);
    expect(t.reserveBytes(BUDGET.maxFileBytes)).toBe(true);
    expect(t.snapshot().bytes).toBe(BUDGET.maxFileBytes);
  });

  it('holds the total cap exactly: 8 + 8 + 2 MB fits the 18 MB ceiling, one more byte does not', () => {
    const t = new BudgetTracker();
    expect(t.reserveBytes(8 * MB)).toBe(true);
    expect(t.reserveBytes(8 * MB)).toBe(true);
    expect(t.reserveBytes(8 * MB)).toBe(false);          // 24 MB: would break the total
    expect(t.snapshot().bytes).toBe(16 * MB);            // the refusal left the counter alone
    expect(t.reserveBytes(2 * MB + 1)).toBe(false);
    expect(t.reserveBytes(2 * MB)).toBe(true);
    expect(t.snapshot().bytes).toBe(BUDGET.maxRawBytes);
    expect(t.reserveBytes(1)).toBe(false);
    expect(t.reserveBytes(0)).toBe(true);                // an empty file costs nothing even at the ceiling
  });

  it('refuses NaN, negative and infinite sizes without touching the counter (a bad size must not rewind or poison the cap)', () => {
    const t = new BudgetTracker();
    expect(t.reserveBytes(5 * MB)).toBe(true);
    for (const bad of [NaN, -1, -8 * MB, Infinity, -Infinity]) expect(t.reserveBytes(bad), String(bad)).toBe(false);
    expect(t.snapshot().bytes).toBe(5 * MB);
    // Had -8 MB been accepted the next three would all fit; had NaN been accepted the cap would never trip again.
    expect(t.reserveBytes(8 * MB)).toBe(true);
    expect(t.reserveBytes(5 * MB)).toBe(true);
    expect(t.reserveBytes(1 * MB)).toBe(false);
  });

  it('honours custom limits', () => {
    const t = new BudgetTracker(limits({ maxFileBytes: 10, maxRawBytes: 15 }));
    expect(t.reserveBytes(11)).toBe(false);
    expect(t.reserveBytes(10)).toBe(true);
    expect(t.reserveBytes(6)).toBe(false);
    expect(t.reserveBytes(5)).toBe(true);
  });
});

describe('BudgetTracker.reservePages', () => {
  it('grants at most the per-file cap to one request', () => {
    const t = new BudgetTracker();
    expect(t.reservePages(100)).toBe(20);
    expect(t.snapshot().pages).toBe(20);
  });

  it('shares the 40-page total across files and grants the remainder, then nothing', () => {
    const t = new BudgetTracker();
    expect([t.reservePages(15), t.reservePages(15), t.reservePages(15), t.reservePages(15)]).toEqual([15, 15, 10, 0]);
    expect(t.snapshot().pages).toBe(BUDGET.maxPdfPagesTotal);
  });

  it('grants a small request in full and a zero request nothing', () => {
    const t = new BudgetTracker();
    expect(t.reservePages(3)).toBe(3);
    expect(t.reservePages(0)).toBe(0);
    expect(t.snapshot().pages).toBe(3);
  });

  it('grants nothing for NaN or a negative request and keeps counting correctly afterwards', () => {
    const t = new BudgetTracker();
    expect(t.reservePages(10)).toBe(10);
    expect(t.reservePages(NaN)).toBe(0);
    expect(t.reservePages(-7)).toBe(0);
    expect(t.snapshot().pages).toBe(10);
    expect(t.reservePages(20)).toBe(20);
    expect(t.reservePages(20)).toBe(10);                 // 40 total: the negative request did not hand back room
    expect(t.estimatedInputTokens()).toBe(40 * 2500);    // and nothing became NaN
  });

  it('an unbounded request is simply clamped', () => {
    expect(new BudgetTracker().reservePages(Infinity)).toBe(20);
  });
});

describe('BudgetTracker.reserveImages', () => {
  it('grants up to 16 across requests', () => {
    const t = new BudgetTracker();
    expect([t.reserveImages(6), t.reserveImages(6), t.reserveImages(6), t.reserveImages(6)]).toEqual([6, 6, 4, 0]);
    expect(t.snapshot().images).toBe(BUDGET.maxImages);
  });

  it('grants nothing for NaN or a negative request', () => {
    const t = new BudgetTracker();
    expect(t.reserveImages(4)).toBe(4);
    expect(t.reserveImages(NaN)).toBe(0);
    expect(t.reserveImages(-3)).toBe(0);
    expect(t.snapshot().images).toBe(4);
    expect(t.reserveImages(100)).toBe(12);
  });
});

describe('BudgetTracker.reserveChars', () => {
  it('caps one item at 12,000 characters whatever it asks for', () => {
    const t = new BudgetTracker();
    expect(t.reserveChars(50_000)).toBe(BUDGET.maxCharsPerItem);
  });

  it('stops at the 60,000 total: five full items, then nothing', () => {
    const t = new BudgetTracker();
    const grants = Array.from({ length: 6 }, () => t.reserveChars(12_000));
    expect(grants).toEqual([12_000, 12_000, 12_000, 12_000, 12_000, 0]);
    expect(t.snapshot().chars).toBe(BUDGET.maxCharsTotal);
  });

  it('grants only what is left of the total to the item that straddles it', () => {
    const t = new BudgetTracker(limits({ maxCharsPerItem: 5_000, maxCharsTotal: 11_000 }));
    expect([t.reserveChars(5_000), t.reserveChars(5_000), t.reserveChars(5_000), t.reserveChars(5_000)]).toEqual([5_000, 5_000, 1_000, 0]);
  });

  it('grants nothing for NaN or a negative request', () => {
    const t = new BudgetTracker();
    expect(t.reserveChars(1_000)).toBe(1_000);
    expect(t.reserveChars(NaN)).toBe(0);
    expect(t.reserveChars(-500)).toBe(0);
    expect(t.snapshot().chars).toBe(1_000);
  });
});

describe('BudgetTracker.estimatedInputTokens', () => {
  it('is 0 for a fresh tracker', () => {
    expect(new BudgetTracker().estimatedInputTokens()).toBe(0);
  });

  it('adds pages x 2.5K, images x 1.5K and chars / 3.5', () => {
    const t = new BudgetTracker();
    t.reservePages(10);
    t.reserveImages(4);
    t.reserveChars(7_000);
    expect(t.estimatedInputTokens()).toBe(10 * 2500 + 4 * 1500 + 2000);
  });

  it('rounds the character share to a whole token', () => {
    const t = new BudgetTracker();
    t.reserveChars(100);                                  // 28.57…
    expect(t.estimatedInputTokens()).toBe(29);
    const u = new BudgetTracker();
    u.reserveChars(3);                                    // 0.857…
    expect(u.estimatedInputTokens()).toBe(1);
  });

  it('can reach the model-call input cap, which is what the caller trims against', () => {
    const t = new BudgetTracker();
    t.reservePages(20);
    t.reservePages(20);
    t.reserveImages(16);
    for (let i = 0; i < 5; i++) t.reserveChars(12_000);
    expect(t.snapshot()).toMatchObject({ pages: 40, images: 16, chars: 60_000 });
    expect(t.estimatedInputTokens()).toBeGreaterThan(BUDGET.estInputTokenCap);
  });
});

describe('BudgetTracker state', () => {
  it('snapshot is a copy: editing it does not move the tracker', () => {
    const t = new BudgetTracker();
    t.reservePages(5);
    const s = t.snapshot();
    s.pages = 999;
    s.bytes = 999;
    expect(t.snapshot()).toEqual({ bytes: 0, pages: 5, images: 0, chars: 0 });
  });

  it('each tracker counts for itself', () => {
    const a = new BudgetTracker();
    const b = new BudgetTracker();
    a.reservePages(20);
    a.reserveImages(16);
    a.reserveChars(12_000);
    a.reserveBytes(8 * MB);
    expect(b.snapshot()).toEqual({ bytes: 0, pages: 0, images: 0, chars: 0 });
  });

  it('the four counters are independent of each other', () => {
    const t = new BudgetTracker();
    t.reserveBytes(8 * MB);
    expect(t.reservePages(20)).toBe(20);
    expect(t.reserveImages(16)).toBe(16);
    expect(t.reserveChars(12_000)).toBe(12_000);
    expect(t.snapshot()).toEqual({ bytes: 8 * MB, pages: 20, images: 16, chars: 12_000 });
  });

  it('does not change the shared BUDGET constant', () => {
    const before = { ...BUDGET };
    const t = new BudgetTracker();
    t.reserveBytes(8 * MB);
    t.reservePages(20);
    expect(BUDGET).toEqual(before);
  });
});

// The reservations are synchronous on purpose: fetchers run four at a time, and a check-then-act across an `await`
// would let two of them both pass the same cap. Interleave them the way the pool does.
describe('BudgetTracker under concurrent fetchers', () => {
  const tick = () => Promise.resolve();

  it('never grants more than the page total however the fetchers interleave', async () => {
    const t = new BudgetTracker();
    const grants = await Promise.all(Array.from({ length: 12 }, async () => { await tick(); await tick(); return t.reservePages(10); }));
    expect(grants.reduce((a, b) => a + b, 0)).toBe(BUDGET.maxPdfPagesTotal);
    expect(t.snapshot().pages).toBe(BUDGET.maxPdfPagesTotal);
    expect(grants.filter(g => g === 10)).toHaveLength(4);
  });

  it('never lets two downloads share the last of the byte budget', async () => {
    const t = new BudgetTracker();
    const results = await Promise.all(Array.from({ length: 5 }, async () => { await tick(); return t.reserveBytes(4 * MB); }));
    expect(results.filter(Boolean)).toHaveLength(4);     // 16 MB fits, the fifth would make 20 MB
    expect(t.snapshot().bytes).toBe(16 * MB);
  });

  it('never grants more than the image or character totals', async () => {
    const t = new BudgetTracker();
    const images = await Promise.all(Array.from({ length: 10 }, async () => { await tick(); return t.reserveImages(5); }));
    const chars = await Promise.all(Array.from({ length: 10 }, async () => { await tick(); return t.reserveChars(12_000); }));
    expect(images.reduce((a, b) => a + b, 0)).toBe(BUDGET.maxImages);
    expect(chars.reduce((a, b) => a + b, 0)).toBe(BUDGET.maxCharsTotal);
  });
});
