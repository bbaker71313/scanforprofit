// Regression tests for the Chapter 02 AI-market-authority defect fix, updated
// for Profit Scanner v2 (cross-market resale opportunity architecture).
//
// Defect (verified live in supabase/functions/claude-proxy/index.ts before
// this fix): when the verified market-data pipeline (SoldComps + eBay
// Browse) failed, the scan handlers fed Claude's own (non-null)
// avg_sold_price/sell_through_rate/avg_days_to_sell/demand_level straight
// into the decision engine. Those AI values are never null, so they sailed
// right through the null-means-missing-evidence checks and could produce a
// fully authoritative-looking HOT/LIST/SKIP decision, net profit, ROI, and
// max-buy-price from an unverified AI guess.
//
// Fix, now generalized across marketplaces: resolveScanResultCore() is the
// single gate both single/text and shelf scan go through. It calls the
// marketplace opportunity engine (marketplaceOpportunity.ts) which only ever
// considers a marketplace whose evidence-quality is 'strong' or 'moderate'
// (evidenceQuality.ts) — 'weak'/'none' evidence (or no marketplace evidence
// at all) never produces a decision (LIMITED EVIDENCE: decisionAvailable
// false, every authoritative field null), with the AI's own guess carried
// separately (and only informationally) in `aiEstimate`.
//
// Run: `deno test --no-check --node-modules-dir=none --allow-env --allow-read
// --allow-net --import-map=supabase/functions/_shared/testing/deno_test_import_map.json
// supabase/functions/claude-proxy/`
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveScanResultCore, roiForDisplay, type MarketplaceEvidenceBundle } from "./index.ts";
import { mapEbayResultToEvidence } from "../_shared/marketplaceProviders.ts";
import type { MarketDataResult, MarketDataSuccess, MarketDataFailureReason, IdentityCandidate } from "../_shared/marketData.ts";

// Minimal settings row shape used by resolveScanResultCore.
const SETTINGS = {
  ebay_fee: 13, pkg_cost: 1.25, target_roi: 200, min_profit: 15,
  sourcing_style: 'balanced', ship_cost: 6.00, shipping: 'buyer' as const,
};

const IDENTITY: IdentityCandidate = {
  itemName: 'Minolta X-700 35mm SLR Film Camera', brand: 'Minolta', model: 'X-700',
  variant: null, gtin: null, gtinKind: null, manufacturerPartNumber: null, modelFamilyHint: null,
  likelyEbayCategory: 'Cameras', categoryHints: ['Cameras'], conditionHints: null,
  unresolvedAttributes: [], identityConfidence: 80, evidenceUsed: ['visual_ai'],
  normalizedSearchTerms: ['Minolta X-700'], providerId: 'anthropic-claude-vision',
};

// Builds the eBay-only MarketplaceEvidenceBundle resolveScanResultCore now
// takes, from a raw eBay MarketDataResult — the same shape
// resolveMarketplaceEvidenceBundle() would produce for a scan whose AI
// identification succeeded (item_name present) but whose eBay verification
// may or may not have. Identity always resolves from the AI's own fields
// independent of eBay verification succeeding — see identityFromAiScan.
function bundleFrom(result: MarketDataResult): MarketplaceEvidenceBundle {
  return {
    identity: IDENTITY,
    routedMarketplaces: ['ebay'],
    evidenceByMarketplace: { ebay: mapEbayResultToEvidence(result) },
    ebayInformational: result.ok
      ? {
          sellThroughRate: result.metrics.sellThroughRate,
          avgDaysToSell: result.metrics.turnover?.marketTurnoverDays ?? null,
          demandLevel: result.metrics.demandLevel,
        }
      : { sellThroughRate: null, avgDaysToSell: null, demandLevel: null },
  };
}

