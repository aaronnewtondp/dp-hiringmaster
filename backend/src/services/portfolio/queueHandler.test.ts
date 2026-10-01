import { describe, it, expect, vi } from 'vitest';
import { handlePortfolioMessage, HandlerDeps } from './queueHandler.js';
import { BUSY_RETRY_DELAY_SECONDS, BUSY_RETRY_JITTER_SECONDS, MAX_BUSY_RETRIES } from './queueMessage.js';
import { MAX_ATTEMPTS } from './jobState.js';

type Mocked = { [K in keyof HandlerDeps]: ReturnType<typeof vi.fn> };
function deps(over: Partial<Record<keyof HandlerDeps, unknown>> = {}): Mocked & HandlerDeps {
  return {
    run:         vi.fn().mockResolvedValue({ ran: true, status: 'completed' }),
    requeue:     vi.fn().mockResolvedValue({ enqueued: true }),
    needsReview: vi.fn().mockResolvedValue(true),
    giveUp:      vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}
const BUSY = { ran: false, status: 'busy', reason: 'browser in use' };
const busyDeps = (over: Partial<Record<keyof HandlerDeps, unknown>> = {}) => deps({ run: vi.fn().mockResolvedValue(BUSY), ...over });

describe('handlePortfolioMessage', () => {
  it('acknowledges a malformed message without running anything', async () => {
    const d = deps();
    expect(await handlePortfolioMessage({ applicationId: 'nope' }, { deliveryCount: 1 }, d)).toEqual({ outcome: 'ignored' });
    expect(await handlePortfolioMessage(null, undefined, d)).toEqual({ outcome: 'ignored' });
    expect(d.run).not.toHaveBeenCalled();
  });

  it("runs the review with the queue's delivery count as the attempt, and does nothing else when it settles", async () => {
    const d = deps();
    const out = await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 2 }, d);
    expect(d.run).toHaveBeenCalledWith('A0611', { attempt: 2 });
    expect(out).toEqual({ outcome: 'done', result: { ran: true, status: 'completed' } });
    expect(d.requeue).not.toHaveBeenCalled();
    expect(d.giveUp).not.toHaveBeenCalled();
  });

  it('treats a missing delivery count as the first attempt', async () => {
    const d = deps();
    await handlePortfolioMessage({ applicationId: 'A0611' }, undefined, d);
    expect(d.run).toHaveBeenCalledWith('A0611', { attempt: 1 });
  });

  it('lets a failure of ours propagate so the queue redelivers it', async () => {
    const d = deps({ run: vi.fn().mockRejectedValue(new Error('model overloaded')) });
    await expect(handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 1 }, d)).rejects.toThrow('model overloaded');
    expect(d.requeue).not.toHaveBeenCalled();
  });

  describe('when the browser on this instance is busy', () => {
    it('hands the review back as a fresh delayed message with the counter advanced — and returns normally (acknowledges)', async () => {
      const d = busyDeps();
      const out = await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 1 }, d);
      expect(out.outcome).toBe('requeued');
      expect(d.requeue).toHaveBeenCalledTimes(1);
      const [id, opts] = d.requeue.mock.calls[0];
      expect(id).toBe('A0611');
      expect(opts.busyRetries).toBe(1);
      expect(opts.attemptsUsed).toBe(0);                       // the busy delivery ran nothing
      expect(opts.delaySeconds).toBeGreaterThanOrEqual(BUSY_RETRY_DELAY_SECONDS);
      expect(opts.delaySeconds).toBeLessThan(BUSY_RETRY_DELAY_SECONDS + BUSY_RETRY_JITTER_SECONDS);
      expect(d.giveUp).not.toHaveBeenCalled();
    });

    it('keeps counting busy hand-backs across the chain', async () => {
      const d = busyDeps();
      await handlePortfolioMessage({ applicationId: 'A0611', busyRetries: 11 }, { deliveryCount: 1 }, d);
      expect(d.requeue.mock.calls[0][1].busyRetries).toBe(12);
    });

    describe('the attempt budget survives a hand-back (a hard-killed review must still be bounded)', () => {
      it('carries the deliveries that were really spent: a busy redelivery #2 means 1 earlier attempt was used', async () => {
        const d = busyDeps();
        await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 2 }, d);
        expect(d.requeue.mock.calls[0][1].attemptsUsed).toBe(1);
      });

      it('adds to what earlier hand-backs already carried', async () => {
        const d = busyDeps();
        await handlePortfolioMessage({ applicationId: 'A0611', attemptsUsed: 1 }, { deliveryCount: 2 }, d);
        expect(d.requeue.mock.calls[0][1].attemptsUsed).toBe(2);
      });

      it('runs the next delivery with the TRUE attempt number, not the queue\'s restarted count', async () => {
        const d = deps();
        await handlePortfolioMessage({ applicationId: 'A0611', attemptsUsed: 2 }, { deliveryCount: 1 }, d);
        expect(d.run).toHaveBeenCalledWith('A0611', { attempt: 3 });
      });

      it('refuses to run once earlier deliveries have spent the whole budget, and records a failure instead', async () => {
        const d = deps();
        const out = await handlePortfolioMessage({ applicationId: 'A0611', attemptsUsed: MAX_ATTEMPTS }, { deliveryCount: 1 }, d);
        expect(out).toEqual({ outcome: 'gave_up' });
        expect(d.run).not.toHaveBeenCalled();
        expect(d.giveUp).toHaveBeenCalledWith('A0611', expect.stringContaining('Re-run'));
      });

      it('a simulated poison review (always kills its worker, redelivered onto a busy instance each time) is stopped after the budget, not 90 cycles', async () => {
        // Each round: the redelivery (deliveryCount 2) finds the instance busy -> hand-back.
        // Then the new message (deliveryCount 1) runs and is killed (the queue redelivers it as deliveryCount 2).
        let msg: Record<string, unknown> = { applicationId: 'A0611' };
        let kills = 0;
        let stopped = false;
        for (let round = 0; round < 20 && !stopped; round++) {
          // delivery 1 of this message runs and is hard-killed (no JS) — counts as a kill
          kills++;
          // delivery 2 lands on a busy instance
          const d = busyDeps();
          const out = await handlePortfolioMessage(msg, { deliveryCount: 2 }, d);
          if (out.outcome === 'gave_up') { stopped = true; break; }
          msg = { applicationId: 'A0611', ...d.requeue.mock.calls[0][1] };
        }
        expect(stopped).toBe(true);
        expect(kills).toBeLessThanOrEqual(MAX_ATTEMPTS);
      });
    });

    it('does not spend a delivery attempt on the bounce itself: it requeues even on the last delivery', async () => {
      const d = busyDeps();
      const out = await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 3 }, d);
      expect(out.outcome).toBe('requeued');
      expect(d.requeue.mock.calls[0][1].attemptsUsed).toBe(2);
    });

    it('drops a stale or duplicate message for a review that has since settled (or is held by another worker) instead of bouncing it', async () => {
      const d = busyDeps({ needsReview: vi.fn().mockResolvedValue(false) });
      const out = await handlePortfolioMessage({ applicationId: 'A0611', busyRetries: 5 }, { deliveryCount: 1 }, d);
      expect(out).toEqual({ outcome: 'stale' });
      expect(d.requeue).not.toHaveBeenCalled();
      expect(d.giveUp).not.toHaveBeenCalled();
    });

    it('records a failure (with a Re-run hint) instead of looping forever once the wait budget is spent', async () => {
      const d = busyDeps();
      const out = await handlePortfolioMessage({ applicationId: 'A0611', busyRetries: MAX_BUSY_RETRIES }, { deliveryCount: 1 }, d);
      expect(out).toEqual({ outcome: 'gave_up' });
      expect(d.giveUp).toHaveBeenCalledWith('A0611', expect.stringContaining('Re-run'));
      expect(d.requeue).not.toHaveBeenCalled();
    });

    it('falls back to the queue\'s own redelivery (throws) if the hand-back could not be sent and deliveries remain', async () => {
      const d = busyDeps({ requeue: vi.fn().mockResolvedValue({ enqueued: false, error: 'queue did not respond within 8s' }) });
      await expect(handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 1 }, d)).rejects.toThrow(/queue did not respond/);
      expect(d.giveUp).not.toHaveBeenCalled();
    });

    it('but on the LAST delivery (the queue will acknowledge and drop it) a failed hand-back is recorded, not lost', async () => {
      const d = busyDeps({ requeue: vi.fn().mockResolvedValue({ enqueued: false, error: 'queue down' }) });
      const out = await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: MAX_ATTEMPTS }, d);
      expect(out).toEqual({ outcome: 'gave_up' });
      expect(d.giveUp).toHaveBeenCalledWith('A0611', expect.stringContaining('Re-run'));
    });
  });
});
