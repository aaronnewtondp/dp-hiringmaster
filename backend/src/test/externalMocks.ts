// Factories for vi.mock() of the packages that talk to the outside world. A route test replaces them so that nothing it
// does can reach Google, Anthropic or Vercel's queue even if a handler is driven further than the test intended:
//
//   vi.mock('@anthropic-ai/sdk', async () => (await import('../test/externalMocks.js')).anthropicSdk());
//   vi.mock('googleapis',        async () => (await import('../test/externalMocks.js')).googleapis());
//
// (vi.mock calls are hoisted into the file that contains them, so they cannot live in this module; only the factories do.)
//
// `google-auth-library` is deliberately not here: the Google sign-in test needs a programmable verifyIdToken, so it builds
// its own with vi.hoisted.

const OFFLINE = 'network access is switched off in route tests';

/** `import Anthropic from '@anthropic-ai/sdk'` whose every call rejects. */
export function anthropicSdk() {
  class FakeAnthropic {
    messages = { create: async () => { throw new Error(`Anthropic: ${OFFLINE}`); } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
}

/** `import { google } from 'googleapis'` whose clients exist but fail when used. */
export function googleapis() {
  const offline = () => { throw new Error(`Google: ${OFFLINE}`); };
  class FakeAuth { constructor(..._args: unknown[]) { /* never authenticates */ } }
  return {
    google: {
      auth: { JWT: FakeAuth, GoogleAuth: FakeAuth, OAuth2: FakeAuth },
      drive: offline, calendar: offline, gmail: offline, docs: offline, sheets: offline,
    },
  };
}

/** `await import('@vercel/queue')` — send() never delivers. */
export function vercelQueue() {
  return { send: async () => { throw new Error(`Queue: ${OFFLINE}`); } };
}
