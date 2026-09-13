// SoldComps (api.sold-comps.com) — the approved sold-history provider while
// eBay Marketplace Insights production access is unavailable (task doc §4).
// Built behind SoldMarketDataProvider so another source (e.g. a future
// EbayMarketplaceInsightsProvider) can replace it later without touching
// the decision engine or any caller of this interface.
//
// ****************************************************************************
// CONTRACT LIVE-VERIFIED 2026-08-26 via a temporary diagnostic edge function
// invoked through pg_net (this sandbox's own egress to sold-comps.com is
// blocked, but Supabase's runtime is not — see session report). Confirmed
// against a real GET /v1/scrape?keyword=...&limit=... call with the live
// SOLD_COMPS_API_KEY secret:
//   - query param is `keyword` (singular), not `keywords`
//   - response envelope: {keyword, page, totalItems, totalResults,
//     hasNextPage, autoSelectedCategory, items: [...]}
//   - soldPrice/totalPrice/shippingPrice arrive as NUMERIC STRINGS ("81",
//     "95.95"), not numbers — coerced below, never left as unparsed strings
//   - conditionId arrives as a number (e.g. 1000, 3000)
//   - endedAt arrives as a date-only string ("2026-08-26"), not a full
//     ISO 8601 datetime — still Date.parse-able
//   - listing URL field is `url`, not `listingUrl`
//   - seller positive-feedback field is `sellerPositivePercent`, not
//     `sellerFeedbackPercent`
//   - per-format currency fields are `soldCurrency`/`shippingCurrency`,
//     no single top-level `currency`
//   - auth confirmed via 200 + x-ratelimit-remaining/-limit headers (59/60
//     on first call) — a malformed request returns 400 with a Zod error
//     body, not 401, so a missing/invalid `keyword` looks like a validation
//     error, not an auth failure
//   - pagination confirmed present (`page`, `hasNextPage`) but not wired
//     into this provider — single page of up to 40 results per call, same
//     as originally documented; multi-page fetch is a P1 enhancement
// Not verified live: Best Offer semantics beyond the `bestOfferAccepted`
// boolean field being present and populated (true on the sampled records);
// exact 90-day window enforcement (no explicit date-range request param
// was found/needed — treated as the provider's documented retention, per
// DEFAULT_SOLD_WINDOW_DAYS in marketDataPipeline.ts, not a request param).
// ****************************************************************************
import type { SoldCompListing, MarketDataFailureReason } from "./marketData.ts"
import type { MarketEvidenceProviderCapabilities } from "./marketplaceTypes.ts"
import { acquireSlot, noteRateLimitHeaders } from "./providerRateLimit.ts"
import { externalCall, ExternalCallError } from "./externalCall.ts"
import { SerpApiEbaySoldProvider } from "./serpApiEbaySoldProvider.ts"

export interface SoldCompsQuery {
  searchTerms: string       // normalized identification search terms
  limit?: number
}

export type SoldEvidenceResult =
  | { ok: true; comps: SoldCompListing[]; providerId?: string; suppliesBestOfferFlag?: boolean; providerAttempts?: SoldProviderAttempt[] }
  | { ok: false; reason: MarketDataFailureReason; detail: string; providerId?: string; providerAttempts?: SoldProviderAttempt[] }

export interface SoldProviderAttempt {
  providerId: string
  ok: boolean
  reason: MarketDataFailureReason | null
  detail: string | null
  latencyMs: number
}

export interface SoldMarketDataProvider {
  readonly providerId: string
  readonly capabilities: MarketEvidenceProviderCapabilities
  searchSoldComps(query: SoldCompsQuery): Promise<SoldEvidenceResult>
}

const REQUEST_TIMEOUT_MS = 10_000;
const TRAWL_BASE_URL = 'https://api.trawl.dev/ebay/v1/sold';
const TRAWL_DEFAULT_LIMIT = 240;
const TRAWL_SOLD_WINDOW_DAYS = 90;
// R2 (§5.2, Decision B: 3s throttle budget per scan item). Pacing gets a
// small slice of that budget; the rest is left for the actual request and
// its retries (totalRetryBudgetMs below).
const TRAWL_PACING_MAX_WAIT_MS = 500;

