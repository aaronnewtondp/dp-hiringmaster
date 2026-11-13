// Imports the "Company Lists" tab of the colleague's sourcing workbook ("Sourcing plans.xlsx") into the company directory.
//
//   npx tsx src/scripts/importSourcingWorkbook.ts <path-to-xlsx> [--dry-run]
//
// One record per company however many lists/cities it is in (duplicates merge, see utils/sourcingOutreach.ts mergeCompanyRows). Idempotent: a
// company already in the directory only gains the lists and cities it did not have; nothing typed in the app (notes, exclusions) is overwritten.
// The plan templates are NOT read from the workbook: they are seeded from utils/sourcingPlanTemplates.ts the first time Sourcing is opened.
import 'dotenv/config';
import * as XLSX from 'xlsx';
import { pool } from '../db/index.js';
import { importCompanies } from '../services/sourcingCompanies.js';
import { mergeCompanyRows, parseCompanyRows } from '../utils/sourcingOutreach.js';

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) { console.error('Usage: tsx src/scripts/importSourcingWorkbook.ts <path-to-xlsx> [--dry-run]'); process.exit(1); }
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets['Company Lists'] ?? wb.Sheets[wb.SheetNames.find(n => /compan/i.test(n)) ?? ''];
  if (!sheet) { console.error(`No "Company Lists" sheet. Sheets: ${wb.SheetNames.join(', ')}`); process.exit(1); }
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' }).map(r => (r as unknown[]).map(c => String(c ?? '')));
  const parsed = parseCompanyRows(table);
  if (parsed.fatal) { console.error(parsed.fatal); process.exit(1); }
  const merged = mergeCompanyRows(parsed.rows);
  console.log(`${parsed.rows.length} rows → ${merged.length} companies in ${new Set(parsed.rows.map(r => r.list)).size} lists (${parsed.rejected.length} rows skipped)`);
  if (flags.includes('--dry-run')) { console.log('Dry run: nothing written.'); return; }
  const r = await importCompanies(table, { userId: null } as never);
  console.log(`Imported: ${r.companies_new} new, ${r.companies_merged} merged into existing records, ${r.lists} lists.`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
