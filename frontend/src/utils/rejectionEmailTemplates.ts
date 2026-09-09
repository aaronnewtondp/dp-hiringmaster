import { REJECTION_REASONS } from '../types/index.ts';

// Candidate-facing copy never exposes the literal internal reason category —
// industry norm for rejection emails is a warm, generic explanation
// regardless of the true internal reason (avoids sounding blunt/legally
// risky over things like "Cultural / values concern"). Each entry is just
// varied enough in its opening line to not feel like one copy-pasted email
// reused verbatim across every rejection reason.
const REASON_OPENERS: Record<string, string> = {
  'Missing mandatory skill':                    "after a close review, we found the role calls for some specific technical skills that weren't reflected in your background",
  'Below experience threshold':                 'this particular role calls for a level of experience beyond what your background currently reflects',
  'Assignment performance insufficient':        "after reviewing your assignment submission, we've decided to move forward with other candidates for this role",
  'Communication gap':                          "based on our conversations so far, we felt the role needs a slightly different communication style than what we experienced",
  'Compensation mismatch':                      "we weren't able to align on compensation expectations for this role",
  'Short average tenure':                       "we're looking for a slightly different profile in terms of career trajectory for this particular role",
  'Cultural / values concern':                  "your background and ours weren't quite the right fit for this particular role",
  'Role filled — other candidate preferred':    "we've decided to move forward with another candidate whose background more closely matches what we're looking for right now",
  'Role cancelled / on hold':                   "the role itself has been paused/cancelled on our end — this is unrelated to your candidacy",
};

export interface RejectionDraft {
  subject: string;
  body: string;
}

// candidateName is either the real name (single-candidate flow) or the
// literal '{{candidate_name}}' token (bulk flow — interpolated per-recipient
// right before send); same for roleTitle.
export function buildRejectionDraft(reasonCat: string, candidateName: string, roleTitle: string): RejectionDraft {
  const opener = REASON_OPENERS[reasonCat] || "after careful consideration, we've decided not to move forward with your application for this role";
  return {
    subject: `Update on your application — ${roleTitle}`,
    body: `Hi ${candidateName},\n\n` +
      `Thank you for taking the time to apply for the ${roleTitle} role at DigitalPaani, and for the time you invested throughout the process.\n\n` +
      `After careful consideration, we've decided not to move forward with your candidacy for this role — ${opener}.\n\n` +
      `This isn't a reflection of your overall abilities, and we'd encourage you to apply again for a role that's a closer match in the future. We wish you the very best in your search.\n\n` +
      `Warm regards,\nDigitalPaani Hiring Team`,
  };
}

// Guard used by the UI to only ever offer this for a real REJECTION_REASONS
// value (defensive — the reason dropdown already only offers these).
export const isKnownRejectionReason = (reasonCat: string) => REJECTION_REASONS.includes(reasonCat);

// Bulk flows share one edited template across N different candidates —
// this fills in the real name/role per recipient immediately before send.
export function interpolateRejectionDraft(draft: RejectionDraft, candidateName: string, roleTitle: string): RejectionDraft {
  const fill = (s: string) => s.split('{{candidate_name}}').join(candidateName).split('{{role_title}}').join(roleTitle);
  return { subject: fill(draft.subject), body: fill(draft.body) };
}
