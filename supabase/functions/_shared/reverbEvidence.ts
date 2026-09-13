// R3 (docs/files/DECISIONS.md "Reverb price-guide evidence pulled into
// R3..."): a real Reverb adapter, category-gated by marketplaceRouter.ts
// (guitars/pedals/amps/synths/pro audio) — the one piece of R5's provider
// federation map pulled forward into R3 rather than left NOT_CONFIGURED.
//
// Calls Reverb's official, documented, authenticated Listings API
// (GET /api/listings) for current active asking prices — NOT the
// undocumented/unauthenticated `/api/priceguide` scrape path (see the
// plan's §8.0: that path is "undocumented and may change without notice,"
// and its per-guide transactions endpoint "was retired in 2026" — not a
// stable foundation, and inconsistent with a configured API *key* since
// that anonymous path takes no auth at all). Evidence class is therefore
// `active_market`, capped at `moderate` — never `strong`/HOT-qualifying,
// same §8.1 ceiling principle full federation uses. Reuses the same
// provider-generic scored matcher (compSelection.ts) and proportional
// support rule (T2: retainedCount>=5 AND retainedCount/sampledCount>=0.60)
// eBay Browse active evidence already uses — never a second, bespoke
// matching implementation for one marketplace.
import { externalCall, ExternalCallError } from "./externalCall.ts"
import { planMarketEvidenceQueries } from "./queryPlanner.ts"
import { selectComparableSoldComps, isCoherentPriceSpread } from "./compSelection.ts"
import type { IdentityCandidate, SoldCompListing } from "./marketData.ts"
import type {
  MarketEvidenceProviderCapabilities, MarketplaceEvidenceResult, ProviderFailureReason,
} from "./marketplaceTypes.ts"

const REVERB_API_KEY_ENV_NAME = 'REVERB_API_KEY';
const REVERB_LISTINGS_URL = 'https://api.reverb.com/api/listings';
const REQUEST_TIMEOUT_MS = 10_000;

const REVERB_CAPS: MarketEvidenceProviderCapabilities = {
  marketplace: 'reverb',
  evidenceClass: 'active_market',
  queryMatching: 'relevance',
  maxUsefulQueryTerms: 6,
  supportsPagination: true,
  suppliesBestOfferFlag: false,
  costClass: 'rate_limited',
};

interface ReverbListing {
  id?: string | number
  title?: string
  price?: { amount?: string | number; currency?: string }
  condition?: { display_name?: string }
  _links?: { web?: { href?: string } }
}

