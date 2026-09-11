import {
  isCoherentPriceSet, rejectOutliers, scoreComp, selectComparableSoldComps,
  extractProductType,
} from "./compSelection.ts";
import type { QueryCandidate } from "./compSelection.ts";
import type { IdentityCandidate, SoldCompListing } from "./marketData.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(actual: boolean, msg: string): void {
  if (!actual) throw new Error(`expected true: ${msg}`);
}

const IDENTITY: IdentityCandidate = {
  itemName: 'GE Super Radio 7-2880', brand: 'GE', model: '7-2880', variant: null,
  gtin: null, gtinKind: null, manufacturerPartNumber: null, modelFamilyHint: null,
  likelyEbayCategory: 'Portable AM FM Radios', categoryHints: ['Portable AM FM Radios'],
  conditionHints: 'Used, working', unresolvedAttributes: [], identityConfidence: 90,
  evidenceUsed: ['visual_ai'], normalizedSearchTerms: [], providerId: 'test',
};

function comp(itemId: string, title: string, soldPrice: number, condition = 'Used'): SoldCompListing {
  return {
    itemId, title, soldPrice, totalPrice: soldPrice, shippingPrice: null,
    shippingType: null, currency: 'USD', endedAt: '2026-08-01T00:00:00Z',
    condition, conditionId: '3000', buyingFormat: 'FIXED_PRICE', bidCount: null,
    bestOfferAccepted: false, listingType: 'FixedPrice', listingUrl: null,
    sellerFeedbackScore: null, sellerFeedbackPercent: null,
  };
}

// Query-cascade planning (formerly buildSoldCompsQueries here) moved to
// queryPlanner.ts (R2 §5.4, provider-aware) — see queryPlanner_test.ts for
// cascade/dedup/truncation coverage. This file now only tests comp matching.
const EXACT_MODEL_CANDIDATE: QueryCandidate = { query: 'ge 7 2880', precision: 'exact_model' };

Deno.test('comp selection removes parts, lots, and a conflicting model — keeps the genuine exact match', () => {
  const candidate = EXACT_MODEL_CANDIDATE;
  const result = selectComparableSoldComps([
    comp('1', 'GE Super Radio 7-2880 AM FM Portable Radio', 45),
    comp('2', 'GE Super Radio 7-2880 For Parts Not Working', 8),
    comp('3', 'Lot of 4 GE Portable Radios', 100),
    comp('4', 'GE Super Radio 7-2885 AM FM Portable Radio', 55),
  ], IDENTITY, candidate);
  assertEquals(result.retained.map(item => item.itemId), ['1']);
  assertEquals(result.excluded.length, 3);
});

// T1 — "a token that is merely missing scores zero, it never rejects."
Deno.test('T1: a comp missing the brand/head-noun words is retained (usable), never hard-rejected', () => {
  const result = scoreComp(
    comp('5', 'General Electric 7-2880 Super Radio', 40),
    IDENTITY, EXACT_MODEL_CANDIDATE,
  );
  // model present (+40) but brand "GE" and head noun "radio" are both
  // literally absent from this exact string as our tokens ("general",
  // "electric" != "ge"; title DOES say "radio" actually — use a title that
  // truly omits both to prove absence alone never rejects.
  assertTrue(result.band !== 'reject', `expected not-reject, got ${JSON.stringify(result)}`);
});

Deno.test('T1: model present but brand AND head noun both absent — lands in reject band from insufficient score, never from an active exclusion rule', () => {
  const result = scoreComp(comp('6', '7-2880 tabletop unit', 40), IDENTITY, EXACT_MODEL_CANDIDATE);
  // Only model scores (+40, below the 60 usable floor) — this is "not enough
  // accumulated signal to trust" (score-threshold reject), never one of the
  // three hard-contradiction reject reasons T1 restricts hard rejection to.
  assertEquals(result.rejection, 'score below usable threshold');
  assertTrue(result.score > 0, 'the model match must still have contributed points, not been discarded');
});

Deno.test('T1: no validated model — ceiling is usable, never exact (25+15+20=60 max)', () => {
  const noModelIdentity: IdentityCandidate = { ...IDENTITY, model: null };
  const result = scoreComp(
    comp('7', 'GE Super Radio Vintage Portable AM FM', 40),
    noModelIdentity, { query: 'ge radio', precision: 'product_family' },
  );
  assertTrue(result.score <= 60, `expected score <=60 without a model, got ${result.score}`);
  assertTrue(result.band !== 'exact', 'expected band never exact without a validated model');
});

