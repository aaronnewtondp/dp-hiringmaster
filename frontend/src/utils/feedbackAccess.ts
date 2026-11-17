/**
 * Who may submit feedback (or record an Assignment outcome) on an interview round. Mirrors the backend's rule in
 * `PATCH /interviews/:id/feedback` (backend/src/routes/interviews.ts) exactly: HR-tier may always; anyone else only when their
 * e-mail is on the round's `interviewer_emails` (case-insensitive) — or when nobody was assigned at all (no list, or an empty one),
 * which leaves the round open to every persona. The server still enforces it; this only keeps the page from offering a button
 * that is certain to be refused.
 */
export function canSubmitRoundFeedback(
  user: { persona: string; email: string } | null | undefined,
  round: { interviewer_emails?: string[] | null },
): boolean {
  if (!user) return false;
  if (user.persona === 'hr_recruiter' || user.persona === 'leadership' || user.persona === 'super_admin') return true;
  const emails = round.interviewer_emails;
  if (!Array.isArray(emails) || emails.length === 0) return true;
  return emails.some(e => typeof e === 'string' && e.toLowerCase() === user.email.toLowerCase());
}