function numLike(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toSoldShaped(listing: ReverbListing, index: number): SoldCompListing | null {
  const price = numLike(listing.price?.amount);
  if (price === null || price <= 0) return null;
  const title = typeof listing.title === 'string' ? listing.title : '';
  if (!title) return null;
  return {
    itemId: String(listing.id ?? index),
    title, soldPrice: price, totalPrice: price, shippingPrice: null, shippingType: null,
    currency: listing.price?.currency ?? 'USD', endedAt: new Date(0).toISOString(),
    condition: listing.condition?.display_name ?? null, conditionId: null,
    buyingFormat: null, bidCount: null, bestOfferAccepted: false, listingType: null,
    listingUrl: listing._links?.web?.href ?? null, sellerFeedbackScore: null, sellerFeedbackPercent: null,
  };
}

function mapFailure(reason: ProviderFailureReason, detail: string): MarketplaceEvidenceResult {
  return { ok: false, marketplace: 'reverb', reason, detail };
}

export async function getReverbMarketplaceEvidence(identity: IdentityCandidate): Promise<MarketplaceEvidenceResult> {
  const apiKey = Deno.env.get(REVERB_API_KEY_ENV_NAME);
  if (!apiKey) {
    return mapFailure('NOT_CONFIGURED', `${REVERB_API_KEY_ENV_NAME} is not configured`);
  }

  const queries = planMarketEvidenceQueries(identity, REVERB_CAPS);
  if (!queries.length) {
    return mapFailure('IDENTIFICATION_UNRESOLVED', 'Identification produced no usable search terms for Reverb');
  }
  // A relevance search engine doesn't need the full all_terms retry
  // cascade — the single highest-precision rung is the best query to send.
  const query = queries[0];

  let rawListings: ReverbListing[];
  try {
    rawListings = await externalCall<ReverbListing[]>(
      `${REVERB_LISTINGS_URL}?${new URLSearchParams({ query: query.query, per_page: '40' }).toString()}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/hal+json',
          'Accept-Version': '3.0',
        },
      },
      { timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: 1, isIdempotent: true },
      async (res) => {
        const data = await res.json().catch(() => null);
        if (data === null || typeof data !== 'object') throw new Error('Reverb response was not valid JSON');
        const d = data as Record<string, unknown>;
        return Array.isArray(d.listings) ? d.listings as ReverbListing[] : [];
      },
    );
  } catch (err) {
    if (err instanceof ExternalCallError) {
      if (err.kind === 'timeout') return mapFailure('PROVIDER_TIMEOUT', `Reverb request exceeded ${REQUEST_TIMEOUT_MS}ms`);
      if (err.kind === 'http' && err.status === 429) return mapFailure('PROVIDER_THROTTLED', 'Reverb rate limit exceeded');
      const status = err.status !== undefined ? `${err.status} ` : '';
      return mapFailure('PROVIDER_UNAVAILABLE', `Reverb ${status}${err.bodyText ?? err.message}`.slice(0, 500));
    }
    return mapFailure('PROVIDER_UNAVAILABLE', err instanceof Error ? err.message : String(err));
  }

  const sampled = rawListings.map(toSoldShaped).filter((l): l is SoldCompListing => l !== null);
  if (sampled.length === 0) {
    return mapFailure('INSUFFICIENT_VERIFIED_MARKET_DATA', 'No usable Reverb listings were found for this item');
  }

  // Same provider-generic scored matcher every other marketplace uses (T1) —
  // never a bespoke, one-off matching rule for Reverb.
  const selection = selectComparableSoldComps(sampled, identity, query);
  const sampledCount = sampled.length;
  const retainedCount = selection.retained.length;
  const proportionOk = sampledCount > 0 && retainedCount / sampledCount >= 0.60;
  const prices = selection.retained.map((c) => c.soldPrice).sort((a, b) => a - b);
  const coherent = isCoherentPriceSpread(prices);

  if (!(retainedCount >= 5 && proportionOk && coherent)) {
    return mapFailure('EVIDENCE_TOO_WEAK', `Found ${sampledCount} Reverb listing(s), ${retainedCount} matched — not enough coherent, comparable evidence.`);
  }

  // Conservative (never highest) asking-price percentile — same 35th-
  // percentile convention marketplaceProviders.ts uses for eBay's
  // active-only expected-sale-price fallback.
  const conservativeIdx = Math.floor((prices.length - 1) * 0.35);
  const expectedSalePrice = Math.round(prices[conservativeIdx] * 100) / 100;

  return {
    ok: true,
    evidence: {
      marketplace: 'reverb',
      evidenceType: 'active_market',
      matchedItemCount: retainedCount,
      comparableCount: retainedCount,
      askingPrices: prices,
      medianSoldPrice: null,
      medianAskingPrice: prices[Math.floor(prices.length / 2)] ?? null,
      priceLow: prices[0] ?? null, priceHigh: prices[prices.length - 1] ?? null,
      expectedSalePrice,
      matchPrecision: query.precision,
      // §8.1 class ceiling: active_market caps at moderate, never strong —
      // this adapter never claims HOT-qualifying evidence.
      evidenceQuality: 'moderate',
      sourceName: 'Reverb active listings',
      fetchedAt: new Date().toISOString(),
    },
  };
}