// A verified success result with strong evidence (12 coherent exact-model
// sold comps) — qualifies for HOT at a $20 acquisition cost.
function verifiedStrongResult(): MarketDataSuccess {
  return {
    ok: true,
    identity: IDENTITY,
    catalogMatch: null,
    category: { categoryTreeId: '0', categoryId: '625', categoryName: 'Cameras', resolved: true },
    metrics: {
      compMatchPrecision: 'exact_model',
      soldPriceStats: {
        compCount: 12, excludedBestOfferCount: 0,
        medianSoldPrice: 85, averageSoldPrice: 88,
        soldPriceLow: 60, soldPriceHigh: 110, evidenceQuality: 'strong',
      },
      activeMarketEvidence: {
        totalActiveResultCount: 5, sampledCount: 5, retainedCount: 5,
        sampledListings: [], retainedListings: [],
        askingPriceLow: 70, askingPriceHigh: 100,
      },
      turnover: {
        marketTurnoverDays: 15, averageVerifiedSalesPerDay: 0.33,
        soldWindowDays: 90, soldCountInWindow: 12, activeInventoryCount: 5,
      },
      sellThroughRate: 75,
      demandLevel: 'VERY HIGH',
    },
  };
}

const NOT_VERIFIED: MarketDataResult = {
  ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: 'provider outage (test fixture)',
};

// The AI's own guess is deliberately shaped to qualify for HOT if it were
// (incorrectly) fed into the decision engine — cheap enough for both profit
// and ROI to clear a $1 acquisition cost. If the fix regresses, this fixture
// alone is enough to flip a "SKIP/no-decision because unavailable" mistake
// back into a fabricated HOT.
const AI_HOT_LOOKING_ESTIMATE: Record<string, unknown> = {
  item_name: 'Minolta X-700 35mm SLR Film Camera',
  avg_sold_price: 100, price_low: 80, price_high: 120,
  sell_through_rate: 90, avg_days_to_sell: 5, demand_level: 'VERY HIGH',
  confidence: 85,
};

// ── 1. Verified single scan: unchanged authoritative behavior ──────────────
Deno.test("verified single scan: decisionAvailable, authoritative decision, real economics", () => {
  const core = resolveScanResultCore(bundleFrom(verifiedStrongResult()), AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0);
  assertEquals(core.decisionAvailable, true);
  assertEquals(core.decisionStatus, 'ok');
  assertEquals(core.marketDataSource, 'verified');
  assertEquals(core.decision, 'HOT');
  assertEquals(core.bestMarketplace, 'ebay');
  assertEquals(core.estimatedSell, 85); // verified median, never the AI's 100
  assertNotEquals(core.estimatedProfit, null);
  assertNotEquals(core.roi, null);
  assertEquals(core.aiEstimate, null); // AI guess never enters authoritative economics
  assertEquals(core.unavailableReason, null); // R1: null exactly when decisionAvailable is true
});

// ── 2 & core defect ──────────────────────────────────────────────────────
Deno.test("unverified single scan: AI market estimate never enters authoritative economics or decisioning", () => {
  const core = resolveScanResultCore(bundleFrom(NOT_VERIFIED), AI_HOT_LOOKING_ESTIMATE, 1, SETTINGS, 0);
  // Before the fix this exact fixture (cheap cost + AI-estimate shaped to
  // qualify) produced decision:'HOT'. It must now be null.
  assertEquals(core.decision, null);
  assertEquals(core.decisionAvailable, false);
  assertEquals(core.decisionStatus, 'insufficient_market_data');
  assertEquals(core.estimatedProfit, null);
  assertEquals(core.roi, null);
  assertEquals(core.sellThroughRate, null);
  assertEquals(core.avgDaysToSell, null);
  assertEquals(core.demandLevel, null);
  assertEquals(core.estimatedSell, null);
  assertEquals(core.bestMarketplace, null);
  // R1 (P1-9): eBay's own SOLDCOMPS_UNAVAILABLE reason reaches the client as
  // PROVIDER_UNAVAILABLE — never the same identical message a rate limit or
  // a genuine no-comps result would produce.
  assertEquals(core.unavailableReason, 'PROVIDER_UNAVAILABLE');
});

// ── 3. No authoritative max-buy-price when unverified, evidence exposed ────
Deno.test("unverified single scan: no authoritative max-buy-price, insufficient evidence explicit", () => {
  const core = resolveScanResultCore(bundleFrom(NOT_VERIFIED), AI_HOT_LOOKING_ESTIMATE, null, SETTINGS, 0);
  assertEquals(core.maxBuyPrice, null);
  assertEquals(core.maxBuyPriceLimitedBy, null);
  assertEquals(core.decisionStatus, 'insufficient_market_data');
  // AI-created market numbers are not returned even as informational values.
  assertEquals(core.aiEstimate, null);
  assertEquals(core.marketDataSource, 'ai_estimate');
});

