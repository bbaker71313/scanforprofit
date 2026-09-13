// Deno-native mirror of packages/shared/src/types/marketData.ts.
// Duplicated intentionally — see financialEngine.ts for why (unverified
// cross-package import through the Supabase CLI bundler). Keep in lockstep.

import type { DemandLevel } from "./decisionEngine.ts"

export type IdentificationEvidenceKind =
  | 'barcode' | 'gtin' | 'upc' | 'ean' | 'isbn'
  | 'model_number' | 'manufacturer_part_number'
  | 'ocr_label' | 'catalog_match'
  | 'verified_attributes' | 'visual_ai' | 'text_inference'
  // R3: a confident SerpAPI Google Lens visual-product-search title match
  // contributed identity.itemName — see serpApiIdentification.ts. Feeds the
  // M "reasonably identifiable" gate (identityNormalization.ts).
  | 'visual_product_search'

export interface IdentityCandidate {
  itemName: string | null
  brand: string | null
  model: string | null
  variant: string | null
  gtin: string | null
  gtinKind: 'GTIN' | 'UPC' | 'EAN' | 'ISBN' | null
  manufacturerPartNumber: string | null
  // R2 (§5.3): a salvaged family signal from a rejected model_number value
  // (identityNormalization.ts's parseModelToken), e.g. "p-series" — real
  // identity signal that isn't a validated model, kept instead of discarded.
  // Feeds a query-planner rung (queryPlanner.ts) and, eventually, a scoring
  // signal — never treated as equivalent to a validated model.
  modelFamilyHint: string | null
  likelyEbayCategory: string | null
  categoryHints: string[]
  conditionHints: string | null
  unresolvedAttributes: string[]
  identityConfidence: number
  evidenceUsed: IdentificationEvidenceKind[]
  normalizedSearchTerms: string[]
  providerId: string
}

export interface CatalogMatch {
  matchType: 'exact' | 'probable' | 'none'
  epid: string | null
  gtin: string | null
  title: string | null
  brand: string | null
  aspects: Record<string, string[]>
}

export interface CategoryResolution {
  categoryTreeId: string | null
  categoryId: string | null
  categoryName: string | null
  resolved: boolean
}

export interface SoldCompListing {
  itemId: string
  title: string
  soldPrice: number
  totalPrice: number | null
  shippingPrice: number | null
  shippingType: string | null
  currency: string
  endedAt: string
  condition: string | null
  conditionId: string | null
  buyingFormat: string | null
  bidCount: number | null
  bestOfferAccepted: boolean
  listingType: string | null
  listingUrl: string | null
  sellerFeedbackScore: number | null
  sellerFeedbackPercent: number | null
}

export interface ActiveListingSummary {
  itemId: string
  title: string
  price: number
  currency: string
  condition: string | null
  conditionId: string | null
  categoryId: string | null
  itemWebUrl: string | null
}

// R3 (DECISIONS.md T2): the provider's raw unfiltered result count and the
// RETAINED (identity-matched) count are two different numbers with two
// different jobs. totalActiveResultCount is informational competition-volume
// only — it must never feed evidence quality and must never be treated as
// if every result were a valid comparable. retainedCount (the length of
// retainedListings after compSelection.ts's scorer runs) is the ONLY count
// evidenceQuality.ts may read. sampledCount is how many raw listings were
// actually fetched/considered before filtering — the denominator for T2's
// ≥60% retained-proportion rule (marketDataPipeline.ts).
export interface ActiveMarketEvidence {
  /** eBay's/the provider's own total-matches count — informational only,
   *  can be thousands. NEVER an evidence-quality input. */
  totalActiveResultCount: number
  /** How many raw listings were fetched and run through the matcher. */
  sampledCount: number
  /** How many survived the scored matcher (compSelection.ts) — the ONLY
   *  count evidenceQuality.ts's assessEvidenceQuality may consume. */
  retainedCount: number
  sampledListings: ActiveListingSummary[]
  retainedListings: ActiveListingSummary[]
  askingPriceLow: number | null
  askingPriceHigh: number | null
}

export type CompMatchPrecision =
  | 'exact_identifier_variant'
  | 'exact_model_variant'
  | 'exact_model'
  | 'product_family'
  | 'substitute'

export interface SoldPriceStats {
  compCount: number
  excludedBestOfferCount: number
  medianSoldPrice: number | null
  averageSoldPrice: number | null
  soldPriceLow: number | null
  soldPriceHigh: number | null
  evidenceQuality: 'strong' | 'moderate' | 'weak' | 'none'
}

export interface MarketTurnoverEstimate {
  marketTurnoverDays: number | null
  averageVerifiedSalesPerDay: number | null
  soldWindowDays: number
  soldCountInWindow: number
  activeInventoryCount: number
}