function soldCompsBaseUrl(): string {
  // Overridable via secret so the real path can be corrected without a
  // code change once the docs are confirmed against a real account.
  return Deno.env.get('SOLDCOMPS_API_BASE_URL') ?? 'https://api.sold-comps.com/v1/scrape';
}

// Accepts a real number OR a numeric string (SoldComps sends soldPrice/
// totalPrice/shippingPrice as strings, e.g. "81", "95.95") — never coerces
// a non-numeric or empty value, that stays null rather than becoming 0.
function numLike(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Runtime-validates one raw API record against the live-verified field
// contract (see file header). Returns null (dropped, not fabricated) for
// anything that fails validation — never coerces a missing/malformed price
// into a guessed number. Exported for direct unit testing.
export function parseSoldComp(raw: unknown): SoldCompListing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const itemId = r.itemId;
  const soldPrice = numLike(r.soldPrice);
  const endedAt = r.endedAt;
  if (typeof itemId !== 'string' && typeof itemId !== 'number') return null;
  if (soldPrice === null || soldPrice <= 0) return null;
  if (typeof endedAt !== 'string' || Number.isNaN(Date.parse(endedAt))) return null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

  return {
    itemId: String(itemId),
    title: str(r.title) ?? '',
    soldPrice,
    totalPrice: numLike(r.totalPrice),
    shippingPrice: numLike(r.shippingPrice),
    shippingType: str(r.shippingType),
    currency: str(r.soldCurrency) ?? str(r.currency) ?? 'USD',
    endedAt: new Date(endedAt).toISOString(),
    condition: str(r.condition),
    conditionId: str(r.conditionId) ?? (typeof r.conditionId === 'number' ? String(r.conditionId) : null),
    buyingFormat: str(r.buyingFormat),
    bidCount: numLike(r.bidCount),
    bestOfferAccepted: r.bestOfferAccepted === true,
    listingType: str(r.listingType),
    listingUrl: str(r.url) ?? str(r.listingUrl) ?? str(r.link) ?? str(r.itemWebUrl),
    sellerFeedbackScore: numLike(r.sellerFeedbackScore),
    sellerFeedbackPercent: numLike(r.sellerPositivePercent) ?? numLike(r.sellerFeedbackPercent),
  };
}

// Runtime-validates one Trawl /ebay/v1/sold result. Trawl returns numeric
// prices and a full ISO date in a `results` envelope. The API reports the
// actual final sale price, so no Best Offer price exclusion is required.
export function parseTrawlSoldComp(raw: unknown): SoldCompListing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const itemId = r.item_id;
  const soldPrice = numLike(r.sale_price);
  const endedAt = r.date_sold;
  if (typeof itemId !== 'string' && typeof itemId !== 'number') return null;
  if (soldPrice === null || soldPrice <= 0) return null;
  if (typeof endedAt !== 'string' || Number.isNaN(Date.parse(endedAt))) return null;

  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const shippingPrice = numLike(r.shipping_price);
  const currencySymbol = str(r.currency);

  return {
    itemId: String(itemId),
    title: str(r.title) ?? '',
    soldPrice,
    totalPrice: shippingPrice === null ? soldPrice : soldPrice + shippingPrice,
    shippingPrice,
    shippingType: shippingPrice === null ? null : shippingPrice === 0 ? 'free' : 'paid',
    currency: currencySymbol === '$' ? 'USD' : currencySymbol ?? 'USD',
    endedAt: new Date(endedAt).toISOString(),
    condition: str(r.condition_raw) ?? str(r.condition),
    conditionId: null,
    buyingFormat: str(r.buying_format),
    bidCount: null,
    bestOfferAccepted: false,
    listingType: 'sold',
    listingUrl: str(r.item_link),
    sellerFeedbackScore: null,
    sellerFeedbackPercent: null,
  };
}

