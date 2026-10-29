import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role, Candidate } from '../types/index.js';

// The base 8-dimension ResumeIQ: what comes back from the model call (the JSON parse path and its fallback), what the request carries, how the profile is
// rendered into the prompt, the priority buckets and the Drive file-id extraction. The prompt's role section and today's date are pinned in resumeIQ.test.ts;
// this file covers the rest. Where the code passes a model reply through unchecked (no clamp, no recompute) the test says CURRENT BEHAVIOUR so a deliberate
// hardening later shows up as one clearly named test to change, not as a surprise.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: createMock }; } }));
// driveService keeps its own copy of extractDriveFileId; it is imported below only to prove the two copies agree.
vi.mock('./googleAuth.js', () => ({ getGoogleCredentials: () => ({ client_email: 'sa@example.iam', private_key: 'k' }) }));
vi.mock('googleapis', () => ({ google: { auth: { GoogleAuth: class {}, JWT: class {} }, drive: () => ({ files: {} }) } }));

import { extractDriveFileId, priorityBucketFromScore, scoreCandidate } from './resumeIQ.js';
import { extractDriveFileId as driveServiceExtract } from './driveService.js';

const DIMS = ['technical', 'experience', 'industryFit', 'cultureFit', 'roleAlignment', 'trajectory', 'leadership', 'communication'] as const;

function reply(obj: unknown) { return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }; }
function goodResult(score = 7) {
  const r: Record<string, unknown> = {};
  for (const d of DIMS) r[d] = { score, note: `${d} note` };
  return { ...r, avgScore: score, strengths: ['s1', 's2', 's3'], redFlags: [], summary: 'Two short sentences.', recommendation: 'Yes' };
}

const candidate = { full_name: 'Synthetic Candidate' } as unknown as Candidate;
const role = { title: 'Synthetic Role', generated_jd_content: null } as unknown as Role;
const sent = () => createMock.mock.calls[0][0];
const promptOf = () => sent().messages[0].content as string;

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue(reply(goodResult()));
});