export interface MarketMetrics {
  compMatchPrecision: CompMatchPrecision | null
  // soldPriceStats.evidenceQuality is the Profit Scanner v2 marketplace-
  // independent decision-authority tier (evidenceQuality.ts's
  // assessEvidenceQuality), not a plain comp-count bucket.
  soldPriceStats: SoldPriceStats
  activeMarketEvidence: ActiveMarketEvidence | null
  turnover: MarketTurnoverEstimate | null
  // Profit Scanner v2: sell-through rate / demand level are no longer
  // scanner decision inputs (decisionEngine.ts) — eBay-specific signals that
  // don't generalize across marketplaces. Kept informational-only, for
  // backward compatibility with Inventory's SourcingMeta / Listing Generator
  // (out of scope for the scanner redesign). Never gates HOT/LIST/SKIP.
  //
  // Approved formula (product-owner-approved 2026-08-26):
  //   STR = soldCount90d / (soldCount90d + activeCount) * 100
  sellThroughRate: number | null
  // Approved thresholds (product-owner-approved 2026-08-26) — see
  // computeDemandLevel in marketMetrics.ts.
  demandLevel: DemandLevel | null
}

export type MarketDataFailureReason =
  | 'IDENTIFICATION_UNRESOLVED'
  | 'CATALOG_UNAVAILABLE'
  | 'TAXONOMY_UNAVAILABLE'
  | 'SOLDCOMPS_UNAVAILABLE'
  | 'SOLDCOMPS_NOT_CONFIGURED'
  | 'BROWSE_UNAVAILABLE'
  | 'INSUFFICIENT_VERIFIED_MARKET_DATA'
  // Profit Scanner v2: real evidence was found (at least one sold comp or
  // active listing) but it only reaches 'weak' evidence-quality — not enough
  // to defensibly support HOT/LIST/SKIP. Distinct from
  // INSUFFICIENT_VERIFIED_MARKET_DATA (zero usable evidence at all) so the UI
  // can say what was actually observed. Both are LIMITED EVIDENCE states —
  // never a fabricated decision.
  | 'EVIDENCE_TOO_WEAK'
  | 'MARKETPLACE_AUTH_FAILED'
  | 'PROVIDER_TIMEOUT'
  // R1 (P1-9): split from the former single PROVIDER_RATE_LIMITED so the
  // client can honestly distinguish "retry shortly" from "the monthly
  // allowance is spent" instead of one identical message for both. Only set
  // where the provider actually distinguishes them (Trawl's Retry-After
  // header, see soldCompsProvider.ts) — never guessed.
  | 'PROVIDER_THROTTLED'
  | 'PROVIDER_QUOTA_EXHAUSTED'
  | 'MALFORMED_PROVIDER_RESPONSE'

// R1 (P1-10): the forensic record of every sold-comp query attempted for one
// scan, carried all the way from marketDataPipeline.ts through
// MarketplaceEvidenceResult into scan_log.raw_response.decisionAudit — never
// discarded at the marketplace-provider boundary. Bounded so a shelf scan
// with pagination/retries can't balloon the persisted row; never logs
// provider credentials or raw response bodies.
export interface MarketEvidenceAuditEntry {
  providerId?: string
  query: string
  precision: CompMatchPrecision
  rawCompCount: number
  retainedCompCount: number
  // Capped at 25 entries per query — the remainder is counted, not dropped
  // silently, via excludedOverflowCount.
  excludedComps: Array<{ itemId: string; title: string; soldPrice: number; reason: string }>
  excludedOverflowCount: number
  qualified: boolean
  rejectionReason: string | null
  providerLatencyMs: number
  // Always 0 until the Retry-After retry policy (task doc §5.2, decision B)
  // is implemented — never fabricated ahead of that.
  retryCount: number
}

export interface MarketEvidenceAudit {
  attemptedQueries: MarketEvidenceAuditEntry[]
  // null when no query fully or partially qualified (e.g. every attempt
  // failed outright, or identification never produced a usable query).
  selectedQuery: string | null
  // Active-listing sampling outcome, present only once the pipeline reached
  // that stage (never fabricated for an early sold-comp failure that never
  // got there).
  activeSample: { sampled: number; retained: number; totalResultCount: number | null } | null
}

export interface MarketDataFailure {
  ok: false
  reason: MarketDataFailureReason
  detail: string
  audit?: MarketEvidenceAudit
}

export interface MarketDataSuccess {
  ok: true
  identity: IdentityCandidate
  catalogMatch: CatalogMatch | null
  category: CategoryResolution | null
  soldProviderId?: string | null
  metrics: MarketMetrics
  audit?: MarketEvidenceAudit
}

export type MarketDataResult = MarketDataSuccess | MarketDataFailure