// ── 4. Verified shelf item: normal authoritative behavior (cost always null) ─
Deno.test("verified shelf item: authoritative decision via backward-solved max-buy-price", () => {
  const core = resolveScanResultCore(bundleFrom(verifiedStrongResult()), AI_HOT_LOOKING_ESTIMATE, null, SETTINGS, 0);
  assertEquals(core.decisionAvailable, true);
  assertEquals(core.decision, 'HOT');
  assertNotEquals(core.maxBuyPrice, null);
});

// ── 5. Unverified shelf item: no HOT/LIST/SKIP from AI estimate alone ───────
Deno.test("unverified shelf item: no HOT/LIST/SKIP merely from AI estimate", () => {
  const core = resolveScanResultCore(bundleFrom(NOT_VERIFIED), AI_HOT_LOOKING_ESTIMATE, null, SETTINGS, 0);
  assertEquals(core.decision, null);
  assertEquals(core.decisionAvailable, false);
});

// ── 6. Mixed shelf results: each item's gate is independent ────────────────
Deno.test("mixed shelf results: verified and unverified items resolve independently", () => {
  const verifiedItem = resolveScanResultCore(bundleFrom(verifiedStrongResult()), AI_HOT_LOOKING_ESTIMATE, null, SETTINGS, 0);
  const unverifiedItem = resolveScanResultCore(bundleFrom(NOT_VERIFIED), AI_HOT_LOOKING_ESTIMATE, null, SETTINGS, 0);
  assertEquals(verifiedItem.decisionAvailable, true);
  assertEquals(verifiedItem.decision, 'HOT');
  assertEquals(unverifiedItem.decisionAvailable, false);
  assertEquals(unverifiedItem.decision, null);
});

// ── $0 acquisition cost still bypasses ROI, only on the verified path ──────
Deno.test("verified path: $0 acquisition cost still solves max-buy-price, not treated as a real cost", () => {
  const core = resolveScanResultCore(bundleFrom(verifiedStrongResult()), AI_HOT_LOOKING_ESTIMATE, 0, SETTINGS, 0);
  // acquisitionCost=0 is a real entered cost (not "blank"), so the cost-entered
  // branch runs — net/roi computed, roi null only because cost<=0.
  assertEquals(core.decisionAvailable, true);
  assertEquals(core.roi, null); // calcProfit: roi null when cost <= 0
});

Deno.test("ROI display is suppressed for free/sub-dollar cost without changing decision math", () => {
  assertEquals(roiForDisplay(null, 0), null);
  assertEquals(roiForDisplay(1000, 0.5), null);
  assertEquals(roiForDisplay(1000, 1), 1000);
  assertEquals(roiForDisplay(null, null), null);
});

// ── Profit Scanner v2: weak/none evidence is LIMITED EVIDENCE, never a
// fabricated HOT/LIST/SKIP (replaces the old "hotCappedByEvidence" cap) ────
function verifiedWeakEvidenceResult(): MarketDataSuccess {
  const base = verifiedStrongResult();
  return {
    ...base,
    metrics: {
      ...base.metrics,
      soldPriceStats: { ...base.metrics.soldPriceStats, compCount: 1, evidenceQuality: 'weak' },
    },
  };
}

// R3 (docs/files/DECISIONS.md, item L): superseded the old "weak evidence
// -> LIMITED EVIDENCE, decisionAvailable:false" behavior. On a reasonably
// identifiable item (IDENTITY has brand+model here, passes the M gate),
// weak/no evidence now resolves to a distinctly-labeled zero-evidence SKIP
// — decisionAvailable:TRUE, decision:'SKIP', decisionStatus:
// 'ok_no_evidence' — never a fabricated HOT/LIST/SKIP from profit math
// (every financial field stays null), and never the old terminal no-
// decision state either.
Deno.test("weak evidenceQuality on an identifiable item resolves to the zero-evidence SKIP, never a fabricated profit-based decision", () => {
  const core = resolveScanResultCore(bundleFrom(verifiedWeakEvidenceResult()), AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0);
  assertEquals(core.decisionAvailable, true);
  assertEquals(core.decision, 'SKIP');
  assertEquals(core.decisionStatus, 'ok_no_evidence');
  assertEquals(core.noEvidenceReason, 'NO_MARKET_EVIDENCE');
  assertEquals(core.unavailableReason, null);
  assertEquals(core.estimatedProfit, null);
  assertEquals(core.roi, null);
  assertEquals(core.maxBuyPrice, null);
  assertEquals(core.bestMarketplace, null);
});

