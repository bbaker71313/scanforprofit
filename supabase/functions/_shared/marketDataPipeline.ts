// Orchestrates the eBay TransactionEvidenceProvider + MarketplaceSignalProvider
// pipeline (Profit Scanner v2 — see marketplaceProviders.ts for the
// marketplace-agnostic provider contracts this feeds):
//
//   item evidence -> provider-agnostic identification -> Catalog/product
//   resolution -> Taxonomy/category resolution -> verified sold evidence +
//   Browse active evidence -> comparable matching -> evidence-quality
//   assessment (evidenceQuality.ts) -> deterministic price stats
//
// R3 (docs/files/DECISIONS.md "R3 tightenings..."): §6.2 active evidence is
// now proportional (retainedCount >= 5 AND retainedCount/sampledCount >=
// 0.60), never an all-or-nothing "every sample must match" gate. §6.3 a
// later provider/query failure no longer discards partial sold evidence
// already collected, or skips the active-evidence stage — a MAD-based
// outlier guard (compSelection.ts rejectOutliers) is applied to the winning
// sold-comp set before it's treated as qualified. §6.4 the best-effort
// Catalog/Taxonomy calls are contained (a credential/outage failure there
// must never discard an otherwise-qualified decision), and an unconfigured
// sold provider is reported honestly (PROVIDER_NOT_CONFIGURED-shaped, via
// SOLDCOMPS_NOT_CONFIGURED) instead of masquerading as a market gap.
import { getItemIdentifier, type IdentifyInput } from "./itemIdentification.ts"
import { catalogSearchByGtin, catalogSearchByKeywords } from "./ebayCatalog.ts"
import { resolveCategory } from "./ebayTaxonomy.ts"
import { searchActiveListings } from "./ebayBrowse.ts"
import { EbayAppAuthError } from "./ebayAppAuth.ts"
import { ExternalCallError } from "./externalCall.ts"
import { getSoldMarketDataProvider } from "./soldCompsProvider.ts"
import {
  isCoherentPriceSet, isCoherentPriceSpread, rejectOutliers, selectComparableSoldComps,
  type QueryCandidate,
} from "./compSelection.ts"
import { planMarketEvidenceQueries } from "./queryPlanner.ts"
import { computeSoldPriceStats, computeMarketTurnoverDays, computeSellThroughRate, computeDemandLevel } from "./marketMetrics.ts"
import { assessEvidenceQuality } from "./evidenceQuality.ts"
import type {
  MarketDataResult, MarketMetrics, CompMatchPrecision, IdentityCandidate, SoldCompListing,
  ActiveMarketEvidence, MarketEvidenceAuditEntry, MarketDataFailureReason, CatalogMatch, CategoryResolution,
} from "./marketData.ts"
import type { MarketEvidenceProviderCapabilities } from "./marketplaceTypes.ts"

// The approved sold-evidence window used for STR and turnover. Providers must
// constrain their request to this same window or guarantee equivalent coverage.
const DEFAULT_SOLD_WINDOW_DAYS = 90;

// eBay Browse (searchActiveListings) is also an all_terms provider (task
// doc §5.1) — used as the query-planning capability fallback when no
// sold-comp provider is configured, since Browse's active-listing search
// (queryForActive below) still needs a planned query either way.
const EBAY_BROWSE_FALLBACK_CAPS: MarketEvidenceProviderCapabilities = {
  marketplace: 'ebay', evidenceClass: 'active_market', queryMatching: 'all_terms',
  maxUsefulQueryTerms: 4, supportsPagination: true, suppliesBestOfferFlag: false, costClass: 'free',
};

export async function runMarketDataPipeline(input: IdentifyInput): Promise<MarketDataResult> {
  const identifier = getItemIdentifier();
  if (!identifier) {
    return { ok: false, reason: 'IDENTIFICATION_UNRESOLVED', detail: 'No identification provider is configured' };
  }

  const identity = await identifier.identify(input);
  return resolveVerifiedMarketData(identity);
}

// R1 (P1-10): cap the persisted exclusion detail per query so a shelf scan
// with many candidates/retries can't balloon scan_log — the remainder is
// counted (excludedOverflowCount), never silently dropped.
const MAX_EXCLUDED_COMPS_PER_QUERY = 25;

