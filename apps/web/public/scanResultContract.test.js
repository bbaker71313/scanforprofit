// Run: node --test apps/web/public/scanResultContract.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSingleScanResult, normalizeShelfScanResult, normalizeShelfScanItem } = require('./scanResultContract.js');

// Profit Scanner v2: decisionEngine.ts's DecisionResult no longer carries
// strPass/daysPass/demandIsVeryHigh/hotCappedByEvidence — sell-through-rate/
// days-to-sell/demand-level are informational only now, never decision inputs.
function decisionReasonsFor(decision, overrides) {
  return Object.assign({
    decision: decision, profitPass: true, roiPass: true, failingThresholds: [],
  }, overrides || {});
}

function baseSingleScan(overrides) {
  return Object.assign({
    itemName: 'Minolta X-700 35mm SLR Film Camera',
    estimatedSell: 85, priceLow: 60, priceHigh: 110,
    sellThroughRate: 62, avgDaysToSell: 21,
    demandLevel: 'HIGH', confidence: 80, reasoning: 'confirmed via label',
    searchKeywords: ['minolta x-700'], listingTips: ['tip'], riskFlags: [],
    conditionNotes: 'light wear', category: 'Cameras', brand: 'Minolta', notes: '',
    decision: 'LIST',
    estimatedProfit: 42.5, roi: 298.75, feeAmount: 13, shipCostAmount: 6,
    acquisitionCost: 20, maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    marketDataSource: 'verified', decisionAvailable: true, decisionStatus: 'ok',
    decisionReasons: decisionReasonsFor('LIST'), aiEstimate: null,
    evidenceQuality: 'strong', compMatchPrecision: 'exact_model', suggestedSearchQuery: 'minolta x 700',
    bestMarketplace: 'ebay', bestMarketplaceLabel: 'eBay',
    whyThisMarketplace: 'Strong verified evidence from eBay sold listings + active market data.',
    alternativeMarketplaces: [],
  }, overrides || {});
}

// A scan where no marketplace had decision-capable evidence — every
// authoritative field is null/decisionAvailable:false. AI-created market
// numbers are absent.
function insufficientEvidenceSingleScan(overrides) {
  return Object.assign({
    itemName: 'Minolta X-700 35mm SLR Film Camera',
    estimatedSell: null, priceLow: null, priceHigh: null,
    sellThroughRate: null, avgDaysToSell: null, demandLevel: null,
    confidence: 55, reasoning: 'low confidence — no verified comps found',
    searchKeywords: [], listingTips: [], riskFlags: [],
    conditionNotes: '', category: 'Cameras', brand: 'Minolta', notes: '',
    decision: null,
    estimatedProfit: null, roi: null, feeAmount: null, shipCostAmount: null,
    acquisitionCost: 20, maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    marketDataSource: 'ai_estimate', decisionAvailable: false, decisionStatus: 'insufficient_market_data',
    unavailableReason: 'NO_MARKET_EVIDENCE',
    decisionReasons: null,
    aiEstimate: null,
    evidenceQuality: null, compMatchPrecision: null, suggestedSearchQuery: 'minolta x 700',
    bestMarketplace: null, bestMarketplaceLabel: null, whyThisMarketplace: null,
    alternativeMarketplaces: [],
  }, overrides || {});
}

test('normalizeSingleScanResult: happy path maps camelCase -> snake_case item shape', () => {
  const out = normalizeSingleScanResult(baseSingleScan());
  assert.equal(out.item.item_name, 'Minolta X-700 35mm SLR Film Camera');
  assert.equal(out.item.avg_sold_price, 85);
  assert.equal(out.item.demand_level, 'HIGH');
  assert.equal(out.dec, 'LIST');
  assert.equal(out.fin.profit, 42.5);
  assert.equal(out.fin.roi, 298.75);
});

test('normalizeSingleScanResult: preserves the server scanLogId for idempotent buy', () => {
  const out = normalizeSingleScanResult(baseSingleScan({ scanLogId: 417 }));
  assert.equal(out.scanLogId, 417);
});

