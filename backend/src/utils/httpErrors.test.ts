import { describe, it, expect } from 'vitest';
import { errorResponseFor } from './httpErrors.js';

describe('errorResponseFor', () => {
  it.each(['23514', '22P02', '22003', '22001', '22007', '22008'])('Postgres %s (a value the route did not validate) is a 400 that names no field', code => {
    const out = errorResponseFor(Object.assign(new Error('new row for relation "roles" violates check constraint "roles_priority_check"'), { code, constraint: 'roles_priority_check' }));
    expect(out.status).toBe(400);
    expect(out.error).not.toMatch(/roles|priority|constraint|violates/i);
  });
  it('a unique violation (23505) is a 409', () => {
    expect(errorResponseFor({ code: '23505' })).toEqual({ status: 409, error: 'That value already exists.' });
  });
  it('body-parser errors keep their own 4xx: malformed JSON, too large, anything else', () => {
    expect(errorResponseFor({ status: 400, type: 'entity.parse.failed' })).toEqual({ status: 400, error: 'Malformed JSON body.' });
    expect(errorResponseFor({ statusCode: 413, type: 'entity.too.large' })).toEqual({ status: 413, error: 'Request body too large.' });
    expect(errorResponseFor({ status: 404 })).toEqual({ status: 404, error: 'Bad request.' });
  });
  it('everything else stays the generic 500, including other Postgres codes (a foreign key, a connection failure) and non-errors', () => {
    for (const e of [new Error('boom'), { code: '23503' }, { code: '08006' }, { code: 123 }, { status: 500 }, { status: 302 }, null, undefined, 'a string'])
      expect(errorResponseFor(e)).toEqual({ status: 500, error: 'Internal server error' });
  });
});