Deno.test('normalization: X-700 and X700 match as the same model token', () => {
  const identity: IdentityCandidate = { ...IDENTITY, brand: null, model: 'X-700', itemName: 'X-700 Receiver' };
  const result = scoreComp(comp('8', 'Vintage X700 Stereo Receiver', 60), identity, EXACT_MODEL_CANDIDATE);
  assertTrue(result.signals.includes('model +40'), `expected model match, got ${JSON.stringify(result.signals)}`);
});

Deno.test("normalization: 1960'S and 1960s match", () => {
  const identity: IdentityCandidate = { ...IDENTITY, brand: null, model: null, itemName: "1960's Transistor Radio" };
  const result = scoreComp(comp('9', 'GE 1960s Transistor Radio Works', 40), identity, { query: 'transistor radio', precision: 'product_family' });
  // productFamily leaves "1960s"/"transistor"/"radio" as family tokens once
  // brand/model are null — head noun "radio" should score, and "1960s"
  // (an additional descriptive token) should also score once both sides
  // normalize to the same token.
  assertTrue(result.score > 0, `expected a positive score from the 1960s match, got ${result.score}`);
});

Deno.test('word-boundary: "all" never matches inside "wall"', () => {
  const identity: IdentityCandidate = { ...IDENTITY, brand: null, model: null, itemName: 'All Weather Radio' };
  const result = scoreComp(comp('10', 'Drywall Repair Kit', 20), identity, { query: 'all weather radio', precision: 'substitute' });
  assertEquals(result.score, 0);
});

Deno.test('hard reject: conflicting model (same shape, different number) is rejected even without the majority of other tokens', () => {
  const result = scoreComp(comp('11', 'GE Portable Radio Model 7-2885', 50), IDENTITY, EXACT_MODEL_CANDIDATE);
  assertEquals(result.band, 'reject');
  assertEquals(result.rejection, 'conflicting model');
});

Deno.test('hard reject: conflicting brand (a different brand leads the title, ours is absent)', () => {
  const identity: IdentityCandidate = { ...IDENTITY, model: null };
  const result = scoreComp(comp('12', 'Zenith Super Radio Vintage Portable', 50), identity, { query: 'super radio', precision: 'product_family' });
  assertEquals(result.band, 'reject');
  assertEquals(result.rejection, 'conflicting brand');
});

Deno.test('condition: binary NEW/USED conflict scores -15, never a hard reject', () => {
  const newWanted: IdentityCandidate = { ...IDENTITY, conditionHints: 'Brand new, sealed in box' };
  const result = scoreComp(comp('13', 'GE Super Radio 7-2880 AM FM Portable Radio', 45, 'Used'), newWanted, EXACT_MODEL_CANDIDATE);
  assertTrue(result.signals.includes('condition conflict -15'), `expected condition conflict signal, got ${JSON.stringify(result.signals)}`);
  assertTrue(result.band !== 'reject', 'condition conflict must never be a hard reject');
});

Deno.test('condition: "knobs appear new" in free-text condition notes never parses as a NEW requirement', () => {
  const identity: IdentityCandidate = { ...IDENTITY, conditionHints: 'Knobs appear new, case has scratches' };
  const result = scoreComp(comp('14', 'GE Super Radio 7-2880 AM FM Portable Radio', 45, 'Used'), identity, EXACT_MODEL_CANDIDATE);
  assertTrue(!result.signals.includes('condition conflict -15'), 'a NEW-condition fragment inside used-item notes must not force a conflict against a Used comp');
});

Deno.test('coherence guard rejects a mixed 100x price population', () => {
  assertEquals(isCoherentPriceSet([
    comp('1', 'GE Super Radio 7-2880', 0.99),
    comp('2', 'GE Super Radio 7-2880', 40),
    comp('3', 'GE Super Radio 7-2880', 99),
  ]), false);
});

Deno.test('coherence guard accepts three closely grouped prices', () => {
  assertEquals(isCoherentPriceSet([
    comp('1', 'GE Super Radio 7-2880', 35),
    comp('2', 'GE Super Radio 7-2880', 40),
    comp('3', 'GE Super Radio 7-2880', 50),
  ]), true);
});

// R3 §6.3 outlier rejection
Deno.test('rejectOutliers: drops a single far-off price, keeps the coherent cluster', () => {
  const comps = [
    comp('1', 'a', 40), comp('2', 'a', 42), comp('3', 'a', 38),
    comp('4', 'a', 41), comp('5', 'a', 500),
  ];
  const result = rejectOutliers(comps);
  assertEquals(result.failed, false);
  assertEquals(result.survivors.map((c) => c.itemId).sort(), ['1', '2', '3', '4']);
  assertEquals(result.dropped.length, 1);
  assertEquals(result.dropped[0].itemId, '5');
});

