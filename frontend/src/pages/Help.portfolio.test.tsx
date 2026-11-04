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

// The frontend is a browser package and has no @types/node. These three built-ins are used only to READ source files as text (see the
// last describe block), so they are left untyped instead of adding a dependency.
// @ts-ignore TS2307 until @types/node is added to the frontend
import fs from 'node:fs';
// @ts-ignore TS2307 until @types/node is added to the frontend
import path from 'node:path';
// @ts-ignore TS2307 until @types/node is added to the frontend
import { fileURLToPath } from 'node:url';

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

  it('says what a re-run does to the earlier score: a score from the new run replaces it, and only a run with nothing to score keeps it', () => {
    const text = flat(answer());
    expect(text).toMatch(/For Head of Marketing, a Re-run reviews the answer again and replaces the score/);
    expect(text).toMatch(/If the Re-run ends with nothing that can be scored this time \(for example the links are now private, or the answer is now text only\), the earlier score stays in the average and the Portfolio column shows it with a small red dot/);
    // the old wording ("finds nothing new") read as if re-reviewing the same work would leave the score alone
    expect(text).not.toMatch(/finds nothing new/);
  });

  it('says the designer review holds a missing link against the candidate only when the resume could be read, and how a deck-only or bot-blocked portfolio is treated', () => {
    const text = flat(answer());
    expect(text).toMatch(/This applies only if the resume could be read; if it could not, the Portfolio dimension is left out/);
    expect(text).toMatch(/A portfolio that is only a PDF or slide-deck link is not opened automatically: it gets a low score of 3 and a flag asking you to review it by hand/);
    expect(text).toMatch(/A site that blocks automated access is not held against the candidate and is not scored/);
    // all of that is in the designer part
    expect(text.indexOf('only a PDF or slide-deck link')).toBeLessThan(text.indexOf('Head of Marketing.'));
  });

  it('says video and Instagram links are only background beside real work, and are never scored on their own', () => {
    const text = flat(answer());
    expect(text).toMatch(/YouTube, Vimeo and Loom links and Instagram links are never opened as work/);
    expect(text).toMatch(/only as background beside real work — if those are the only links, nothing is scored/);
    expect(text).toMatch(/LinkedIn is never opened/);
    // the old sentence listed them as if they earned a score
    expect(text).not.toMatch(/YouTube and Vimeo links are judged from the title/);
  });

  it('says only a review that has links to open is provisional; an empty or text-only answer is settled at once', () => {
    const text = flat(answer());
    expect(text).toMatch(/When a review has to open links, it runs in the background/);
    expect(text).toMatch(/If there is nothing to open \(no link in the resume, or a blank or text-only answer\) the result is settled at once/);
  });
});

// ─── The figures in the portfolio answers, checked against the code that decides them ─────────────────────────────────
// Same idea as the last part of Help.test.tsx: the answers quote a score, a count and a threshold, and each is read as text from
// the file that decides it (the backend is a separate package, so it cannot be imported), so a change there fails here.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function grab(rel: string, re: RegExp): string[] {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`${rel} is missing: these checks compare the Help page with the code that decides each figure, so they need the whole repository checked out.`);
  const m = re.exec(fs.readFileSync(file, 'utf8'));
  if (!m) throw new Error(`${rel}: nothing matches ${re}. The code this check reads has moved or changed shape: update the check, do not drop it.`);
  return m.slice(1);
}
/** Opens one question and returns just its own answer as one whitespace-normalised string. */
function answerOf(question: RegExp): string {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Help /></QueryClientProvider>);
  const button = screen.getByRole('button', { name: question });
  fireEvent.click(button);
  const body = button.parentElement!.querySelector('.leading-relaxed');
  expect(body, `no answer opened for ${String(question)}`).not.toBeNull();
  return (body!.textContent ?? '').replace(/\s+/g, ' ').trim();
}
function said(text: string, re: RegExp): number {
  const m = re.exec(text);
  expect(m, `the answer no longer says ${re}`).not.toBeNull();
  return Number(m![1]);
}

describe('Help — the portfolio figures are the ones the review and the screens use', () => {
  it('a designer portfolio that is only a PDF or slide deck gets the score the review gives it', () => {
    const score = Number(grab('backend/src/services/portfolio/run.ts', /score: onlyFiles \? (\d+) : \d+,/)[0]);
    expect(said(answerOf(/How does the Portfolio review work/i), /it gets a low score of (\d+) and a flag/)).toBe(score);
  });

  it('the designer review judges as many criteria as the rubric has', () => {
    const block = grab('backend/src/services/portfolio/rubric.ts', /export const DESIGNER_CRITERIA[^=]*=\s*\[([\s\S]*?)\n\] as const;/)[0];
    const criteria = [...block.matchAll(/\{ id: '/g)].length;
    expect(criteria).toBeGreaterThan(0);
    expect(said(answerOf(/How does the Portfolio review work/i), /the hiring manager's (\d+) criteria/)).toBe(criteria);
  });

  it('Portfolio is the ninth dimension because the Scorecard Summary has eight ResumeIQ ones', () => {
    const block = grab('frontend/src/pages/ScorecardSummary.tsx', /const DIMENSIONS[^=]*=\s*\[([\s\S]*?)\n\];/)[0];
    const base = [...block.matchAll(/label: '/g)].length;
    const ORDINAL: Record<number, string> = { 9: 'ninth' };
    expect(ORDINAL[base + 1], `add the word for dimension ${base + 1} to this test`).toBeDefined();
    expect(answerOf(/How does the Portfolio review work/i)).toContain(`get a ${ORDINAL[base + 1]} ResumeIQ dimension`);
  });

  it('the Portfolio filter button quotes the threshold the screen applies, and "8 or more" follows from whole-number scores', () => {
    const min = Number(grab('frontend/src/pages/ScorecardSummary.tsx', /const PORTFOLIO_SCORE_FILTER_MIN = ([\d.]+);/)[0]);
    grab('backend/src/db/schema.sql', /score_portfolio\s+INTEGER/);   // the score is stored as a whole number, which is why 7.5 means 8 or more
    const t = answerOf(/What is My Tasks, and what is the Scorecard Summary table/i);
    expect(said(t, /Portfolio ≥ ([\d.]+)/)).toBe(min);
    expect(said(t, /scored ([\d.]+) or higher/)).toBe(min);
    expect(said(t, /so that means (\d+) or more/)).toBe(Math.ceil(min));
  });
});
