// SerpAPI eBay Sold Provider — primary eBay sold-history provider.
// Replaces Trawl on the default decision path (DECISIONS.md 2026-09-11).
// Uses engine=ebay with show_only=Sold to fetch only items that actually sold
// (completed-unsold listings are not evidence of a real transaction).
//
// SERP_API_KEY is shared with serpApiIdentification.ts (Google Lens visual
// identification). Sold search and visual identification are separate API calls
// billed to the same account — they do not duplicate each other.
//
// Evidence contract: every result from show_only=Sold is admitted as
// verified_transaction evidence unless it carries an unsold_date field
// (explicit signal that the listing ended without a buyer). A missing
// sold_date is not a rejection reason — eBay's own sold-filter guarantees
// the item sold; an unknown date is kept outside recent-velocity metrics.
import type { SoldCompListing, MarketDataFailureReason } from "./marketData.ts"
import type { MarketEvidenceProviderCapabilities } from "./marketplaceTypes.ts"
import type { SoldMarketDataProvider, SoldCompsQuery, SoldEvidenceResult } from "./soldCompsProvider.ts"
import { externalCall, ExternalCallError } from "./externalCall.ts"

const SERP_API_BASE_URL = 'https://serpapi.com/search.json';
const REQUEST_TIMEOUT_MS = 30_000;

function numLike(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// Extracts the numeric price from SerpAPI's price object.
// SerpAPI uses `extracted` in some contexts, `extracted_value` in others.
function extractPrice(priceObj: unknown): number | null {
  if (typeof priceObj !== 'object' || priceObj === null) return null;
  const p = priceObj as Record<string, unknown>;
  return numLike(p.extracted) ?? numLike(p.extracted_value);
}

function isAmbiguousRange(priceObj: unknown): boolean {
  if (typeof priceObj !== 'object' || priceObj === null) return false;
  const p = priceObj as Record<string, unknown>;
  return typeof p.from === 'object' || typeof p.to === 'object';
}

// Parses one raw SerpAPI eBay organic_results entry into a SoldCompListing.
// Returns null for any record failing required-field validation — never coerces
// a missing or malformed price into a fabricated number.
// Exported for direct unit testing.
export function parseSerpApiSoldItem(raw: unknown): SoldCompListing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  // An unsold_date field means the item ended without a buyer — exclude it
  // even when fetched via show_only=Sold (defensive guard against API quirks).
  if (r.unsold_date !== undefined && r.unsold_date !== null) return null;

  // Price: may be in `price` object or `prices` array (first element).
  let soldPrice: number | null = null;
  if (r.price !== undefined) {
    soldPrice = extractPrice(r.price);
    // Some responses carry the price directly as a number
    if (soldPrice === null) soldPrice = numLike(r.price);
  } else if (Array.isArray(r.prices) && r.prices.length > 0) {
    soldPrice = extractPrice(r.prices[0]);
  }
  if (soldPrice === null || soldPrice <= 0) return null;

  // Title is required.
  const title = str(r.title);
  if (!title) return null;

  // Item ID: prefer product_id, fall back to item_id, then extract from link.
  let itemId: string | null = str(r.product_id) ?? str(r.item_id);
  if (!itemId) {
    const linkMatch = str(r.link)?.match(/\/itm\/(\d+)/);
    itemId = linkMatch ? linkMatch[1] : null;
  }
  if (!itemId) return null;

  // Sold date: parse human-readable "Aug 15, 2026" or ISO "2026-08-15".
  // Preserve an unknown date as epoch. This keeps a real sold price usable
  // for valuation while ensuring it cannot enter the 90-day velocity window.
  let endedAt: string;
  const rawDate = str(r.sold_date);
  if (rawDate) {
    const ts = Date.parse(rawDate);
    endedAt = Number.isNaN(ts) ? new Date(0).toISOString() : new Date(ts).toISOString();
  } else {
    endedAt = new Date(0).toISOString();
  }

  return {
    itemId,
    title,
    soldPrice,
    totalPrice: soldPrice, // SerpAPI eBay does not expose separate shipping price
    shippingPrice: null,
    shippingType: null,
    currency: 'USD',
    endedAt,
    condition: str(r.condition),
    conditionId: null,
    buyingFormat: null,
    bidCount: null,
    bestOfferAccepted: false, // SerpAPI eBay does not report Best Offer acceptance
    listingType: 'sold',
    listingUrl: str(r.link),
    sellerFeedbackScore: null,
    sellerFeedbackPercent: null,
  };
}

