import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Several rules exist twice because the backend and the frontend are separate packages (and separate Vercel projects) with no shared-code mechanism. Nothing
// failed when one copy changed and the other did not. This file is the guard. It never imports from ../frontend (backend/tsconfig has rootDir=src, so that would
// break `tsc`): the frontend files are READ AS TEXT. Constants are compared by parsing their declarations; the four pure frontend utilities (hiringManagers,
// rejectionReasons, budget) are transpiled and evaluated in an empty vm context, which is only possible while they import nothing, so the loader refuses a file
// that has gained an import (the day that happens this test says so, instead of quietly testing less). schema.sql is read as text too: its latest CHECK
// constraints must agree with the TypeScript unions.
vi.mock('../db/index.js', () => ({ query: vi.fn(), queryOne: vi.fn(), transaction: vi.fn(), pool: {} }));

import { STAGE_ORDER } from '../types/index.js';
import { FEEDBACK_DUE_ACTION_TYPES } from '../jobs/slaChecker.js';
import { LOW_PIPELINE_MAX_SHORTLISTED, LOW_PIPELINE_MAX_ACTIVE } from './lowPipeline.js';
import { SOURCING_CHANNELS } from './sourcingConfig.js';
import { splitHiringManagerNames, isNamedHiringManager } from './hiringManagers.js';
import { REASON_DELIMITER, splitReasons, joinReasons, normalizeReasons } from './rejectionReasons.js';
import { parseCtcBandMax, isSeverelyOverBudget, OVER_BUDGET_TOLERANCE } from './budget.js';

const ROOT = path.resolve(__dirname, '../../..');
function read(rel: string): string {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`${rel} is missing: this guard compares the backend with the frontend and the schema, so it needs the whole repository checked out.`);
  return fs.readFileSync(file, 'utf8');
}

const FRONTEND_TYPES = read('frontend/src/types/index.ts');
const BACKEND_TYPES = read('backend/src/types/index.ts');
const PORTFOLIO_TYPES = read('backend/src/services/portfolio/types.ts');
const SCHEMA = read('backend/src/db/schema.sql');