Deno.test("verified path: strong evidenceQuality (unchanged fixture) still reaches HOT", () => {
  const core = resolveScanResultCore(bundleFrom(verifiedStrongResult()), AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0);
  assertEquals(core.decision, 'HOT');
  assertEquals(core.evidenceQuality, 'strong');
  assertEquals(core.compMatchPrecision, 'exact_model');
});

Deno.test("unverified single scan: evidenceQuality/compMatchPrecision/bestMarketplace are null (no viable evidence exists)", () => {
  const core = resolveScanResultCore(bundleFrom(NOT_VERIFIED), AI_HOT_LOOKING_ESTIMATE, 1, SETTINGS, 0);
  assertEquals(core.evidenceQuality, null);
  assertEquals(core.compMatchPrecision, null);
  assertEquals(core.bestMarketplace, null);
});

Deno.test("moderate evidenceQuality qualifies as LIST, never HOT", () => {
  const moderate: MarketDataSuccess = {
    ...verifiedStrongResult(),
    metrics: {
      ...verifiedStrongResult().metrics,
      compMatchPrecision: 'product_family',
      soldPriceStats: { ...verifiedStrongResult().metrics.soldPriceStats, evidenceQuality: 'moderate' },
    },
  };
  const core = resolveScanResultCore(bundleFrom(moderate), AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0);
  assertEquals(core.decision, 'LIST');
  assertEquals(core.decisionAvailable, true);
});

// ── R1 §4.2 (P1-9): unavailableReason — honest failure classification ──────
// "unavailableReason is non-null exactly when decisionAvailable is false,
// and null otherwise" (task doc §4.2's own test requirement).

Deno.test("unavailableReason: non-null exactly when decisionAvailable is false, across every fixture above", () => {
  const cases: MarketDataResult[] = [
    verifiedStrongResult(),
    verifiedWeakEvidenceResult(),
    NOT_VERIFIED,
    { ok: false, reason: 'SOLDCOMPS_NOT_CONFIGURED', detail: 'no key configured (test fixture)' },
    { ok: false, reason: 'PROVIDER_THROTTLED', detail: 'retry-after present (test fixture)' },
    { ok: false, reason: 'PROVIDER_QUOTA_EXHAUSTED', detail: 'monthly allowance spent (test fixture)' },
    { ok: false, reason: 'EVIDENCE_TOO_WEAK', detail: 'too weak (test fixture)' },
    { ok: false, reason: 'INSUFFICIENT_VERIFIED_MARKET_DATA', detail: 'no evidence (test fixture)' },
  ];
  for (const result of cases) {
    const label = result.ok ? 'ok:true' : result.reason;
    const core = resolveScanResultCore(bundleFrom(result), AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0);
    if (core.decisionAvailable) {
      assertEquals(core.unavailableReason, null, `expected null unavailableReason for ${label}`);
    } else {
      assertNotEquals(core.unavailableReason, null, `expected a real unavailableReason for ${label}`);
    }
  }
});

Deno.test("unavailableReason: maps each eBay SYSTEM-failure reason to its distinct client-facing reason (decisionAvailable stays false)", () => {
  const expected: Array<[MarketDataFailureReason, string]> = [
    ['SOLDCOMPS_NOT_CONFIGURED', 'PROVIDER_NOT_CONFIGURED'],
    ['PROVIDER_THROTTLED', 'PROVIDER_THROTTLED'],
    ['PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_QUOTA_EXHAUSTED'],
    ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['MALFORMED_PROVIDER_RESPONSE', 'MALFORMED_PROVIDER_RESPONSE'],
    ['MARKETPLACE_AUTH_FAILED', 'MARKETPLACE_AUTH_FAILED'],
  ];
  for (const [reason, wanted] of expected) {
    const core = resolveScanResultCore(
      bundleFrom({ ok: false, reason, detail: 'test fixture' }),
      AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0,
    );
    assertEquals(core.decisionAvailable, false, `expected decisionAvailable:false for ${reason}`);
    assertEquals(core.unavailableReason, wanted, `reason ${reason} should map to ${wanted}`);
  }
});

