import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyJWT, jwtFromCookie } from "../_shared/jwt.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { resolveScanLimit, resolveItemLimit } from "../_shared/tierCatalog.ts";
import type { DecisionResult, DemandLevel, EvidenceQuality } from "../_shared/decisionEngine.ts";
import { resolveVerifiedMarketData } from "../_shared/marketDataPipeline.ts";
import { routeMarketplaces } from "../_shared/marketplaceRouter.ts";
import { fetchMarketplaceEvidence, mapEbayResultToEvidence } from "../_shared/marketplaceProviders.ts";
import {
  buildMarketplaceOpportunities, selectBestMarketplace, type OpportunitySettings,
} from "../_shared/marketplaceOpportunity.ts";
import { totalFeePctFor } from "../_shared/marketplaceEconomics.ts";
import {
  MARKETPLACE_LABELS, type MarketplaceEvidenceResult, type MarketplaceId,
  type MarketplaceOpportunity, type ProviderFailureReason,
} from "../_shared/marketplaceTypes.ts";
import type { IdentityCandidate, IdentificationEvidenceKind } from "../_shared/marketData.ts";
import { parseModelToken, parseVariantToken, parseGtinToken, isReasonablyIdentifiable } from "../_shared/identityNormalization.ts";
import { identifyViaSerpApi } from "../_shared/serpApiIdentification.ts";
import { computeStaleInventoryItems, type StaleCandidateRow } from "../_shared/staleInventory.ts";
import { CLAUDE_MODEL, ANTHROPIC_MESSAGES_URL } from "../_shared/aiConfig.ts";

function ab2b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  let s = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Keys must match CATEGORIES in apps/web/public/app.html verbatim — that's the
// only client, and its category strings are what actually arrives here. This
// previously used an eBay-style taxonomy ('Consumer Electronics', 'Clothing,
// Shoes & Accessories', ...) that the client never sends, so nearly every item
// fell through to the 'OTH_' fallback regardless of its real category.
const CATEGORY_SKU_PREFIX: Record<string, string> = {
  'Electronics':          'ELEC',
  'Clothing':             'CLTH',
  'Shoes':                'SHOE',
  'Home & Garden':        'HOME',
  'Collectibles':         'COLL',
  'Toys & Hobbies':       'TOYS',
  'Sporting Goods':       'SPRT',
  'Books':                'BOOK',
  'Automotive':           'AUTO',
  'Health & Beauty':      'HLTH',
  'Tools':                'TOOL',
  'Musical Instruments':  'INST',
  'Pet Supplies':         'PETS',
  'Baby':                 'BABY',
  'Jewelry & Watches':    'JEWL',
};

class HttpError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly data: Record<string, unknown> = {},
  ) { super(message); }
}

// Defaults from FEATURE_TRIAGE.md — used only when user has no settings row
const DEFAULT_SETTINGS = {
  ebay_fee: 13, pkg_cost: 1.25, target_roi: 200, min_profit: 15,
  sourcing_style: 'balanced', ship_cost: 6.00, shipping: 'buyer',
};

type Settings = typeof DEFAULT_SETTINGS;

// SEC-015: module-level json unused after local shadow in Deno.serve — kept for type reference only.
function json(data: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...(req ? corsHeaders(req) : {}), 'Content-Type': 'application/json' },
  });
}

// Look up or lazily create the users row by email.
// Bridges Supabase Auth (UUID sub) → custom users table (integer id).
async function getOrCreateUser(
  supabase: ReturnType<typeof createClient>,
  email: string,
  username: string,
): Promise<{ id: number; tier: string; scan_count_month: number; scan_reset_date: string; token_version: number; settings: Settings; }> {
  const { data: existing } = await supabase
    .from('users').select('id, tier, scan_count_month, scan_reset_date, token_version')
    .eq('email', email).maybeSingle();

  let user = existing;
  if (!user) {
    const { data: created, error } = await supabase
      .from('users')
      .insert({ email, username: username || email.split('@')[0], password: 'supabase_auth', is_verified: true })
      .select('id, tier, scan_count_month, scan_reset_date, token_version').single();
    if (error || !created) throw new Error('Failed to create user');
    user = created;
  }

  const { data: settingsRow } = await supabase
    .from('settings').select('*').eq('user_id', user.id).maybeSingle();

  return { ...user, settings: settingsRow ?? DEFAULT_SETTINGS };
}

function r2(n: number) { return Math.round(n * 100) / 100; }

// Distinguishes "user left this blank" from "user typed 0" from a malformed
// value — all three are represented as null (unknown) except a real,
// non-negative, finite number. Never returns a fabricated default.
function parseAcquisitionCost(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

// SEC-017: strip control chars and truncate before injecting user text into AI prompts
function sanitizeForPrompt(s: string, maxLen = 500): string {
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, maxLen).trim();
}

// Profit Scanner v2: sourcing-style multipliers must not alter the user's
// explicit thresholds in the authoritative decision engine. The setting is
// kept in the UI/DB (unrelated cleanup) but is never read here.
//
// One scanned item's identification, the marketplaces it was routed to
// (marketplaceRouter.ts), and each routed marketplace's evidence
// (marketplaceProviders.ts) — the input resolveScanResultCore needs. Built
// by resolveMarketplaceEvidenceBundle below.
export interface MarketplaceEvidenceBundle {
  identity: IdentityCandidate | null;
  routedMarketplaces: MarketplaceId[];
  evidenceByMarketplace: Partial<Record<MarketplaceId, MarketplaceEvidenceResult>>;
  // Informational only (Profit Scanner v2 — never gates HOT/LIST/SKIP): eBay
  // is the only marketplace that computes these, kept purely for backward
  // compatibility with Inventory's SourcingMeta / the Listing Generator (out
  // of scope for the scanner redesign — see CLAUDE.md hard scope boundary).
  // Frequently null now that verified sold+active evidence is no longer a
  // hard requirement for a decision.
  ebayInformational: { sellThroughRate: number | null; avgDaysToSell: number | null; demandLevel: DemandLevel | null };
}

