// Regression tests for the P0 Browse-failure-vs-verified-zero defect.
//
// Defect (verified live before this fix): searchActiveListings() returned
// EMPTY_EVIDENCE (matchingActiveCount: 0) whenever the eBay Browse HTTP call
// failed, timed out, was rate-limited, or returned a malformed body — making
// a failed lookup indistinguishable from a real "Browse succeeded, zero
// active listings." Downstream, marketDataPipeline.ts/marketMetrics.ts treat
// matchingActiveCount:0 as a verified competition count, which can produce a
// fabricated 100% sell-through rate and 0-day turnover — VERY HIGH demand,
// HOT — from nothing but a provider outage.
//
// Fix: searchActiveListings() now throws for every operational failure mode
// (network/HTTP error, timeout, malformed response) and only returns a real
// ActiveMarketEvidence — including a legitimate matchingActiveCount: 0 — when
// the Browse call actually succeeded and parsed.
//
// Run: `deno test --no-check --node-modules-dir=none --allow-env --allow-read
// --allow-net --import-map=supabase/functions/_shared/testing/deno_test_import_map.json
// supabase/functions/_shared/`
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { searchActiveListings } from './ebayBrowse.ts';

const CREDS = { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' };
const originalFetch = globalThis.fetch;

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prior[k] = Deno.env.get(k); Deno.env.set(k, vars[k]); }
  return fn().finally(() => {
    for (const k of Object.keys(vars)) { if (prior[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, prior[k]!); }
  });
}

const TOKEN_RESPONSE = () => new Response(JSON.stringify({ access_token: 'app_token', expires_in: 7200 }), { status: 200 });

// Routes eBay's token endpoint to a canned success response (so
// getEbayAppAccessToken() always succeeds — that's not what these tests are
// about) and everything else (the Browse search call) to the caller-supplied
// handler.
function mockFetch(browseHandler: () => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return Promise.resolve(TOKEN_RESPONSE());
    return Promise.resolve(browseHandler());
  }) as typeof fetch;
}

async function expectOperationalFailure(fn: () => Promise<unknown>) {
  let failed = false;
  try { await fn(); } catch { failed = true; }
  assertEquals(failed, true);
}

Deno.test('searchActiveListings: Browse success with 0 active listings is a real verified zero', async () => {
  globalThis.fetch = mockFetch(() =>
    new Response(JSON.stringify({ itemSummaries: [], total: 0 }), { status: 200 }));
  try {
    const result = await withEnv(CREDS, () => searchActiveListings({ query: 'general electric all transistor am radio' }));
    assertEquals(result?.totalActiveResultCount, 0);
    assertEquals(result?.sampledListings.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('searchActiveListings: Browse success with positive active listings parses correctly', async () => {
  globalThis.fetch = mockFetch(() => new Response(JSON.stringify({
    total: 37,
    itemSummaries: [
      { itemId: '1', title: 'GE Radio', price: { value: '20.00', currency: 'USD' }, condition: 'Used', conditionId: '3000' },
      { itemId: '2', title: 'GE Radio 2', price: { value: '35.00', currency: 'USD' }, condition: 'Used', conditionId: '3000' },
    ],
  }), { status: 200 }));
  try {
    const result = await withEnv(CREDS, () => searchActiveListings({ query: 'ge radio' }));
    assertEquals(result?.totalActiveResultCount, 37);
    assertEquals(result?.sampledListings.length, 2);
    assertEquals(result?.retainedListings.length, 2);
    assertEquals(result?.askingPriceLow, 20);
    assertEquals(result?.askingPriceHigh, 35);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('searchActiveListings: HTTP 500 surfaces an operational failure', async () => {
  globalThis.fetch = mockFetch(() => new Response('server error', { status: 500 }));
  try {
    await expectOperationalFailure(() => withEnv(CREDS, () => searchActiveListings({ query: 'ge radio' })));
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('searchActiveListings: rate limit (429) surfaces an operational failure', async () => {
  globalThis.fetch = mockFetch(() => new Response('rate limited', { status: 429 }));
  try {
    await expectOperationalFailure(() => withEnv(CREDS, () => searchActiveListings({ query: 'ge radio' })));
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('searchActiveListings: network failure surfaces an operational failure', async () => {
  globalThis.fetch = ((url: string | URL) => {
    const u = String(url);
    if (u.includes('/identity/v1/oauth2/token')) return Promise.resolve(TOKEN_RESPONSE());
    return Promise.reject(new TypeError('network failure'));
  }) as typeof fetch;
  try {
    await expectOperationalFailure(() => withEnv(CREDS, () => searchActiveListings({ query: 'ge radio' })));
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('searchActiveListings: malformed response body surfaces an operational failure', async () => {
  globalThis.fetch = mockFetch(() => new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
  try {
    await expectOperationalFailure(() => withEnv(CREDS, () => searchActiveListings({ query: 'ge radio' })));
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('searchActiveListings: malformed response shape surfaces an operational failure', async () => {
  globalThis.fetch = mockFetch(() =>
    new Response(JSON.stringify({ itemSummaries: 'not-an-array', total: 5 }), { status: 200 }));
  try {
    await expectOperationalFailure(() => withEnv(CREDS, () => searchActiveListings({ query: 'ge radio' })));
  } finally { globalThis.fetch = originalFetch; }
});