// ── text parsers ────────────────────────────────────────────────────────────────────────────────────────────────────
const quoted = (block: string): string[] => [...block.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map(m => m[1] ?? m[2]);
const nonEmpty = (what: string, list: string[]): string[] => {
  if (!list.length) throw new Error(`parsed nothing for ${what}: the declaration moved or changed shape, so this guard would compare two empty lists`);
  return list;
};
function arrayConst(src: string, name: string): string[] {
  const m = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?\\s*;`).exec(src);
  return nonEmpty(`const ${name}`, m ? quoted(m[1].replace(/\/\/.*$/gm, '')) : []);
}
function unionType(src: string, name: string): string[] {
  const m = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(src);
  return nonEmpty(`type ${name}`, m ? quoted(m[1]) : []);
}
/** The values of the LAST `ADD CONSTRAINT <name>` in schema.sql (it is an append-only history of ALTERs: the last one is the live one). */
function namedCheck(name: string): string[] {
  const at = SCHEMA.lastIndexOf(`ADD CONSTRAINT ${name}`);
  if (at < 0) return nonEmpty(`constraint ${name}`, []);
  return nonEmpty(`constraint ${name}`, quoted(SCHEMA.slice(at, SCHEMA.indexOf(';', at))));
}
/** The values of the inline `<column> ... CHECK (<column> IN (...))` of a table's CREATE TABLE. */
function inlineCheck(table: string, column: string): string[] {
  const start = SCHEMA.indexOf(`CREATE TABLE ${table} (`);
  const m = new RegExp(`\\n\\s*${column}\\s+TEXT[^\\n]*CHECK \\(${column} IN \\(([\\s\\S]*?)\\)\\)`).exec(SCHEMA.slice(start));
  return nonEmpty(`${table}.${column} CHECK`, start >= 0 && m ? quoted(m[1]) : []);
}
const sorted = (l: readonly string[]) => [...l].sort();

// ── evaluating a pure frontend module from its text ─────────────────────────────────────────────────────────────────
function loadFrontend(rel: string): Record<string, any> {
  const src = read(rel);
  if (/^\s*import\s/m.test(src) || /\brequire\s*\(/.test(src) || /^\s*export\s+[^;]*\bfrom\s+['"]/m.test(src)) {
    throw new Error(`${rel} now imports something. This guard evaluates it in an empty context, so it can no longer be loaded as text: extend the guard instead of dropping it.`);
  }
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(js, { exports }, { timeout: 5000 });
  return exports;
}
// Results cross a realm boundary: compare plain JSON copies.
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v === undefined ? null : v));

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('pipeline stages: frontend STAGES = backend STAGE_ORDER, in order', () => {
  const STAGES = arrayConst(FRONTEND_TYPES, 'STAGES');

  it('are the same eleven stages in the same order', () => {
    expect(STAGES).toEqual(STAGE_ORDER);
    expect(STAGE_ORDER).toHaveLength(11);
  });
  it('start at "Applied and Screened" and end at "Joined"', () => {
    expect(STAGE_ORDER[0]).toBe('Applied and Screened');
    expect(STAGE_ORDER[STAGE_ORDER.length - 1]).toBe('Joined');
  });
  it.each(['Applied', 'Resume Review', 'Shortlisted'])('the retired stage name "%s" is in neither list', retired => {
    expect(STAGES).not.toContain(retired);
    expect(STAGE_ORDER).not.toContain(retired);
  });
  it('has no duplicates', () => {
    expect(new Set(STAGE_ORDER).size).toBe(STAGE_ORDER.length);
  });
});

describe('personas', () => {
  const FRONTEND = unionType(FRONTEND_TYPES, 'Persona');
  const BACKEND = unionType(BACKEND_TYPES, 'Persona');
  const PERSONAS_RECORD = (() => {
    const m = /export const PERSONAS: Record<Persona, string> = \{([\s\S]*?)\};/.exec(FRONTEND_TYPES);
    return nonEmpty('PERSONAS', m ? [...m[1].matchAll(/(\w+):\s*'([^']*)'/g)].flatMap(x => [x[1], x[2]]) : []);
  })();

  it('are the same four in the frontend type, the backend type and the users.persona CHECK', () => {
    expect(sorted(FRONTEND)).toEqual(sorted(BACKEND));
    expect(sorted(namedCheck('users_persona_check'))).toEqual(sorted(BACKEND));
    expect(sorted(BACKEND)).toEqual(['hiring_manager', 'hr_recruiter', 'leadership', 'super_admin']);
  });
  it('the retired "interviewer" persona is gone everywhere', () => {
    expect(FRONTEND).not.toContain('interviewer');
    expect(BACKEND).not.toContain('interviewer');
    expect(namedCheck('users_persona_check')).not.toContain('interviewer');
  });
  it('the frontend label table has an entry for every persona and shows hr_recruiter as "HR/Admin"', () => {
    const keys = PERSONAS_RECORD.filter((_, i) => i % 2 === 0);
    const labels = Object.fromEntries(PERSONAS_RECORD.reduce<string[][]>((a, v, i) => (i % 2 === 0 ? [...a, [v]] : (a[a.length - 1].push(v), a)), []));
    expect(sorted(keys)).toEqual(sorted(BACKEND));
    expect(labels.hr_recruiter).toBe('HR/Admin');
    expect(labels.hiring_manager).toBe('Hiring Manager');
    expect(labels.leadership).toBe('Leadership');
    expect(labels.super_admin).toBe('Super Admin');
  });
});

describe('status vocabularies: frontend = backend = schema.sql', () => {
  it('application status', () => {
    const f = unionType(FRONTEND_TYPES, 'ApplicationStatus');
    expect(f).toEqual(unionType(BACKEND_TYPES, 'ApplicationStatus'));
    expect(f).toEqual(arrayConst(FRONTEND_TYPES, 'APPLICATION_STATUSES'));
    expect(sorted(namedCheck('applications_status_check'))).toEqual(sorted(f));
    expect(f).not.toContain('On Hold');
  });
  it('role status', () => {
    const b = unionType(BACKEND_TYPES, 'RoleStatus');
    expect(arrayConst(FRONTEND_TYPES, 'ROLE_STATUSES')).toEqual(b);
    expect(sorted(inlineCheck('roles', 'status'))).toEqual(sorted(b));
  });
  it('recruiter screening status', () => {
    const b = unionType(BACKEND_TYPES, 'ScreeningStatus');
    expect(unionType(FRONTEND_TYPES, 'ScreeningStatus')).toEqual(b);
    expect(sorted(inlineCheck('applications', 'recruiter_screening_status'))).toEqual(sorted(b));
  });
  it('priority', () => {
    const b = unionType(BACKEND_TYPES, 'Priority');
    expect(unionType(FRONTEND_TYPES, 'Priority')).toEqual(b);
    expect(arrayConst(FRONTEND_TYPES, 'PRIORITIES')).toEqual(b);
    expect(sorted(inlineCheck('roles', 'priority'))).toEqual(sorted(b));
  });
  it('ResumeIQ recommendation', () => {
    expect(unionType(FRONTEND_TYPES, 'Recommendation')).toEqual(unionType(BACKEND_TYPES, 'Recommendation'));
  });
  it('portfolio review status and kind', () => {
    const status = unionType(PORTFOLIO_TYPES, 'PortfolioStatus');
    expect(unionType(FRONTEND_TYPES, 'PortfolioStatus')).toEqual(status);
    expect(sorted(namedCheck('applications_portfolio_status_check'))).toEqual(sorted(status));
    expect(sorted(namedCheck('roles_portfolio_review_kind_check'))).toEqual(sorted(unionType(FRONTEND_TYPES, 'PortfolioReviewKind')));
  });
  it('the portfolio criterion verdicts', () => {
    expect(unionType(FRONTEND_TYPES, 'CriterionVerdict')).toEqual(unionType(PORTFOLIO_TYPES, 'CriterionVerdict'));
  });
});

describe('other constants mirrored by hand', () => {
  it('the Feedback Due action types (My Tasks splits its lists on them)', () => {
    expect(arrayConst(FRONTEND_TYPES, 'FEEDBACK_DUE_ACTION_TYPES')).toEqual(FEEDBACK_DUE_ACTION_TYPES);
  });
  it('the Low Pipeline thresholds', () => {
    const num = (name: string) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(FRONTEND_TYPES)?.[1]);
    expect(num('LOW_PIPELINE_MAX_SHORTLISTED')).toBe(LOW_PIPELINE_MAX_SHORTLISTED);
    expect(num('LOW_PIPELINE_MAX_ACTIVE')).toBe(LOW_PIPELINE_MAX_ACTIVE);
  });
  it('the recruitment channels are the sourcing channels (same five names; the order differs by design)', () => {
    expect(sorted(arrayConst(FRONTEND_TYPES, 'RECRUITMENT_CHANNELS'))).toEqual(sorted(SOURCING_CHANNELS));
  });
});

// ── the pure utilities, evaluated from the frontend's own text ──────────────────────────────────────────────────────
describe('hiringManagers: frontend = backend over one table', () => {
  const fe = loadFrontend('frontend/src/utils/hiringManagers.ts');

  const FIELDS: Array<string | null | undefined> = [
    'Test One', 'TEST ONE', '  Test   One  ', 'Test One', 'Test​One', 'Test　One', 'Test﻿One', 'Test One', 'Test\tOne', 'Test\nOne',
    'Test One, Test Two', 'Test One,Test Two', 'Test One ,Test Two', 'Test One , Test Two', 'Test One; Test Two', 'Test One;Test Two', 'Test One & Test Two',
    'Test One&Test Two', 'Test One and Test Two', 'Test One  and  Test Two', 'Test One AND Test Two', 'Test One And Test Two', 'Test One, and Test Two',
    'A, B, and C', 'A, B and C', 'A; B & C', 'and Test One', 'And Test One', 'Test One and', 'Test One,', ',Test One', ',,Test One,,', 'Test One, , Test Two',
    'Sandra Handley', 'Handley and Sandra', 'Sandra Handley and Test Two', 'Brandon', 'Alexander', 'Alex', 'Pat Quill', 'Quill, Pat', 'Pat',
    'Pat Quill, Robin Vale', 'Pat Quill and Robin Vale', 'First Last-Name, Other O’Brien', 'Test One ; ; Test Two',
    ',;&', ';', '&', ' ', '', null, undefined, 'x'.repeat(2000), 'Test One, '.repeat(200), ' '.repeat(100_000) + 'Test One',
  ];
  const USERS: Array<string | null | undefined> = [
    'Test One', 'test one', 'TEST ONE', '  Test   One ', 'Test One', 'Test Two', 'Pat', 'Pat Quill', 'Quill', 'Quill, Pat', 'Alexander', 'Alex',
    'Robin Vale', ' Pat   Quill ', 'Handley', 'Sandra Handley', 'Sandra', 'A', 'B', 'C', ' ', '', null, undefined,
  ];

  it('the frontend file exports the three names the app uses', () => {
    expect(typeof fe.splitHiringManagerNames).toBe('function');
    expect(typeof fe.isNamedHiringManager).toBe('function');
    expect(typeof fe.HIRING_MANAGER_FIELD_HINT).toBe('string');
  });

  it('splitHiringManagerNames gives the same people for every field in the table', () => {
    for (const f of FIELDS) expect(plain(fe.splitHiringManagerNames(f)), JSON.stringify(String(f).slice(0, 40))).toEqual(splitHiringManagerNames(f));
  });

  it('isNamedHiringManager gives the same answer for every user x field pair', () => {
    let pairs = 0; let trues = 0;
    for (const f of FIELDS) for (const u of USERS) {
      expect(fe.isNamedHiringManager(u, f), `user ${JSON.stringify(u)} in ${JSON.stringify(String(f).slice(0, 40))}`).toBe(isNamedHiringManager(u, f));
      pairs++; if (isNamedHiringManager(u, f)) trues++;
    }
    // The table must contain both outcomes in quantity, or "they agree" proves little.
    expect(pairs).toBe(FIELDS.length * USERS.length);
    expect(trues).toBeGreaterThan(20);
    expect(pairs - trues).toBeGreaterThan(200);
  });

  describe('and the rule itself, pinned on the backend copy (the frontend copy must then agree)', () => {
    it.each([
      ['Pat Quill, Robin Vale', ['Pat Quill', 'Robin Vale']],
      ['A, B, and C', ['A', 'B', 'C']],
      ['A and B', ['A', 'B']],
      ['A; B & C', ['A', 'B', 'C']],
      ['Sandra Handley', ['Sandra Handley']],
      ['Quill, Pat', ['Quill', 'Pat']],
      ['  Test   One  ', ['Test One']],
      [',;&', []], ['', []], [null, []], [undefined, []],
    ] as Array<[string | null | undefined, string[]]>)('%j splits to %j in both', (field, expected) => {
      expect(splitHiringManagerNames(field)).toEqual(expected);
      expect(plain(fe.splitHiringManagerNames(field))).toEqual(expected);
    });

    it.each([
      ['Test One', 'Test One, Test Two', true],
      ['test  one', 'Test One, Test Two', true],
      ['Test Two', 'Test One and Test Two', true],
      ['Pat', 'Pat Quill', false],
      ['Alex', 'Alexander', false],
      ['Quill, Pat', 'Quill, Pat', true],
      ['Test One', null, false], [null, 'Test One', false], ['', 'Test One', false], [' ', 'Test One', false],
    ] as Array<[string | null, string | null, boolean]>)('user %j in field %j is %s in both', (user, field, expected) => {
      expect(isNamedHiringManager(user, field)).toBe(expected);
      expect(fe.isNamedHiringManager(user, field)).toBe(expected);
    });
  });
});

describe('rejectionReasons: frontend = backend', () => {
  const fe = loadFrontend('frontend/src/utils/rejectionReasons.ts');

  it('the delimiter is the same', () => {
    expect(fe.REASON_DELIMITER).toBe(REASON_DELIMITER);
    expect(REASON_DELIMITER).toBe('; ');
  });

  it.each([
    [null], [undefined], [''], ['A'], ['A; B'], ['A;B'], [' A ;  B '], [';;'], ['A; ; B'], ['A, B'], ['A; B; C; D'], ['  '],
  ])('splitReasons(%j) agrees', stored => {
    expect(plain(fe.splitReasons(stored as string | null | undefined))).toEqual(splitReasons(stored as string | null | undefined));
  });

  it('a stored reason string splits back into the list that built it, in both', () => {
    const reasons = ['Missing mandatory skill', 'Communication gap', 'Role cancelled / on hold'];
    expect(splitReasons(joinReasons(reasons))).toEqual(reasons);
    expect(plain(fe.splitReasons(joinReasons(reasons)))).toEqual(reasons);
  });

  it('the legacy single string the frontend sends is exactly what the backend stores for the same reasons', () => {
    for (const reasons of [['A'], ['A', 'B'], ['Missing mandatory skill', 'Communication gap', 'Compensation mismatch']]) {
      const sent = fe.reasonFields(reasons);
      expect(sent.rejection_reason_cat).toBe(joinReasons(normalizeReasons(reasons)));
      expect(plain(sent.rejection_reason_cats)).toEqual(reasons);
    }
    expect(plain(fe.reasonFields([]))).toEqual({});
  });
});

describe('budget: frontend = backend', () => {
  const fe = loadFrontend('frontend/src/utils/budget.ts');

  it('the over-budget tolerance is the same 15%', () => {
    expect(fe.OVER_BUDGET_TOLERANCE).toBe(OVER_BUDGET_TOLERANCE);
    expect(OVER_BUDGET_TOLERANCE).toBe(1.15);
  });

  const BANDS: Array<string | null | undefined> = ['18-24 LPA', '5-9 ', '12.5 - 15.75 lakh', 'Upto 30', '100', '0', '1,200', 'abc', '', ' ', null, undefined, '10', '7 to 9 LPA'];
  it.each(BANDS.map(b => [b]))('parseCtcBandMax(%j) agrees', band => {
    expect(fe.parseCtcBandMax(band)).toBe(parseCtcBandMax(band));
  });

  it('isSeverelyOverBudget agrees on a grid that includes the 15% boundary, missing values and zero', () => {
    const expected = [undefined, null, 0, 1, 9, 10, 11, 11.49, 11.5, 11.51, 12, 20.7, 20.71, 27.6, 100, 1_000_000];
    for (const band of BANDS) for (const e of expected) {
      expect(fe.isSeverelyOverBudget(e, band), `expected ${e} band ${JSON.stringify(band)}`).toBe(isSeverelyOverBudget(e, band));
    }
  });

  it('the pinned rule: at or past band max x 1.15 is severe; a missing figure is never severe', () => {
    expect(isSeverelyOverBudget(100, '18-24 LPA')).toBe(true);
    expect(isSeverelyOverBudget(24, '18-24 LPA')).toBe(false);
    expect(isSeverelyOverBudget(27.6, '18-24 LPA')).toBe(true);
    expect(isSeverelyOverBudget(null, '18-24 LPA')).toBe(false);
    expect(isSeverelyOverBudget(30, null)).toBe(false);
  });
});

describe('the guard itself', () => {
  it('refuses to evaluate a frontend file that imports something (so it can never silently test less)', () => {
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p).endsWith(path.join('utils', 'budget.ts')) ? "import { x } from './x';\nexport const y = 1;" : (real as (...a: unknown[]) => unknown)(p, ...rest)) as typeof fs.readFileSync);
    try { expect(() => loadFrontend('frontend/src/utils/budget.ts')).toThrow(/now imports something/); } finally { spy.mockRestore(); }
  });

  it('refuses to compare two empty lists when a declaration cannot be found', () => {
    expect(() => arrayConst('export const OTHER = [];', 'STAGES')).toThrow(/parsed nothing/);
    expect(() => unionType('export type Other = string;', 'Persona')).toThrow(/parsed nothing/);
  });
});