test('normalizeSingleScanResult: null roi (zero acquisition cost) is preserved, never coerced to 0', () => {
  const out = normalizeSingleScanResult(baseSingleScan({ roi: null, acquisitionCost: 0 }));
  assert.equal(out.fin.roi, null);
  assert.equal(out.cost, 0);
});

test('normalizeSingleScanResult: undefined roi (malformed/missing) also normalizes to null, not fabricated', () => {
  const raw = baseSingleScan();
  delete raw.roi;
  const out = normalizeSingleScanResult(raw);
  assert.equal(out.fin.roi, null);
});

test('normalizeSingleScanResult: missing required decision throws rather than rendering garbage', () => {
  const raw = baseSingleScan({ decision: 'MAYBE' });
  assert.throws(() => normalizeSingleScanResult(raw), /decision/);
});

test('normalizeSingleScanResult: missing required estimatedProfit throws (never null/undefined silently)', () => {
  const raw = baseSingleScan();
  delete raw.estimatedProfit;
  assert.throws(() => normalizeSingleScanResult(raw), /estimatedProfit/);
});

test('normalizeSingleScanResult: NaN/Infinity in a numeric field throws (implicit-coercion guard)', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ estimatedProfit: NaN })), /estimatedProfit/);
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ priceHigh: Infinity })), /priceHigh/);
});

test('normalizeSingleScanResult: invalid demandLevel throws; null demandLevel is allowed (unverified evidence)', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ demandLevel: 'EXTREME' })), /demandLevel/);
  const out = normalizeSingleScanResult(baseSingleScan({ demandLevel: null }));
  assert.equal(out.item.demand_level, null);
});

test('normalizeSingleScanResult: null market evidence fields stay null (never fabricated)', () => {
  const out = normalizeSingleScanResult(baseSingleScan({
    estimatedSell: null, priceLow: null, priceHigh: null,
    sellThroughRate: null, avgDaysToSell: null, demandLevel: null,
  }));
  assert.equal(out.item.avg_sold_price, null);
  assert.equal(out.item.sell_through_rate, null);
  assert.equal(out.item.demand_level, null);
});

test('normalizeSingleScanResult: throws on a non-object input', () => {
  assert.throws(() => normalizeSingleScanResult(null));
  assert.throws(() => normalizeSingleScanResult('not an object'));
});

// ── R3 (docs/files/DECISIONS.md, item L): the zero-evidence SKIP state ──

// decisionAvailable:true, decision:'SKIP', decisionStatus:'ok_no_evidence'
// — a reasonably identifiable item whose evidence ladder came up empty.
// Every financial field and bestMarketplace stay null (never a fabricated
// basis for the SKIP) — distinct from both a normal 'ok' SKIP and the
// decisionAvailable:false 'insufficient_market_data' state.
function zeroEvidenceSkipSingleScan(overrides) {
  return Object.assign({
    itemName: 'Acme Widget Model 42', estimatedSell: null, priceLow: null, priceHigh: null,
    sellThroughRate: null, avgDaysToSell: null, demandLevel: null,
    confidence: 65, reasoning: 'identified but no comparable market evidence found',
    searchKeywords: ['acme widget 42'], listingTips: [], riskFlags: [],
    conditionNotes: '', category: 'Tools', brand: 'Acme', notes: '',
    decision: 'SKIP',
    estimatedProfit: null, roi: null, feeAmount: null, shipCostAmount: null,
    acquisitionCost: 20, maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    marketDataSource: 'ai_estimate', decisionAvailable: true, decisionStatus: 'ok_no_evidence',
    unavailableReason: null, noEvidenceReason: 'NO_MARKET_EVIDENCE',
    decisionReasons: null, aiEstimate: null,
    evidenceQuality: 'none', compMatchPrecision: null, suggestedSearchQuery: 'acme widget 42',
    bestMarketplace: null, bestMarketplaceLabel: null, whyThisMarketplace: null,
    alternativeMarketplaces: [],
  }, overrides || {});
}

