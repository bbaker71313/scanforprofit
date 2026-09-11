import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planMarketEvidenceQueries } from "./queryPlanner.ts";
import type { IdentityCandidate } from "./marketData.ts";
import type { MarketEvidenceProviderCapabilities } from "./marketplaceTypes.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

const BASE_IDENTITY: IdentityCandidate = {
  itemName: null, brand: null, model: null, variant: null,
  gtin: null, gtinKind: null, manufacturerPartNumber: null, modelFamilyHint: null,
  likelyEbayCategory: null, categoryHints: [], conditionHints: null,
  unresolvedAttributes: [], identityConfidence: 0, evidenceUsed: ['visual_ai'],
  normalizedSearchTerms: [], providerId: 'test',
};

const ALL_TERMS_CAPS: MarketEvidenceProviderCapabilities = {
  marketplace: 'ebay', evidenceClass: 'verified_transaction', queryMatching: 'all_terms',
  maxUsefulQueryTerms: 4, supportsPagination: true, suppliesBestOfferFlag: false, costClass: 'metered_quota',
};

const IDENTIFIER_ONLY_CAPS: MarketEvidenceProviderCapabilities = {
  ...ALL_TERMS_CAPS, queryMatching: 'identifier_only',
};

Deno.test("planMarketEvidenceQueries: GTIN, when present, is the first rung and untruncated", () => {
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY, itemName: 'GE Super Radio', brand: 'GE', model: '7-2880',
    gtin: '041333130001',
  };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  assertEquals(queries[0], { query: '041333130001', precision: 'exact_identifier_variant' });
});

Deno.test("planMarketEvidenceQueries: rung 4 reaches the exact GE-radio query proven to match real comps", () => {
  // Task doc §5.4: rung 4 or 6 must reach something equivalent to "general
  // electric transistor radio" — the query proven to match 6 of 9 real comps.
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY, itemName: 'GE Super Radio 7-2880', brand: 'GE', model: '7-2880',
    normalizedSearchTerms: [
      'GE Super Radio 7-2880',
      'general electric transistor radio',
      'GE portable AM FM radio',
      'vintage GE radio',
    ],
  };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  assert(
    queries.some((q) => q.query === 'general electric transistor radio' && q.precision === 'product_family'),
    `expected a rung equal to "general electric transistor radio", got ${JSON.stringify(queries)}`,
  );
});

Deno.test("planMarketEvidenceQueries: no all_terms rung ever exceeds maxUsefulQueryTerms tokens", () => {
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY,
    itemName: 'Very Long Descriptive Vintage Portable Tabletop AM FM Transistor Radio',
    brand: 'General Electric', model: '7-2880', variant: 'Limited Anniversary Edition',
    normalizedSearchTerms: ['this is a much longer search keyword phrase than four words'],
  };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  for (const q of queries) {
    const tokenCount = q.query.split(' ').filter(Boolean).length;
    assert(tokenCount <= ALL_TERMS_CAPS.maxUsefulQueryTerms, `rung "${q.query}" has ${tokenCount} tokens`);
  }
});

Deno.test("planMarketEvidenceQueries: an item with only a name (no brand/model/keywords) still plans at least one non-empty rung", () => {
  const identity: IdentityCandidate = { ...BASE_IDENTITY, itemName: 'Mystery Item' };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  assert(queries.length > 0, 'expected at least one rung from itemName alone — never zero rungs when any identity signal exists');
  assert(queries.every((q) => q.query.length > 0), 'no rung may be empty');
});

Deno.test("planMarketEvidenceQueries: a salvaged modelFamilyHint feeds rung 5 when there is no validated model", () => {
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY, itemName: 'Some P-Series Speaker', brand: 'Bose', modelFamilyHint: 'p-series',
  };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  assert(
    queries.some((q) => q.query.includes('p series') || q.query.includes('bose p series')),
    `expected the family hint to appear in a rung, got ${JSON.stringify(queries)}`,
  );
});

Deno.test("planMarketEvidenceQueries: a search_keyword that normalizes to the same text as an earlier rung is dropped, keeping the earlier (higher-precision) one", () => {
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY, itemName: 'GE Radio', brand: 'GE', model: '7-2880',
    normalizedSearchTerms: ['GE 7-2880'], // normalizes to the same text as the brand+model rung
  };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  const keys = queries.map((q) => q.query.toLowerCase());
  assertEquals(new Set(keys).size, keys.length, 'expected no duplicate queries');
  // The brand+model rung (exact_model) is planned before the search_keyword
  // rung (product_family) — deduplication keeps the first (higher-precision)
  // occurrence, not the later, lower-precision restatement of it.
  assert(
    queries.some((q) => q.query === 'ge 7 2880' && q.precision === 'exact_model'),
    `expected the surviving duplicate to keep exact_model precision, got ${JSON.stringify(queries)}`,
  );
});

Deno.test("planMarketEvidenceQueries: identifier_only providers get a short ladder, ignoring search_keywords/variant/family rungs", () => {
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY, itemName: 'Pink Floyd - The Wall', brand: 'Pink Floyd', model: 'SHDW412',
    variant: 'UK First Pressing', gtin: '5099902988700',
    normalizedSearchTerms: ['pink floyd the wall vinyl', 'shdw412'],
  };
  const queries = planMarketEvidenceQueries(identity, IDENTIFIER_ONLY_CAPS);
  assertEquals(queries, [
    { query: '5099902988700', precision: 'exact_identifier_variant' },
    { query: 'pink floyd shdw412', precision: 'exact_model' },
  ]);
});

Deno.test("planMarketEvidenceQueries: with no identity signal at all, returns no rungs rather than an empty query", () => {
  const queries = planMarketEvidenceQueries(BASE_IDENTITY, ALL_TERMS_CAPS);
  assertEquals(queries, []);
});

Deno.test("planMarketEvidenceQueries: production GE-radio identity — cascade rungs contain 'radio' and never 'top'", () => {
  // Real scan: "General Electric All Transistor AM Radio Vintage 1960s Table Top"
  // with no validated model and no normalizedSearchTerms. The cascade falls
  // through to rungs 5-6. The old last-token heuristic yielded "top" as the
  // head noun; the fix must yield "radio".
  const identity: IdentityCandidate = {
    ...BASE_IDENTITY,
    itemName: 'General Electric All Transistor AM Radio Vintage 1960s Table Top',
    brand: 'General Electric',
    normalizedSearchTerms: [],
  };
  const queries = planMarketEvidenceQueries(identity, ALL_TERMS_CAPS);
  assert(
    queries.every((q) => !q.query.split(' ').includes('top')),
    `no rung should contain the token "top": ${JSON.stringify(queries)}`,
  );
  assert(
    queries.some((q) => q.query.split(' ').includes('radio')),
    `expected at least one rung containing the token "radio", got ${JSON.stringify(queries)}`,
  );
});
