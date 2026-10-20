// One explanation for the Gender column, shared by the three independent candidate tables (Active Candidates, Archived
// Pipeline, Ready for Review) so the three info markers can never drift apart. Facts: backend/src/utils/genderClassifier.ts
// (auto-tag at creation, NULL = unknown on purpose) and the absence of any screen that edits the field.
export const GENDER_COLUMN_INFO =
  "M or F, worked out automatically from the candidate's name when they were added: a best guess, not a verified fact. A " +
  "dash means Unknown: an unrecognised or genuinely unisex name is left untagged on purpose rather than guessed. It can't " +
  "be edited from these screens; the Gender filter's \"Not tagged\" option finds the dashes.";