// R3 (DECISIONS.md "R3 identification is SerpAPI-first..."): a confident
// SerpAPI visual-search title takes priority over the AI vision call's own
// item_name guess. Everything else Claude read (brand/model/variant/gtin/
// condition/category/search_keywords) is kept — SerpAPI's reverse-image
// match can't reliably read a label/barcode the way the vision call can.
// A SerpAPI miss/failure is best-effort and never blocks the scan — the
// base (Claude-only) identity is used as-is.
function mergeSerpApiIdentity(
  base: IdentityCandidate,
  serp: { itemName: string | null; matches: Array<{ title: string; exactMatch: boolean }> },
): IdentityCandidate {
  if (!serp.itemName) return base;
  const normalize = (value: string | null) => (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const title = normalize(serp.itemName);
  const model = normalize(base.model);
  const brand = normalize(base.brand);
  const exact = serp.matches[0]?.exactMatch === true;
  const corroborated = (model.length >= 2 && title.includes(model)) ||
    (brand.length >= 3 && title.split(' ').includes(brand));
  // SerpAPI ranks results by relevance, but position one is not itself a
  // confidence signal. Never create a hybrid identity from an uncorroborated
  // visual result.
  if (!exact && !corroborated) return base;
  return {
    ...base,
    itemName: serp.itemName,
    model: model && title.includes(model) ? base.model : null,
    variant: base.variant && title.includes(normalize(base.variant)) ? base.variant : null,
    normalizedSearchTerms: [serp.itemName, ...base.normalizedSearchTerms]
      .filter((value, index, all) => all.findIndex((other) => normalize(other) === normalize(value)) === index),
    evidenceUsed: base.evidenceUsed.includes('visual_product_search')
      ? base.evidenceUsed
      : [...base.evidenceUsed, 'visual_product_search'],
  };
}

// Resolves identity from the AI scan's own identification fields, routes it
// to relevant marketplaces (marketplaceRouter.ts), and fetches each routed
// marketplace's evidence (marketplaceProviders.ts) — eBay via the real,
// live-verified pipeline; Reverb via its real, category-gated adapter
// (R3); every other marketplace via its provider-boundary placeholder (task
// doc §9). Never throws — a hard provider outage degrades to an explicit
// per-marketplace failure, never a fabricated fallback.
//
// `serpImage`, when supplied (single/text scan only — see handleSingleScan;
// shelf scan has no per-item cropped photo to search, see the R3 session
// note in handleShelfScan), runs the SerpAPI visual-identification call
// against the scanned photo. A SerpAPI failure is best-effort/never fatal —
// caught here, never propagated.
async function resolveMarketplaceEvidenceBundle(
  ai: Record<string, unknown>,
  evidenceKind: IdentificationEvidenceKind,
  supabase: ReturnType<typeof createClient>,
  serpImage?: { bytes: Uint8Array; mimeType: string } | null,
  maxSoldQueries = 2,
): Promise<MarketplaceEvidenceBundle> {
  const noInformational: MarketplaceEvidenceBundle['ebayInformational'] = {
    sellThroughRate: null, avgDaysToSell: null, demandLevel: null,
  };
  let identity = identityFromAiScan(ai, evidenceKind);
  if (!identity) {
    return { identity: null, routedMarketplaces: [], evidenceByMarketplace: {}, ebayInformational: noInformational };
  }

  if (serpImage) {
    const serp = await identifyViaSerpApi(supabase, serpImage.bytes, serpImage.mimeType).catch(() => null);
    if (serp && serp.ok) identity = mergeSerpApiIdentity(identity, serp);
  }

  const routedMarketplaces = routeMarketplaces(identity);

  let ebayEvidence: MarketplaceEvidenceResult;
  let ebayInformational: MarketplaceEvidenceBundle['ebayInformational'] = noInformational;
  try {
    const rawEbay = await resolveVerifiedMarketData(identity, { maxSoldQueries });
    if (rawEbay.ok) {
      ebayInformational = {
        sellThroughRate: rawEbay.metrics.sellThroughRate,
        avgDaysToSell: rawEbay.metrics.turnover?.marketTurnoverDays ?? null,
        demandLevel: rawEbay.metrics.demandLevel,
      };
    }
    ebayEvidence = mapEbayResultToEvidence(rawEbay);
  } catch (err) {
    ebayEvidence = { ok: false, marketplace: 'ebay', reason: 'PROVIDER_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) };
  }

  const otherMarketplaces = routedMarketplaces.filter((m) => m !== 'ebay');
  const otherEvidence = await fetchMarketplaceEvidence(identity, otherMarketplaces);

  return {
    identity, routedMarketplaces,
    evidenceByMarketplace: { ebay: ebayEvidence, ...otherEvidence },
    ebayInformational,
  };
}

// Retained in the response contract for backward compatibility. New scans
// always return null: AI-created market numbers are no longer requested or
// displayed when verified evidence is unavailable.
interface AiMarketEstimate {
  avgSoldPrice: number | null;
  priceLow: number | null;
  priceHigh: number | null;
  sellThroughRate: number | null;
  avgDaysToSell: number | null;
  demandLevel: DemandLevel | null;
}

// A marketplace opportunity that was NOT selected as the best one — shown to
// the user as an alternative, with its own evidence/economics so the UI can
// explain why the best marketplace won instead.
export interface AlternativeMarketplace {
  marketplace: MarketplaceId;
  label: string;
  evidenceQuality: EvidenceQuality;
  priceLow: number | null;
  priceHigh: number | null;
  expectedSalePrice: number;
  netProfit: number | null;
  roi: number | null;
  maxBuyPrice: number | null;
  qualifies: boolean;
  reason: string;
}

// R1 (P1-9): why decisionAvailable is false, in enough detail for the client
// to distinguish "try again shortly" (transient) from "no comps" (a real
// data gap the user should judge for themselves) — today's single identical
// LIMITED EVIDENCE sentence taught users to distrust the product in both
// cases. The server never sends the underlying provider `detail` string to
// the client; that stays in scan_log only.
export type ScanUnavailableReason =
  | 'PROVIDER_THROTTLED'        // retryable; try again shortly
  | 'PROVIDER_QUOTA_EXHAUSTED'  // monthly allowance spent
  | 'PROVIDER_UNAVAILABLE'      // outage / malformed response
  | 'PROVIDER_NOT_CONFIGURED'   // no sold-data key
  | 'IDENTIFICATION_UNRESOLVED' // could not identify the item
  | 'NO_MARKET_EVIDENCE'        // searched, found nothing comparable
  | 'EVIDENCE_TOO_WEAK'         // found some, not enough to trust
  | 'MARKETPLACE_AUTH_FAILED'   // eBay app credentials/entitlement

// R3 (DECISIONS.md, item L): the zero-evidence SKIP is reachable ONLY for
// these two reasons — both mean the market-data pipeline ran to completion
// and genuinely found nothing/not enough. Everything else — a system
// failure (PROVIDER_THROTTLED/QUOTA_EXHAUSTED/UNAVAILABLE/NOT_CONFIGURED/
// MARKETPLACE_AUTH_FAILED) or the rare edge case where the eBay pipeline
// itself reports IDENTIFICATION_UNRESOLVED even after the M gate already
// passed (e.g. a validated identity that still produced zero usable search
// terms) — is deliberately NOT eligible for L and falls through to the
// existing decisionAvailable:false path. An allowlist, not a denylist: a
// future ScanUnavailableReason value defaults to staying decisionAvailable
// :false rather than silently becoming eligible for a fabricated-looking SKIP.
const GENUINE_MARKET_GAP_REASONS: readonly ScanUnavailableReason[] = ['NO_MARKET_EVIDENCE', 'EVIDENCE_TOO_WEAK'];
function isGenuineMarketGapReason(reason: ScanUnavailableReason): reason is 'NO_MARKET_EVIDENCE' | 'EVIDENCE_TOO_WEAK' {
  return GENUINE_MARKET_GAP_REASONS.includes(reason);
}

// Maps eBay's own ProviderFailureReason (the only marketplace with a real
// provider today) to the client-facing reason above. Every other marketplace
// is a NOT_CONFIGURED placeholder, already covered here.
const UNAVAILABLE_REASON_MAP: Record<ProviderFailureReason, ScanUnavailableReason> = {
  NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_UNAVAILABLE',
  PROVIDER_THROTTLED: 'PROVIDER_THROTTLED',
  PROVIDER_QUOTA_EXHAUSTED: 'PROVIDER_QUOTA_EXHAUSTED',
  MALFORMED_PROVIDER_RESPONSE: 'PROVIDER_UNAVAILABLE',
  IDENTIFICATION_UNRESOLVED: 'IDENTIFICATION_UNRESOLVED',
  INSUFFICIENT_VERIFIED_MARKET_DATA: 'NO_MARKET_EVIDENCE',
  EVIDENCE_TOO_WEAK: 'EVIDENCE_TOO_WEAK',
  MARKETPLACE_AUTH_FAILED: 'MARKETPLACE_AUTH_FAILED',
};

// eBay is the only marketplace with a real evidence provider today (task doc
// §9) — its failure is the authoritative reason a scan has no decision.
// Falls back to NO_MARKET_EVIDENCE only for the edge case where eBay itself
// reported ok:true but nothing qualified as a marketplace opportunity (e.g.
// a null expectedSalePrice); never fabricates a more specific reason than
// the evidence actually supports.
function deriveUnavailableReason(bundle: MarketplaceEvidenceBundle): ScanUnavailableReason {
  const ebay = bundle.evidenceByMarketplace.ebay;
  if (ebay && !ebay.ok) return UNAVAILABLE_REASON_MAP[ebay.reason];
  return 'NO_MARKET_EVIDENCE';
}

// Result of the single authoritative gate below: everything a scan response
// needs, with every authoritative field (decision, profit, ROI, max-buy-price,
// best marketplace) forced to null/unavailable whenever no marketplace had
// decision-capable (strong/moderate) evidence — never populated from an AI
// estimate, and never from weak/none evidence (LIMITED EVIDENCE).
export interface ScanResultCore {
  decision: DecisionResult['decision'] | null;
  decisionAvailable: boolean;
  // R3 (DECISIONS.md, item L): 'ok_no_evidence' is a THIRD state — distinct
  // from both 'ok' (a normal profit/ROI-gated decision) and
  // 'insufficient_market_data' (decisionAvailable:false — identification or
  // system failure). It means: identity was reasonably identifiable (M),
  // the pipeline genuinely ran to completion, and the full evidence ladder
  // came up empty — decision is 'SKIP', decisionAvailable is TRUE, but
  // every financial field stays null (never a fabricated price to justify
  // the SKIP).
  decisionStatus: 'ok' | 'ok_no_evidence' | 'insufficient_market_data';
  // Non-null exactly when decisionAvailable is false — see ScanUnavailableReason.
  unavailableReason: ScanUnavailableReason | null;
  // Non-null exactly when decisionStatus is 'ok_no_evidence' — which of the
  // two genuine-market-gap reasons (never a system failure — those stay in
  // unavailableReason with decisionAvailable:false).
  noEvidenceReason: 'NO_MARKET_EVIDENCE' | 'EVIDENCE_TOO_WEAK' | null;
  decisionReasons: DecisionResult | null;
  acquisitionCost: number | null;
  estimatedSell: number | null;
  estimatedProfit: number | null;
  roi: number | null;
  feeAmount: number | null;
  shipCostAmount: number | null;
  maxBuyPrice: number | null;
  maxBuyPriceLimitedBy: 'minProfit' | 'targetRoi' | 'both' | 'none' | null;
  priceLow: number | null;
  priceHigh: number | null;
  // Informational only (Profit Scanner v2) — see MarketplaceEvidenceBundle.
  sellThroughRate: number | null;
  avgDaysToSell: number | null;
  demandLevel: DemandLevel | null;
  marketDataSource: 'verified' | 'ai_estimate';
  aiEstimate: AiMarketEstimate | null;
  evidenceQuality: EvidenceQuality | null;
  compMatchPrecision: string | null;
  suggestedSearchQuery: string | null;
  // Profit Scanner v2: which marketplace the decision above is based on, and
  // what else was evaluated. bestMarketplace is null exactly when
  // decisionAvailable is false.
  bestMarketplace: MarketplaceId | null;
  bestMarketplaceLabel: string | null;
  whyThisMarketplace: string | null;
  alternativeMarketplaces: AlternativeMarketplace[];
}

export function roiForDisplay(roi: number | null, acquisitionCost: number | null): number | null {
  return acquisitionCost !== null && acquisitionCost < 1 ? null : roi;
}

function suggestedSearchQueryFor(bundle: MarketplaceEvidenceBundle, ai: Record<string, unknown>): string | null {
  return bundle.identity?.itemName
    ?? bundle.identity?.normalizedSearchTerms[0]
    ?? (ai.item_name as string | undefined)
    ?? null;
}

function toAlternative(o: MarketplaceOpportunity): AlternativeMarketplace {
  return {
    marketplace: o.marketplace, label: MARKETPLACE_LABELS[o.marketplace],
    evidenceQuality: o.evidenceQuality, priceLow: o.priceLow, priceHigh: o.priceHigh,
    expectedSalePrice: o.expectedSalePrice, netProfit: o.economics.netProfit, roi: o.economics.roi,
    maxBuyPrice: o.economics.maxBuyPrice, qualifies: o.qualifies, reason: o.reason,
  };
}

// LIMITED EVIDENCE (task doc §4): identification may still be shown, but no
// HOT/LIST/SKIP, profit, ROI, or max-buy-price is fabricated from
// indefensible evidence.
function noDecisionResult(
  acquisitionCost: number | null,
  suggestedSearchQuery: string | null,
  alternativeMarketplaces: AlternativeMarketplace[] = [],
  unavailableReason: ScanUnavailableReason = 'NO_MARKET_EVIDENCE',
): ScanResultCore {
  return {
    decision: null, decisionAvailable: false, decisionStatus: 'insufficient_market_data',
    unavailableReason, noEvidenceReason: null,
    decisionReasons: null, acquisitionCost,
    estimatedSell: null, estimatedProfit: null, roi: null,
    feeAmount: null, shipCostAmount: null,
    maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    priceLow: null, priceHigh: null, sellThroughRate: null, avgDaysToSell: null, demandLevel: null,
    marketDataSource: 'ai_estimate', aiEstimate: null,
    evidenceQuality: null, compMatchPrecision: null,
    suggestedSearchQuery,
    bestMarketplace: null, bestMarketplaceLabel: null, whyThisMarketplace: null,
    alternativeMarketplaces,
  };
}

// R3 (DECISIONS.md, item L): the genuinely-zero-evidence residual case.
// Identity was reasonably identifiable (M), the pipeline ran to completion,
// and the full evidence ladder came up empty (or too weak to trust) — this
// resolves conservatively to SKIP, never a terminal no-decision state and
// never a fabricated price. Every financial field stays null; decide() is
// never invoked (there is no expectedSalePrice to compute from).
function zeroEvidenceSkipResult(
  acquisitionCost: number | null,
  suggestedSearchQuery: string | null,
  noEvidenceReason: 'NO_MARKET_EVIDENCE' | 'EVIDENCE_TOO_WEAK',
): ScanResultCore {
  return {
    decision: 'SKIP', decisionAvailable: true, decisionStatus: 'ok_no_evidence',
    unavailableReason: null, noEvidenceReason,
    decisionReasons: null, acquisitionCost,
    estimatedSell: null, estimatedProfit: null, roi: null,
    feeAmount: null, shipCostAmount: null,
    maxBuyPrice: null, maxBuyPriceLimitedBy: null,
    priceLow: null, priceHigh: null, sellThroughRate: null, avgDaysToSell: null, demandLevel: null,
    marketDataSource: 'ai_estimate', aiEstimate: null,
    evidenceQuality: 'none', compMatchPrecision: null,
    suggestedSearchQuery,
    bestMarketplace: null, bestMarketplaceLabel: null, whyThisMarketplace: null,
    alternativeMarketplaces: [],
  };
}

// THE single authoritative gate deciding whether a scanned item's HOT/LIST/
// SKIP decision, net profit, ROI, max-buy-price, and best marketplace may be
// computed at all: only when at least one routed marketplace produced
// decision-capable (strong/moderate) evidence. This is the Profit Scanner v2
// evolution of the Chapter 02 AI-market-authority fix — previously gated on
// a single eBay-only verified/unverified boolean; now gated on the
// marketplace opportunity engine (marketplaceOpportunity.ts) finding at
// least one qualifying-evidence marketplace. AI-created market numbers are
// still never fed into decisioning. Used by both single/text and shelf
// scan — one implementation (CLAUDE.md Anti-Drift Contract rule 11).
export function resolveScanResultCore(
  bundle: MarketplaceEvidenceBundle,
  ai: Record<string, unknown>,
  acquisitionCost: number | null,
  settings: Settings,
  shipForCalc: number,
): ScanResultCore {
  const suggested = suggestedSearchQueryFor(bundle, ai);
  if (!bundle.identity) return noDecisionResult(acquisitionCost, suggested, [], 'IDENTIFICATION_UNRESOLVED');
  // R3 (DECISIONS.md, item M) — the SAME gate the L zero-evidence-SKIP
  // branch below relies on. A bare generic noun with nothing else
  // (identity.itemName present but not reasonably identifiable) is still an
  // identification failure, not a candidate for the zero-evidence SKIP.
  if (!isReasonablyIdentifiable(bundle.identity)) {
    return noDecisionResult(acquisitionCost, suggested, [], 'IDENTIFICATION_UNRESOLVED');
  }

  const opportunitySettings: OpportunitySettings = {
    ebayFeePct: settings.ebay_fee, pkgCost: settings.pkg_cost, shipCost: shipForCalc,
    minProfit: settings.min_profit, targetRoi: settings.target_roi,
  };
  const opportunities = buildMarketplaceOpportunities(
    bundle.evidenceByMarketplace, bundle.routedMarketplaces, acquisitionCost, opportunitySettings,
  );
  const best = selectBestMarketplace(opportunities);
  if (!best) {
    const reason = deriveUnavailableReason(bundle);
    // R3 (DECISIONS.md, item L): only a genuine market-evidence gap (the
    // pipeline ran to completion and found nothing/not enough) on an
    // already-identifiable item resolves to the zero-evidence SKIP. A
    // system failure — or any reason not explicitly on the allowlist —
    // still withholds a decision entirely (decisionAvailable:false), never
    // masquerading as SKIP.
    if (isGenuineMarketGapReason(reason)) {
      return zeroEvidenceSkipResult(acquisitionCost, suggested, reason);
    }
    return noDecisionResult(acquisitionCost, suggested, [], reason);
  }

  const alternatives = opportunities.filter((o) => o.marketplace !== best.marketplace).map(toAlternative);
  const bestEvidence = bundle.evidenceByMarketplace[best.marketplace];
  const matchPrecision = bestEvidence && bestEvidence.ok ? bestEvidence.evidence.matchPrecision : null;
  const feeAmount = r2(best.expectedSalePrice * (totalFeePctFor(best.marketplace, settings.ebay_fee) / 100));
  const resolvedCost = (acquisitionCost !== null && acquisitionCost !== undefined && acquisitionCost >= 0) ? acquisitionCost : null;

  return {
    decision: best.decisionReasons.decision, decisionAvailable: true, decisionStatus: 'ok',
    unavailableReason: null, noEvidenceReason: null,
    decisionReasons: best.decisionReasons, acquisitionCost: resolvedCost,
    estimatedSell: best.expectedSalePrice, estimatedProfit: best.economics.netProfit, roi: best.economics.roi,
    feeAmount, shipCostAmount: best.economics.shipCost,
    maxBuyPrice: best.economics.maxBuyPrice, maxBuyPriceLimitedBy: best.economics.maxBuyPriceLimitedBy,
    priceLow: best.priceLow, priceHigh: best.priceHigh,
    sellThroughRate: bundle.ebayInformational.sellThroughRate,
    avgDaysToSell: bundle.ebayInformational.avgDaysToSell,
    demandLevel: bundle.ebayInformational.demandLevel,
    marketDataSource: 'verified', aiEstimate: null,
    evidenceQuality: best.evidenceQuality, compMatchPrecision: matchPrecision,
    suggestedSearchQuery: suggested,
    bestMarketplace: best.marketplace, bestMarketplaceLabel: MARKETPLACE_LABELS[best.marketplace],
    whyThisMarketplace: best.reason,
    alternativeMarketplaces: alternatives,
  };
}

function detectImageMime(buf: ArrayBuffer): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  if (buf.byteLength < 12) return null;
  const b = new Uint8Array(buf, 0, 12);
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[4] === 0x57 && b[5] === 0x45 && b[6] === 0x42 && b[7] === 0x50) return 'image/webp';
  return null;
}

