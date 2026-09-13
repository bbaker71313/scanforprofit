// P3-39/P3-40: typed contract + runtime validation for claude-proxy's scan
// response shapes, extracted from analyze()/analyzeShelf()'s previously
// inline, unvalidated field mapping in app.html.
//
// Why a plain .js file loaded via <script src="..."> instead of a real
// TypeScript import: app.html has no build step (CLAUDE.md/ARCHITECTURE.md
// — vanilla HTML/CSS/JS, no bundler), so it cannot literally import a .ts
// module. This file is the smallest architecture-compatible way to get a
// real typed *contract* (documented shape + runtime-enforced invariants)
// between the server response and the UI, without inventing a bundler or
// rewriting the frontend (P3-39's explicit fallback: "use runtime
// validation / narrow adapters / explicit schemas rather than pretending
// untyped objects are safe" where full TS consumption isn't practical yet).
//
// Design:
// - Pure functions only — no DOM, no network, no globals mutated. Fully
//   unit-testable with `node --test` independent of a browser.
// - Fails honestly (throws) on a malformed *required* field (a decision
//   that isn't HOT/LIST/SKIP, a profit that isn't a finite number) rather
//   than silently rendering a wrong or fabricated business result — per
//   CLAUDE.md's Anti-Drift Contract rule 6 (no silent fallbacks).
// - Distinguishes fields that are legitimately nullable by business
//   semantics (roi — null means $0 acquisition cost, not "unknown"; market
//   evidence fields — null means unverified/unavailable, see
//   packages/shared/src/utils/marketMetrics.ts) from fields that must
//   always be a real number (net profit, fees, shipping cost — calcProfit.ts
//   never returns these as null). A field silently arriving as `undefined`
//   from a malformed response is treated the same as genuinely missing for
//   nullable fields (→ null, never fabricated), but is a hard error for
//   required fields.