describe('scoreCandidate: reading the model reply', () => {
  it('a plain JSON reply is returned as-is with resumeRead added', async () => {
    const out = await scoreCandidate(candidate, role, 'resume text');
    expect(out).toEqual({ ...goodResult(), resumeRead: true });
  });

  it.each([
    ['a ```json fence', (j: string) => '```json\n' + j + '\n```'],
    ['a bare ``` fence', (j: string) => '```\n' + j + '\n```'],
    ['fences with surrounding blank lines and spaces', (j: string) => '\n\n  ```json\n' + j + '\n```  \n'],
    ['a fence opened but never closed', (j: string) => '```json\n' + j],
  ])('%s around the JSON is stripped and parsed', async (_n, wrap) => {
    createMock.mockResolvedValue(reply(wrap(JSON.stringify(goodResult(5)))));
    const out = await scoreCandidate(candidate, role, 'resume text');
    expect(out.avgScore).toBe(5);
    expect(out.technical).toEqual({ score: 5, note: 'technical note' });
    expect(out.redFlags).toEqual([]);
  });

  it('only the first text block is read; a leading non-text block is skipped', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'tool_use', id: 'x' }, { type: 'text', text: JSON.stringify(goodResult(6)) }, { type: 'text', text: 'ignored' }] });
    expect((await scoreCandidate(candidate, role, 'r')).avgScore).toBe(6);
  });

  describe('a reply that is not valid JSON falls back to the all-zero "scoring failed" result (and does not throw)', () => {
    const FALLBACK_FLAG = 'AI scoring returned invalid output — retry needed';
    it.each([
      ['plain prose', 'I could not score this candidate.'],
      ['prose before the JSON', 'Here is the JSON:\n' + JSON.stringify(goodResult())],
      ['JSON cut off mid-object (the truncation the 2048 token limit guards against)', JSON.stringify(goodResult()).slice(0, 120)],
      ['an empty string', ''],
      ['a trailing comma', '{"technical":{"score":1,"note":"x"},}'],
      ['single quotes', "{'technical':{'score':1}}"],
    ])('%s', async (_n, text) => {
      createMock.mockResolvedValue(reply(text));
      const out = await scoreCandidate(candidate, role, 'resume text');
      for (const d of DIMS) expect(out[d]).toEqual({ score: 0, note: 'Scoring failed' });
      expect(out.avgScore).toBe(0);
      expect(out.strengths).toEqual(['Unable to score', 'Unable to score', 'Unable to score']);
      expect(out.redFlags).toEqual([FALLBACK_FLAG]);
      expect(out.summary).toBe('Automated scoring failed; manual review required.');
      expect(out.recommendation).toBe('Maybe');
      expect(out.resumeRead).toBe(true);
    });

    it('the fallback still reports whether a resume was read', async () => {
      createMock.mockResolvedValue(reply('not json'));
      expect((await scoreCandidate(candidate, role, null)).resumeRead).toBe(false);
    });
  });

  it('CURRENT BEHAVIOUR: a reply with no text block is NOT the fallback: it parses as "{}" and returns only resumeRead (the caller then fails on result.technical)', async () => {
    createMock.mockResolvedValue({ content: [] });
    const out = await scoreCandidate(candidate, role, 'resume text');
    expect(out).toEqual({ resumeRead: true });
    expect((out as Record<string, unknown>).technical).toBeUndefined();
  });

  it('CURRENT BEHAVIOUR: the reply is trusted as-is: no clamp to 0-10, avgScore is not recomputed, a string score is passed through', async () => {
    const odd = { ...goodResult(2), technical: { score: 42, note: 'x' }, experience: { score: -3, note: 'x' }, industryFit: { score: '9', note: 'x' }, avgScore: 9.9 };
    createMock.mockResolvedValue(reply(odd));
    const out = await scoreCandidate(candidate, role, 'r');
    expect(out.technical.score).toBe(42);
    expect(out.experience.score).toBe(-3);
    expect(out.industryFit.score).toBe('9');
    expect(out.avgScore).toBe(9.9);
  });

  it('CURRENT BEHAVIOUR: extra keys in the reply are kept on the result', async () => {
    createMock.mockResolvedValue(reply({ ...goodResult(), unexpected: 'kept' }));
    expect(((await scoreCandidate(candidate, role, 'r')) as unknown as Record<string, unknown>).unexpected).toBe('kept');
  });

  it('the reply cannot set resumeRead: it is always what the caller supplied', async () => {
    createMock.mockResolvedValue(reply({ ...goodResult(), resumeRead: true }));
    expect((await scoreCandidate(candidate, role, null)).resumeRead).toBe(false);
  });

  it('an SDK error is not swallowed (the caller turns it into "scored: false")', async () => {
    createMock.mockRejectedValue(new Error('synthetic API failure'));
    await expect(scoreCandidate(candidate, role, 'r')).rejects.toThrow('synthetic API failure');
  });
});

describe('scoreCandidate: resumeRead', () => {
  it.each([
    ['text', true], ['  ', true], ['x', true], ['', false], [null, false], [undefined, false],
  ])('resume text %j gives resumeRead %s', async (text, expected) => {
    expect((await scoreCandidate(candidate, role, text as string | null | undefined)).resumeRead).toBe(expected);
  });
});

describe('scoreCandidate: the request', () => {
  it('uses claude-sonnet-4-5, max_tokens 2048 and exactly one user message', async () => {
    await scoreCandidate(candidate, role, 'r');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(sent().model).toBe('claude-sonnet-4-5');
    expect(sent().max_tokens).toBe(2048);
    expect(sent().messages).toHaveLength(1);
    expect(sent().messages[0].role).toBe('user');
  });

  it('asks for JSON only, 0-10 integers, a mean avgScore, three strengths and the four recommendation values', async () => {
    await scoreCandidate(candidate, role, 'r');
    const p = promptOf();
    expect(p).toContain('Return ONLY valid JSON, no markdown, no code fences');
    expect(p).toContain('scores 0-10 integers, avgScore = mean of 8 scores (1 decimal)');
    expect(p).toContain('"Strong Yes"|"Yes"|"Maybe"|"No"');
    expect(p).toContain('strengths = exactly 3 strings');
    for (const d of DIMS) expect(p).toContain(`"${d}": {"score": 0, "note": ""}`);
  });

  it('the resume text is placed under RESUME CONTENT; with none, the prompt says to score on profile fields only', async () => {
    await scoreCandidate(candidate, role, 'RESUME-BODY-SENTINEL');
    expect(promptOf()).toContain('RESUME CONTENT:\nRESUME-BODY-SENTINEL');
    createMock.mockClear();
    await scoreCandidate(candidate, role, null);
    expect(promptOf()).toContain('(No resume text available — score based on profile fields only)');
    createMock.mockClear();
    await scoreCandidate(candidate, role, '');
    expect(promptOf()).toContain('(No resume text available — score based on profile fields only)');
  });
});