const MAX_SCAN_IMAGES = 6;
const MAX_SCAN_IMAGE_BYTES = 8 * 1024 * 1024;

function validateBase64Images(images: unknown): string | null {
  if (!Array.isArray(images)) return 'No image provided';
  if (images.length === 0) return 'No image provided';
  if (images.length > MAX_SCAN_IMAGES) return `A maximum of ${MAX_SCAN_IMAGES} images is allowed`;
  for (const image of images) {
    if (typeof image !== 'string' || image.length === 0) return 'Invalid image payload';
    if (image.length * 0.75 > MAX_SCAN_IMAGE_BYTES) return 'Image exceeds the 8MB limit';
  }
  return null;
}

async function callAnthropic(
  key: string, system: string, images: string[], maxTokens = 1024,
  mimeTypes: ('image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')[] = [],
  userText?: string,
): Promise<string> {
  const imageBlocks = images.map((data, i) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: (mimeTypes[i] ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data },
  }));
  const textPrompt = userText ?? (images.length > 1
    ? `Analyze these ${images.length} photos of the same item from different angles.`
    : 'Analyze this image.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
      signal: controller.signal,
      body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: textPrompt }],
      }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? 'Anthropic error');
  const raw = data.content[0].text as string;
  // Strip markdown code fences Claude sometimes adds despite "no markdown" instructions
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// Identification-only successor to FEATURE_TRIAGE.md P-03. Market numbers
// are deliberately absent; verified providers own that evidence.
function buildSinglePrompt(_s: Settings): string {
  return `You are a meticulous product-identification expert. Your job is to ACCURATELY identify the photographed item so a separate verified-market-data system can find comparable eBay sales.

IDENTIFICATION (critical):
- Study EVERY visible detail in the photo: brand logos, model numbers on labels/tags, serial plates, color, size, design era, materials, distinctive features.
- Identify the EXACT make, model, and variant — not just a generic category. "Camera" is wrong. "Minolta X-700 35mm SLR Film Camera" is right.
- Use any text description to confirm or narrow your photo identification.
- If you cannot identify specifics, say so clearly in confidence_reason and set confidence below 60.

- If a barcode/UPC/EAN/ISBN is legible in the photo, read its digits exactly — never guess or approximate a digit you cannot actually read.

Do not estimate prices, sell-through rate, demand, profit, ROI, or days-to-sell. Those values come only from verified marketplace evidence and deterministic code.

Return ONLY valid JSON, no markdown:
{"item_name":"specific make model and variant","category":"string","brand":"string or null","model_number":"string or null","variant":"color/size/edition if visible, else null","gtin":"barcode/UPC/EAN/ISBN digits if legible, else null","estimated_weight_lbs":number,"confidence":number,"confidence_reason":"what you confirmed and what you could not","condition_notes":"visible condition issues","search_keywords":["4 specific eBay search terms for this exact item"],"listing_tips":["4 actionable selling tips"],"risk_flags":["red flags or empty array"],"notes":"important identification or condition context"}`;
}

// Identification-only successor to FEATURE_TRIAGE.md P-04.
function buildShelfPrompt(_s: Settings): string {
  // Chapter 02 audit: AI identifies and prices items only. The seller hasn't
  // bought any of these yet, so there is no acquisition cost to reason about
  // here — profit, ROI, and the buy/skip decision are computed deterministically
  // server-side from a solved-for maximum qualifying purchase price, never
  // from an AI-estimated thrift cost.
  return `You are a meticulous product-identification expert scanning a shelf photo. Study EVERY item with care.

For each distinct item visible:
- Identify as specifically as possible: brand, model, type, era. Do not be generic.
- Use all visible clues: labels, logos, colors, shapes, text, design era.
- Do not estimate price, sell-through, demand, profit, ROI, or days-to-sell. A separate verified-market-data system calculates those values.
- Only include items you can identify with at least 40% confidence.
- Do NOT calculate profit, ROI, or a buy/skip decision — the seller hasn't paid an acquisition price yet, and that math is computed deterministically elsewhere.
- If a barcode/UPC/EAN/ISBN is legible on an item, read its digits exactly — never guess or approximate a digit you cannot actually read.

Return ONLY a valid JSON array, no markdown:
[{"item_name":"specific name with brand and model","category":"string","brand":"string or null","model_number":"string or null","variant":"color/size/edition if visible, else null","gtin":"barcode/UPC/EAN/ISBN digits if legible, else null","confidence":number,"condition_notes":"string","notes":"one sentence of identification or condition context"}]`;
}

// Builds an IdentityCandidate from the AI scan response's identification
// fields (item_name/brand/model_number/category), reusing the identification
// already done by the single call to buildSinglePrompt/buildShelfPrompt
// rather than triggering a second, redundant AI identification call. Returns
// null when there isn't enough identity signal to search a market-data
// provider with (never sends an empty/near-empty query).
function identityFromAiScan(ai: Record<string, unknown>, evidence: IdentificationEvidenceKind): IdentityCandidate | null {
  const itemName = (ai.item_name as string) || null;
  const brand = (ai.brand as string) || null;
  const rawModel = (ai.model_number as string) || null;
  if (!itemName && !brand && !rawModel) return null;

  // R2 (§5.3): validate every raw AI identity token instead of trusting it
  // verbatim — production scans routinely returned prose ("Unknown - model
  // number not visible in photo") where a model number belongs, which
  // poisoned every downstream query. A rejected-but-clean value is salvaged
  // as modelFamilyHint rather than silently discarded.
  const { model, modelFamilyHint } = parseModelToken(rawModel);
  const variant = parseVariantToken((ai.variant as string) || null);
  const { gtin, gtinKind } = parseGtinToken((ai.gtin as string) || null);
  const searchKeywords = Array.isArray(ai.search_keywords)
    ? ai.search_keywords.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  return {
    itemName, brand, model, variant,
    gtin, gtinKind, manufacturerPartNumber: null,
    modelFamilyHint,
    likelyEbayCategory: (ai.category as string) || null,
    categoryHints: ai.category ? [ai.category as string] : [],
    conditionHints: (ai.condition_notes as string) || null,
    unresolvedAttributes: [],
    identityConfidence: (ai.confidence as number) ?? 0,
    evidenceUsed: [evidence],
    // R2 (§5.3): the AI's own curated eBay search terms, previously
    // requested, returned to the client, but never used to build a query
    // (task doc §5.3) — now the query planner's highest-signal rung
    // (queryPlanner.ts, rung 4) instead of a same-3-tokens restatement of
    // itemName/brand/model.
    normalizedSearchTerms: searchKeywords,
    providerId: 'anthropic-claude-vision',
  };
}