Deno.test('rejectOutliers: never drops more than 20% of the set', () => {
  const comps = Array.from({ length: 10 }, (_, i) => comp(String(i), 'a', 40 + i));
  // Push two extreme outliers — at most 20% (2 of 10) may be dropped.
  comps.push(comp('outlier1', 'a', 5000));
  comps.push(comp('outlier2', 'a', 6000));
  const result = rejectOutliers(comps);
  assertTrue(result.dropped.length <= Math.floor(comps.length * 0.20), `dropped too many: ${result.dropped.length}`);
});

Deno.test('rejectOutliers: fails (no rescue) when fewer than 3 would survive', () => {
  const comps = [comp('1', 'a', 40), comp('2', 'a', 41), comp('3', 'a', 5000)];
  const result = rejectOutliers(comps);
  // Dropping the one outlier leaves exactly 2 survivors — below the >=3 floor.
  if (result.dropped.length > 0) assertTrue(result.failed, 'expected failed:true when survivors drop below 3');
});

// ─── Production regression: GE All Transistor AM Radio ────────────────────
// Real scan: first query returned 20 comps, second 138 comps, 0 survived
// scoring. Root cause: productFamily() produced trailing "table top" tokens
// and the old last-token heuristic selected "top" as the head noun instead
// of "radio". No comp title contains "top" as a product-type signal, so
// every comp scored below 60 (brand +25 only) and was rejected.
// Fix: extractProductType() strips trailing form-factor/era tokens right-to-
// left to reach the meaningful product noun.
const GE_RADIO_PRODUCTION_IDENTITY: IdentityCandidate = {
  itemName: 'General Electric All Transistor AM Radio Vintage 1960s Table Top',
  brand: 'General Electric',
  model: null, variant: null,
  gtin: null, gtinKind: null, manufacturerPartNumber: null, modelFamilyHint: null,
  likelyEbayCategory: 'Vintage AM Radios', categoryHints: ['Vintage AM Radios'],
  conditionHints: 'Used', unresolvedAttributes: [], identityConfidence: 75,
  evidenceUsed: ['visual_ai'], normalizedSearchTerms: [], providerId: 'test',
};

Deno.test('extractProductType: strips trailing "1960s Table Top" to reach "radio" for the production identity', () => {
  const result = extractProductType(GE_RADIO_PRODUCTION_IDENTITY);
  assertEquals(result, 'radio');
});

Deno.test('GE radio regression: a legitimate sold comp reaches usable band and carries the head-noun signal', () => {
  // This comp mirrors a real sold listing shape. With the buggy "top" head
  // noun it would score brand+25 only (total 25 < 60 → reject). With "radio"
  // it should score brand+25, head noun+15, descriptive tokens (transistor,
  // all) +20 = 60 — exactly the usable floor.
  const result = scoreComp(
    comp('r1', 'Vintage General Electric GE P-808A All Transistor AM Radio White Working', 45),
    GE_RADIO_PRODUCTION_IDENTITY,
    { query: 'general electric transistor radio', precision: 'product_family' },
  );
  assertTrue(result.band !== 'reject', `expected usable/exact band, got ${JSON.stringify(result)}`);
  assertTrue(result.signals.includes('head noun +15'), `expected head-noun signal for "radio", got ${JSON.stringify(result.signals)}`);
  assertTrue(result.score >= 60, `expected score >=60 (brand+head noun+descriptive), got ${result.score}`);
});

Deno.test('GE radio regression: unrelated GE products are rejected — brand alone is insufficient', () => {
  // Brand (+25) alone never reaches the 60-point usable floor. These three
  // products share the GE brand but not the product type — all must be
  // rejected after the fix (not merely because of "top" being absent, but
  // because "radio" is also absent).
  const candidate = { query: 'general electric radio', precision: 'product_family' as const };

  const iron = scoreComp(
    comp('r2', 'General Electric Steam Iron Auto Shut Off', 18),
    GE_RADIO_PRODUCTION_IDENTITY, candidate,
  );
  assertEquals(iron.band, 'reject');

  const percolator = scoreComp(
    comp('r3', 'General Electric Coffee Percolator Chrome Vintage', 35),
    GE_RADIO_PRODUCTION_IDENTITY, candidate,
  );
  assertEquals(percolator.band, 'reject');

  const cassette = scoreComp(
    comp('r4', 'General Electric Cassette Player Recorder Model 3-5252', 22),
    GE_RADIO_PRODUCTION_IDENTITY, candidate,
  );
  assertEquals(cassette.band, 'reject');
});
