import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The Portfolio review answer on the Help page: what it says about a criterion the work does not show, and about a link
// nobody could open, has to match what the review really does to the score.
vi.mock('../services/api.ts', () => ({ sourcingApi: { status: async () => ({ data: { enabled: false } }) } }));
vi.mock('../contexts/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Aaron Newton', email: 'a@x.com', persona: 'hr_recruiter' } }),
}));

import Help from './Help.tsx';

function answer(): HTMLElement {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Help /></QueryClientProvider>);
  const question = screen.getByRole('button', { name: /How does the Portfolio review work/i });
  fireEvent.click(question);
  // the answer is the region the question button controls
  const region = document.getElementById(question.getAttribute('aria-controls') ?? '') ?? question.parentElement!.parentElement!;
  return region as HTMLElement;
}
const flat = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ');

describe('Help — the Portfolio review answer', () => {
  it('says plainly that "Not evidenced" on what the work should show lowers the score, and is not neutral', () => {
    const text = flat(answer());
    expect(text).toMatch(/"Not evidenced" is not an accusation/);
    expect(text).toMatch(/it is not neutral either: on what the work should show it counts for less than "Partly" and lowers the score/);
    // the old wording said it was only "not treated as a concern", which read as no penalty at all
    expect(text).not.toMatch(/only means the work doesn't show it/);
    expect(text).not.toMatch(/it is not treated as a concern about the candidate/);
  });

  it('says the criteria a portfolio cannot prove are left out of the maths, for Head of Marketing', () => {
    const text = flat(answer());
    // there are two exceptions, not one: the corroboration-only criteria and the personal-role criterion
    expect(text).toMatch(/For Head of Marketing there are two exceptions\. The few criteria a portfolio can rarely prove/);
    expect(text).not.toMatch(/there is one exception/);
    expect(text).toMatch(/are left out of the maths unless the work itself clearly shows them, so missing or partial evidence of those never lowers the score/);
  });

  it('says what "Personal role shown" does to the score: it counts only when clear, and "Partly" and "Not evidenced" both leave it out', () => {
    const text = flat(answer());
    expect(text).toMatch(/"Personal role shown" — whether the candidate's own part in the work is evidenced — only counts when it is clear either way/);
    expect(text).toMatch(/a named credit or an explicit first-person role raises the score, a different person credited \(or a claim the work contradicts\) lowers it/);
    expect(text).toMatch(/"Partly" or "Not evidenced" there \(a plausible owner, or a brand page with no credit\) leaves it out of the maths altogether/);
    expect(text).toMatch(/A criterion the reviewer could not assess at all is left out too/);
  });

  it('lists "the material could not be assessed" among the Head of Marketing outcomes that are not scored', () => {
    const text = flat(answer());
    expect(text).toMatch(/a link a machine cannot open, or work the review could not assess \(unreadable, or in a language it cannot judge\) is not scored/);
    // and that sentence is in the Head of Marketing part, not the designer's
    expect(text.indexOf('could not assess (unreadable, or in a language it cannot judge) is not scored')).toBeGreaterThan(text.indexOf('Head of Marketing.'));
  });

  it('says a link that cannot be opened is never held against the candidate — in the Head of Marketing part, not the designer\'s', () => {
    const text = flat(answer());
    expect(text).toMatch(/A link that cannot be opened is never held against the candidate/);
    // the designer part still says a dead or private portfolio lowers the score: both statements are true of their own role
    expect(text).toMatch(/Designer roles\..*A missing portfolio link, or a dead or private one, is a concern and lowers the score\./);
    expect(text.indexOf('A link that cannot be opened is never held against the candidate')).toBeGreaterThan(text.indexOf('Head of Marketing.'));
  });

  it('does not promise the Portfolio column shows coverage or confidence — those are inside the review', () => {
    const text = flat(answer());
    expect(text).toMatch(/Inside the review \(under View Highlights and Summary, or on the candidate's page\) the score is shown with how many of the links it is based on and a confidence level/);
    expect(text).toMatch(/The Portfolio column shows the score on its own; hover a dash to see why there is none/);
    expect(text).not.toMatch(/Every score is shown with how many of the links/);
  });

  it('says what a re-run that finds nothing new does to the earlier score', () => {
    expect(flat(answer())).toMatch(/if a Re-run finds nothing new, the earlier score stays in the average and the Portfolio column shows it with a small red dot/);
  });
});