function mapSerpApiEbayError(err: unknown): SoldEvidenceResult {
  if (err instanceof ExternalCallError) {
    if (err.kind === 'timeout') {
      return { ok: false, reason: 'PROVIDER_TIMEOUT', detail: `SerpAPI eBay sold request exceeded ${REQUEST_TIMEOUT_MS}ms` };
    }
    if (err.kind === 'parse') {
      return {
        ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE',
        detail: typeof err.cause === 'string' ? err.cause : err.message,
      };
    }
    if (err.kind === 'http' && err.status === 429) {
      return {
        ok: false,
        reason: 'PROVIDER_THROTTLED',
        detail: err.retryAfterMs !== undefined
          ? `SerpAPI rate limit; retry after ${Math.ceil(err.retryAfterMs / 1000)}s`
          : 'SerpAPI rate or throughput limit reached',
      };
    }
    const status = err.status !== undefined ? `${err.status} ` : '';
    return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: `SerpAPI eBay ${status}${err.bodyText ?? err.message}`.slice(0, 500) };
  }
  return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
}

export class SerpApiEbaySoldProvider implements SoldMarketDataProvider {
  readonly providerId = 'serpapi.com/ebay';
  readonly capabilities: MarketEvidenceProviderCapabilities = {
    marketplace: 'ebay',
    evidenceClass: 'verified_transaction',
    queryMatching: 'all_terms',   // eBay's search requires all query words to appear
    maxUsefulQueryTerms: 4,
    supportsPagination: false,    // single-page fetch; pagination is a future enhancement
    suppliesBestOfferFlag: false, // SerpAPI eBay does not expose Best Offer acceptance
    costClass: 'metered_quota',   // SerpAPI charges per search
  } as const;

  constructor(private readonly apiKey: string) {}

  async searchSoldComps(query: SoldCompsQuery): Promise<SoldEvidenceResult> {
    const qs = new URLSearchParams({
      engine: 'ebay',
      _nkw: query.searchTerms,
      show_only: 'Sold',    // verified sold items only — NOT "Complete" (includes unsold)
      api_key: this.apiKey,
      // No no_cache=true: SerpAPI's default caching is acceptable for sold data
      // and reduces cost (cached results are free).
    });

    try {
      const data = await externalCall<Record<string, unknown>>(
        `${SERP_API_BASE_URL}?${qs.toString()}`,
        { method: 'GET' },
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          // Give one live eBay-engine search enough time to finish instead
          // of aborting and repeating the same paid request.
          maxRetries: 0,
          isIdempotent: true,
          shouldRetry: (error, retryAfterMs) => {
            if (error.kind === 'http') {
              if (error.status === 429) return retryAfterMs !== undefined;
              if (error.status !== undefined && error.status < 500) return false;
            }
            return true;
          },
        },
        (res) => res.json() as Promise<Record<string, unknown>>,
      );

      const searchStatus = (data.search_metadata as Record<string, unknown> | undefined)?.status;
      if (searchStatus !== 'Success') {
        const errorDetail = str(data.error) ?? `SerpAPI reported status: ${String(searchStatus ?? 'unknown')}`;
        if (typeof data.error === 'string' && data.error.toLowerCase().includes('quota')) {
          return { ok: false, reason: 'PROVIDER_QUOTA_EXHAUSTED', detail: data.error };
        }
        return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: errorDetail };
      }

      const rawResults = Array.isArray(data.organic_results) ? data.organic_results as unknown[] : [];
      const comps = rawResults.map(parseSerpApiSoldItem).filter((c): c is SoldCompListing => c !== null);

      const safelyUnusable = rawResults.length > 0 && rawResults.every((raw) => {
        if (typeof raw !== 'object' || raw === null) return false;
        const row = raw as Record<string, unknown>;
        return isAmbiguousRange(row.price);
      });
      if (rawResults.length > 0 && comps.length === 0 && !safelyUnusable) {
        return {
          ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE',
          detail: 'SerpAPI eBay returned results but none matched the expected sold-item field contract',
        };
      }

      return { ok: true, comps };
    } catch (err) {
      return mapSerpApiEbayError(err);
    }
  }
}
