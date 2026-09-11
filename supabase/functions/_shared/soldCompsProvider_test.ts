// Runtime tests for the live-verified SoldComps response parsing.
// Run: `deno test supabase/functions/_shared/`
// Fixture below is the real (sanitized) shape confirmed live 2026-08-26 —
// see soldCompsProvider.ts file header for how it was obtained.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSoldComp, parseTrawlSoldComp, getSoldMarketDataProvider, TrawlProvider } from "./soldCompsProvider.ts";
import { __resetForTests as __resetRateLimitForTests } from "./providerRateLimit.ts";

const LIVE_RECORD = {
  itemId: "377417007385",
  url: "https://www.ebay.com/itm/377417007385?nordt=true",
  thumbnailUrl: "https://i.ebayimg.com/images/g/268AAeSwiX5qfp0T/s-l225.jpg",
  fullResThumbnailUrl: "https://i.ebayimg.com/images/g/268AAeSwiX5qfp0T/s-l500.jpg",
  epid: "14039799782",
  title: "Jordan Air Jordan 1 Mid SE Patent Black/White/Gold 852542-007",
  condition: "Brand New",
  conditionId: 1000,
  sellerType: null,
  buyingFormat: null,
  bestOfferAccepted: true,
  acceptsOffers: true,
  bidCount: null,
  categoryId: "15709",
  listingType: "sold",
  endedAt: "2026-08-26",
  soldPrice: "81",
  soldCurrency: "USD",
  shippingPrice: "14.95",
  shippingCurrency: "USD",
  shippingType: "paid",
  totalPrice: "95.95",
  sellerUsername: "nameblayne18",
  sellerPositivePercent: 90.9,
  sellerFeedbackScore: 18,
  itemLocation: "United States",
  scrapedAt: "2026-08-26T19:14:45.378Z",
};

Deno.test("live-verified record — numeric-string prices are coerced to numbers", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  if (!parsed) throw new Error("expected a parsed comp");
  assertEquals(parsed.soldPrice, 81);
  assertEquals(parsed.totalPrice, 95.95);
  assertEquals(parsed.shippingPrice, 14.95);
});

Deno.test("live-verified record — conditionId (number) becomes a string", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  assertEquals(parsed?.conditionId, "1000");
});

Deno.test("live-verified record — url field maps to listingUrl", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  assertEquals(parsed?.listingUrl, "https://www.ebay.com/itm/377417007385?nordt=true");
});

Deno.test("live-verified record — sellerPositivePercent maps to sellerFeedbackPercent", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  assertEquals(parsed?.sellerFeedbackPercent, 90.9);
});

Deno.test("live-verified record — soldCurrency maps to currency", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  assertEquals(parsed?.currency, "USD");
});

Deno.test("live-verified record — date-only endedAt is preserved as valid ISO", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  assertEquals(parsed?.endedAt, new Date("2026-08-26").toISOString());
});

Deno.test("live-verified record — bestOfferAccepted evidence is preserved, not dropped", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  assertEquals(parsed?.bestOfferAccepted, true);
});

Deno.test("a numeric-string soldPrice of \"0\" is rejected, not coerced to a usable comp", () => {
  const parsed = parseSoldComp({ ...LIVE_RECORD, soldPrice: "0" });
  assertEquals(parsed, null);
});

Deno.test("a non-numeric soldPrice string is rejected, never fabricated as 0 or NaN", () => {
  const parsed = parseSoldComp({ ...LIVE_RECORD, soldPrice: "call for price" });
  assertEquals(parsed, null);
});

Deno.test("missing itemId is rejected", () => {
  const { itemId: _itemId, ...rest } = LIVE_RECORD;
  assertEquals(parseSoldComp(rest), null);
});

Deno.test("non-object input is rejected, not thrown on", () => {
  assertEquals(parseSoldComp(null), null);
  assertEquals(parseSoldComp("not an object"), null);
  assertEquals(parseSoldComp(42), null);
});

Deno.test("a record with only 1 valid comp still parses (low comp count is a stats-layer concern, not a parse failure)", () => {
  const parsed = parseSoldComp(LIVE_RECORD);
  if (!parsed) throw new Error("expected a parsed comp");
  assertEquals(typeof parsed.soldPrice, "number");
});

