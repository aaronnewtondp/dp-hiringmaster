// The stored owner of an SLA breach is the string 'HR / Recruiter' (backend/src/jobs/slaChecker.ts `Owner`). The persona is
// called "HR/Admin" everywhere a person reads it, so screens show this label for the owner while still sending the stored
// value to the API. 'Hiring Manager' is shown as it is.
export function ownerLabel(owner: string): string {
  return owner === 'HR / Recruiter' ? 'HR/Admin' : owner;
}