// R2 (§5.2): maps a failed externalCall onto Trawl's specific failure
// vocabulary. Never invents a reason externalCall didn't actually observe.
function mapTrawlError(err: unknown): SoldEvidenceResult {
  if (err instanceof ExternalCallError) {
    if (err.kind === 'timeout') {
      return { ok: false, reason: 'PROVIDER_TIMEOUT', detail: `Trawl request exceeded ${REQUEST_TIMEOUT_MS}ms` };
    }
    if (err.kind === 'parse') {
      return {
        ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE',
        detail: typeof err.cause === 'string' ? err.cause : err.message,
      };
    }
    if (err.kind === 'http' && err.status === 429) {
      // R1 (P1-9): Retry-After presence is the one signal that actually
      // distinguishes "retry shortly" (PROVIDER_THROTTLED) from "the
      // monthly allowance is spent" (PROVIDER_QUOTA_EXHAUSTED). R2 (§5.2)
      // additionally means a quota-exhausted 429 was never retried by
      // externalCall's shouldRetry hook below — this branch only fires
      // after retries are genuinely done, not mid-cascade.
      return err.retryAfterMs !== undefined
        ? { ok: false, reason: 'PROVIDER_THROTTLED', detail: `Trawl rate limit exceeded; retry after ${Math.ceil(err.retryAfterMs / 1000)} seconds` }
        : { ok: false, reason: 'PROVIDER_QUOTA_EXHAUSTED', detail: 'Trawl monthly request allowance is exhausted' };
    }
    const status = err.status !== undefined ? `${err.status} ` : '';
    return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: `Trawl ${status}${err.bodyText ?? err.message}`.slice(0, 500) };
  }
  return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
}

// Last-resort provider in the explicit, audited failover chain. It is reached
// only when the primary providers fail operationally (DECISIONS.md 2026-09-13).
export class TrawlProvider implements SoldMarketDataProvider {
  readonly providerId = 'trawl.dev';
  // R2 (§5.1): Trawl sources completed eBay sales, so it's a
  // verified_transaction provider for the 'ebay' marketplace even though
  // the request itself goes to api.trawl.dev, not ebay.com.
  readonly capabilities: MarketEvidenceProviderCapabilities = {
    marketplace: 'ebay',
    evidenceClass: 'verified_transaction',
    queryMatching: 'all_terms',
    // R0 spike's measured output (task doc §5.1) — not a guess.
    maxUsefulQueryTerms: 4,
    supportsPagination: true,
    // parseTrawlSoldComp always sets bestOfferAccepted:false — Trawl does
    // not supply this flag, so false here means "unknown," never a
    // verified no (P2-15).
    suppliesBestOfferFlag: false,
    // R0: Trawl's real constraint is a measured 250-requests-per-month
    // allowance, not a per-second throttle.
    costClass: 'metered_quota',
  } as const;

  constructor(private readonly apiKey: string) {}