const TRAWL_RECORD = {
  title: "Apple iPhone 15 Pro 256GB Unlocked",
  sale_price: 525,
  shipping_price: 12.99,
  currency: "$",
  condition: "used",
  condition_raw: "Pre-Owned",
  date_sold: "2026-07-18T00:00:00.000Z",
  buying_format: "Buy It Now",
  item_id: "256637082114",
  item_link: "https://www.ebay.com/itm/256637082114",
};

Deno.test("Trawl record maps final sold price, shipping, currency, and URL", () => {
  const parsed = parseTrawlSoldComp(TRAWL_RECORD);
  assertEquals(parsed?.itemId, "256637082114");
  assertEquals(parsed?.soldPrice, 525);
  assertEquals(parsed?.shippingPrice, 12.99);
  assertEquals(parsed?.totalPrice, 537.99);
  assertEquals(parsed?.currency, "USD");
  assertEquals(parsed?.condition, "Pre-Owned");
  assertEquals(parsed?.listingUrl, "https://www.ebay.com/itm/256637082114");
});

Deno.test("Trawl malformed or zero-price records are rejected", () => {
  assertEquals(parseTrawlSoldComp({ ...TRAWL_RECORD, sale_price: 0 }), null);
  assertEquals(parseTrawlSoldComp({ ...TRAWL_RECORD, date_sold: "not-a-date" }), null);
  assertEquals(parseTrawlSoldComp({ ...TRAWL_RECORD, item_id: null }), null);
});

// R2 (§5.2) — TrawlProvider.searchSoldComps transport behavior: moved onto
// externalCall.ts's retry policy + providerRateLimit.ts pacing. These mock
// globalThis.fetch the same way ebayBrowse_test.ts does, rather than
// injecting a fetchImpl, since TrawlProvider (like searchActiveListings)
// resolves the global at call time.
const originalFetch = globalThis.fetch;

function withEnv<T>(vars: Record<string, string>, cleared: string[], fn: () => Promise<T>): Promise<T>;
function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T>;
function withEnv<T>(vars: Record<string, string>, clearedOrFn: string[] | (() => Promise<T>), fn?: () => Promise<T>): Promise<T> {
  const cleared = Array.isArray(clearedOrFn) ? clearedOrFn : [];
  const theFn = (typeof clearedOrFn === 'function' ? clearedOrFn : fn)!;
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prior[k] = Deno.env.get(k); Deno.env.set(k, vars[k]); }
  for (const k of cleared) { prior[k] = Deno.env.get(k); Deno.env.delete(k); }
  return theFn().finally(() => {
    for (const k of [...Object.keys(vars), ...cleared]) {
      if (prior[k] === undefined) Deno.env.delete(k); else Deno.env.set(k, prior[k]!);
    }
  });
}

// TRAWL_ENV kept for existing withEnv call-sites — factory no longer selects Trawl.
const TRAWL_ENV = { TRAWL_API_KEY: "test-trawl-key" };

// Construct TrawlProvider directly — factory no longer selects Trawl
// (DECISIONS.md 2026-09-11: SerpAPI is now primary).
function trawlProvider() {
  const key = Deno.env.get("TRAWL_API_KEY") ?? "test-trawl-key";
  return new TrawlProvider(key);
}