test('normalizeSingleScanResult: ok_no_evidence is a valid, distinct result shape', () => {
  const out = normalizeSingleScanResult(zeroEvidenceSkipSingleScan());
  assert.equal(out.decisionAvailable, true);
  assert.equal(out.decisionStatus, 'ok_no_evidence');
  assert.equal(out.dec, 'SKIP');
  assert.equal(out.fin.profit, null);
  assert.equal(out.fin.roi, null);
  assert.equal(out.maxBuyPrice, null);
  assert.equal(out.bestMarketplace, null);
  assert.equal(out.decisionReasons, null);
  assert.equal(out.noEvidenceReason, 'NO_MARKET_EVIDENCE');
  assert.equal(out.unavailableReason, null); // decisionAvailable is true — this is NOT a system/identification failure
});

test('normalizeSingleScanResult: rejects ok_no_evidence with a non-null financial field (never a fabricated basis)', () => {
  assert.throws(() => normalizeSingleScanResult(zeroEvidenceSkipSingleScan({ estimatedProfit: 10 })), /estimatedProfit/);
});

test('normalizeSingleScanResult: rejects ok_no_evidence with a non-null bestMarketplace', () => {
  assert.throws(() => normalizeSingleScanResult(zeroEvidenceSkipSingleScan({ bestMarketplace: 'ebay' })), /bestMarketplace/);
});

test('normalizeSingleScanResult: rejects ok_no_evidence with a null noEvidenceReason', () => {
  assert.throws(() => normalizeSingleScanResult(zeroEvidenceSkipSingleScan({ noEvidenceReason: null })), /noEvidenceReason/);
});

test('normalizeSingleScanResult: rejects a normal ok decision carrying a non-null noEvidenceReason', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ noEvidenceReason: 'NO_MARKET_EVIDENCE' })), /noEvidenceReason/);
});

test('normalizeSingleScanResult: rejects an unrecognized noEvidenceReason', () => {
  assert.throws(() => normalizeSingleScanResult(zeroEvidenceSkipSingleScan({ noEvidenceReason: 'MADE_UP' })), /noEvidenceReason/);
});

function baseShelfItem(overrides) {
  return Object.assign({
    itemName: 'Vintage Levi Jacket', avgSoldPrice: 45,
    maxBuyPrice: 12, maxBuyPriceLimitedBy: 'minProfit',
    demandLevel: 'VERY HIGH', decision: 'HOT', notes: 'strong comps',
    conditionNotes: '', category: 'Clothing', confidence: 70,
    sellThroughRate: 75, avgDaysToSell: 10,
    marketDataSource: 'verified', decisionAvailable: true, decisionStatus: 'ok',
    decisionReasons: decisionReasonsFor('HOT'), aiEstimate: null,
    evidenceQuality: 'strong', compMatchPrecision: 'exact_model',
    bestMarketplace: 'ebay', bestMarketplaceLabel: 'eBay',
    whyThisMarketplace: 'Strong verified evidence from eBay sold listings + active market data.',
    alternativeMarketplaces: [],
  }, overrides || {});
}

// Mirrors an item with no decision-capable evidence — see
// insufficientEvidenceSingleScan above.
function insufficientEvidenceShelfItem(overrides) {
  return Object.assign({
    itemName: 'Unmarked Ceramic Vase', avgSoldPrice: null,
    maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    demandLevel: null, decision: null, notes: '',
    conditionNotes: '', category: 'Collectibles', confidence: 45,
    sellThroughRate: null, avgDaysToSell: null,
    marketDataSource: 'ai_estimate', decisionAvailable: false, decisionStatus: 'insufficient_market_data',
    unavailableReason: 'EVIDENCE_TOO_WEAK',
    decisionReasons: null,
    aiEstimate: { avgSoldPrice: 30, priceLow: 20, priceHigh: 45, sellThroughRate: 80, avgDaysToSell: 8, demandLevel: 'HIGH' },
    evidenceQuality: null, compMatchPrecision: null,
    bestMarketplace: null, bestMarketplaceLabel: null, whyThisMarketplace: null,
    alternativeMarketplaces: [],
  }, overrides || {});
}

test('normalizeShelfScanResult: maps every item and defaults missing items array to empty', () => {
  const out1 = normalizeShelfScanResult({ items: [baseShelfItem(), baseShelfItem({ decision: 'SKIP', demandLevel: null })] });
  assert.equal(out1.length, 2);
  assert.equal(out1[0].decision, 'HOT');
  assert.equal(out1[1].decision, 'SKIP');

  const out2 = normalizeShelfScanResult({});
  assert.deepEqual(out2, []);
});