(function (global) {
  'use strict';

  var VALID_DECISIONS = ['HOT', 'LIST', 'SKIP'];
  var VALID_DEMAND_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'];
  // R3 (docs/files/DECISIONS.md, item L): 'ok_no_evidence' is a THIRD
  // decisionStatus — identity was reasonably identifiable (M), the pipeline
  // ran to completion, and the full evidence ladder came up empty. decision
  // is 'SKIP' and decisionAvailable is true, but every financial field and
  // bestMarketplace stay null (never a fabricated price to justify it) —
  // distinct from both 'ok' (a normal decision) and
  // 'insufficient_market_data' (decisionAvailable:false).
  var VALID_DECISION_STATUSES = ['ok', 'ok_no_evidence', 'insufficient_market_data'];
  var VALID_EVIDENCE_QUALITIES = ['strong', 'moderate', 'weak', 'none'];
  // R1 §4.2 (P1-9): why decisionAvailable is false — lets the client tell
  // "try again shortly" (transient) apart from "no comps" (a real data gap),
  // instead of one identical LIMITED EVIDENCE sentence for every cause.
  var VALID_UNAVAILABLE_REASONS = [
    'PROVIDER_THROTTLED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_UNAVAILABLE',
    'PROVIDER_NOT_CONFIGURED', 'IDENTIFICATION_UNRESOLVED', 'NO_MARKET_EVIDENCE',
    'EVIDENCE_TOO_WEAK', 'MARKETPLACE_AUTH_FAILED',
  ];
  // R3: which of the two genuine-market-gap reasons produced an
  // 'ok_no_evidence' result — non-null exactly when decisionStatus is
  // 'ok_no_evidence', null otherwise (never present alongside unavailableReason).
  var VALID_NO_EVIDENCE_REASONS = ['NO_MARKET_EVIDENCE', 'EVIDENCE_TOO_WEAK'];
  // Profit Scanner v2 (cross-market resale opportunity architecture).
  var VALID_MARKETPLACE_IDS = ['ebay', 'etsy', 'reverb', 'discogs', 'amazon', 'mercari', 'poshmark', 'facebook_local'];

  function fail(field, expected, value) {
    throw new Error('scanResultContract: ' + field + ' must be ' + expected + ', got ' + JSON.stringify(value));
  }

  // Required: must be present and a finite number. Never coerces a string,
  // never treats NaN/Infinity as valid — those are exactly the "implicit
  // numeric coercion" bugs this contract exists to catch.
  function asNumber(v, field) {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(field, 'a finite number', v);
    return v;
  }

  // Nullable: null/undefined both normalize to null (missing evidence is
  // never fabricated as 0 or any other value); a *present* value must still
  // be a real finite number.
  function asNullableNumber(v, field) {
    if (v === null || v === undefined) return null;
    return asNumber(v, field);
  }

  function asString(v, field, fallback) {
    if (v === null || v === undefined) return fallback === undefined ? null : fallback;
    if (typeof v !== 'string') fail(field, 'a string', v);
    return v;
  }

  function asStringArray(v, field) {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) fail(field, 'an array', v);
    return v;
  }

  function asDecision(v, field) {
    if (VALID_DECISIONS.indexOf(v) === -1) fail(field, 'one of HOT/LIST/SKIP', v);
    return v;
  }

  // Chapter 02 AI-market-authority fix: the server now returns decision:null
  // whenever verified market evidence was unavailable — no authoritative
  // HOT/LIST/SKIP exists for that scan. null is allowed ONLY here (not for
  // the plain asDecision above, which still guards other required-decision
  // call sites against a silently-missing field).
  function asNullableDecision(v, field) {
    if (v === null || v === undefined) return null;
    return asDecision(v, field);
  }

  function asBoolean(v, field) {
    if (typeof v !== 'boolean') fail(field, 'a boolean', v);
    return v;
  }

  function asDecisionStatus(v, field) {
    if (VALID_DECISION_STATUSES.indexOf(v) === -1) fail(field, "'ok' or 'insufficient_market_data'", v);
    return v;
  }

  // R1 §4.2: nullable — a present value must be one of the 8 real reasons.
  // Callers enforce the null-exactly-when-decisionAvailable-is-false
  // invariant themselves (same pattern as asNullableDecision/asMarketplaceId).
  function asUnavailableReason(v, field) {
    if (v === null || v === undefined) return null;
    if (VALID_UNAVAILABLE_REASONS.indexOf(v) === -1) fail(field, 'a valid unavailableReason or null', v);
    return v;
  }

  // R3: nullable — non-null exactly when decisionStatus is 'ok_no_evidence'.
  function asNoEvidenceReason(v, field) {
    if (v === null || v === undefined) return null;
    if (VALID_NO_EVIDENCE_REASONS.indexOf(v) === -1) fail(field, 'a valid noEvidenceReason or null', v);
    return v;
  }

  // Decision Integrity remediation (Release A): comp-sample-size evidence
  // quality (see marketMetrics.ts computeSoldPriceStats). Nullable — null
  // whenever no verified metrics exist (marketDataSource is 'ai_estimate').
  function asEvidenceQuality(v, field) {
    if (v === null || v === undefined) return null;
    if (VALID_EVIDENCE_QUALITIES.indexOf(v) === -1) fail(field, "'strong'/'moderate'/'weak'/'none' or null", v);
    return v;
  }

  // The deterministic decisionEngine.ts DecisionResult object — null when no
  // authoritative decision was made (no marketplace had decision-capable
  // evidence). Profit Scanner v2: sell-through-rate/days-to-sell/demand-level
  // pass/fail and the comp-count-based "hotCappedByEvidence" cap are gone —
  // HOT/LIST/SKIP is now netProfit/roi/evidenceQuality only (weak/none
  // evidence never reaches a decision at all, see resolveScanResultCore in
  // claude-proxy/index.ts).
  function asDecisionReasons(v, field) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object' || Array.isArray(v)) fail(field, 'a decision-reasons object or null', v);
    return {
      decision: asDecision(v.decision, field + '.decision'),
      profitPass: asBoolean(v.profitPass, field + '.profitPass'),
      roiPass: asBoolean(v.roiPass, field + '.roiPass'),
      failingThresholds: asStringArray(v.failingThresholds, field + '.failingThresholds'),
    };
  }

  // Profit Scanner v2: nullable marketplace id — null is allowed only for
  // bestMarketplace when no marketplace has a decision (decisionAvailable:false).
  function asMarketplaceId(v, field) {
    if (v === null || v === undefined) return null;
    if (VALID_MARKETPLACE_IDS.indexOf(v) === -1) fail(field, 'a valid marketplace id or null', v);
    return v;
  }

  function asRequiredMarketplaceId(v, field) {
    if (VALID_MARKETPLACE_IDS.indexOf(v) === -1) fail(field, 'a valid marketplace id', v);
    return v;
  }

  // Other marketplaces the opportunity engine evaluated but did not select as
  // best (marketplaceOpportunity.ts) — each with its own evidence/economics
  // so the UI can show why the best marketplace won instead of just the
  // highest asking price.
  function asAlternativeMarketplaces(v, field) {
    if (v === null || v === undefined) return [];
    if (!Array.isArray(v)) fail(field, 'an array', v);
    return v.map(function (alt, i) {
      var f = field + '[' + i + ']';
      if (!alt || typeof alt !== 'object') fail(f, 'an object', alt);
      return {
        marketplace: asRequiredMarketplaceId(alt.marketplace, f + '.marketplace'),
        label: asString(alt.label, f + '.label', ''),
        evidence_quality: asEvidenceQuality(alt.evidenceQuality, f + '.evidenceQuality'),
        price_low: asNullableNumber(alt.priceLow, f + '.priceLow'),
        price_high: asNullableNumber(alt.priceHigh, f + '.priceHigh'),
        expected_sale_price: asNumber(alt.expectedSalePrice, f + '.expectedSalePrice'),
        net_profit: asNullableNumber(alt.netProfit, f + '.netProfit'),
        roi: asNullableNumber(alt.roi, f + '.roi'),
        max_buy_price: asNullableNumber(alt.maxBuyPrice, f + '.maxBuyPrice'),
        qualifies: asBoolean(alt.qualifies, f + '.qualifies'),
        reason: asString(alt.reason, f + '.reason', ''),
      };
    });
  }

  // Chapter 02: the AI's own price/STR/days/demand guess, kept structurally
  // separate from the authoritative fields above. Present only when
  // decisionStatus is 'insufficient_market_data'; null once verified
  // evidence exists (the AI guess is superseded, not merged with it).
  function asAiEstimate(v, field) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'object' || Array.isArray(v)) fail(field, 'an AI-estimate object or null', v);
    return {
      avg_sold_price: asNullableNumber(v.avgSoldPrice, field + '.avgSoldPrice'),
      price_low: asNullableNumber(v.priceLow, field + '.priceLow'),
      price_high: asNullableNumber(v.priceHigh, field + '.priceHigh'),
      sell_through_rate: asNullableNumber(v.sellThroughRate, field + '.sellThroughRate'),
      avg_days_to_sell: asNullableNumber(v.avgDaysToSell, field + '.avgDaysToSell'),
      demand_level: asDemandLevel(v.demandLevel, field + '.demandLevel'),
    };
  }

  // Demand level is nullable (unverified market evidence — see DECISIONS.md
  // P0 rules) but a *present* value must be one of the four real levels.
  function asDemandLevel(v, field) {
    if (v === null || v === undefined) return null;
    if (VALID_DEMAND_LEVELS.indexOf(v) === -1) fail(field, 'a valid demand level or null', v);
    return v;
  }

  // claude-proxy's single_scan/text_scan response → the snake_case `item`
  // shape renderSingle() consumes, plus the decision/financial fields.
  function normalizeSingleScanResult(r) {
    if (!r || typeof r !== 'object') fail('single scan result', 'an object', r);
    var item = {
      item_name: asString(r.itemName, 'itemName', ''),
      avg_sold_price: asNullableNumber(r.estimatedSell, 'estimatedSell'),
      price_low: asNullableNumber(r.priceLow, 'priceLow'),
      price_high: asNullableNumber(r.priceHigh, 'priceHigh'),
      sell_through_rate: asNullableNumber(r.sellThroughRate, 'sellThroughRate'),
      avg_days_to_sell: asNullableNumber(r.avgDaysToSell, 'avgDaysToSell'),
      demand_level: asDemandLevel(r.demandLevel, 'demandLevel'),
      confidence: asNullableNumber(r.confidence, 'confidence'),
      confidence_reason: asString(r.reasoning, 'reasoning', ''),
      search_keywords: asStringArray(r.searchKeywords, 'searchKeywords'),
      listing_tips: asStringArray(r.listingTips, 'listingTips'),
      risk_flags: asStringArray(r.riskFlags, 'riskFlags'),
      condition_notes: asString(r.conditionNotes, 'conditionNotes', ''),
      category: asString(r.category, 'category', null),
      brand: asString(r.brand, 'brand', null),
      notes: asString(r.notes, 'notes', ''),
    };
    // Chapter 02 fix: decision is null exactly when verified market evidence
    // was unavailable (decisionAvailable:false) — never a fabricated
    // HOT/LIST/SKIP built from the AI's own market estimate.
    var decisionAvailable = asBoolean(r.decisionAvailable, 'decisionAvailable');
    var decisionStatus = asDecisionStatus(r.decisionStatus, 'decisionStatus');
    var dec = asNullableDecision(r.decision, 'decision');
    if (decisionAvailable && dec === null) fail('decision', 'a real decision when decisionAvailable is true', dec);
    if (!decisionAvailable && dec !== null) fail('decision', 'null when decisionAvailable is false', dec);
    // R1 §4.2: unavailableReason is non-null exactly when decisionAvailable
    // is false, and null otherwise (task doc §4.2's own test requirement).
    var unavailableReason = asUnavailableReason(r.unavailableReason, 'unavailableReason');
    if (decisionAvailable && unavailableReason !== null) fail('unavailableReason', 'null when decisionAvailable is true', unavailableReason);
    if (!decisionAvailable && unavailableReason === null) fail('unavailableReason', 'a real reason when decisionAvailable is false', unavailableReason);

    // R3: non-null exactly when decisionStatus is 'ok_no_evidence'.
    var noEvidenceReason = asNoEvidenceReason(r.noEvidenceReason, 'noEvidenceReason');
    var isNoEvidence = decisionStatus === 'ok_no_evidence';
    if (isNoEvidence && noEvidenceReason === null) fail('noEvidenceReason', 'a real reason when decisionStatus is ok_no_evidence', noEvidenceReason);
    if (!isNoEvidence && noEvidenceReason !== null) fail('noEvidenceReason', 'null unless decisionStatus is ok_no_evidence', noEvidenceReason);

    var profit = asNullableNumber(r.estimatedProfit, 'estimatedProfit');
    var fee = asNullableNumber(r.feeAmount, 'feeAmount');
    var shipCost = asNullableNumber(r.shipCostAmount, 'shipCostAmount');
    // R3: the zero-evidence SKIP is decisionAvailable:true but never has a
    // financial basis (no expectedSalePrice to compute from) — only a
    // normal 'ok' decision requires real finite numbers here.
    if (decisionStatus === 'ok' && (profit === null || fee === null || shipCost === null)) {
      fail('estimatedProfit/feeAmount/shipCostAmount', 'finite numbers when decisionStatus is ok', { profit: profit, fee: fee, shipCost: shipCost });
    }
    if (isNoEvidence && (profit !== null || fee !== null || shipCost !== null)) {
      fail('estimatedProfit/feeAmount/shipCostAmount', 'null when decisionStatus is ok_no_evidence — never a fabricated financial basis', { profit: profit, fee: fee, shipCost: shipCost });
    }
    var fin = {
      profit: profit,
      roi: asNullableNumber(r.roi, 'roi'), // null = $0 acquisition cost (P2-31) or unavailable — never coerce to 0
      fee: fee,
      shipCost: shipCost,
    };
    // Profit Scanner v2: which marketplace the decision/economics above are
    // based on — null exactly when decisionAvailable is false OR the R3
    // zero-evidence SKIP (no marketplace had decision-capable evidence
    // either way), same consistency rule as `decision`.
    var bestMarketplace = asMarketplaceId(r.bestMarketplace, 'bestMarketplace');
    if (decisionStatus === 'ok' && bestMarketplace === null) fail('bestMarketplace', 'a real marketplace id when decisionStatus is ok', bestMarketplace);
    if (decisionStatus !== 'ok' && bestMarketplace !== null) fail('bestMarketplace', 'null unless decisionStatus is ok', bestMarketplace);

    return {
      item: item,
      dec: dec,
      fin: fin,
      cost: asNullableNumber(r.acquisitionCost, 'acquisitionCost'),
      maxBuyPrice: asNullableNumber(r.maxBuyPrice, 'maxBuyPrice'),
      maxBuyPriceLimitedBy: asString(r.maxBuyPriceLimitedBy, 'maxBuyPriceLimitedBy', null),
      marketDataSource: asString(r.marketDataSource, 'marketDataSource', null),
      decisionAvailable: decisionAvailable,
      decisionStatus: decisionStatus,
      unavailableReason: unavailableReason,
      noEvidenceReason: noEvidenceReason,
      decisionReasons: asDecisionReasons(r.decisionReasons, 'decisionReasons'),
      aiEstimate: asAiEstimate(r.aiEstimate, 'aiEstimate'),
      evidenceQuality: asEvidenceQuality(r.evidenceQuality, 'evidenceQuality'),
      compMatchPrecision: asString(r.compMatchPrecision, 'compMatchPrecision', null),
      suggestedSearchQuery: asString(r.suggestedSearchQuery, 'suggestedSearchQuery', null),
      bestMarketplace: bestMarketplace,
      bestMarketplaceLabel: asString(r.bestMarketplaceLabel, 'bestMarketplaceLabel', null),
      whyThisMarketplace: asString(r.whyThisMarketplace, 'whyThisMarketplace', null),
      alternativeMarketplaces: asAlternativeMarketplaces(r.alternativeMarketplaces, 'alternativeMarketplaces'),
      scanLogId: (typeof r.scanLogId === 'number' || typeof r.scanLogId === 'string') ? r.scanLogId : null,
    };
  }

  // One item within claude-proxy's shelf_scan response. Every shelf item is
  // pre-purchase (no acquisition cost yet), so unlike normalizeSingleScanResult
  // there is no `fin`/`cost` here — only the server's deterministic
  // backward-solved maxBuyPrice.
  function normalizeShelfScanItem(i) {
    if (!i || typeof i !== 'object') fail('shelf scan item', 'an object', i);
    var decisionAvailable = asBoolean(i.decisionAvailable, 'decisionAvailable');
    var decisionStatus = asDecisionStatus(i.decisionStatus, 'decisionStatus');
    var decision = asNullableDecision(i.decision, 'decision');
    if (decisionAvailable && decision === null) fail('decision', 'a real decision when decisionAvailable is true', decision);
    if (!decisionAvailable && decision !== null) fail('decision', 'null when decisionAvailable is false', decision);
    // R3: bestMarketplace is real only for a normal 'ok' decision — both
    // decisionAvailable:false and the zero-evidence SKIP ('ok_no_evidence')
    // leave it null.
    var bestMarketplace = asMarketplaceId(i.bestMarketplace, 'bestMarketplace');
    if (decisionStatus === 'ok' && bestMarketplace === null) fail('bestMarketplace', 'a real marketplace id when decisionStatus is ok', bestMarketplace);
    if (decisionStatus !== 'ok' && bestMarketplace !== null) fail('bestMarketplace', 'null unless decisionStatus is ok', bestMarketplace);
    var unavailableReason = asUnavailableReason(i.unavailableReason, 'unavailableReason');
    if (decisionAvailable && unavailableReason !== null) fail('unavailableReason', 'null when decisionAvailable is true', unavailableReason);
    if (!decisionAvailable && unavailableReason === null) fail('unavailableReason', 'a real reason when decisionAvailable is false', unavailableReason);
    var noEvidenceReason = asNoEvidenceReason(i.noEvidenceReason, 'noEvidenceReason');
    var isNoEvidence = decisionStatus === 'ok_no_evidence';
    if (isNoEvidence && noEvidenceReason === null) fail('noEvidenceReason', 'a real reason when decisionStatus is ok_no_evidence', noEvidenceReason);
    if (!isNoEvidence && noEvidenceReason !== null) fail('noEvidenceReason', 'null unless decisionStatus is ok_no_evidence', noEvidenceReason);
    return {
      item_name: asString(i.itemName, 'itemName', ''),
      avg_sold_price: asNullableNumber(i.avgSoldPrice, 'avgSoldPrice'),
      max_buy_price: asNullableNumber(i.maxBuyPrice, 'maxBuyPrice'),
      max_buy_price_limited_by: asString(i.maxBuyPriceLimitedBy, 'maxBuyPriceLimitedBy', null),
      demand_level: asDemandLevel(i.demandLevel, 'demandLevel'),
      decision: decision,
      decision_reason: asString(i.notes, 'notes', ''),
      condition_notes: asString(i.conditionNotes, 'conditionNotes', ''),
      category: asString(i.category, 'category', null),
      confidence: asNullableNumber(i.confidence, 'confidence'),
      sell_through_rate: asNullableNumber(i.sellThroughRate, 'sellThroughRate'),
      avg_days_to_sell: asNullableNumber(i.avgDaysToSell, 'avgDaysToSell'),
      market_data_source: asString(i.marketDataSource, 'marketDataSource', null),
      decision_available: decisionAvailable,
      decision_status: decisionStatus,
      unavailable_reason: unavailableReason,
      no_evidence_reason: noEvidenceReason,
      decision_reasons: asDecisionReasons(i.decisionReasons, 'decisionReasons'),
      ai_estimate: asAiEstimate(i.aiEstimate, 'aiEstimate'),
      evidence_quality: asEvidenceQuality(i.evidenceQuality, 'evidenceQuality'),
      comp_match_precision: asString(i.compMatchPrecision, 'compMatchPrecision', null),
      suggested_search_query: asString(i.suggestedSearchQuery, 'suggestedSearchQuery', null),
      best_marketplace: bestMarketplace,
      best_marketplace_label: asString(i.bestMarketplaceLabel, 'bestMarketplaceLabel', null),
      why_this_marketplace: asString(i.whyThisMarketplace, 'whyThisMarketplace', null),
      alternative_marketplaces: asAlternativeMarketplaces(i.alternativeMarketplaces, 'alternativeMarketplaces'),
    };
  }

  function normalizeShelfScanResult(r) {
    if (!r || typeof r !== 'object') fail('shelf scan result', 'an object', r);
    var rawItems = r.items;
    if (rawItems === null || rawItems === undefined) rawItems = [];
    if (!Array.isArray(rawItems)) fail('items', 'an array', rawItems);
    return rawItems.map(normalizeShelfScanItem);
  }

  var ScanResultContract = {
    normalizeSingleScanResult: normalizeSingleScanResult,
    normalizeShelfScanResult: normalizeShelfScanResult,
    normalizeShelfScanItem: normalizeShelfScanItem,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ScanResultContract;
  } else {
    global.ScanResultContract = ScanResultContract;
  }
})(typeof window !== 'undefined' ? window : globalThis);
