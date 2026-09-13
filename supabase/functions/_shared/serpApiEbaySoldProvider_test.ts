// Tests for SerpAPI eBay sold provider: parser, error handling, and transport.
// Run: `cd supabase/functions && deno test --allow-env --config deno.json _shared/`
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseSerpApiSoldItem, SerpApiEbaySoldProvider } from "./serpApiEbaySoldProvider.ts";

// ── Parser tests ────────────────────────────────────────────────────────────

const VALID_ITEM = {
  product_id: "123456789",
  title: "GE Super Radio III AM/FM Stereo",
  price: { extracted: 85.00, currency: "USD" },
  condition: "Used",
  sold_date: "Aug 10, 2026",
  link: "https://www.ebay.com/itm/123456789",
};

Deno.test("parseSerpApiSoldItem: valid item parses correctly", () => {
  const result = parseSerpApiSoldItem(VALID_ITEM);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.itemId, "123456789");
  assertEquals(result.title, "GE Super Radio III AM/FM Stereo");
  assertEquals(result.soldPrice, 85.00);
  assertEquals(result.currency, "USD");
  assertEquals(result.condition, "Used");
  assertEquals(result.listingType, "sold");
  assertEquals(result.listingUrl, "https://www.ebay.com/itm/123456789");
});

Deno.test("parseSerpApiSoldItem: price.extracted_value is accepted as well as price.extracted", () => {
  const item = { ...VALID_ITEM, price: { extracted_value: 72.50 } };
  const result = parseSerpApiSoldItem(item);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.soldPrice, 72.50);
});

Deno.test("parseSerpApiSoldItem: prices array (first element) is accepted when price absent", () => {
  const { price: _p, ...noPrice } = VALID_ITEM;
  const item = { ...noPrice, prices: [{ extracted: 60.00 }] };
  const result = parseSerpApiSoldItem(item);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.soldPrice, 60.00);
});

Deno.test("parseSerpApiSoldItem: price as a direct number is accepted", () => {
  const item = { ...VALID_ITEM, price: 45 };
  const result = parseSerpApiSoldItem(item);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.soldPrice, 45);
});

Deno.test("parseSerpApiSoldItem: missing price is rejected", () => {
  const { price: _p, ...noPrice } = VALID_ITEM;
  assertEquals(parseSerpApiSoldItem(noPrice), null);
});

Deno.test("parseSerpApiSoldItem: zero price is rejected", () => {
  assertEquals(parseSerpApiSoldItem({ ...VALID_ITEM, price: { extracted: 0 } }), null);
});

Deno.test("parseSerpApiSoldItem: negative price is rejected", () => {
  assertEquals(parseSerpApiSoldItem({ ...VALID_ITEM, price: { extracted: -5 } }), null);
});

Deno.test("parseSerpApiSoldItem: missing title is rejected", () => {
  const { title: _t, ...noTitle } = VALID_ITEM;
  assertEquals(parseSerpApiSoldItem(noTitle), null);
});

Deno.test("parseSerpApiSoldItem: item_id fallback used when product_id absent", () => {
  const { product_id: _p, ...noProductId } = VALID_ITEM;
  const item = { ...noProductId, item_id: "987654321" };
  const result = parseSerpApiSoldItem(item);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.itemId, "987654321");
});

Deno.test("parseSerpApiSoldItem: itemId extracted from link when neither product_id nor item_id present", () => {
  const { product_id: _p, ...noProductId } = VALID_ITEM;
  const result = parseSerpApiSoldItem(noProductId);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.itemId, "123456789");
});

Deno.test("parseSerpApiSoldItem: missing itemId (no product_id, item_id, or /itm/ link) is rejected", () => {
  const { product_id: _p, link: _l, ...noIds } = VALID_ITEM;
  const item = { ...noIds, link: "https://www.ebay.com/sch/i.html?_nkw=radio" };
  assertEquals(parseSerpApiSoldItem(item), null);
});

Deno.test("parseSerpApiSoldItem: unsold_date present is excluded (defensive guard)", () => {
  const item = { ...VALID_ITEM, unsold_date: "Aug 10, 2026" };
  assertEquals(parseSerpApiSoldItem(item), null);
});

Deno.test("parseSerpApiSoldItem: sold_date absent uses epoch so it cannot inflate recent velocity", () => {
  const { sold_date: _d, ...noDate } = VALID_ITEM;
  const result = parseSerpApiSoldItem(noDate);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.endedAt, new Date(0).toISOString());
  assertEquals(result.soldPrice, 85.00);
});

Deno.test("parseSerpApiSoldItem: sold_date 'Aug 15, 2026' parses to correct ISO", () => {
  const item = { ...VALID_ITEM, sold_date: "Aug 15, 2026" };
  const result = parseSerpApiSoldItem(item);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.endedAt, new Date("Aug 15, 2026").toISOString());
});

