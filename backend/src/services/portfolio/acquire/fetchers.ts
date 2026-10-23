// WORKER-ONLY (see ../browser.ts). Which fetcher opens which kind of link in the marketing work-sample review.
// The orchestrator (index.ts) is handed this map instead of importing the fetcher modules itself, so it stays testable
// with fake fetchers; this file is the one place that says "a 'document' link is opened by documents.ts".
import { fetchDocument } from './documents.js';
import type { FetcherMap } from './index.js';
import { fetchImage, fetchSocial, fetchVideo, resolveLink } from './media.js';

// No entry for 'site' (a website is opened in Chromium by capture.ts, never by plain fetching) or for 'none' (never opened).
export const defaultFetchers: FetcherMap = {
  document: fetchDocument,
  image:    fetchImage,
  video:    fetchVideo,
  social:   fetchSocial,
  resolve:  resolveLink,
};