test('normalizeShelfScanItem: invalid decision throws, never defaults to SKIP silently', () => {
  assert.throws(() => normalizeShelfScanItem(baseShelfItem({ decision: '' })), /decision/);
});

test('normalizeShelfScanResult: throws if items is present but not an array', () => {
  assert.throws(() => normalizeShelfScanResult({ items: 'not-an-array' }), /items/);
});

// ── Chapter 02 AI-market-authority fix: decisionAvailable / insufficient-evidence state ──

test('normalizeSingleScanResult: verified scan (decisionAvailable:true) accepted with real decisionReasons object', () => {
  const out = normalizeSingleScanResult(baseSingleScan());
  assert.equal(out.decisionAvailable, true);
  assert.equal(out.decisionStatus, 'ok');
  assert.equal(out.dec, 'LIST');
  assert.deepEqual(out.decisionReasons.failingThresholds, []);
  assert.equal(out.aiEstimate, null);
});

test('normalizeSingleScanResult: insufficient-evidence scan is a valid, distinct result shape', () => {
  const out = normalizeSingleScanResult(insufficientEvidenceSingleScan());
  assert.equal(out.decisionAvailable, false);
  assert.equal(out.decisionStatus, 'insufficient_market_data');
  assert.equal(out.dec, null);
  assert.equal(out.fin.profit, null);
  assert.equal(out.fin.roi, null);
  assert.equal(out.maxBuyPrice, null);
  assert.equal(out.decisionReasons, null);
  assert.equal(out.aiEstimate, null); // no AI-created numerical market fallback
  assert.equal(out.suggestedSearchQuery, 'minolta x 700');
  assert.equal(out.item.avg_sold_price, null); // never merged into the authoritative item fields
  assert.equal(out.bestMarketplace, null);
});

// ── R1 §4.2 (P1-9): unavailableReason — honest failure classification ──────

test('normalizeSingleScanResult: unavailableReason is null on the verified path', () => {
  const out = normalizeSingleScanResult(baseSingleScan());
  assert.equal(out.unavailableReason, null);
});

test('normalizeSingleScanResult: unavailableReason is non-null exactly when decisionAvailable is false', () => {
  const out = normalizeSingleScanResult(insufficientEvidenceSingleScan());
  assert.equal(out.decisionAvailable, false);
  assert.equal(out.unavailableReason, 'NO_MARKET_EVIDENCE');
});

test('normalizeSingleScanResult: rejects an unrecognized unavailableReason', () => {
  assert.throws(() => normalizeSingleScanResult(insufficientEvidenceSingleScan({ unavailableReason: 'SOMETHING_MADE_UP' })), /unavailableReason/);
});

test('normalizeSingleScanResult: rejects decisionAvailable:true with a non-null unavailableReason (malformed combination)', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ unavailableReason: 'NO_MARKET_EVIDENCE' })), /unavailableReason/);
});

test('normalizeSingleScanResult: rejects decisionAvailable:false with a null unavailableReason (malformed combination)', () => {
  assert.throws(() => normalizeSingleScanResult(insufficientEvidenceSingleScan({ unavailableReason: null })), /unavailableReason/);
});

test('normalizeShelfScanItem: unavailableReason is null on the verified path, non-null on the insufficient-evidence path', () => {
  const verified = normalizeShelfScanItem(baseShelfItem());
  assert.equal(verified.unavailable_reason, null);
  const unverified = normalizeShelfScanItem(insufficientEvidenceShelfItem());
  assert.equal(unverified.unavailable_reason, 'EVIDENCE_TOO_WEAK');
});

test('normalizeShelfScanItem: rejects decisionAvailable:false with a null unavailableReason', () => {
  assert.throws(() => normalizeShelfScanItem(insufficientEvidenceShelfItem({ unavailableReason: null })), /unavailableReason/);
});

test('normalizeSingleScanResult: rejects decisionAvailable:true with a null decision (malformed combination)', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ decision: null })), /decision/);
});