// Parses the AI identification/pricing JSON, evaluates the deterministic
// financial + decision engine against it, persists a fully auditable scan_log
// row, and returns the response shape shared by single_scan and text_scan.
//
// `acquisitionCost` is the user's real entered price (or null when left
// blank) — this function never invents one from sale price.
async function finalizeSingleOrTextScan(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  settings: Settings,
  scanType: 'single' | 'text',
  ai: Record<string, unknown>,
  acquisitionCost: number | null,
  serpImage: { bytes: Uint8Array; mimeType: string } | null = null,
) {
  // Resolve identity, route to relevant marketplaces, and fetch each routed
  // marketplace's evidence. Failure/absence of evidence preserves item
  // identification but never substitutes AI-created market numbers.
  const bundle = await resolveMarketplaceEvidenceBundle(ai, scanType === 'single' ? 'visual_ai' : 'text_inference', supabase, serpImage);
  const confidence = (ai.confidence as number) ?? null;

  // Seller-paid shipping cost is included only when the seller actually
  // bears it ('seller'); buyer-paid shipping contributes $0 seller cost.
  const shipForCalc = settings.shipping === 'seller' ? settings.ship_cost : 0;

  // The single authoritative gate: HOT/LIST/SKIP, net profit, ROI, best
  // marketplace, and max-buy-price are computed ONLY when at least one
  // marketplace has decision-capable evidence. When none do, `core` reports
  // decisionAvailable:false and every authoritative field null.
  const core = resolveScanResultCore(bundle, ai, acquisitionCost, settings, shipForCalc);
  const displayRoi = roiForDisplay(core.roi, acquisitionCost);
  const resolvedItemName = bundle.identity?.itemName ?? (ai.item_name as string);

  const { data: logRow } = await supabase.from('scan_log').insert({
    user_id: userId, scan_type: scanType, decision: core.decision,
    item_name: resolvedItemName, category: ai.category,
    estimated_profit: core.estimatedProfit, estimated_sell: core.estimatedSell,
    cost: core.acquisitionCost, roi: core.roi, confidence, bought: false,
    raw_response: {
      ai,
      decisionAudit: {
        decisionAvailable: core.decisionAvailable, decisionStatus: core.decisionStatus,
        unavailableReason: core.unavailableReason, noEvidenceReason: core.noEvidenceReason,
        acquisitionCost: core.acquisitionCost, maxBuyPrice: core.maxBuyPrice,
        maxBuyPriceLimitedBy: core.maxBuyPriceLimitedBy,
        settingsUsed: settings, marketDataSource: core.marketDataSource,
        bestMarketplace: core.bestMarketplace, routedMarketplaces: bundle.routedMarketplaces,
        evidenceByMarketplace: bundle.evidenceByMarketplace, aiEstimate: core.aiEstimate,
        decisionReasons: core.decisionReasons,
      },
    },
  }).select('id').single();

  return {
    decision: core.decision,
    decisionAvailable: core.decisionAvailable,
    decisionStatus: core.decisionStatus,
    unavailableReason: core.unavailableReason,
    noEvidenceReason: core.noEvidenceReason,
    itemName: resolvedItemName, category: ai.category, brand: bundle.identity?.brand ?? (ai.brand as string) ?? null,
    acquisitionCost: core.acquisitionCost,
    estimatedSell: core.estimatedSell,
    estimatedProfit: core.estimatedProfit,
    roi: displayRoi,
    feeAmount: core.feeAmount, shipCostAmount: core.shipCostAmount, pkgCost: settings.pkg_cost,
    maxBuyPrice: core.maxBuyPrice,
    maxBuyPriceLimitedBy: core.maxBuyPriceLimitedBy,
    confidence,
    reasoning: (ai.confidence_reason as string) ?? (ai.notes as string) ?? '',
    searchKeywords: ai.search_keywords ?? [],
    priceLow: core.priceLow, priceHigh: core.priceHigh,
    sellThroughRate: core.sellThroughRate, avgDaysToSell: core.avgDaysToSell, demandLevel: core.demandLevel,
    listingTips: ai.listing_tips ?? [], riskFlags: ai.risk_flags ?? [],
    conditionNotes: ai.condition_notes ?? '',
    notes: (ai.notes as string) ?? '',
    // Tells the client whether the numbers above came from verified
    // marketplace evidence (SoldComps sold comps + eBay Browse) or the scan
    // has no authoritative market data at all (decisionAvailable:false) — so
    // the client can keep disclosing this honestly either way.
    marketDataSource: core.marketDataSource,
    // Informational only when present (decisionAvailable:false) — never an
    // authoritative substitute for the (null) fields above.
    aiEstimate: core.aiEstimate,
    decisionReasons: core.decisionReasons,
    // Decision Integrity remediation (Release A): lets the client show an
    // honest evidence label instead of a blanket "VERIFIED" claim.
    evidenceQuality: core.evidenceQuality,
    compMatchPrecision: core.compMatchPrecision,
    suggestedSearchQuery: core.suggestedSearchQuery,
    // Profit Scanner v2: which marketplace the decision/economics above are
    // based on, why it won, and what other marketplaces were evaluated.
    bestMarketplace: core.bestMarketplace,
    bestMarketplaceLabel: core.bestMarketplaceLabel,
    whyThisMarketplace: core.whyThisMarketplace,
    alternativeMarketplaces: core.alternativeMarketplaces,
    scanLogId: logRow?.id ?? null,
  };
}

async function handleSingleScan(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: number,
  settings: Settings,
  images: string[],
  mimeTypes: string[] = [],
  acquisitionCost: number | null = null,
) {
  const raw = await callAnthropic(anthropicKey, buildSinglePrompt(settings), images, undefined, mimeTypes as ('image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')[]);
  let ai: Record<string, unknown>;
  try {
    ai = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { ai = JSON.parse(m[0]); }
      catch { throw new Error('Could not analyze this photo. Try a clearer photo of a single item.'); }
    } else {
      throw new Error('Could not analyze this photo. Try a clearer photo of a single item.');
    }
  }
  // R3: a single scan has exactly one photo of exactly one item — the
  // well-defined case for SerpAPI visual identification (see
  // resolveMarketplaceEvidenceBundle's serpImage param). Best-effort: a
  // malformed/undecodable image never blocks the scan, just skips SerpAPI.
  let serpImage: { bytes: Uint8Array; mimeType: string } | null = null;
  if (images.length > 0) {
    try {
      const bytes = Uint8Array.from(atob(images[0]), (c) => c.charCodeAt(0));
      const mimeType = (mimeTypes[0] as string) || 'image/jpeg';
      serpImage = { bytes, mimeType };
    } catch { serpImage = null; }
  }
  return finalizeSingleOrTextScan(supabase, userId, settings, 'single', ai, acquisitionCost, serpImage);
}

async function handleTextScan(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: number,
  settings: Settings,
  text: string,
  acquisitionCost: number | null = null,
) {
  const userText = `Identify and price this specific item for eBay resale: "${text.slice(0, 300)}". Provide realistic eBay sold comps — not retail or asking prices.`;
  const raw = await callAnthropic(anthropicKey, buildSinglePrompt(settings), [], 1024, [], userText);
  let ai: Record<string, unknown>;
  try { ai = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { ai = JSON.parse(m[0]); } catch { throw new Error('Could not analyze this item. Try adding more detail.'); } }
    else throw new Error('Could not analyze this item. Try adding more detail.');
  }
  return finalizeSingleOrTextScan(supabase, userId, settings, 'text', ai, acquisitionCost);
}