describe('scoreCandidate: the candidate profile as the prompt shows it', () => {
  const profile = (over: Record<string, unknown>) => ({ full_name: 'Synthetic Candidate', ...over }) as unknown as Candidate;
  const line = (label: string) => promptOf().split('\n').find(l => l.startsWith(label)) as string;

  it('a bare candidate reads "Not specified" everywhere that is optional', async () => {
    await scoreCandidate(profile({}), role, 'r');
    expect(line('Name:')).toBe('Name: Synthetic Candidate');
    for (const label of ['Current CTC:', 'Expected CTC:', 'Notice Period:', 'Location:', 'Current Company:', 'Current Designation:', 'Industry:', 'Years of Experience:']) {
      expect(line(label)).toBe(`${label} Not specified`);
    }
  });

  it.each([
    [{ current_ctc_fixed: 12 }, '12 Fixed LPA'],
    [{ current_ctc_fixed: 12, current_ctc_variable: 3 }, '12 Fixed + 3 Variable LPA'],
    [{ current_ctc_fixed: 12, current_ctc_variable: 3, current_esops: 1.5 }, '12 Fixed + 3 Variable + 1.5 ESOPs LPA'],
    [{ current_ctc_variable: 3, current_esops: 1 }, '3 Variable + 1 ESOPs LPA'],
    [{ current_ctc_fixed: 0, current_ctc_variable: 0 }, '0 Fixed + 0 Variable LPA'],
    [{ current_esops: 0 }, '0 ESOPs LPA'],
  ])('current CTC %j reads "%s" (a zero is a real figure, not "not specified")', async (over, expected) => {
    await scoreCandidate(profile(over), role, 'r');
    expect(line('Current CTC:')).toBe(`Current CTC: ${expected}`);
  });

  it('expected CTC is "<n> LPA"; a zero or missing one reads Not specified', async () => {
    await scoreCandidate(profile({ expected_ctc: 18 }), role, 'r');
    expect(line('Expected CTC:')).toBe('Expected CTC: 18 LPA');
    createMock.mockClear();
    await scoreCandidate(profile({ expected_ctc: 0 }), role, 'r');
    expect(line('Expected CTC:')).toBe('Expected CTC: Not specified');
  });

  it('notice period and years of experience show a zero ("0 days", "0"), unlike expected CTC', async () => {
    await scoreCandidate(profile({ notice_period_days: 0, years_of_experience: 0 }), role, 'r');
    expect(line('Notice Period:')).toBe('Notice Period: 0 days');
    expect(line('Years of Experience:')).toBe('Years of Experience: 0');
    createMock.mockClear();
    await scoreCandidate(profile({ notice_period_days: 60, years_of_experience: 7.5 }), role, 'r');
    expect(line('Notice Period:')).toBe('Notice Period: 60 days');
    expect(line('Years of Experience:')).toBe('Years of Experience: 7.5');
  });

  it('location carries the preferred location in brackets only when one was given', async () => {
    await scoreCandidate(profile({ current_location: 'Pune' }), role, 'r', 'Mumbai');
    expect(line('Location:')).toBe('Location: Pune (Preferred: Mumbai)');
    createMock.mockClear();
    await scoreCandidate(profile({ current_location: 'Pune' }), role, 'r', '');
    expect(line('Location:')).toBe('Location: Pune');
    createMock.mockClear();
    await scoreCandidate(profile({}), role, 'r', 'Mumbai');
    expect(line('Location:')).toBe('Location: Not specified (Preferred: Mumbai)');
  });

  it('company, designation and industry are passed through', async () => {
    await scoreCandidate(profile({ current_company: 'Example Co', current_designation: 'Engineer', current_industry: 'Water' }), role, 'r');
    expect(line('Current Company:')).toBe('Current Company: Example Co');
    expect(line('Current Designation:')).toBe('Current Designation: Engineer');
    expect(line('Industry:')).toBe('Industry: Water');
  });

  it('the candidate profile never includes e-mail or phone (not part of the prompt)', async () => {
    await scoreCandidate(profile({ email: 'private@example.test', phone: '9000000000', linkedin_url: 'https://example.test/in/p' }), role, 'r');
    const p = promptOf();
    expect(p).not.toContain('private@example.test');
    expect(p).not.toContain('9000000000');
    expect(p).not.toContain('example.test/in/p');
  });
});