Deno.test("TrawlProvider: successful response parses comps", async () => {
  __resetRateLimitForTests();
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
    results: [{
      item_id: "1", sale_price: 45, date_sold: "2026-08-01T00:00:00.000Z",
      title: "GE Super Radio", item_link: "https://ebay.com/itm/1",
    }],
  }), { status: 200 }))) as typeof fetch;
  try {
    const result = await withEnv(TRAWL_ENV, () => trawlProvider().searchSoldComps({ searchTerms: "ge radio" }));
    if (!result.ok) throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    assertEquals(result.comps.length, 1);
    assertEquals(result.comps[0].soldPrice, 45);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("TrawlProvider: 429 with Retry-After retries and can still succeed", async () => {
  __resetRateLimitForTests();
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    if (calls === 1) return Promise.resolve(new Response("", { status: 429, headers: { "Retry-After": "0" } }));
    return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  }) as typeof fetch;
  try {
    const result = await withEnv(TRAWL_ENV, () => trawlProvider().searchSoldComps({ searchTerms: "ge radio" }));
    assertEquals(result.ok, true);
    assertEquals(calls, 2, "a 429 with Retry-After must be retried");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("TrawlProvider: 429 with no Retry-After is quota exhaustion, never retried", async () => {
  __resetRateLimitForTests();
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response("", { status: 429 }));
  }) as typeof fetch;
  try {
    const result = await withEnv(TRAWL_ENV, () => trawlProvider().searchSoldComps({ searchTerms: "ge radio" }));
    if (result.ok) throw new Error("expected a failure result");
    assertEquals(result.reason, "PROVIDER_QUOTA_EXHAUSTED");
    assertEquals(calls, 1, "a quota-exhausted 429 must never be retried — it will not refill mid-scan");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("TrawlProvider: malformed JSON body is reported, never fabricated as zero comps", async () => {
  __resetRateLimitForTests();
  globalThis.fetch = (() => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch;
  try {
    const result = await withEnv(TRAWL_ENV, () => trawlProvider().searchSoldComps({ searchTerms: "ge radio" }));
    if (result.ok) throw new Error("expected a failure result");
    assertEquals(result.reason, "MALFORMED_PROVIDER_RESPONSE");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("TrawlProvider: network failure is reported, never fabricated as zero comps", async () => {
  __resetRateLimitForTests();
  globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  try {
    const result = await withEnv(TRAWL_ENV, () => trawlProvider().searchSoldComps({ searchTerms: "ge radio" }));
    if (result.ok) throw new Error("expected a failure result");
    assertEquals(result.reason, "SOLDCOMPS_UNAVAILABLE");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("TrawlProvider: self-pacing serializes back-to-back calls instead of dropping either", async () => {
  __resetRateLimitForTests();
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  }) as typeof fetch;
  try {
    await withEnv(TRAWL_ENV, async () => {
      const provider = trawlProvider();
      const [a, b] = await Promise.all([
        provider.searchSoldComps({ searchTerms: "ge radio" }),
        provider.searchSoldComps({ searchTerms: "ge radio 2" }),
      ]);
      assertEquals(a.ok, true);
      assertEquals(b.ok, true);
    });
    assertEquals(calls, 2, "both calls must still complete, just paced rather than dropped");
  } finally { globalThis.fetch = originalFetch; }
});

// Factory selection tests — verify provider priority after DECISIONS.md 2026-09-11 change.
Deno.test("factory: SERP_API_KEY present selects SerpApiEbaySoldProvider", async () => {
  const provider = await withEnv({ SERP_API_KEY: "test-serp-key" }, ["SOLD_COMPS_API_KEY", "TRAWL_API_KEY"], async () => {
    return getSoldMarketDataProvider();
  });
  if (!provider) throw new Error("expected a provider");
  assertEquals(provider.providerId, "serpapi.com/ebay");
});

Deno.test("factory: no keys configured returns null", async () => {
  const provider = await withEnv({}, ["SERP_API_KEY", "SOLD_COMPS_API_KEY", "TRAWL_API_KEY"], async () => {
    return getSoldMarketDataProvider();
  });
  assertEquals(provider, null);
});

Deno.test("factory: SERP_API_KEY takes priority over SOLD_COMPS_API_KEY", async () => {
  const provider = await withEnv(
    { SERP_API_KEY: "test-serp-key", SOLD_COMPS_API_KEY: "test-sc-key" },
    ["TRAWL_API_KEY"],
    async () => getSoldMarketDataProvider(),
  );
  if (!provider) throw new Error("expected a provider");
  assertEquals(provider.providerId, "serpapi.com/ebay");
});

Deno.test("factory: SOLD_COMPS_API_KEY is fallback when SERP_API_KEY absent", async () => {
  const provider = await withEnv({ SOLD_COMPS_API_KEY: "test-sc-key" }, ["SERP_API_KEY", "TRAWL_API_KEY"], async () => {
    return getSoldMarketDataProvider();
  });
  if (!provider) throw new Error("expected a provider");
  assertEquals(provider.providerId, "sold-comps.com");
});
