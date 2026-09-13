// Marketplace evidence providers (task doc §8-9). eBay is wired to the real,
// live-verified pipeline (marketDataPipeline.ts — SerpAPI/SoldComps/Trawl sold
// evidence + eBay Browse active evidence). Every other marketplace is a
// provider-boundary placeholder: no supported API integration is
// implemented for Etsy/Reverb/Discogs/Amazon/Mercari/Poshmark yet (no
// official API credentials configured in this environment), so each returns
// an explicit NOT_CONFIGURED result — never scraped, never fabricated, never
// silently substituted with an AI guess. Facebook/local has no evidence
// provider at all: per task doc §9, a local-sale recommendation borrows
// valuation evidence from another marketplace and applies local-sale
// economics (facebook_local's $0/no-shipping fee profile) — see
// marketplaceOpportunity.ts.
import { resolveVerifiedMarketData } from "./marketDataPipeline.ts"
import { getReverbMarketplaceEvidence as getReverbEvidenceReal } from "./reverbEvidence.ts"
import type { IdentityCandidate, MarketDataFailureReason, MarketDataResult } from "./marketData.ts"
import type {
  MarketplaceEvidenceResult, MarketplaceId, ProviderFailureReason,
} from "./marketplaceTypes.ts"

function medianOf(sorted: number[]): number | null {
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const REASON_MAP: Record<MarketDataFailureReason, ProviderFailureReason> = {
  IDENTIFICATION_UNRESOLVED: 'IDENTIFICATION_UNRESOLVED',
  CATALOG_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TAXONOMY_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  SOLDCOMPS_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  SOLDCOMPS_NOT_CONFIGURED: 'NOT_CONFIGURED',
  BROWSE_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INSUFFICIENT_VERIFIED_MARKET_DATA: 'INSUFFICIENT_VERIFIED_MARKET_DATA',
  EVIDENCE_TOO_WEAK: 'EVIDENCE_TOO_WEAK',
  MARKETPLACE_AUTH_FAILED: 'MARKETPLACE_AUTH_FAILED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_THROTTLED: 'PROVIDER_THROTTLED',
  PROVIDER_QUOTA_EXHAUSTED: 'PROVIDER_QUOTA_EXHAUSTED',
  MALFORMED_PROVIDER_RESPONSE: 'MALFORMED_PROVIDER_RESPONSE',
}

// eBay implements both TransactionEvidenceProvider (sold comps) and
// MarketplaceSignalProvider (Browse active listings) at once — the existing
// pipeline already fuses both into one evidence-quality-assessed result.
// Split into a raw fetch + a pure mapper so a caller that also wants eBay's
// raw MarketDataResult (e.g. for the informational-only sell-through-rate/
// demand-level fields kept for Inventory's SourcingMeta — see
// claude-proxy/index.ts) can do so without a second, redundant pipeline run.
export async function getEbayMarketplaceEvidence(identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return mapEbayResultToEvidence(await resolveVerifiedMarketData(identity))
}

export function mapEbayResultToEvidence(result: MarketDataResult): MarketplaceEvidenceResult {
  if (!result.ok) {
    // R1 (P1-10): carry the query-cascade audit trail through instead of
    // discarding it here — it used to stop at this boundary while scan_log
    // kept only reason/detail.
    return { ok: false, marketplace: 'ebay', reason: REASON_MAP[result.reason], detail: result.detail, audit: result.audit }
  }
  const stats = result.metrics.soldPriceStats
  const active = result.metrics.activeMarketEvidence
  // R3 (T2): asking-price evidence is built from the RETAINED (identity-
  // matched) listings, never the raw sample — retainedListings is what
  // survived compSelection.ts's scorer.
  const askingPrices = active?.retainedListings.map(l => l.price).filter(p => Number.isFinite(p) && p > 0).sort((a, b) => a - b) ?? []
  const medianAsking = medianOf(askingPrices)

  // Expected sale price: sold-comp median when real sold evidence exists
  // (robust market center); otherwise a conservative (never the highest
  // listing) asking-price percentile from active-only moderate evidence.
  // This blending happens HERE, at the MarketplaceEvidence layer — never in
  // soldPriceStats itself, which must never have asking prices merged into
  // its sold-price fields (task doc §10).
  const conservativeAskingIdx = Math.floor((askingPrices.length - 1) * 0.35)
  const conservativeAskingPrice = askingPrices.length ? round2(askingPrices[conservativeAskingIdx]) : null
  const expectedSalePrice = stats.compCount > 0 ? stats.medianSoldPrice : conservativeAskingPrice
  const priceLow = stats.compCount > 0 ? stats.soldPriceLow : (askingPrices.length ? round2(askingPrices[0]) : null)
  const priceHigh = stats.compCount > 0 ? stats.soldPriceHigh : active?.askingPriceHigh ?? null

  return {
    ok: true,
    evidence: {
      marketplace: 'ebay',
      evidenceType: stats.compCount > 0 ? 'verified_transaction' : 'active_market',
      // R3 (T2): totalActiveResultCount (informational competition volume)
      // here, never used as if every result were a matched comparable.
      matchedItemCount: stats.compCount + (active?.retainedCount ?? 0),
      comparableCount: stats.compCount,
      askingPrices,
      medianSoldPrice: stats.compCount > 0 ? stats.medianSoldPrice : null,
      medianAskingPrice: medianAsking,
      priceLow, priceHigh, expectedSalePrice,
      matchPrecision: result.metrics.compMatchPrecision,
      evidenceQuality: stats.evidenceQuality,
      sourceName: stats.compCount > 0
        ? `eBay sold listings (${result.soldProviderId ?? 'provider'})${active ? ' + active market data' : ''}`
        : 'eBay active market data',
      fetchedAt: new Date().toISOString(),
    },
    audit: result.audit,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Placeholder adapters — provider boundary is real (matches the task doc's
// TransactionEvidenceProvider/MarketplaceSignalProvider contracts), but no
// supported API access exists in this environment. Never scrapes a
// marketplace whose terms/API don't support it (task doc §9, §23).
function notConfigured(marketplace: MarketplaceId, envVar: string): MarketplaceEvidenceResult {
  return {
    ok: false, marketplace, reason: 'NOT_CONFIGURED',
    detail: `No supported ${envVar.replace(/_API_.*/, '')} API integration is implemented yet — provider boundary exists (marketplaceProviders.ts), wire a real adapter behind ${envVar} when official API access is available.`,
  }
}

export async function getEtsyMarketplaceEvidence(_identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return notConfigured('etsy', 'ETSY_API_KEY')
}

// R3: real adapter (reverbEvidence.ts), category-gated by
// marketplaceRouter.ts — see DECISIONS.md "Reverb price-guide evidence
// pulled into R3...". Reports NOT_CONFIGURED itself when REVERB_API_KEY is
// absent, so no separate placeholder branch is needed here.
export async function getReverbMarketplaceEvidence(identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return getReverbEvidenceReal(identity)
}

export async function getDiscogsMarketplaceEvidence(_identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return notConfigured('discogs', 'DISCOGS_API_TOKEN')
}

export async function getAmazonMarketplaceEvidence(_identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return notConfigured('amazon', 'AMAZON_SP_API_CREDENTIALS')
}

export async function getMercariMarketplaceEvidence(_identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return notConfigured('mercari', 'MERCARI_API_KEY')
}

export async function getPoshmarkMarketplaceEvidence(_identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  return notConfigured('poshmark', 'POSHMARK_API_KEY')
}

// Marketplaces with a real evidence provider today. facebook_local
// deliberately has no entry — see file header.
const EVIDENCE_PROVIDERS: Partial<Record<MarketplaceId, (identity: IdentityCandidate) => Promise<MarketplaceEvidenceResult>>> = {
  ebay: getEbayMarketplaceEvidence,
  etsy: getEtsyMarketplaceEvidence,
  reverb: getReverbMarketplaceEvidence,
  discogs: getDiscogsMarketplaceEvidence,
  amazon: getAmazonMarketplaceEvidence,
  mercari: getMercariMarketplaceEvidence,
  poshmark: getPoshmarkMarketplaceEvidence,
}

// Fetches evidence for every routed marketplace that has a provider,
// concurrently. A provider failure never throws — same "explicit failure,
// never a fabricated zero" contract as every provider above.
export async function fetchMarketplaceEvidence(
  identity: IdentityCandidate,
  marketplaces: MarketplaceId[],
): Promise<Partial<Record<MarketplaceId, MarketplaceEvidenceResult>>> {
  const entries = await Promise.all(
    marketplaces
      .filter((m) => EVIDENCE_PROVIDERS[m])
      .map(async (m) => [m, await EVIDENCE_PROVIDERS[m]!(identity)] as const),
  )
  return Object.fromEntries(entries)
}
