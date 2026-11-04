import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// getGoogleCredentials: the one place the service-account key is read for Drive, Calendar and Gmail. Order: the JSON in GOOGLE_APPLICATION_CREDENTIALS_JSON
// (Vercel) wins; else the file at GOOGLE_APPLICATION_CREDENTIALS (local Docker volume) if it exists; else a documented error. The filesystem is faked, so no
// real key file is ever read and nothing is written. Every key below is a synthetic placeholder.
const fsMock = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('fs', () => ({ default: fsMock, ...fsMock }));

import { getGoogleCredentials } from './googleAuth.js';

const JSON_KEY = { client_email: 'json-sa@example.iam.test', private_key: 'json-private-key-placeholder', project_id: 'synthetic-json' };
const FILE_KEY = { client_email: 'file-sa@example.iam.test', private_key: 'file-private-key-placeholder', project_id: 'synthetic-file' };
const MESSAGE = 'No Google service account credentials found. Set GOOGLE_APPLICATION_CREDENTIALS_JSON or GOOGLE_APPLICATION_CREDENTIALS.';

beforeEach(() => {
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', '');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  fsMock.existsSync.mockReset().mockReturnValue(false);
  fsMock.readFileSync.mockReset().mockReturnValue(JSON.stringify(FILE_KEY));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('getGoogleCredentials: where the key comes from', () => {
  it('the JSON env var is parsed and returned whole (every key kept), and the filesystem is not touched', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', JSON.stringify(JSON_KEY));
    expect(getGoogleCredentials()).toEqual(JSON_KEY);
    expect(fsMock.existsSync).not.toHaveBeenCalled();
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('the JSON env var WINS over a file path that exists', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', JSON.stringify(JSON_KEY));
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/key.json');
    fsMock.existsSync.mockReturnValue(true);
    expect(getGoogleCredentials().client_email).toBe(JSON_KEY.client_email);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('with no JSON, the file at GOOGLE_APPLICATION_CREDENTIALS is read as UTF-8 and parsed when it exists', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/key.json');
    fsMock.existsSync.mockReturnValue(true);
    expect(getGoogleCredentials()).toEqual(FILE_KEY);
    expect(fsMock.existsSync).toHaveBeenCalledWith('/synthetic/key.json');
    expect(fsMock.readFileSync).toHaveBeenCalledWith('/synthetic/key.json', 'utf-8');
  });

  it('an EMPTY JSON env var counts as unset, so the file is used', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/key.json');
    fsMock.existsSync.mockReturnValue(true);
    expect(getGoogleCredentials().client_email).toBe(FILE_KEY.client_email);
  });
});

describe('getGoogleCredentials: when there is no key', () => {
  it('neither variable set: throws the documented message and reads nothing', () => {
    expect(() => getGoogleCredentials()).toThrow(MESSAGE);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('a file path that does not exist: the same documented error (never a raw ENOENT)', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/missing.json');
    fsMock.existsSync.mockReturnValue(false);
    expect(() => getGoogleCredentials()).toThrow(MESSAGE);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('an empty file-path variable is treated as unset (existsSync is not even asked)', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    expect(() => getGoogleCredentials()).toThrow(MESSAGE);
    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });
});

describe('getGoogleCredentials: a key that is there but unusable', () => {
  it('malformed JSON in the env var throws a SyntaxError and does NOT fall back to the file', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', '{not json');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/key.json');
    fsMock.existsSync.mockReturnValue(true);
    expect(() => getGoogleCredentials()).toThrow(SyntaxError);
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });

  it('a whitespace-only JSON env var is not "unset": it is parsed and fails', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON', '   ');
    expect(() => getGoogleCredentials()).toThrow(SyntaxError);
  });

  it('malformed JSON in the key file throws a SyntaxError', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/key.json');
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue('{broken');
    expect(() => getGoogleCredentials()).toThrow(SyntaxError);
  });

  it('a file that cannot be read (permissions) surfaces the read error', () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/synthetic/key.json');
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockImplementation(() => { throw new Error('EACCES synthetic'); });
    expect(() => getGoogleCredentials()).toThrow('EACCES synthetic');
  });
});