test('normalizeSingleScanResult: rejects decisionAvailable:false with a non-null decision (malformed combination)', () => {
  assert.throws(() => normalizeSingleScanResult(insufficientEvidenceSingleScan({ decision: 'SKIP' })), /decision/);
});

test('normalizeSingleScanResult: rejects decisionAvailable:true with a null estimatedProfit (never a silent gap in authoritative economics)', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ estimatedProfit: null })), /estimatedProfit/);
});

test('normalizeSingleScanResult: rejects an unrecognized decisionStatus', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ decisionStatus: 'unknown_status' })), /decisionStatus/);
});

test('normalizeSingleScanResult: rejects a decisionReasons that is not the DecisionResult shape (e.g. a bare array)', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ decisionReasons: [] })), /decisionReasons/);
});

test('normalizeShelfScanResult: verified and insufficient-evidence items coexist correctly in one mixed shelf response', () => {
  const out = normalizeShelfScanResult({
    items: [baseShelfItem(), insufficientEvidenceShelfItem(), baseShelfItem({ decision: 'SKIP', decisionReasons: decisionReasonsFor('SKIP') })],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].decision, 'HOT');
  assert.equal(out[0].decision_available, true);
  assert.equal(out[1].decision, null);
  assert.equal(out[1].decision_available, false);
  assert.equal(out[1].decision_status, 'insufficient_market_data');
  assert.equal(out[1].ai_estimate.demand_level, 'HIGH');
  assert.equal(out[2].decision, 'SKIP');
});

test('normalizeShelfScanItem: rejects decisionAvailable:false with a non-null decision', () => {
  assert.throws(() => normalizeShelfScanItem(insufficientEvidenceShelfItem({ decision: 'LIST' })), /decision/);
});

// ── Decision Integrity: evidenceQuality / compMatchPrecision ──

test('normalizeSingleScanResult: evidenceQuality and compMatchPrecision pass through on the verified path', () => {
  const out = normalizeSingleScanResult(baseSingleScan());
  assert.equal(out.evidenceQuality, 'strong');
  assert.equal(out.compMatchPrecision, 'exact_model');
});

test('normalizeSingleScanResult: evidenceQuality and compMatchPrecision are null on the unverified path', () => {
  const out = normalizeSingleScanResult(insufficientEvidenceSingleScan());
  assert.equal(out.evidenceQuality, null);
  assert.equal(out.compMatchPrecision, null);
});

test('normalizeSingleScanResult: rejects an unrecognized evidenceQuality value', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ evidenceQuality: 'super-strong' })), /evidenceQuality/);
});

test('normalizeShelfScanItem: evidence_quality/comp_match_precision map to snake_case', () => {
  const out = normalizeShelfScanItem(baseShelfItem());
  assert.equal(out.evidence_quality, 'strong');
  assert.equal(out.comp_match_precision, 'exact_model');
  const unverified = normalizeShelfScanItem(insufficientEvidenceShelfItem());
  assert.equal(unverified.evidence_quality, null);
  assert.equal(unverified.comp_match_precision, null);
});

// ── Profit Scanner v2: bestMarketplace / alternativeMarketplaces ──

test('normalizeSingleScanResult: bestMarketplace/label/reason pass through on the verified path', () => {
  const out = normalizeSingleScanResult(baseSingleScan());
  assert.equal(out.bestMarketplace, 'ebay');
  assert.equal(out.bestMarketplaceLabel, 'eBay');
  assert.equal(typeof out.whyThisMarketplace, 'string');
});

test('normalizeSingleScanResult: rejects decisionAvailable:true with a null bestMarketplace', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ bestMarketplace: null })), /bestMarketplace/);
});

test('normalizeSingleScanResult: rejects decisionAvailable:false with a non-null bestMarketplace', () => {
  assert.throws(() => normalizeSingleScanResult(insufficientEvidenceSingleScan({ bestMarketplace: 'ebay' })), /bestMarketplace/);
});

test('normalizeSingleScanResult: rejects an unrecognized marketplace id', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({ bestMarketplace: 'craigslist' })), /bestMarketplace/);
});