// R3 (item L): these two are NOT system failures — the pipeline ran to
// completion and genuinely found nothing/not enough. On an identifiable
// item they route to the zero-evidence SKIP instead of decisionAvailable
// :false — unavailableReason stays null; noEvidenceReason carries the
// distinction instead.
Deno.test("unavailableReason: EVIDENCE_TOO_WEAK/INSUFFICIENT_VERIFIED_MARKET_DATA route to the zero-evidence SKIP, not decisionAvailable:false", () => {
  const cases: Array<[MarketDataFailureReason, 'NO_MARKET_EVIDENCE' | 'EVIDENCE_TOO_WEAK']> = [
    ['EVIDENCE_TOO_WEAK', 'EVIDENCE_TOO_WEAK'],
    ['INSUFFICIENT_VERIFIED_MARKET_DATA', 'NO_MARKET_EVIDENCE'],
  ];
  for (const [reason, wantedNoEvidenceReason] of cases) {
    const core = resolveScanResultCore(
      bundleFrom({ ok: false, reason, detail: 'test fixture' }),
      AI_HOT_LOOKING_ESTIMATE, 20, SETTINGS, 0,
    );
    assertEquals(core.decisionAvailable, true, `expected decisionAvailable:true for ${reason}`);
    assertEquals(core.decision, 'SKIP');
    assertEquals(core.decisionStatus, 'ok_no_evidence');
    assertEquals(core.unavailableReason, null);
    assertEquals(core.noEvidenceReason, wantedNoEvidenceReason, `reason ${reason} should set noEvidenceReason ${wantedNoEvidenceReason}`);
  }
});

// R3 (item M): a bare generic noun with nothing else — no GTIN, no
// brand+model, no SerpAPI title, no distinguishing attribute — is NOT
// reasonably identifiable even though bundle.identity is non-null. It stays
// IDENTIFICATION_UNRESOLVED, the one case L does not touch, never the
// zero-evidence SKIP.
Deno.test("M gate: a bare generic item name with no brand/model stays IDENTIFICATION_UNRESOLVED, never the zero-evidence SKIP", () => {
  const genericBundle: MarketplaceEvidenceBundle = {
    identity: {
      itemName: 'radio', brand: null, model: null, variant: null, gtin: null, gtinKind: null,
      manufacturerPartNumber: null, modelFamilyHint: null, likelyEbayCategory: null, categoryHints: [],
      conditionHints: null, unresolvedAttributes: [], identityConfidence: 40, evidenceUsed: ['visual_ai'],
      normalizedSearchTerms: [], providerId: 'anthropic-claude-vision',
    },
    routedMarketplaces: ['ebay'],
    evidenceByMarketplace: {},
    ebayInformational: { sellThroughRate: null, avgDaysToSell: null, demandLevel: null },
  };
  const core = resolveScanResultCore(genericBundle, { item_name: 'radio' }, 20, SETTINGS, 0);
  assertEquals(core.decisionAvailable, false);
  assertEquals(core.decisionStatus, 'insufficient_market_data');
  assertEquals(core.unavailableReason, 'IDENTIFICATION_UNRESOLVED');
  assertEquals(core.decision, null);
});

Deno.test("unavailableReason: no identity at all is classified as IDENTIFICATION_UNRESOLVED, not a generic no-evidence message", () => {
  const core = resolveScanResultCore(
    { identity: null, routedMarketplaces: [], evidenceByMarketplace: {}, ebayInformational: { sellThroughRate: null, avgDaysToSell: null, demandLevel: null } },
    {}, null, SETTINGS, 0,
  );
  assertEquals(core.decisionAvailable, false);
  assertEquals(core.unavailableReason, 'IDENTIFICATION_UNRESOLVED');
});