function capExcluded(excluded: { itemId: string; title: string; soldPrice: number; reason: string }[]) {
  return {
    excludedComps: excluded.slice(0, MAX_EXCLUDED_COMPS_PER_QUERY),
    excludedOverflowCount: Math.max(0, excluded.length - MAX_EXCLUDED_COMPS_PER_QUERY),
  };
}

// §6.4 (P2-11) containment: Catalog/Taxonomy are documented best-effort
// (Catalog is known-unentitled, returns 403 — see ebayCatalog.ts) and must
// never take down an otherwise-qualified decision. Never let a thrown
// EbayAppAuthError (or anything else) escape from here.
async function safeCatalogMatch(identity: IdentityCandidate, queryForActive: string): Promise<CatalogMatch | null> {
  try {
    return identity.gtin
      ? await catalogSearchByGtin(identity.gtin)
      : await catalogSearchByKeywords(queryForActive);
  } catch {
    return null;
  }
}

async function safeResolveCategory(identity: IdentityCandidate, queryForActive: string): Promise<CategoryResolution | null> {
  try {
    return await resolveCategory(identity.likelyEbayCategory ?? queryForActive);
  } catch {
    return null;
  }
}

// Runs everything AFTER identification against an already-resolved
// IdentityCandidate. Split out so a caller that already has identification
// (e.g. a scan handler's own AI call) can reuse it here instead of
// triggering a second, redundant identification call.
export async function resolveVerifiedMarketData(
  identity: IdentityCandidate,
  options: { maxSoldQueries?: number } = {},
): Promise<MarketDataResult> {
  // R2 (§5.4): plan queries from the configured provider's own capabilities
  // (see EBAY_BROWSE_FALLBACK_CAPS above) instead of a provider-naive builder.
  const soldProvider = getSoldMarketDataProvider();
  const plannedQueries = planMarketEvidenceQueries(identity, soldProvider?.capabilities ?? EBAY_BROWSE_FALLBACK_CAPS);
  // SerpAPI is metered. Bound one scan to two sold searches while preserving
  // one highest-precision and one broader/family fallback query. This keeps
  // the 250-scan paid tier within the $25/1,000-search operating budget even
  // when a photo also consumes one Lens search.
  const firstBroad = plannedQueries.find((q) => q.precision === 'product_family' || q.precision === 'substitute');
  const queries = [plannedQueries[0], firstBroad].filter((q, i, all): q is QueryCandidate =>
    !!q && all.findIndex((x) => x?.query === q.query) === i
  ).slice(0, Math.max(0, Math.min(2, options.maxSoldQueries ?? 2)));
  if (!plannedQueries.length) {
    return { ok: false, reason: 'IDENTIFICATION_UNRESOLVED', detail: 'Identification produced no usable search terms' };
  }

  const attemptedQueries: MarketEvidenceAuditEntry[] = [];
  // The best fully-qualified (3+ coherent, outlier-screened) sold-comp
  // query, and — independently — the best PARTIAL result (1-2 real comps)
  // seen along the way, kept only as a fallback for the 'moderate with
  // active support' evidence tier if nothing fully qualifies.
  type SelectedSoldEvidence = {
    query: string
    precision: CompMatchPrecision
    comps: SoldCompListing[]
    providerId: string
    suppliesBestOfferFlag: boolean
  };
  let qualified: SelectedSoldEvidence | null = null;
  let partial: SelectedSoldEvidence | null = null;
  // §6.3/§6.4: a genuine operational failure (provider outage/rate-limit/
  // malformed response) encountered mid-cascade. Recorded, not fatal —
  // evidence already collected (this query's own comps if any, plus
  // whatever active evidence Browse can still supply) is preserved and
  // still evaluated. Reported ONLY as the final failure reason if nothing
  // ends up qualifying — never silently downgraded into a generic
  // "no evidence" message, and never silently discarded either.
  let soldProviderFailure: { reason: MarketDataFailureReason; detail: string } | null = null;

  if (soldProvider) {
    for (const candidate of queries) {
      const requestStartedAt = Date.now();
      const soldResult = await soldProvider.searchSoldComps({ searchTerms: candidate.query });
      const providerLatencyMs = Date.now() - requestStartedAt;
      const providerAttempts = soldResult.providerAttempts ?? [{
        providerId: soldResult.providerId ?? soldProvider.providerId,
        ok: soldResult.ok,
        reason: soldResult.ok ? null : soldResult.reason,
        detail: soldResult.ok ? null : soldResult.detail,
        latencyMs: providerLatencyMs,
      }];
      for (const attempt of providerAttempts.filter((entry) => !entry.ok)) {
        attemptedQueries.push({
          providerId: attempt.providerId,
          query: candidate.query, precision: candidate.precision,
          rawCompCount: 0, retainedCompCount: 0, excludedComps: [], excludedOverflowCount: 0,
          qualified: false, rejectionReason: `${attempt.reason}: ${attempt.detail}`,
          providerLatencyMs: attempt.latencyMs, retryCount: 0,
        });
      }
      if (!soldResult.ok) {
        // A provider outage/rate-limit/malformed response is not evidence
        // that a broader query is needed — stop the cascade rather than
        // multiplying failed calls. §6.3: unlike before, this no longer
        // returns immediately — whatever partial sold evidence and active
        // evidence can still be assembled is preserved and evaluated below.
        soldProviderFailure = { reason: soldResult.reason, detail: soldResult.detail };
        break;
      }
      const rawSelection = selectComparableSoldComps(soldResult.comps, identity, candidate);
      // §6.3: MAD-based outlier screen on the scored-in retained set before
      // treating it as a candidate for full qualification. A set that fails
      // outlier screening (fewer than 3 defensible survivors) is treated the
      // same as "didn't qualify" for THIS rung — the cascade still tries the
      // next one — but the dropped comps are recorded in the audit trail,
      // never silently discarded.
      const outlierResult = rejectOutliers(rawSelection.retained);
      const retainedForStats = outlierResult.failed ? rawSelection.retained : outlierResult.survivors;
      const allExcluded = [...rawSelection.excluded, ...outlierResult.dropped];
      const stats = computeSoldPriceStats(retainedForStats);
      const coherent = !outlierResult.failed && isCoherentPriceSet(retainedForStats.filter(comp => !comp.bestOfferAccepted));
      const fullyQualifies = stats.compCount >= 3 && coherent;
      const rejectionReason = fullyQualifies ? null
        : stats.compCount === 0 ? 'no matching comps'
        : stats.compCount < 3 ? 'fewer than 3 coherent matching comps'
        : outlierResult.failed ? 'retained prices failed the outlier/coherence guard'
        : 'retained prices failed the p20/p80 coherence guard';
      attemptedQueries.push({
        providerId: soldResult.providerId ?? soldProvider.providerId,
        query: candidate.query, precision: candidate.precision,
        rawCompCount: soldResult.comps.length, retainedCompCount: stats.compCount,
        ...capExcluded(allExcluded), qualified: fullyQualifies, rejectionReason,
        providerLatencyMs: providerAttempts.find((entry) => entry.ok)?.latencyMs ?? providerLatencyMs,
        retryCount: 0,
      });
      const selectedProvider = {
        providerId: soldResult.providerId ?? soldProvider.providerId,
        suppliesBestOfferFlag: soldResult.suppliesBestOfferFlag ?? soldProvider.capabilities.suppliesBestOfferFlag,
      };
      if (fullyQualifies) {
        qualified = { query: candidate.query, precision: candidate.precision, comps: retainedForStats, ...selectedProvider };
        break;
      }
      // Track the best partial (1-2 usable comps) across the cascade —
      // never used alone, only as support alongside active evidence.
      if (stats.compCount >= 1 && stats.compCount <= 2 && (!partial || stats.compCount > partial.comps.length)) {
        partial = { query: candidate.query, precision: candidate.precision, comps: retainedForStats, ...selectedProvider };
      }
    }
  }

  const selected = qualified ?? partial;
  const queryForActive = selected?.query ?? plannedQueries[0].query;

  // Product/catalog and category resolution are best-effort — run against
  // the winning evidence query when one exists, else the first candidate.
  // §6.4 (P2-11): contained — a credential/outage failure here must never
  // discard an otherwise-qualified decision (see safeCatalogMatch/
  // safeResolveCategory above).
  const [catalogMatch, category] = await Promise.all([
    safeCatalogMatch(identity, queryForActive),
    safeResolveCategory(identity, queryForActive),
  ]);

  // Active evidence is best-effort informational/supporting evidence now,
  // never a hard requirement for a decision-capable result (Profit Scanner
  // v2) — a missing count is still never treated as a verified zero.
  let activeCandidate: ActiveMarketEvidence | null = null;
  let activeProviderFailure: { reason: MarketDataFailureReason; detail: string } | null = null;
  try {
    activeCandidate = await searchActiveListings({
      query: queryForActive, categoryId: category?.categoryId ?? undefined,
    });
  } catch (err) {
    if (err instanceof EbayAppAuthError) {
      activeProviderFailure = { reason: 'MARKETPLACE_AUTH_FAILED', detail: err.message };
    } else if (err instanceof ExternalCallError) {
      activeProviderFailure = {
        reason: err.kind === 'timeout' ? 'PROVIDER_TIMEOUT' : err.status === 429 ? 'PROVIDER_THROTTLED' : 'BROWSE_UNAVAILABLE',
        detail: err.message,
      };
    } else {
      activeProviderFailure = { reason: 'BROWSE_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // R3 (§6.2, T2): proportional support, not "every sampled listing must
  // match." retainedCount is the ONLY count feeding evidence quality;
  // totalActiveResultCount (the provider's raw total, can be thousands)
  // never does. Support qualifies at retainedCount>=5 AND
  // retainedCount/sampledCount>=0.60 — a single imperfect listing in twenty
  // no longer voids everything (the old `retained.length !== sampled.length`
  // all-or-nothing rule this replaces).
  let activeMarketEvidence: ActiveMarketEvidence | null = null;
  if (activeCandidate && activeCandidate.sampledListings.length > 0) {
    const sampleAsSold: SoldCompListing[] = activeCandidate.sampledListings.map(item => ({
      itemId: item.itemId, title: item.title, soldPrice: item.price, totalPrice: item.price,
      shippingPrice: null, shippingType: null, currency: item.currency,
      endedAt: new Date(0).toISOString(), condition: item.condition, conditionId: item.conditionId,
      buyingFormat: null, bidCount: null, bestOfferAccepted: false, listingType: null,
      listingUrl: item.itemWebUrl, sellerFeedbackScore: null, sellerFeedbackPercent: null,
    }));
    const precisionForFilter = (selected?.precision ?? 'substitute') as
      'exact_model_variant' | 'exact_model' | 'product_family' | 'substitute';
    const activeSelection = selectComparableSoldComps(sampleAsSold, identity, { query: queryForActive, precision: precisionForFilter });
    const sampledCount = sampleAsSold.length;
    const retainedCount = activeSelection.retained.length;
    const proportionOk = sampledCount > 0 && (retainedCount / sampledCount) >= 0.60;
    if (retainedCount >= 5 && proportionOk) {
      const retainedIds = new Set(activeSelection.retained.map((c) => c.itemId));
      activeMarketEvidence = {
        totalActiveResultCount: activeCandidate.totalActiveResultCount,
        sampledCount, retainedCount,
        sampledListings: activeCandidate.sampledListings,
        retainedListings: activeCandidate.sampledListings.filter((l) => retainedIds.has(l.itemId)),
        askingPriceLow: activeCandidate.askingPriceLow, askingPriceHigh: activeCandidate.askingPriceHigh,
      };
    }
  }
  const activeAskingPricesCoherent = activeMarketEvidence
    ? isCoherentPriceSpread(activeMarketEvidence.retainedListings.map(l => l.price))
    : false;

  // R1 (P1-10): what Browse actually returned vs. what survived the
  // identity-match filter above.
  const activeSample = {
    sampled: activeCandidate?.sampledListings.length ?? 0,
    retained: activeMarketEvidence?.retainedCount ?? 0,
    totalResultCount: activeCandidate?.totalActiveResultCount ?? null,
  };

  // ── Evidence-quality assessment (marketplace-independent, Profit Scanner v2) ──
  const soldSignal = selected ? {
    count: selected.comps.length, precision: selected.precision, coherent: selected === qualified,
  } : null;
  const activeSignal = activeMarketEvidence ? {
    count: activeMarketEvidence.retainedCount, coherent: activeAskingPricesCoherent,
  } : null;
  let evidenceQuality = assessEvidenceQuality({ soldEvidence: soldSignal, activeEvidence: activeSignal });
  // A provider that cannot distinguish accepted Best Offers cannot prove the
  // displayed amount was the final transaction price. It may support LIST,
  // but cannot independently earn the strong-evidence/HOT tier.
  if (evidenceQuality === 'strong' && selected?.suppliesBestOfferFlag === false) {
    evidenceQuality = 'moderate';
  }

  if (evidenceQuality === 'none' || evidenceQuality === 'weak') {
    // §6.4/P1-8: an operational failure encountered along the way is a more
    // honest, more actionable reason than a generic "no evidence" message —
    // never silently converted into one. An unconfigured sold provider is
    // likewise its own honest reason, not folded into "no market evidence."
    if (soldProviderFailure) {
      return {
        ok: false, reason: soldProviderFailure.reason, detail: soldProviderFailure.detail,
        audit: { attemptedQueries, selectedQuery: selected?.query ?? null, activeSample },
      };
    }
    if (activeProviderFailure) {
      return {
        ok: false, reason: activeProviderFailure.reason, detail: activeProviderFailure.detail,
        audit: { attemptedQueries, selectedQuery: selected?.query ?? null, activeSample },
      };
    }
    if (!soldProvider) {
      return {
        ok: false, reason: 'SOLDCOMPS_NOT_CONFIGURED',
        detail: 'No sold-comp provider is configured (SERP_API_KEY/SOLD_COMPS_API_KEY/TRAWL_API_KEY absent) — active-market-only evidence did not reach a decisive tier.',
        audit: { attemptedQueries, selectedQuery: selected?.query ?? null, activeSample },
      };
    }
    if (evidenceQuality === 'none') {
      return {
        ok: false, reason: 'INSUFFICIENT_VERIFIED_MARKET_DATA',
        detail: 'No usable sold or active marketplace evidence was found for this item.',
        audit: { attemptedQueries, selectedQuery: selected?.query ?? null, activeSample },
      };
    }
    const soldNote = soldSignal ? `${soldSignal.count} sold comp(s) at ${soldSignal.precision} precision` : 'no matching sold comps';
    const activeNote = activeSignal ? `${activeSignal.count} active listing(s)` : 'no matching active listings';
    return {
      ok: false, reason: 'EVIDENCE_TOO_WEAK',
      detail: `Found ${soldNote} and ${activeNote} — not enough coherent, comparable evidence to trust a HOT/LIST/SKIP recommendation.`,
      audit: { attemptedQueries, selectedQuery: selected?.query ?? null, activeSample },
    };
  }

  // evidenceQuality is 'strong' or 'moderate' from here on. soldPriceStats
  // reflects sold-comp evidence ONLY (never merges asking prices into
  // sold-price fields — task doc §10) — it stays all-null when there are no
  // usable sold comps. The active-evidence-only expected-sale-price fallback
  // (conservative asking-price percentile, never the highest listing) is a
  // MarketplaceEvidence-level v2 concept, computed by the marketplace
  // provider adapter (marketplaceProviders.ts getEbayMarketplaceEvidence),
  // not here.
  const soldPriceStats = computeSoldPriceStats(selected?.comps ?? []);
  soldPriceStats.evidenceQuality = evidenceQuality;

  // STR/turnover/demand are informational-only now (never gating) — only
  // computed when BOTH verified sold and active evidence exist and describe
  // the same item population.
  let turnover = null as MarketMetrics['turnover'];
  let sellThroughRate: number | null = null;
  let demandLevel: MarketMetrics['demandLevel'] = null;
  if (qualified && activeMarketEvidence) {
    const windowStart = Date.now() - DEFAULT_SOLD_WINDOW_DAYS * 86_400_000;
    const soldCount90d = qualified.comps.filter((comp) => Date.parse(comp.endedAt) >= windowStart).length;
    turnover = computeMarketTurnoverDays(soldCount90d, DEFAULT_SOLD_WINDOW_DAYS, activeMarketEvidence.retainedCount);
    sellThroughRate = computeSellThroughRate(soldCount90d, activeMarketEvidence.retainedCount);
    demandLevel = computeDemandLevel(sellThroughRate, turnover?.marketTurnoverDays ?? null);
  }

  const metrics: MarketMetrics = {
    compMatchPrecision: selected?.precision ?? null,
    soldPriceStats, activeMarketEvidence, turnover, sellThroughRate, demandLevel,
  };

  return {
    ok: true, identity, catalogMatch, category, soldProviderId: selected?.providerId ?? null, metrics,
    audit: { selectedQuery: queryForActive, attemptedQueries, activeSample },
  };
}