test('normalizeSingleScanResult: alternativeMarketplaces maps to snake_case, defaults to empty array', () => {
  const out = normalizeSingleScanResult(baseSingleScan({
    alternativeMarketplaces: [{
      marketplace: 'etsy', label: 'Etsy', evidenceQuality: 'moderate',
      priceLow: 40, priceHigh: 60, expectedSalePrice: 50, netProfit: 30,
      roi: 150, maxBuyPrice: null, qualifies: false, reason: 'Moderate evidence; ROI below target.',
    }],
  }));
  assert.equal(out.alternativeMarketplaces.length, 1);
  assert.equal(out.alternativeMarketplaces[0].marketplace, 'etsy');
  assert.equal(out.alternativeMarketplaces[0].expected_sale_price, 50);
  assert.equal(out.alternativeMarketplaces[0].qualifies, false);

  const withoutAlts = normalizeSingleScanResult(baseSingleScan({ alternativeMarketplaces: undefined }));
  assert.deepEqual(withoutAlts.alternativeMarketplaces, []);
});

test('normalizeSingleScanResult: rejects an alternative marketplace entry with an invalid marketplace id', () => {
  assert.throws(() => normalizeSingleScanResult(baseSingleScan({
    alternativeMarketplaces: [{ marketplace: 'not-real', label: '', evidenceQuality: 'weak', priceLow: null, priceHigh: null, expectedSalePrice: 10, netProfit: null, roi: null, maxBuyPrice: null, qualifies: false, reason: '' }],
  })), /marketplace/);
});

// R3 (item L): shelf items reach ok_no_evidence exactly the same way single
// scans do — same resolveScanResultCore, one implementation for every mode.
function zeroEvidenceSkipShelfItem(overrides) {
  return Object.assign({
    itemName: 'Unbranded Metal Bracket', avgSoldPrice: null,
    maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    demandLevel: null, decision: 'SKIP', notes: '',
    conditionNotes: '', category: 'Tools', confidence: 60,
    sellThroughRate: null, avgDaysToSell: null,
    marketDataSource: 'ai_estimate', decisionAvailable: true, decisionStatus: 'ok_no_evidence',
    unavailableReason: null, noEvidenceReason: 'EVIDENCE_TOO_WEAK',
    decisionReasons: null, aiEstimate: null,
    evidenceQuality: 'none', compMatchPrecision: null,
    bestMarketplace: null, bestMarketplaceLabel: null, whyThisMarketplace: null,
    alternativeMarketplaces: [],
  }, overrides || {});
}

test('normalizeShelfScanItem: ok_no_evidence is a valid, distinct shelf-item shape', () => {
  const out = normalizeShelfScanItem(zeroEvidenceSkipShelfItem());
  assert.equal(out.decision, 'SKIP');
  assert.equal(out.decision_available, true);
  assert.equal(out.decision_status, 'ok_no_evidence');
  assert.equal(out.best_marketplace, null);
  assert.equal(out.unavailable_reason, null);
  assert.equal(out.no_evidence_reason, 'EVIDENCE_TOO_WEAK');
});

test('normalizeShelfScanItem: rejects ok_no_evidence with a non-null bestMarketplace', () => {
  assert.throws(() => normalizeShelfScanItem(zeroEvidenceSkipShelfItem({ bestMarketplace: 'ebay' })), /bestMarketplace/);
});

test('normalizeShelfScanResult: HOT, insufficient-evidence, and ok_no_evidence items all coexist in one shelf response', () => {
  const out = normalizeShelfScanResult({
    items: [baseShelfItem(), insufficientEvidenceShelfItem(), zeroEvidenceSkipShelfItem()],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].decision_status, 'ok');
  assert.equal(out[1].decision_status, 'insufficient_market_data');
  assert.equal(out[2].decision_status, 'ok_no_evidence');
  assert.equal(out[2].decision, 'SKIP');
});

test('normalizeShelfScanItem: best_marketplace/alternative_marketplaces map to snake_case', () => {
  const out = normalizeShelfScanItem(baseShelfItem());
  assert.equal(out.best_marketplace, 'ebay');
  assert.equal(out.best_marketplace_label, 'eBay');
  assert.deepEqual(out.alternative_marketplaces, []);
  const unverified = normalizeShelfScanItem(insufficientEvidenceShelfItem());
  assert.equal(unverified.best_marketplace, null);
});
