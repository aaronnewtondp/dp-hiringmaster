// ─── Manual (externally-authored) long-form JD importer ───────────────────────
// For a role whose long-form JD was written by hand outside this system (not
// condensed from the role's raw DB fields via jdContent.ts's normal
// generateJdContent()) — e.g. a JD a hiring manager or founder drafted
// directly as a PDF. This script:
//   1. Uploads that PDF as-is to the Drive JD folder — roles.jd_drive_link
//      points AT this exact file, not a system-rendered one.
//   2. Extracts its text and asks Claude to structure it into the same
//      generated_jd_content shape jdContent.ts's normal flow produces —
//      extraction only, never inventing content the source doesn't have
//      (extractJdContentFromText()) — so resumeIQ.ts's
//      buildRoleRequirementsSection() scores candidates against the real
//      external JD, not the short must_have_skills/nice_to_have_skills/
//      kpi_expectations DB fields it'd otherwise fall back to.
//   3. Renders ONLY the social JD (still system-rendered, from that same
//      structured content) and uploads it — roles.social_jd_drive_link.
//   4. Sets jd_source='manual', which roles.ts's auto-generate-on-Approve
//      trigger and POST /:id/regenerate-jd both check and refuse to
//      overwrite.
//
// Usage:
//   npx tsx src/scripts/importManualJd.ts <path-to-jd-pdf> <role-id>
//
// Idempotent-ish: safe to re-run for the same role with an updated PDF — it
// always overwrites jd_drive_link/social_jd_drive_link/generated_jd_content
// for that role (there's no "already imported" guard, unlike the
// auto-generate trigger, since re-running with a revised source PDF is the
// whole point of this script existing rather than the regenerate-jd route).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { query, queryOne, pool } from '../db/index.js';
import { extractPdfText, uploadJdPdf } from '../services/driveService.js';
import { extractJdContentFromText } from '../services/jdContent.js';
import { renderSocialJd } from '../services/pdf/socialJd.js';
import { Role } from '../types/index.js';

async function main() {
  const [, , pdfPath, roleId] = process.argv;
  if (!pdfPath || !roleId) {
    console.error('Usage: npx tsx src/scripts/importManualJd.ts <path-to-jd-pdf> <role-id>');
    process.exit(1);
  }

  const role = await queryOne<Role>('SELECT * FROM roles WHERE id = $1', [roleId]);
  if (!role) {
    console.error(`No role found with id ${roleId}`);
    process.exit(1);
  }

  const folderId = process.env.DRIVE_JD_FOLDER_ID;
  if (!folderId) {
    console.error('DRIVE_JD_FOLDER_ID is not set');
    process.exit(1);
  }

  console.log(`Importing manual JD for ${role.id} — ${role.title}`);

  const pdfBuffer = fs.readFileSync(path.resolve(pdfPath));
  const safeTitle = role.title.replace(/[^a-zA-Z0-9]+/g, '_');

  console.log('Uploading source PDF to Drive...');
  const longFormUpload = await uploadJdPdf(pdfBuffer, `JD_${role.id}_${safeTitle}.pdf`, folderId);

  console.log('Extracting text from source PDF...');
  const sourceText = await extractPdfText(pdfBuffer);
  if (!sourceText.trim()) {
    console.error('Extracted no text from the source PDF — aborting before any DB writes.');
    process.exit(1);
  }

  console.log('Structuring content for ResumeIQ + social JD (Claude extraction call)...');
  const content = await extractJdContentFromText(role, sourceText);
  if (!content) {
    console.error('Content extraction failed — aborting before any DB writes. jd_drive_link was NOT set.');
    process.exit(1);
  }

  console.log('Rendering social JD from extracted content...');
  const socialBuffer = await renderSocialJd(role, content);
  const socialUpload = await uploadJdPdf(socialBuffer, `Social_${role.id}_${safeTitle}.pdf`, folderId);

  await query(
    `UPDATE roles SET jd_drive_link=$1, social_jd_drive_link=$2, generated_jd_content=$3, jd_source='manual' WHERE id=$4`,
    [longFormUpload.webViewLink, socialUpload.webViewLink, JSON.stringify(content), role.id]
  );
  await query(
    `INSERT INTO activity_log (role_id, event_type, event_detail, performed_by_name)
     VALUES ($1, 'JD Generated', $2, 'System (manual JD import)')`,
    [role.id, `Manually-provided long-form JD linked for ${role.title}; social JD generated from it`]
  );

  console.log('Done.');
  console.log('Long-form JD:', longFormUpload.webViewLink);
  console.log('Social JD:   ', socialUpload.webViewLink);
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