describe('scoreCandidate: screening answers', () => {
  it('are appended after the resume as Q:/A: pairs under a ROLE-SPECIFIC SCREENING ANSWERS heading', async () => {
    await scoreCandidate(candidate, role, 'RESUME', null, [{ question: 'Why us?', answer: 'Water.' }, { question: 'Notice?', answer: '30 days' }]);
    const p = promptOf();
    expect(p).toContain('ROLE-SPECIFIC SCREENING ANSWERS:\nQ: Why us?\nA: Water.\n\nQ: Notice?\nA: 30 days');
    expect(p.indexOf('RESUME CONTENT:')).toBeLessThan(p.indexOf('ROLE-SPECIFIC SCREENING ANSWERS'));
  });

  it.each([[undefined], [null], [[]]])('%j adds no screening section', async answers => {
    await scoreCandidate(candidate, role, 'RESUME', null, answers as null);
    expect(promptOf()).not.toContain('SCREENING ANSWERS');
  });
});

describe('priorityBucketFromScore (average 0-10 to the bucket the dashboard filters on)', () => {
  it.each([
    [10, 'Strong Fit'], [8.01, 'Strong Fit'], [8, 'Strong Fit'],
    [7.99, 'Review'], [7, 'Review'], [6.01, 'Review'], [6, 'Review'],
    [5.99, 'Low Priority'], [5, 'Low Priority'], [4.01, 'Low Priority'], [4, 'Low Priority'],
    [3.99, 'Reject'], [3, 'Reject'], [0.1, 'Reject'], [0, 'Reject'], [-1, 'Reject'],
  ])('%s is %s', (score, bucket) => { expect(priorityBucketFromScore(score)).toBe(bucket); });

  it('a score that is not a number is Reject (every comparison is false)', () => {
    expect(priorityBucketFromScore(NaN)).toBe('Reject');
  });

  it('above 10 is still Strong Fit (no upper bound)', () => {
    expect(priorityBucketFromScore(99)).toBe('Strong Fit');
  });
});

describe('extractDriveFileId (the Form stores the resume as a Drive link in two shapes)', () => {
  const TABLE: Array<[string, string | null]> = [
    ['https://drive.google.com/open?id=1AbC_dEf-123', '1AbC_dEf-123'],
    ['https://drive.google.com/file/d/1AbC_dEf-123/view', '1AbC_dEf-123'],
    ['https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing', '1AbC_dEf-123'],
    ['https://drive.google.com/file/d/1AbC_dEf-123', '1AbC_dEf-123'],
    ['https://drive.google.com/uc?export=download&id=1AbC_dEf-123', '1AbC_dEf-123'],
    ['https://drive.google.com/open?usp=sharing&id=1AbC_dEf-123', '1AbC_dEf-123'],
    ['https://drive.google.com/open?id=1AbC_dEf-123&authuser=0', '1AbC_dEf-123'],
    ['https://drive.google.com/file/u/0/d/1AbC/view', null],
    // Not Drive file links:
    ['https://docs.google.com/document/d/1DocId/edit', null],
    ['https://drive.google.com/drive/folders/1FolderId', null],
    ['https://example.test/resume.pdf', null],
    ['', null],
    ['not a url', null],
    ['https://drive.google.com/open?id=', null],
    ['https://drive.google.com/open?xid=NOPE', null],
    ['https://drive.google.com/open?uid=NOPE', null],
    // The id is cut at the first character outside [A-Za-z0-9_-]:
    ['https://drive.google.com/open?id=abc.def', 'abc'],
    ['https://drive.google.com/open?id=abc%20def', 'abc'],
    // ?id= wins over /file/d/ when a URL carries both:
    ['https://drive.google.com/file/d/AAA111/view?id=BBB222', 'BBB222'],
    // CURRENT BEHAVIOUR: the host is never checked, so any URL with an id parameter yields one:
    ['https://example.test/page?id=12345', '12345'],
  ];
  it.each(TABLE)('%s -> %s', (url, id) => { expect(extractDriveFileId(url)).toBe(id); });

  it('driveService.ts keeps its own copy of this function: both agree on every row above', () => {
    for (const [url, id] of TABLE) expect(driveServiceExtract(url), url).toBe(id);
  });
});