Deno.test("parseSerpApiSoldItem: sold_date ISO '2026-08-15' also accepted", () => {
  const item = { ...VALID_ITEM, sold_date: "2026-08-15" };
  const result = parseSerpApiSoldItem(item);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.endedAt, new Date("2026-08-15").toISOString());
});

Deno.test("parseSerpApiSoldItem: null/non-object input is rejected without throwing", () => {
  assertEquals(parseSerpApiSoldItem(null), null);
  assertEquals(parseSerpApiSoldItem("string"), null);
  assertEquals(parseSerpApiSoldItem(42), null);
  assertEquals(parseSerpApiSoldItem(undefined), null);
});

Deno.test("parseSerpApiSoldItem: bestOfferAccepted is always false (SerpAPI does not report it)", () => {
  const result = parseSerpApiSoldItem(VALID_ITEM);
  if (!result) throw new Error("expected a parsed comp");
  assertEquals(result.bestOfferAccepted, false);
});

// GE Super Radio regression — the item that failed comp-matching before the
// head-noun fix (PR #158). The parser must not drop it.
Deno.test("GE radio regression: parser admits GE Super Radio record with numeric price", () => {
  const geRadio = {
    product_id: "364782319011",
    title: "GE Super Radio III AM/FM High Performance Radio Model 7-2887",
    price: { extracted: 95.00, currency: "USD" },
    condition: "Pre-Owned",
    sold_date: "Sep 3, 2026",
    link: "https://www.ebay.com/itm/364782319011",
  };
  const result = parseSerpApiSoldItem(geRadio);
  if (!result) throw new Error("GE Super Radio sold comp must parse successfully");
  assertEquals(result.soldPrice, 95.00);
  assertEquals(result.itemId, "364782319011");
});

// ── Provider transport tests ─────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function serpProvider() {
  return new SerpApiEbaySoldProvider("test-serp-key");
}

function serpSuccess(items: unknown[]) {
  return new Response(JSON.stringify({
    search_metadata: { status: "Success" },
    organic_results: items,
  }), { status: 200 });
}

Deno.test("SerpApiEbaySoldProvider: successful response returns comps", async () => {
  globalThis.fetch = (() => Promise.resolve(serpSuccess([VALID_ITEM]))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "ge super radio" });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    assertEquals(result.comps.length, 1);
    assertEquals(result.comps[0].soldPrice, 85.00);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: empty organic_results returns ok with zero comps", async () => {
  globalThis.fetch = (() => Promise.resolve(serpSuccess([]))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "rare item" });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    assertEquals(result.comps.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: non-Success status is reported as SOLDCOMPS_UNAVAILABLE", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
    search_metadata: { status: "Error" }, error: "Invalid API key.",
  }), { status: 200 }))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "SOLDCOMPS_UNAVAILABLE");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: quota error in error field is PROVIDER_QUOTA_EXHAUSTED", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
    search_metadata: { status: "Error" }, error: "Your account has run out of searches quota.",
  }), { status: 200 }))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "PROVIDER_QUOTA_EXHAUSTED");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: 429 with Retry-After is PROVIDER_THROTTLED", async () => {
  globalThis.fetch = (() => Promise.resolve(
    new Response("", { status: 429, headers: { "Retry-After": "30" } })
  )) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "PROVIDER_THROTTLED");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: 429 without Retry-After is PROVIDER_THROTTLED", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("", { status: 429 }))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "PROVIDER_THROTTLED");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: malformed JSON body is MALFORMED_PROVIDER_RESPONSE", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "MALFORMED_PROVIDER_RESPONSE");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: network failure is SOLDCOMPS_UNAVAILABLE", async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "SOLDCOMPS_UNAVAILABLE");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: results present but none parseable is MALFORMED_PROVIDER_RESPONSE", async () => {
  globalThis.fetch = (() => Promise.resolve(serpSuccess([
    { not_a_title: "thing" },
    { price: { extracted: 50 } },
  ]))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "radio" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.reason, "MALFORMED_PROVIDER_RESPONSE");
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: ambiguous price ranges are ignored rather than treated as malformed", async () => {
  globalThis.fetch = (() => Promise.resolve(serpSuccess([{
    product_id: "123", title: "GE radio", sold_date: "Aug 10, 2026",
    price: { from: { extracted: 10 }, to: { extracted: 20 } },
  }]))) as typeof fetch;
  try {
    const result = await serpProvider().searchSoldComps({ searchTerms: "ge radio" });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    assertEquals(result.comps.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test("SerpApiEbaySoldProvider: providerId and evidenceClass are correct", () => {
  const p = serpProvider();
  assertEquals(p.providerId, "serpapi.com/ebay");
  assertEquals(p.capabilities.evidenceClass, "verified_transaction");
  assertEquals(p.capabilities.marketplace, "ebay");
  assertEquals(p.capabilities.queryMatching, "all_terms");
  assertEquals(p.capabilities.costClass, "metered_quota");
});