async function handleDetectItem(
  anthropicKey: string,
  imageBase64: string,
  imageMimeType: string,
) {
  const detectPrompt = 'Identify this item for an eBay reseller inventory system. Study all visible details — brand, model, labels, features. Return ONLY valid JSON, no markdown: {"name":"specific item name with brand and model","category":"one of: Electronics/Clothing/Shoes/Home & Garden/Collectibles/Toys & Hobbies/Sporting Goods/Books/Automotive/Health & Beauty/Tools/Musical Instruments/Pet Supplies/Baby/Jewelry & Watches","condition":"New/Like New/Good/Fair/Poor","estimated_value":number,"notes":"condition observations and key selling points in one sentence"}';
  const raw = await callAnthropic(anthropicKey, '', [imageBase64], 400, [imageMimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'], detectPrompt);
  let ai: Record<string, unknown>;
  try { ai = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { ai = JSON.parse(m[0]); } catch { throw new Error('Could not detect item — try a clearer photo'); } }
    else throw new Error('Could not detect item — try a clearer photo');
  }
  return ai;
}

// R2 (§5.2): calibrated against the R0 spike's finding, not a guess —
// bounds how many shelf items resolve their marketplace evidence at once.
// Each item's own query cascade still runs sequentially inside
// resolveMarketplaceEvidenceBundle; this only bounds cross-item fan-out.
const SHELF_SCAN_CONCURRENCY = 3;

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function handleShelfScan(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: number,
  settings: Settings,
  images: string[],
  mimeTypes: string[] = [],
) {
  const raw = await callAnthropic(anthropicKey, buildShelfPrompt(settings), images, 2048, mimeTypes as ('image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')[]);
  let aiItems: Record<string, unknown>[];
  try { aiItems = JSON.parse(raw); }
  catch { throw new Error('AI returned invalid JSON'); }
  if (!Array.isArray(aiItems)) throw new Error('AI returned non-array for shelf scan');

  // Seller-paid shipping cost is included only when the seller actually
  // bears it ('seller'); buyer-paid shipping contributes $0 seller cost.
  const shipForCalc = settings.shipping === 'seller' ? settings.ship_cost : 0;

  // Shelf items are pre-purchase by definition — acquisition cost is always
  // unknown, so every item is priced via the max-qualifying-buy-price solver,
  // never an AI-estimated thrift cost. Each item independently routes to
  // relevant marketplaces and evaluates the same opportunity engine as
  // single/text scan (see finalizeSingleOrTextScan) — one decision authority
  // for every scan mode (task doc §19).
  //
  // R2 (§5.2): bounded to a pool of 3 concurrent items, not Promise.all over
  // every item at once — an 8-item shelf previously fired up to 40 concurrent
  // Trawl calls (every item x its own query-cascade rungs), which was the
  // single largest source of the scanner tripping its own rate limit.
  const items = await mapWithConcurrencyLimit(aiItems, SHELF_SCAN_CONCURRENCY, async (ai) => {
    // R3: no serpImage here — SerpAPI's Google Lens call needs one photo of
    // one item, and a shelf scan has one photo of the WHOLE shelf with no
    // per-item region-cropping in this repo today. Running SerpAPI against
    // the full shelf photo for every detected item would search on the
    // wrong subject, not a useful per-item signal. Shelf items still get
    // the same M/L logic (isReasonablyIdentifiable gate, zero-evidence
    // SKIP) via resolveScanResultCore below — they just identify from
    // Claude's own vision call alone, same as before R3.
    // A shelf request may contain up to eight items. Metered sold searches
    // here would make one entitlement scan consume up to 16 paid queries.
    // Use free active-market evidence for shelf decisions; single/text scans
    // retain the bounded two-query sold-evidence path.
    const bundle = await resolveMarketplaceEvidenceBundle(ai, 'visual_ai', supabase, null, 0);
    const confidence = (ai.confidence as number) ?? null;

    // Same single authoritative gate as single/text scan (resolveScanResultCore)
    // — a shelf item's decision/maxBuyPrice/best-marketplace is computed only
    // when at least one marketplace has decision-capable evidence; otherwise
    // decisionAvailable:false, never a decision derived from an AI market guess.
    const core = resolveScanResultCore(bundle, ai, null, settings, shipForCalc);

    return {
      decision: core.decision,
      decisionAvailable: core.decisionAvailable,
      decisionStatus: core.decisionStatus,
      unavailableReason: core.unavailableReason,
      noEvidenceReason: core.noEvidenceReason,
      itemName: bundle.identity?.itemName ?? (ai.item_name as string), category: ai.category, brand: bundle.identity?.brand ?? (ai.brand as string) ?? null,
      avgSoldPrice: core.estimatedSell, maxBuyPrice: core.maxBuyPrice, maxBuyPriceLimitedBy: core.maxBuyPriceLimitedBy,
      confidence, sellThroughRate: core.sellThroughRate, avgDaysToSell: core.avgDaysToSell, demandLevel: core.demandLevel,
      conditionNotes: ai.condition_notes ?? '', notes: (ai.notes as string) ?? '',
      marketDataSource: core.marketDataSource,
      aiEstimate: core.aiEstimate,
      routedMarketplaces: bundle.routedMarketplaces,
      evidenceByMarketplace: bundle.evidenceByMarketplace,
      decisionReasons: core.decisionReasons,
      evidenceQuality: core.evidenceQuality,
      compMatchPrecision: core.compMatchPrecision,
      suggestedSearchQuery: core.suggestedSearchQuery,
      bestMarketplace: core.bestMarketplace,
      bestMarketplaceLabel: core.bestMarketplaceLabel,
      whyThisMarketplace: core.whyThisMarketplace,
      alternativeMarketplaces: core.alternativeMarketplaces,
    };
  });

  await supabase.from('scan_log').insert({
    user_id: userId, scan_type: 'shelf', decision: null,
    bought: false,
    raw_response: {
      aiItems,
      decisionAudit: {
        settingsUsed: settings,
        items: items.map(i => ({
          itemName: i.itemName, decision: i.decision, decisionAvailable: i.decisionAvailable,
          decisionStatus: i.decisionStatus, unavailableReason: i.unavailableReason, noEvidenceReason: i.noEvidenceReason,
          maxBuyPrice: i.maxBuyPrice, bestMarketplace: i.bestMarketplace,
          marketDataSource: i.marketDataSource, routedMarketplaces: i.routedMarketplaces,
          evidenceByMarketplace: i.evidenceByMarketplace,
          aiEstimate: i.aiEstimate, decisionReasons: i.decisionReasons,
        })),
      },
    },
  });

  // routedMarketplaces/evidenceByMarketplace are kept in the scan_log audit
  // trail above (server-side forensics) but not sent to the client — same
  // minimal response shape as before this pipeline existed, plus the
  // existing marketDataSource/bestMarketplace fields.
  return { items: items.map(({ routedMarketplaces: _routedMarketplaces, evidenceByMarketplace: _evidenceByMarketplace, ...i }) => i) };
}

// P1-C: one logical Save/Buy action must create at most one inventory row,
// even under a double tap, client retry, timeout retry, or reconnect/replay.
// scanLogId is a natural idempotency key here — one scan produces at most one
// "bought" inventory row — falling back to an explicit clientOpId when the
// caller supplies one for a non-scan buy. `client_op_id` is enforced unique
// per user at the database layer (migration 20260826230000).
export async function handleBuyItem(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  tier: string,
  body: Record<string, unknown>,
) {
  const clientOpId = body.scanLogId != null ? `scan:${body.scanLogId}`
    : (body.clientOpId != null ? String(body.clientOpId) : null);

  if (body.scanLogId != null) {
    const { data: ownedScan, error: scanError } = await supabase.from('scan_log')
      .select('id').eq('id', body.scanLogId).eq('user_id', userId).maybeSingle();
    if (scanError) throw new Error(scanError.message);
    if (!ownedScan) throw new HttpError('scan_not_found', 404);
  }

  if (clientOpId) {
    const { data: existing } = await supabase.from('inventory')
      .select('id').eq('user_id', userId).eq('client_op_id', clientOpId).maybeSingle();
    if (existing) return { inventoryId: existing.id };
  }

  const limit = resolveItemLimit(tier);
  if (limit !== null) {
    const { count } = await supabase
      .from('inventory').select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    if ((count ?? 0) >= limit) {
      throw new HttpError('item_limit_reached', 429, { tier, limit });
    }
  }

  const { data: inv, error } = await supabase.from('inventory').insert({
    user_id: userId,
    item_id: `scan-${Date.now()}`,
    nickname: body.itemName,
    category: body.category ?? null,
    cost: body.cost,
    sell_price: body.sellPrice ?? null,
    status: 'Unlisted',
    platform: body.platform ?? 'eBay',
    created_from: 'scan',
    sourcing_meta: body.sourcingMeta ?? null,
    photos: '[]',
    client_op_id: clientOpId,
  }).select('id').single();

  if (error) {
    // Unique-violation on (user_id, client_op_id) means a concurrent duplicate
    // request already created this row — return it instead of failing (P1-C).
    if (error.code === '23505' && clientOpId) {
      const { data: existing } = await supabase.from('inventory')
        .select('id').eq('user_id', userId).eq('client_op_id', clientOpId).maybeSingle();
      if (existing) return { inventoryId: existing.id };
    }
    throw new Error(error.message);
  }

  if (body.scanLogId) {
    await supabase.from('scan_log')
      .update({
        bought: true,
        cost: body.cost,
        estimated_profit: body.estimatedProfit ?? null,
        roi: body.roi ?? null,
      })
      .eq('id', body.scanLogId).eq('user_id', userId);
  }

  return { inventoryId: inv.id };
}

// ── Inventory handlers ──────────────────────────────────────────────────────

export async function handleInventoryList(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  settings: Settings,
  tier: string,
  pageSize = 500,
  pageOffset = 0,
) {
  // §5.8: paginated — default page 500 prevents full-table scans for Stack/Empire users
  const { data: items, error } = await supabase
    .from('inventory').select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(pageOffset, pageOffset + pageSize - 1);
  if (error) throw new Error(error.message);

  const { count } = await supabase
    .from('inventory').select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  return { items: items ?? [], itemCount: count ?? 0, settings, tier, pageSize, pageOffset };
}

// P1-C: the web client assigns each locally-created item a stable id
// (app.html itemForServer/pushItemToServer) before the first save attempt and
// resends that same id on every retry of the same logical save. Using it as
// client_op_id — enforced unique per user at the database layer — means a
// double tap, client retry, timeout retry, or reconnect/replay of the same
// save can never create more than one inventory row; a duplicate request
// reuses the already-created row instead of erroring.
export async function handleInventoryCreate(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  tier: string,
  body: Record<string, unknown>,
) {
  const clientOpId = body.id != null ? String(body.id) : null;

  if (clientOpId) {
    const { data: existing } = await supabase.from('inventory')
      .select('*').eq('user_id', userId).eq('client_op_id', clientOpId).maybeSingle();
    if (existing) return { item: existing };
  }

  // Tier gate — check BEFORE writing
  const limit = resolveItemLimit(tier);
  if (limit !== null) {
    const { count } = await supabase
      .from('inventory').select('*', { count: 'exact', head: true })
      .eq('user_id', userId);
    if ((count ?? 0) >= limit) {
      throw new HttpError('item_limit_reached', 429, { tier, limit });
    }
  }

  // SKU generation: category prefix + zero-padded count across all user items
  const category = (body.category as string) ?? 'Other';
  const prefix = CATEGORY_SKU_PREFIX[category] ?? 'OTH_';
  const { count: existingCount } = await supabase
    .from('inventory').select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  const sku = `${prefix}-${String((existingCount ?? 0) + 1).padStart(5, '0')}`;

  const photos = body.photos ?? [];
  const { data: item, error } = await supabase.from('inventory').insert({
    user_id:      userId,
    item_id:      `manual-${Date.now()}`,
    sku,
    nickname:     body.nickname ?? null,
    category:     body.category ?? null,
    condition:    body.condition ?? null,
    cost:         body.cost ?? null,
    sell_price:   body.sellPrice ?? null,
    status:       'Unlisted',
    platform:     body.platform ?? 'eBay',
    notes:        body.notes ?? null,
    photos,
    created_from: body.createdFrom ?? 'manual',
    photo_count:  Array.isArray(photos) ? photos.length : 0,
    client_op_id: clientOpId,
  }).select('*').single();

  if (error) {
    // Unique-violation on (user_id, client_op_id) means a concurrent duplicate
    // request already created this row — return it instead of failing (P1-C).
    if (error.code === '23505' && clientOpId) {
      const { data: existing } = await supabase.from('inventory')
        .select('*').eq('user_id', userId).eq('client_op_id', clientOpId).maybeSingle();
      if (existing) return { item: existing };
    }
    throw new Error(error.message);
  }
  return { item };
}

// P2-19: fetches the current row and throws the standard 409 conflict shape
// when it no longer exists or its version has moved past what the caller
// expected — shared by handleInventoryUpdate and handleInventoryStatus so the
// two mutation paths report a stale write identically.
async function inventoryConflictOrNotFound(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  itemId: number,
): Promise<never> {
  const { data: latest } = await supabase.from('inventory')
    .select('*').eq('id', itemId).eq('user_id', userId).maybeSingle();
  if (!latest) throw new HttpError('Item not found', 404);
  throw new HttpError('conflict', 409, { code: 'stale_version', item: latest });
}

export async function handleInventoryUpdate(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  body: Record<string, unknown>,
) {
  const itemId = body.id as number;
  if (!itemId) throw new Error('Missing item id');
  const expectedVersion = body.expectedVersion as number | undefined;
  if (expectedVersion == null) throw new HttpError('expectedVersion is required', 400);

  const updates: Record<string, unknown> = { version: expectedVersion + 1 };
  if (body.nickname  !== undefined) updates.nickname   = body.nickname;
  if (body.category  !== undefined) updates.category   = body.category;
  if (body.condition !== undefined) updates.condition  = body.condition;
  if (body.cost      !== undefined) updates.cost       = body.cost;
  if (body.sellPrice !== undefined) updates.sell_price = body.sellPrice;
  if (body.platform  !== undefined) updates.platform   = body.platform;
  if (body.notes     !== undefined) updates.notes      = body.notes;
  if (body.photos    !== undefined) {
    updates.photos      = body.photos;
    updates.photo_count = Array.isArray(body.photos) ? body.photos.length : 0;
  }

  // Version match is part of the WHERE clause, so a stale write matches zero
  // rows atomically — no separate read-then-write race window.
  const { data: item, error } = await supabase.from('inventory')
    .update(updates).eq('id', itemId).eq('user_id', userId).eq('version', expectedVersion)
    .select('*').maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) return inventoryConflictOrNotFound(supabase, userId, itemId);
  return { item };
}