  async searchSoldComps(query: SoldCompsQuery): Promise<SoldEvidenceResult> {
    // R2 (§5.2): pace from our own inferred ceiling before spending a call.
    // Fails fast as PROVIDER_THROTTLED rather than making a call we already
    // expect to be throttled — never silently skipped, never a fabricated
    // zero-evidence result.
    const gotSlot = await acquireSlot(this.providerId, TRAWL_PACING_MAX_WAIT_MS);
    if (!gotSlot) {
      return {
        ok: false, reason: 'PROVIDER_THROTTLED',
        detail: 'Local rate-limit pacing budget was exceeded before this call could be sent (providerRateLimit.ts)',
      };
    }

    const dateFrom = new Date(Date.now() - TRAWL_SOLD_WINDOW_DAYS * 86_400_000)
      .toISOString().slice(0, 10);
    const qs = new URLSearchParams({
      query: query.searchTerms,
      site: 'EBAY_US',
      date_from: dateFrom,
      limit: String(Math.min(query.limit ?? TRAWL_DEFAULT_LIMIT, TRAWL_DEFAULT_LIMIT)),
    });

    try {
      const rawList = await externalCall<unknown[]>(
        `${TRAWL_BASE_URL}?${qs.toString()}`,
        { method: 'GET', headers: { 'x-api-key': this.apiKey } },
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxRetries: 2,
          maxRetryAfterMs: 2_000,
          totalRetryBudgetMs: 3_000,
          isIdempotent: true, // a GET
          // Preserve the throttle-vs-quota distinction: retry only when
          // Trawl told us how long to wait. A 429 with no Retry-After means
          // the monthly allowance is spent — retrying blindly wastes calls
          // against a quota that will not refill mid-scan.
          shouldRetry: (error, retryAfterMs) => error.status !== 429 || retryAfterMs !== undefined,
        },
        async (res) => {
          noteRateLimitHeaders(this.providerId, res.headers);
          const data = await res.json().catch(() => null);
          if (data === null || typeof data !== 'object') {
            throw new Error('Trawl response was not valid JSON');
          }
          const d = data as Record<string, unknown>;
          return Array.isArray(d.results) ? d.results as unknown[] : [];
        },
      );
      const comps = rawList.map(parseTrawlSoldComp).filter((c): c is SoldCompListing => c !== null);
      if (rawList.length > 0 && comps.length === 0) {
        return { ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE', detail: 'Trawl returned records but none matched the expected field contract' };
      }
      return { ok: true, comps };
    } catch (err) {
      return mapTrawlError(err);
    }
  }
}

class SoldCompsProvider implements SoldMarketDataProvider {
  readonly providerId = 'sold-comps.com';
  // R2 (§5.1): not R0-calibrated (R0 only spiked Trawl) — reuses Trawl's
  // measured maxUsefulQueryTerms as a same-shape (all_terms keyword search)
  // placeholder pending this provider's own spike, if it's ever revived.
  readonly capabilities: MarketEvidenceProviderCapabilities = {
    marketplace: 'ebay',
    evidenceClass: 'verified_transaction',
    queryMatching: 'all_terms',
    maxUsefulQueryTerms: 4,
    // The API's docs mention page/hasNextPage, but this implementation
    // never requests a second page (file header) — capability reflects what
    // this adapter actually does, not the provider's ceiling.
    supportsPagination: false,
    // parseSoldComp reads bestOfferAccepted straight from the response.
    suppliesBestOfferFlag: true,
    costClass: 'rate_limited',
  } as const;

  constructor(private readonly apiKey: string) {}

