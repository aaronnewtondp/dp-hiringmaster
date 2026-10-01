import { describe, it, expect, vi } from 'vitest';
import { handlePortfolioMessage, HandlerDeps } from './queueHandler.js';
import { BUSY_RETRY_DELAY_SECONDS, BUSY_RETRY_JITTER_SECONDS, MAX_BUSY_RETRIES } from './queueMessage.js';

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps & { run: ReturnType<typeof vi.fn>; requeue: ReturnType<typeof vi.fn>; giveUp: ReturnType<typeof vi.fn> } {
  return {
    run:     vi.fn().mockResolvedValue({ ran: true, status: 'completed' }),
    requeue: vi.fn().mockResolvedValue({ enqueued: true }),
    giveUp:  vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}
const BUSY = { ran: false, status: 'busy', reason: 'browser in use' };

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
    const d = deps({ run: vi.fn().mockRejectedValue(new Error('model overloaded')) } as never);
    await expect(handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 1 }, d)).rejects.toThrow('model overloaded');
    expect(d.requeue).not.toHaveBeenCalled();
  });

  describe('when the browser on this instance is busy', () => {
    it('hands the review back as a fresh delayed message with the counter advanced — and returns normally (acknowledges)', async () => {
      const d = deps({ run: vi.fn().mockResolvedValue(BUSY) } as never);
      const out = await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 1 }, d);
      expect(out.outcome).toBe('requeued');
      expect(d.requeue).toHaveBeenCalledTimes(1);
      const [id, opts] = d.requeue.mock.calls[0];
      expect(id).toBe('A0611');
      expect(opts.busyRetries).toBe(1);
      expect(opts.delaySeconds).toBeGreaterThanOrEqual(BUSY_RETRY_DELAY_SECONDS);
      expect(opts.delaySeconds).toBeLessThan(BUSY_RETRY_DELAY_SECONDS + BUSY_RETRY_JITTER_SECONDS);
      expect(d.giveUp).not.toHaveBeenCalled();
    });

    it('does not spend a delivery attempt: even on the last delivery it requeues instead of failing', async () => {
      const d = deps({ run: vi.fn().mockResolvedValue(BUSY) } as never);
      const out = await handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 3 }, d);
      expect(out.outcome).toBe('requeued');
      expect(d.giveUp).not.toHaveBeenCalled();
    });

    it('keeps counting across hand-backs', async () => {
      const d = deps({ run: vi.fn().mockResolvedValue(BUSY) } as never);
      await handlePortfolioMessage({ applicationId: 'A0611', busyRetries: 11 }, { deliveryCount: 1 }, d);
      expect(d.requeue.mock.calls[0][1].busyRetries).toBe(12);
    });

    it('records a failure (with a Re-run hint) instead of looping forever once the cap is reached', async () => {
      const d = deps({ run: vi.fn().mockResolvedValue(BUSY) } as never);
      const out = await handlePortfolioMessage({ applicationId: 'A0611', busyRetries: MAX_BUSY_RETRIES }, { deliveryCount: 1 }, d);
      expect(out).toEqual({ outcome: 'gave_up' });
      expect(d.giveUp).toHaveBeenCalledWith('A0611');
      expect(d.requeue).not.toHaveBeenCalled();
    });

    it('falls back to the queue\'s own redelivery (throws) if the hand-back could not be sent, rather than losing the review', async () => {
      const d = deps({
        run: vi.fn().mockResolvedValue(BUSY),
        requeue: vi.fn().mockResolvedValue({ enqueued: false, error: 'queue did not respond within 8s' }),
      } as never);
      await expect(handlePortfolioMessage({ applicationId: 'A0611' }, { deliveryCount: 1 }, d)).rejects.toThrow(/queue did not respond/);
    });
  });
});