export async function handleInventoryDelete(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  body: Record<string, unknown>,
) {
  const itemId = body.id as number;
  if (!itemId) throw new Error('Missing item id');

  const { error } = await supabase.from('inventory')
    .delete().eq('id', itemId).eq('user_id', userId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

const VALID_TRANSITIONS: Record<string, string[]> = {
  'Unlisted':        ['Listed', 'Sold'],
  'Listed':          ['Sold', 'Unlisted'],
  'Sold':            [],
  'Ready to Export': ['Listed'],
};

export async function handleInventoryStatus(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  body: Record<string, unknown>,
) {
  const itemId    = body.id as number;
  const newStatus = body.status as string;
  const expectedVersion = body.expectedVersion as number | undefined;
  if (!itemId || !newStatus) throw new Error('Missing id or status');
  if (expectedVersion == null) throw new HttpError('expectedVersion is required', 400);

  const { data: current, error: fetchErr } = await supabase.from('inventory')
    .select('*').eq('id', itemId).eq('user_id', userId).single();
  if (fetchErr || !current) throw new Error('Item not found');

  // P1-C: a retried status-transition request (double tap, client retry,
  // reconnect/replay) that finds the item already in the requested state is a
  // no-op success, not an error — this is what keeps a retried "mark Sold"
  // from ever producing a second sale effect. Nothing changes, so no version
  // check is needed on this path.
  if (current.status === newStatus) return { item: current };

  const allowed = VALID_TRANSITIONS[current.status as string] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Cannot transition from ${current.status} to ${newStatus}`);
  }

  const updates: Record<string, unknown> = { status: newStatus, version: expectedVersion + 1 };
  if (newStatus === 'Listed') updates.listed_at = new Date().toISOString();
  if (newStatus === 'Sold') {
    updates.sold_at = new Date().toISOString();
    // sold_price is the actual sale price. sell_price is the listing/expected
    // price and must be preserved as-is — never overwritten by the sale (P0 #3).
    if (body.actualSellPrice != null) {
      updates.sold_price = body.actualSellPrice;
    }
  }

  // P2-19: version match is part of the WHERE clause — atomic, no
  // read-then-write race window between the fetch above and this update.
  const { data: item, error } = await supabase.from('inventory')
    .update(updates).eq('id', itemId).eq('user_id', userId).eq('version', expectedVersion)
    .select('*').maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) return inventoryConflictOrNotFound(supabase, userId, itemId);
  return { item };
}

// ── categoryHint map — verbatim from FEATURE_TRIAGE F-29 L3623-3635 ───────────
// Keys match CATEGORIES in apps/web/public/app.html — see CATEGORY_SKU_PREFIX comment.
const CATEGORY_HINT: Record<string, string> = {
  'Electronics':         'functional, tested, specifications',
  'Clothing':            'fabric, fit, brand, styling',
  'Shoes':               'size, fit, brand, sole condition',
  'Home & Garden':       'materials, dimensions, functionality',
  'Collectibles':        'authenticity, rarity, condition',
  'Toys & Hobbies':      'completeness, vintage value, condition',
  'Sporting Goods':      'brand, specifications, condition',
  'Books':               'author, edition, binding, condition',
  'Automotive':          'fitment, brand, condition',
  'Health & Beauty':     'sealed/unused, expiration, brand',
  'Tools':               'brand, functionality, wear',
  'Musical Instruments': 'brand, playability, condition',
  'Pet Supplies':        'size, material, condition',
  'Baby':                'safety, completeness, condition',
  'Jewelry & Watches':   'material, brand, specifications',
};

async function handleListingGenerate(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: number,
  settings: Settings,
  body: Record<string, unknown>,
) {
  const nickname  = sanitizeForPrompt((body.nickname  as string) ?? 'Unknown item', 200);
  const category  = (body.category  as string) ?? 'Other';
  const condition = (body.condition as string) ?? 'Used';
  const notes     = sanitizeForPrompt((body.notes as string) ?? '', 500);
  const sellPrice = body.sellPrice  != null ? Number(body.sellPrice) : null;
  const itemId    = body.itemId     as number | null ?? null;

  const categoryHint = CATEGORY_HINT[category] ?? 'key details, condition, brand';

  // Verbatim from FEATURE_TRIAGE.md F-29 P-06 (L3637–3656)
  const prompt = `You are an expert eBay reseller writing product listings. Generate a title, description, and condition note for this item.

Item name: ${nickname}
Category: ${category}
Condition: ${condition}
Seller notes: ${notes || 'No additional notes'}

Focus on: ${categoryHint}

STRICT REQUIREMENTS:
- Title: max 80 characters, eBay-optimized keywords first
- Description: 250-400 words, bullet points for key details, mobile-friendly
- Condition Note: 50-100 words, specific about condition

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "title": "...",
  "description": "...",
  "conditionNote": "...",
  "suggestedPrice": ${sellPrice ?? 'null'},
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "shippingNote": "Buyer pays shipping"
}`;

  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? 'Anthropic error');

  let ai: Record<string, unknown>;
  try { ai = JSON.parse(data.content[0].text as string); }
  catch { throw new Error('AI returned invalid JSON'); }

  // Enforce title ≤80 chars
  const title = String(ai.title ?? '').slice(0, 80);

  const listing = {
    itemId,
    title,
    description:   String(ai.description   ?? ''),
    conditionNote: String(ai.conditionNote  ?? ''),
    suggestedPrice: ai.suggestedPrice != null ? Number(ai.suggestedPrice) : sellPrice,
    keywords:       Array.isArray(ai.keywords) ? ai.keywords as string[] : [],
    ebayCategory:   category,
    shippingNote:   String(ai.shippingNote ?? (settings.shipping === 'buyer' ? 'Buyer pays shipping' : 'Seller pays shipping')),
    generatedAt:    new Date().toISOString(),
  };

  // Save to inventory row if itemId provided
  if (itemId) {
    await supabase.from('inventory').update({
      listing_title:       title,
      listing_description: listing.description,
      listing_condition:   listing.conditionNote,
      listing_data:        listing,
    }).eq('id', itemId).eq('user_id', userId);
  }

  return { listing };
}

async function handleKeywordsGet(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: number,
) {
  // Check growth_cache for fresh trending keywords (<24hrs)
  const { data: cacheRow } = await supabase.from('growth_cache')
    .select('cache_data, generated_at')
    .eq('user_id', userId)
    .maybeSingle();

  const cacheData = cacheRow?.cache_data as Record<string, unknown> | null;
  const cachedKw = cacheData?.trending_keywords as Record<string, unknown> | null;
  const cachedAt = cachedKw?.cached_at as string | null;

  if (cachedAt) {
    const ageHours = (Date.now() - new Date(cachedAt).getTime()) / (1000 * 3600);
    if (ageHours < 24) {
      return { ...cachedKw, fromCache: true };
    }
  }

  if (!anthropicKey) {
    return { keywords: STATIC_KEYWORDS, trending_categories: STATIC_CATEGORIES, hot_tip: STATIC_TIP, fromCache: false };
  }

  // Verbatim from FEATURE_TRIAGE.md F-28 P-08 (L5402)
  const prompt = `Search for the top trending eBay search keywords and most popular resale categories RIGHT NOW today ${new Date().toLocaleDateString()}. What are buyers searching for most on eBay this week? Focus on thrift resale categories: electronics, clothing, collectibles, home goods. Return ONLY valid JSON: {"keywords":[{"rank":1,"word":"string","trend":"up/stable/down","bar":85},...],"trending_categories":["string"],"hot_tip":"one sentence actionable tip for resellers today"}. Include exactly 10 keywords sorted by search volume.`;

  let kwResult: Record<string, unknown>;
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01', 'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 800,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error?.message ?? 'Anthropic error');
    const textBlock = (d.content as Array<{type: string; text?: string}>).find(b => b.type === 'text');
    kwResult = JSON.parse(textBlock?.text ?? '{}');
  } catch {
    return { keywords: STATIC_KEYWORDS, trending_categories: STATIC_CATEGORIES, hot_tip: STATIC_TIP, fromCache: false };
  }

  // Cache result
  const toCache = { ...kwResult, cached_at: new Date().toISOString() };
  const newCacheData = { ...(cacheData ?? {}), trending_keywords: toCache };
  await supabase.from('growth_cache').upsert({
    user_id: userId, cache_data: newCacheData,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  }, { onConflict: 'user_id' });

  return { ...kwResult, fromCache: false };
}

// ── Growth Agent handler ────────────────────────────────────────────────────

// ── Stats / P&L handlers ────────────────────────────────────────────────────

function calcPnlServer(
  soldItems: Record<string, unknown>[],
  allItems: Record<string, unknown>[],
  expenses: Record<string, unknown>[],
  settings: Settings & { tax_reserve_pct?: number; mileage_rate?: number; stale_days?: number },
  periodLabel: string,
) {
  const ebayFee      = settings.ebay_fee    ?? 13;
  const pkgCost      = settings.pkg_cost    ?? 1.25;
  const shipping     = settings.shipping    ?? 'buyer';
  const shipCost     = settings.ship_cost   ?? 6.00;
  const taxReservePct = settings.tax_reserve_pct ?? 0.25; // never hardcoded
  const mileageRate  = settings.mileage_rate ?? 0.72;     // never hardcoded

  // Realized revenue must come from the actual sold_price (P0 #3), never the
  // listing/expected sell_price. A Sold item with no recorded sold_price is
  // excluded from the dollar totals rather than having its price fabricated.
  let totalRevenue = 0, totalCogs = 0, totalFees = 0, totalPackaging = 0, totalShipping = 0;
  let itemsMissingSoldPrice = 0;
  for (const item of soldItems) {
    if (item.sold_price == null) { itemsMissingSoldPrice++; continue; }
    const sell = Number(item.sold_price);
    const cost = Number(item.cost ?? 0);
    totalRevenue   += sell;
    totalCogs      += cost;
    totalFees      += sell * (ebayFee / 100);
    totalPackaging += pkgCost;
    if (shipping === 'seller') totalShipping += shipCost;
  }

  let totalExpenses = 0, totalMiles = 0;
  for (const exp of expenses) {
    if (exp.category === 'mileage' && exp.miles != null) {
      totalMiles += Number(exp.miles);
    } else {
      totalExpenses += Number(exp.amount ?? 0);
    }
  }
  const totalMileage = totalMiles * mileageRate;
  const netProfit    = r2(totalRevenue - totalCogs - totalFees - totalPackaging - totalShipping - totalExpenses - totalMileage);
  const taxReserve   = netProfit > 0 ? r2(netProfit * taxReservePct) : 0;
  const roi          = totalCogs > 0 ? r2((netProfit / totalCogs) * 100) : 0;

  const daysArr = soldItems
    .filter(i => i.sold_at && i.created_at)
    .map(i => Math.max(0, (new Date(i.sold_at as string).getTime() - new Date(i.created_at as string).getTime()) / 86400000));
  const avgDaysToSell = daysArr.length > 0 ? r2(daysArr.reduce((a, b) => a + b, 0) / daysArr.length) : 0;

  return {
    totalRevenue:   r2(totalRevenue),   totalCogs:      r2(totalCogs),
    totalFees:      r2(totalFees),      totalShipping:  r2(totalShipping),
    totalPackaging: r2(totalPackaging), totalExpenses:  r2(totalExpenses),
    totalMileage:   r2(totalMileage),   netProfit,      taxReserve,    roi,
    avgDaysToSell,  itemsSold: soldItems.length,
    itemsListed:   allItems.filter(i => i.status === 'Listed').length,
    itemsUnlisted: allItems.filter(i => i.status === 'Unlisted').length,
    itemsMissingSoldPrice,
    periodLabel,
  };
}

async function handleStatsSummary(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  settings: Settings,
  body: Record<string, unknown>,
) {
  const period = (body.period as string) ?? 'all';
  let periodLabel = 'All Time';
  let soldFilter = supabase.from('inventory').select('*').eq('user_id', userId).eq('status', 'Sold');
  if (period === 'month') {
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    soldFilter = soldFilter.gte('sold_at', start.toISOString());
    periodLabel = 'This Month';
  } else if (period === 'last30') {
    soldFilter = soldFilter.gte('sold_at', new Date(Date.now() - 30 * 86400000).toISOString());
    periodLabel = 'Last 30 Days';
  }

  const { data: soldItems } = await soldFilter;
  const { data: allItems }  = await supabase.from('inventory').select('status, sell_price, cost, sold_at, created_at').eq('user_id', userId);
  const { data: expenses }  = await supabase.from('pnl_expenses').select('*').eq('user_id', userId);

  const summary = calcPnlServer(
    soldItems ?? [], allItems ?? [], expenses ?? [],
    settings as Settings & { tax_reserve_pct?: number; mileage_rate?: number },
    periodLabel,
  );
  return { summary };
}

async function handleExpensesList(supabase: ReturnType<typeof createClient>, userId: number) {
  const { data, error } = await supabase.from('pnl_expenses')
    .select('*').eq('user_id', userId).order('date', { ascending: false });
  if (error) throw new Error(error.message);
  return { expenses: data ?? [] };
}

async function handleExpensesAdd(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  body: Record<string, unknown>,
) {
  const amount   = Number(body.amount ?? 0);
  const category = (body.category as string) ?? 'other';
  const date     = (body.date as string) ?? new Date().toISOString().slice(0, 10);
  if (amount <= 0) throw new Error('Amount must be greater than 0');

  const { data, error } = await supabase.from('pnl_expenses').insert({
    user_id:     userId,
    amount,
    category,
    description: body.description ?? null,
    date,
    miles:       body.miles != null ? Number(body.miles) : null,
  }).select('*').single();

  if (error) throw new Error(error.message);
  return { expense: data };
}

function mapAction(raw: string): 'relist' | 'drop_price' | 'bundle' | 'donate' {
  const s = raw.toLowerCase();
  if (s.includes('drop') || s.includes('price')) return 'drop_price';
  if (s.includes('bundle')) return 'bundle';
  if (s.includes('donate')) return 'donate';
  return 'relist';
}

async function handleGrowthReport(
  supabase: ReturnType<typeof createClient>,
  anthropicKey: string,
  userId: number,
  settings: Settings,
  forceRefresh: boolean,
) {
  // Check cache first — stored at cache_data.growth_report
  const { data: cacheRow } = await supabase.from('growth_cache')
    .select('cache_data').eq('user_id', userId).maybeSingle();

  const cacheData = (cacheRow?.cache_data ?? {}) as Record<string, unknown>;
  const cached = cacheData.growth_report as (Record<string, unknown> & { generatedAt?: string }) | null;

  if (!forceRefresh && cached?.generatedAt) {
    const ageHours = (Date.now() - new Date(cached.generatedAt as string).getTime()) / 3600000;
    if (ageHours < 24) return { cached: true, data: cached, generatedAt: cached.generatedAt };
  }

  // Pull inventory stats per category
  const { data: catRows } = await supabase.from('inventory')
    .select('category, cost, sell_price, status')
    .eq('user_id', userId);

  const items = catRows ?? [];
  const itemCount = items.length;

  // Build category stats
  const catMap: Record<string, { count: number; revenue: number; cogs: number; sold: number }> = {};
  for (const row of items) {
    const cat = (row.category as string) ?? 'Other';
    if (!catMap[cat]) catMap[cat] = { count: 0, revenue: 0, cogs: 0, sold: 0 };
    catMap[cat].count++;
    if (row.status === 'Sold') {
      catMap[cat].sold++;
      catMap[cat].revenue += Number(row.sell_price ?? 0);
      catMap[cat].cogs    += Number(row.cost ?? 0);
    }
  }
  const categoryStats = Object.entries(catMap).map(([cat, s]) => ({
    category: cat, item_count: s.count, sold_count: s.sold,
    avg_cost: s.count > 0 ? s.cogs / s.count : 0,
    total_profit: s.revenue - s.cogs,
  })).sort((a, b) => b.total_profit - a.total_profit);

  // Pull sold totals — §5.3: include eBay fees + packaging so AI sees real profit
  const sold = items.filter(r => r.status === 'Sold');
  const revenue = sold.reduce((s, r) => s + Number(r.sell_price ?? 0), 0);
  const cogs    = sold.reduce((s, r) => s + Number(r.cost ?? 0), 0);
  const ebayFees = revenue * ((settings.ebay_fee ?? 13) / 100);
  const pkgFees  = sold.length * (settings.pkg_cost ?? 1.25);

  // Pull stale items (>60 days) — P2-23: see computeStaleInventoryItems for
  // why Listed items age from listed_at, not created_at.
  const maxDays = (settings as unknown as Record<string, unknown>).stale_days
    ? Number((settings as unknown as Record<string, unknown>).stale_days)
    : 60;
  const { data: staleCandidates } = await supabase.from('inventory')
    .select('sku, nickname, status, created_at, listed_at')
    .eq('user_id', userId)
    .in('status', ['Unlisted', 'Listed']);

  const staleItems = computeStaleInventoryItems(
    (staleCandidates ?? []) as StaleCandidateRow[], maxDays,
  ).map(r => ({ ...r, nickname: sanitizeForPrompt(r.nickname, 100) }));

  // Pull top scanned categories (last 30 days)
  const { data: scanRows } = await supabase.from('scan_log')
    .select('category')
    .eq('user_id', userId)
    .gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString());

  const scanCatMap: Record<string, number> = {};
  for (const r of scanRows ?? []) {
    const c = (r.category as string) ?? 'Other';
    scanCatMap[c] = (scanCatMap[c] ?? 0) + 1;
  }
  const topScanCats = Object.entries(scanCatMap)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([category, scan_count]) => ({ category, scan_count }));

  const inventorySummary = {
    total_items: itemCount,
    total_revenue: Math.round(revenue * 100) / 100,
    total_cogs: Math.round(cogs * 100) / 100,
    net_profit: Math.round((revenue - cogs - ebayFees - pkgFees) * 100) / 100,
    sold_count: sold.length,
    category_stats: categoryStats.slice(0, 8),
    stale_items: staleItems,
    top_scan_categories: topScanCats,
  };

  if (!anthropicKey) {
    return { cached: false, data: buildFallbackReport(itemCount), generatedAt: new Date().toISOString() };
  }

  // Verbatim from FEATURE_TRIAGE.md F-27 P-05 (L3279–3307)
  const prompt = `You are a business growth advisor for an eBay thrift reseller. Analyze their data and provide actionable insights.

SELLER INVENTORY DATA:
${JSON.stringify(inventorySummary, null, 2)}

SELLER FEE STRUCTURE: ${settings.ebay_fee}% eBay fee + $${settings.pkg_cost} packaging per item. Minimum profit target: $${settings.min_profit}. Target ROI: ${settings.target_roi}%. Max days to sell: ${maxDays}.

TODAY'S DATE: ${new Date().toLocaleDateString()}

Based on this real seller data AND your knowledge of current eBay reselling trends for thrift sellers in 2025-2026, return ONLY valid JSON (no markdown, no preamble):
{
  "business_score": number (0-100),
  "score_label": "Strong/Growing/Steady/Needs Attention",
  "score_color": "#00e676 or #f5a623 or #ff3333",
  "score_summary": "one sentence on overall business health using their actual numbers",
  "top_categories": [
    {"name":"string","profit":"$X","insight":"one sentence specific to their data","bar_pct":number}
  ],
  "stale_actions": [
    {"sku":"string","name":"string","days":number,"action":"Relist / Drop price 10% / Bundle / Donate","reason":"one sentence"}
  ],
  "hunt_list": [
    {"icon":"emoji","item":"string","why":"one sentence why to hunt this now","priority":"HIGH or MED"}
  ],
  "market_trends": [
    {"arrow":"📈 or 📉","category":"string","detail":"one sentence trend insight for thrift resellers"}
  ],
  "advisor_message": "3-4 sentences of direct actionable advice using their actual numbers. Be specific. Tell them exactly what to do differently this week."
}`;

  let ai: Record<string, unknown>;
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error?.message ?? 'Anthropic error');
    ai = JSON.parse(d.content[0].text as string);
  } catch {
    return { cached: false, data: buildFallbackReport(itemCount), generatedAt: new Date().toISOString() };
  }

  // Normalize AI response → GrowthReport shape
  const catStatsByName: Record<string, typeof categoryStats[number]> = {};
  for (const c of categoryStats) catStatsByName[c.category] = c;

  const report = {
    business_score: Number(ai.business_score ?? 50),
    score_label:    String(ai.score_label ?? 'Steady'),
    score_color:    String(ai.score_color ?? '#f5a623'),
    score_summary:  String(ai.score_summary ?? ''),
    top_categories: ((ai.top_categories as unknown[]) ?? []).slice(0, 3).map((c: unknown) => {
      const cat = c as Record<string, unknown>;
      const profitStr = String(cat.profit ?? '0').replace(/[^0-9.-]/g, '');
      const dbCat = catStatsByName[String(cat.name ?? '')] ?? null;
      return {
        name:       String(cat.name ?? ''),
        profit:     parseFloat(profitStr) || 0,
        sold_count: dbCat?.sold_count ?? 0,
        insight:    String(cat.insight ?? ''),
      };
    }),
    stale_actions: ((ai.stale_actions as unknown[]) ?? []).slice(0, 5).map((s: unknown) => {
      const row = s as Record<string, unknown>;
      return {
        sku:         String(row.sku ?? ''),
        nickname:    String(row.name ?? row.nickname ?? 'Unknown'),
        days_listed: Number(row.days ?? 0),
        action:      mapAction(String(row.action ?? 'relist')),
        suggestion:  String(row.reason ?? ''),
      };
    }),
    hunt_list: ((ai.hunt_list as unknown[]) ?? []).slice(0, 5).map((h: unknown) => {
      const row = h as Record<string, unknown>;
      return {
        item:     String(row.item ?? ''),
        priority: (String(row.priority ?? 'MED').toUpperCase() === 'HIGH' ? 'HIGH' : 'MED') as 'HIGH' | 'MED',
        reason:   String(row.why ?? row.reason ?? ''),
        icon:     String(row.icon ?? ''),
      };
    }),
    market_trends: ((ai.market_trends as unknown[]) ?? []).slice(0, 4).map((m: unknown) => {
      const row = m as Record<string, unknown>;
      const arrow = String(row.arrow ?? '');
      return {
        category:  String(row.category ?? ''),
        direction: (arrow.includes('📈') ? 'up' : 'down') as 'up' | 'down',
        reasoning: String(row.detail ?? row.reasoning ?? ''),
      };
    }),
    advisor_message: String(ai.advisor_message ?? ''),
    generatedAt:     new Date().toISOString(),
    item_count:      itemCount,
  };

  // Save to growth_cache
  const newCacheData = { ...cacheData, growth_report: report };
  await supabase.from('growth_cache').upsert({
    user_id: userId, cache_data: newCacheData,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  }, { onConflict: 'user_id' });

  return { cached: false, data: report, generatedAt: report.generatedAt };
}

async function handleSettingsGet(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  tier: string,
) {
  const { data: row, error } = await supabase
    .from('settings').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  const s = row ?? {};
  const settings = {
    id:            s.id ?? 0,
    userId,
    ebayFee:       Number(s.ebay_fee ?? 13),
    pkgCost:       Number(s.pkg_cost ?? 1.25),
    minProfit:     Number(s.min_profit ?? 15),
    targetRoi:     Number(s.target_roi ?? 200),
    maxDays:       Number(s.stale_days ?? 60),
    minStr:        Number(s.min_str ?? 0),
    shipping:      s.shipping ?? 'buyer',
    shipCost:      Number(s.ship_cost ?? 6.00),
    sourcingStyle: s.sourcing_style ?? 'balanced',
    taxReservePct: Number(s.tax_reserve_pct ?? 0.25),
    mileageRate:   Number(s.mileage_rate ?? 0.72),
    updatedAt:     s.updated_at ?? new Date().toISOString(),
  };
  return { success: true, settings, tier };
}

interface SettingsInput {
  ebayFee: number; pkgCost: number; shipCost: number; minProfit: number;
  targetRoi: number; maxDays: number; minStr: number;
  sourcingStyle: string; shipping: string;
}

function validateSettingsInput(s: SettingsInput): string | null {
  if (s.ebayFee < 0 || s.ebayFee > 50)   return 'ebayFee must be 0–50';
  if (s.pkgCost < 0)                       return 'pkgCost must be ≥ 0';
  if (s.shipCost < 0)                      return 'shipCost must be ≥ 0';
  if (s.minProfit < 0)                     return 'minProfit must be ≥ 0';
  if (s.targetRoi < 0 || s.targetRoi > 1000) return 'targetRoi must be 0–1000';
  if (s.maxDays < 1 || s.maxDays > 999)   return 'maxDays must be 1–999';
  if (s.minStr < 0 || s.minStr > 100)     return 'minStr must be 0–100';
  const validSourcing = ['conservative', 'balanced', 'aggressive'];
  if (!validSourcing.includes(s.sourcingStyle)) return 'Invalid sourcingStyle';
  const validShipping = ['buyer', 'seller'];
  if (!validShipping.includes(s.shipping)) return 'Invalid shipping';
  return null;
}

async function handleSettingsUpdate(
  supabase: ReturnType<typeof createClient>,
  userId: number,
  tier: string,
  body: Record<string, unknown>,
) {
  const s = body.settings as SettingsInput;
  if (!s) throw new HttpError('Missing settings payload', 400);
  const validationError = validateSettingsInput(s);
  if (validationError) throw new HttpError(validationError, 400);
  const { data, error } = await supabase.from('settings').upsert({
    user_id:       userId,
    ebay_fee:      s.ebayFee,
    pkg_cost:      s.pkgCost,
    ship_cost:     s.shipCost,
    min_profit:    s.minProfit,
    target_roi:    s.targetRoi,
    stale_days:    s.maxDays,
    min_str:       s.minStr,
    sourcing_style: s.sourcingStyle,
    shipping:      s.shipping,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'user_id' }).select().single();
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown>;
  const updated = {
    id:            row.id as number,
    userId,
    ebayFee:       Number(row.ebay_fee ?? s.ebayFee),
    pkgCost:       Number(row.pkg_cost ?? s.pkgCost),
    minProfit:     Number(row.min_profit ?? s.minProfit),
    targetRoi:     Number(row.target_roi ?? s.targetRoi),
    maxDays:       Number(row.stale_days ?? s.maxDays),
    minStr:        Number(row.min_str ?? s.minStr),
    shipping:      row.shipping ?? s.shipping,
    shipCost:      Number(row.ship_cost ?? s.shipCost),
    sourcingStyle: row.sourcing_style ?? s.sourcingStyle,
    taxReservePct: Number(row.tax_reserve_pct ?? 0.25),
    mileageRate:   Number(row.mileage_rate ?? 0.72),
    updatedAt:     row.updated_at as string,
  };
  return { success: true, settings: updated };
}

function buildFallbackReport(itemCount: number): Record<string, unknown> {
  return {
    business_score: 0, score_label: 'Needs Attention',
    score_color: '#ff3333',
    score_summary: 'Could not generate report — add more sold items for analysis.',
    top_categories: [], stale_actions: [], hunt_list: [], market_trends: [],
    advisor_message: 'List and sell a few items to unlock your weekly brief.',
    generatedAt: new Date().toISOString(), item_count: itemCount,
  };
}

const STATIC_KEYWORDS = [
  { rank: 1, word: 'vintage electronics', trend: 'up',     bar: 92 },
  { rank: 2, word: 'levi jeans',          trend: 'up',     bar: 88 },
  { rank: 3, word: 'retro gaming',        trend: 'up',     bar: 85 },
  { rank: 4, word: 'cast iron cookware',  trend: 'stable', bar: 78 },
  { rank: 5, word: 'nike shoes',          trend: 'up',     bar: 76 },
  { rank: 6, word: 'vintage camera',      trend: 'up',     bar: 72 },
  { rank: 7, word: 'band t shirt',        trend: 'stable', bar: 68 },
  { rank: 8, word: 'pokemon cards',       trend: 'stable', bar: 65 },
  { rank: 9, word: 'vintage pyrex',       trend: 'up',     bar: 62 },
  { rank: 10, word: 'tools hardware',     trend: 'stable', bar: 58 },
];
const STATIC_CATEGORIES = ['Electronics', 'Clothing', 'Collectibles', 'Home & Garden'];
const STATIC_TIP = 'Electronics with original boxes sell 30% faster — always include if available.';

// P1-D/P1-K: guarded so this module can be imported by tests (e.g.
// inventory_isolation_test.ts) without starting an HTTP listener as a
// side effect. Supabase Edge Functions invoke this file directly as the
// entrypoint, so import.meta.main is true in production — no deployed
// behavior changes.
if (import.meta.main) {
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });

  // SEC-015: local json shadows module-level, closes over req for dynamic CORS.
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  const contentType = req.headers.get('Content-Type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    // Mobile clients upload the raw camera file directly (no client-side
    // base64/decode — avoids OOM on low-RAM Android WebViews). Convert to
    // base64 here, server-side, where memory isn't constrained.
    try {
      const form = await req.formData();
      const imageFile = form.get('image') as File | null;
      let b64 = '';
      let imageMime: string = 'image/jpeg';
      if (imageFile) {
        if (imageFile.size > MAX_SCAN_IMAGE_BYTES) return json({ error: 'Image exceeds the 8MB limit' }, 413);
        if (imageFile.size < 12) return json({ error: 'Invalid image file' }, 400);
        const buf = await imageFile.arrayBuffer();
        // Detect ISOBMFF container: bytes 4-7 are 'ftyp' (0x66 0x74 0x79 0x70).
        // Shared by HEIC, AVIF, MP4, MOV. Check bytes 8-11 for the actual brand.
        const hdr = new Uint8Array(buf, 0, 12);
        if (hdr[4] === 0x66 && hdr[5] === 0x74 && hdr[6] === 0x79 && hdr[7] === 0x70) {
          const brand = String.fromCharCode(hdr[8], hdr[9], hdr[10], hdr[11]).toLowerCase();
          const isHeic = ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
          if (isHeic) {
            return json({ error: 'HEIC photos are not supported. On iPhone: Settings → Camera → Format → Most Compatible to save as JPEG.' }, 415);
          }
          // AVIF, MP4, MOV and other unsupported container formats
          return json({ error: 'This image format is not supported. Please use JPEG, PNG, or WebP.' }, 415);
        }
        b64 = ab2b64(buf);
        const detected = detectImageMime(buf);
        if (!detected) return json({ error: 'This image format is not supported. Please use JPEG, PNG, GIF, or WebP.' }, 415);
        imageMime = detected;
      }
      body = {
        type: form.get('type') as string,
        hint: form.get('hint') as string | null,
        acquisitionCost: form.get('acquisitionCost') as string | null,
        imageBase64: b64,
        images: b64 ? [b64] : [],
        imageMimeTypes: b64 ? [imageMime] : [],
      };
    } catch {
      return json({ error: 'Invalid form data' }, 400);
    }
  } else {
    try { body = await req.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400); }
  }

  if (body.type === 'health') {
    return json({ status: 'ok', function: 'claude-proxy', ts: new Date().toISOString() });
  }

  // SEC-015: X-Sfp-Client required on all state-changing requests (forces CORS preflight → blocks CSRF).
  if (!req.headers.get('x-sfp-client')) return json({ error: 'Forbidden' }, 403);

  // SEC-015: cookie-only — no Bearer fallback.
  const token = jwtFromCookie(req);
  if (!token) return json({ error: 'Unauthorized' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!jwtSecret) throw new Error('JWT_SECRET must be set');

  let payload: Record<string, unknown>;
  try {
    payload = await verifyJWT(token, jwtSecret);
  } catch {
    return json({ error: 'Unauthorized' }, 401);
  }

  const email = (payload.email as string) ?? '';
  const username = ((payload.user_metadata as Record<string, unknown>)?.username as string) ?? '';

  let dbUser: Awaited<ReturnType<typeof getOrCreateUser>>;
  try { dbUser = await getOrCreateUser(supabase, email, username); }
  catch (e) { console.error('getOrCreateUser failed:', e); return json({ error: 'Internal error' }, 500); }

  // SEC-012 — reject sessions issued before the last password reset.
  if ((payload.token_version ?? 0) !== (dbUser.token_version ?? 0)) return json({ error: 'Unauthorized' }, 401);

  // Blank/missing/malformed are all treated as "unknown" (never invented).
  // Only a genuinely present, non-negative, finite number counts as an
  // entered acquisition cost — this keeps a user-typed 0 distinct from a
  // field the user never touched.
  const acquisitionCost = parseAcquisitionCost(body.acquisitionCost);

  const isScan = body.type === 'single_scan' || body.type === 'shelf_scan' || body.type === 'text_scan';
  if (isScan) {
    if (!anthropicKey) return json({ error: 'AI service not configured' }, 503);
    if (body.acquisitionCost !== null && body.acquisitionCost !== undefined && body.acquisitionCost !== '' && acquisitionCost === null) {
      return json({ error: 'Acquisition cost must be a non-negative number' }, 400);
    }
    if (body.type === 'text_scan') {
      const text = (body.hint as string) ?? (body.text as string) ?? '';
      if (!text.trim()) return json({ error: 'No item description provided' }, 400);
    } else {
      const imgs = Array.isArray(body.images) ? body.images : body.imageBase64 ? [body.imageBase64] : [];
      const imageError = validateBase64Images(imgs);
      if (imageError) return json({ error: imageError }, imageError.includes('8MB') ? 413 : 400);
    }
    // §5.1 — atomic increment + monthly reset + limit check in one RPC,
    // replacing the read-then-write race. p_limit null = unlimited.
    const limit = resolveScanLimit(dbUser.tier);
    const { error: incErr } = await supabase.rpc('increment_scan_count', {
      p_user_id: dbUser.id,
      p_limit: limit,
    });
    if (incErr) {
      if (incErr.message?.includes('scan_limit_reached')) {
        return json({ error: 'scan_limit_reached', tier: dbUser.tier, limit, used: limit }, 429);
      }
      console.error('increment_scan_count error:', incErr);
      return json({ error: 'Scan service temporarily unavailable' }, 503);
    }
  }

  try {
    if (body.type === 'single_scan') {
      if (!anthropicKey) return json({ error: 'AI service not configured' }, 503);
      const imgs = Array.isArray(body.images) ? (body.images as string[])
        : body.imageBase64 ? [body.imageBase64 as string] : [];
      if (imgs.length === 0) return json({ error: 'No image provided' }, 400);
      const mimes = Array.isArray(body.imageMimeTypes) ? (body.imageMimeTypes as string[]) : [];
      return json(await handleSingleScan(supabase, anthropicKey, dbUser.id, dbUser.settings, imgs, mimes, acquisitionCost));
    }
    if (body.type === 'shelf_scan') {
      if (!anthropicKey) return json({ error: 'AI service not configured' }, 503);
      const imgs = Array.isArray(body.images) ? (body.images as string[])
        : body.imageBase64 ? [body.imageBase64 as string] : [];
      if (imgs.length === 0) return json({ error: 'No image provided' }, 400);
      const mimes = Array.isArray(body.imageMimeTypes) ? (body.imageMimeTypes as string[]) : [];
      return json(await handleShelfScan(supabase, anthropicKey, dbUser.id, dbUser.settings, imgs, mimes));
    }
    if (body.type === 'text_scan') {
      if (!anthropicKey) return json({ error: 'AI service not configured' }, 503);
      const text = (body.hint as string) ?? (body.text as string) ?? '';
      if (!text.trim()) return json({ error: 'No item description provided' }, 400);
      return json(await handleTextScan(supabase, anthropicKey, dbUser.id, dbUser.settings, text, acquisitionCost));
    }
    if (body.type === 'detect_item') {
      if (!anthropicKey) return json({ error: 'AI service not configured' }, 503);
      const imgB64 = (body.imageBase64 as string) ?? '';
      const mime = (body.imageMimeType as string) ?? 'image/jpeg';
      if (!imgB64) return json({ error: 'No image provided' }, 400);
      return json(await handleDetectItem(anthropicKey, imgB64, mime));
    }
    if (body.type === 'buy_item')         return json(await handleBuyItem(supabase, dbUser.id, dbUser.tier, body));
    if (body.type === 'inventory_list')   return json(await handleInventoryList(supabase, dbUser.id, dbUser.settings, dbUser.tier, Number(body.pageSize ?? 500), Number(body.pageOffset ?? 0)));
    if (body.type === 'inventory_create') return json(await handleInventoryCreate(supabase, dbUser.id, dbUser.tier, body));
    if (body.type === 'inventory_update') return json(await handleInventoryUpdate(supabase, dbUser.id, body));
    if (body.type === 'inventory_delete') return json(await handleInventoryDelete(supabase, dbUser.id, body));
    if (body.type === 'inventory_status')  return json(await handleInventoryStatus(supabase, dbUser.id, body));
    if (body.type === 'listing_generate') {
      if (!anthropicKey) return json({ error: 'AI service not configured' }, 503);
      return json(await handleListingGenerate(supabase, anthropicKey, dbUser.id, dbUser.settings, body));
    }
    if (body.type === 'keywords_get') {
      return json(await handleKeywordsGet(supabase, anthropicKey, dbUser.id));
    }
    if (body.type === 'growth_report')   return json(await handleGrowthReport(supabase, anthropicKey, dbUser.id, dbUser.settings, body.forceRefresh === true));
    if (body.type === 'stats_summary')  return json(await handleStatsSummary(supabase, dbUser.id, dbUser.settings, body));
    if (body.type === 'expenses_list')  return json(await handleExpensesList(supabase, dbUser.id));
    if (body.type === 'expenses_add')   return json(await handleExpensesAdd(supabase, dbUser.id, body));
    if (body.type === 'settings_get')   return json(await handleSettingsGet(supabase, dbUser.id, dbUser.tier));
    if (body.type === 'settings_update') return json(await handleSettingsUpdate(supabase, dbUser.id, dbUser.tier, body));

    // SEC-003: no unauthenticated Anthropic pass-through — reject unknown action types
    return json({ error: 'Unknown request type' }, 400);
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ error: e.message, ...e.data }, e.httpStatus);
    }
    console.error('claude-proxy unhandled error:', e);
    return json({ error: 'Internal error' }, 500);
  }
});
}