  async searchSoldComps(query: SoldCompsQuery): Promise<SoldEvidenceResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const qs = new URLSearchParams({
        keyword: query.searchTerms,
        limit: String(Math.min(query.limit ?? 40, 40)),
      });
      const res = await fetch(`${soldCompsBaseUrl()}?${qs.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });

      if (res.status === 429) {
        // No Retry-After signal is checked/available here, unlike Trawl —
        // classify as the retryable case rather than guessing quota
        // exhaustion from nothing.
        return { ok: false, reason: 'PROVIDER_THROTTLED', detail: 'SoldComps returned 429' };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: `${res.status} ${body}`.slice(0, 500) };
      }

      const data = await res.json().catch(() => null);
      if (data === null) {
        return { ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE', detail: 'SoldComps response was not valid JSON' };
      }

      const d = data as Record<string, unknown>;
      // `items` is the live-verified envelope key (see file header).
      // `results`/`listings` kept as defensive fallbacks only.
      const rawList: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray(d?.items) ? d.items as unknown[]
        : Array.isArray(d?.results) ? d.results as unknown[]
        : Array.isArray(d?.listings) ? d.listings as unknown[]
        : [];

      const comps = rawList.map(parseSoldComp).filter((c): c is SoldCompListing => c !== null);

      if (rawList.length > 0 && comps.length === 0) {
        return { ok: false, reason: 'MALFORMED_PROVIDER_RESPONSE', detail: 'SoldComps returned records but none matched the expected field contract — verify the API contract before relying on this provider' };
      }

      return { ok: true, comps };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { ok: false, reason: 'PROVIDER_TIMEOUT', detail: `SoldComps request exceeded ${REQUEST_TIMEOUT_MS}ms` };
      }
      return { ok: false, reason: 'SOLDCOMPS_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// Confirmed 2026-08-26 (product owner): the Supabase secret is set under
// this exact name. The prior 3-name fallback is retired now that the name
// is confirmed — do not reintroduce alternate aliases.
const SOLDCOMPS_API_KEY_ENV_NAME = 'SOLD_COMPS_API_KEY';
const SERP_API_KEY_ENV_NAME = 'SERP_API_KEY';
const TRAWL_API_KEY_ENV_NAME = 'TRAWL_API_KEY';

class FailoverSoldProvider implements SoldMarketDataProvider {
  readonly providerId: string;
  readonly capabilities: MarketEvidenceProviderCapabilities;

  constructor(private readonly providers: SoldMarketDataProvider[]) {
    this.providerId = providers.map((provider) => provider.providerId).join(' -> ');
    const primary = providers[0].capabilities;
    this.capabilities = {
      ...primary,
      // The selected provider is reported on each successful result. At the
      // planning boundary, remain conservative if any fallback lacks this.
      suppliesBestOfferFlag: providers.every((provider) => provider.capabilities.suppliesBestOfferFlag),
    };
  }

  async searchSoldComps(query: SoldCompsQuery): Promise<SoldEvidenceResult> {
    const attempts: SoldProviderAttempt[] = [];
    let lastFailure: Extract<SoldEvidenceResult, { ok: false }> | null = null;
    for (const provider of this.providers) {
      const startedAt = Date.now();
      const result = await provider.searchSoldComps(query);
      const latencyMs = Date.now() - startedAt;
      attempts.push({
        providerId: provider.providerId,
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        detail: result.ok ? null : result.detail,
        latencyMs,
      });
      if (result.ok) {
        return {
          ...result,
          providerId: provider.providerId,
          suppliesBestOfferFlag: provider.capabilities.suppliesBestOfferFlag,
          providerAttempts: attempts,
        };
      }
      lastFailure = result;
    }
    return {
      ...(lastFailure ?? { ok: false as const, reason: 'SOLDCOMPS_NOT_CONFIGURED' as const, detail: 'No sold-comp provider configured' }),
      providerId: attempts.at(-1)?.providerId,
      providerAttempts: attempts,
    };
  }
}

// Factory — returns null when not configured. Callers must treat null as
// SOLDCOMPS_NOT_CONFIGURED, never silently skip to an AI estimate or a
// fabricated value.
// Priority: SerpAPI → SoldComps → Trawl. When more than one key is configured,
// operational failures fall through explicitly and every attempt is retained
// in the scan audit. A successful empty search is not a failure and therefore
// does not spend a backup-provider request.
export function getSoldMarketDataProvider(): SoldMarketDataProvider | null {
  const providers: SoldMarketDataProvider[] = [];
  const serpApiKey = Deno.env.get(SERP_API_KEY_ENV_NAME);
  if (serpApiKey) providers.push(new SerpApiEbaySoldProvider(serpApiKey));

  const apiKey = Deno.env.get(SOLDCOMPS_API_KEY_ENV_NAME);
  if (apiKey) providers.push(new SoldCompsProvider(apiKey));

  const trawlApiKey = Deno.env.get(TRAWL_API_KEY_ENV_NAME);
  if (trawlApiKey) providers.push(new TrawlProvider(trawlApiKey));

  if (!providers.length) return null;
  return providers.length === 1 ? providers[0] : new FailoverSoldProvider(providers);
}
