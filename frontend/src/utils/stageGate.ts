// The two refusals of POST /applications/:id/stage that a written `skip_reason` bypasses (backend/src/routes/applications.ts): an
// interview/assignment round with no feedback yet, and leaving Reference Check with no reference on file. Every screen that moves a stage
// (StageChangeModal, the bulk Change Stage on Active Candidates) recognises them HERE, by the start of the server's message: one definition.
// Every other refusal (HR access required, the over-budget reason, unknown stage…) is not skippable and must stay a plain failure.
export const SKIPPABLE_STAGE_GATE = /^(Feedback is still pending for|Add at least one reference check before advancing)/;

export const isSkippableStageGate = (message: string | undefined | null): boolean => !!message && SKIPPABLE_STAGE_GATE.test(message);

/** The `error` text of an axios failure from our API, or undefined. */
export const apiErrorMessage = (err: unknown): string | undefined =>
  (err as { response?: { data?: { error?: string } } } | null | undefined)?.response?.data?.error;
