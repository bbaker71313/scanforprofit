// R2 (§5.4, P0-1). Provider-aware sold-comp query planning, extracted out of
// compSelection.ts — query construction is a provider concern (what shape of
// query does THIS provider's search actually match against), not a matching
// concern (does THIS candidate record describe the same product). One
// planner serves every provider (§5.1's MarketEvidenceProviderCapabilities);
// what must never happen is a second, marketplace-specific query builder —
// that duplication is exactly how compSelection.ts accumulated the
// prose-query defect this release fixes.
import type { IdentityCandidate } from "./marketData.ts"
import type { QueryCandidate } from "./compSelection.ts"
import { productFamily, extractProductType } from "./compSelection.ts"
import type { MarketEvidenceProviderCapabilities } from "./marketplaceTypes.ts"

function normalize(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}


function truncateTerms(text: string, maxTerms: number): string {
  const tokens = normalize(text).split(' ').filter(Boolean)
  return tokens.slice(0, Math.max(0, maxTerms)).join(' ')
}

// Keep every precision-defining token. Optional brand text is included only
// when it fits in full; silently truncating a model/variant and retaining an
// exact precision label would overstate the evidence match.
function exactQuery(required: string[], optionalBrand: string, maxTerms: number): string | null {
  const requiredTokens = required.filter(Boolean).join(' ').split(' ').filter(Boolean)
  if (!requiredTokens.length || requiredTokens.length > maxTerms) return null
  const brandTokens = optionalBrand.split(' ').filter(Boolean)
  return brandTokens.length + requiredTokens.length <= maxTerms
    ? [...brandTokens, ...requiredTokens].join(' ')
    : requiredTokens.join(' ')
}

function dedupe(candidates: QueryCandidate[]): QueryCandidate[] {
  const seen = new Set<string>()
  const out: QueryCandidate[] = []
  for (const candidate of candidates) {
    const key = normalize(candidate.query)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

// The `all_terms` / `relevance` ladder (§5.4's rung table). Every rung is
// truncated to maxUsefulQueryTerms and, before truncation, each rung is
// strictly shorter-or-broader than the last:
//   1. gtin (validated)                    -> exact_identifier_variant
//   2. brand + model + variant             -> exact_model_variant
//   3. brand + model                       -> exact_model
//   4. each search_keywords[i]             -> product_family
//   5. brand + modelFamilyHint + headNoun  -> product_family
//   6. brand + headNoun                    -> substitute
function planTermMatchedQueries(identity: IdentityCandidate, maxTerms: number): QueryCandidate[] {
  const brand = normalize(identity.brand)
  const model = normalize(identity.model)
  const variant = normalize(identity.variant)
  const familyHint = normalize(identity.modelFamilyHint)
  const noun = extractProductType(identity) ?? ''

  const rungs: QueryCandidate[] = []

  if (identity.gtin) {
    rungs.push({ query: identity.gtin, precision: 'exact_identifier_variant' })
  }
  if (model && variant) {
    const query = exactQuery([model, variant], brand, maxTerms)
    if (query) rungs.push({ query, precision: 'exact_model_variant' })
  }
  if (model) {
    const query = exactQuery([model], brand, maxTerms)
    if (query) rungs.push({ query, precision: 'exact_model' })
  }
  for (const keyword of identity.normalizedSearchTerms) {
    const truncated = truncateTerms(keyword, maxTerms)
    if (truncated) rungs.push({ query: truncated, precision: 'product_family' })
  }
  if (familyHint || noun) {
    rungs.push({ query: [brand, familyHint, noun].filter(Boolean).join(' '), precision: 'product_family' })
  }
  if (brand && noun) {
    rungs.push({ query: [brand, noun].join(' '), precision: 'substitute' })
  }

  // Never send an empty query: if nothing above produced a rung (e.g. no
  // brand/model/keywords survived validation at all), fall back to the raw
  // item name as a last-resort substitute rather than returning nothing.
  if (!rungs.length) {
    const name = truncateTerms(identity.itemName ?? '', maxTerms)
    if (name) rungs.push({ query: name, precision: 'substitute' })
  }

  const truncated = rungs
    .map((r) => r.precision === 'exact_identifier_variant' || r.precision === 'exact_model_variant' || r.precision === 'exact_model'
      ? r
      : { query: truncateTerms(r.query, maxTerms), precision: r.precision })
    .filter((r) => r.query.length > 0)

  return dedupe(truncated)
}

// A provider that resolves by release/part id rather than free text
// (future: Discogs by release, BrickLink by part) plans a much shorter
// ladder off the same identity — no §5.4 six-rung grammar applies, because
// there is no free-text match quality to tune.
function planIdentifierOnlyQueries(identity: IdentityCandidate): QueryCandidate[] {
  const rungs: QueryCandidate[] = []
  if (identity.gtin) rungs.push({ query: identity.gtin, precision: 'exact_identifier_variant' })
  const brand = normalize(identity.brand)
  const model = normalize(identity.model)
  if (model) rungs.push({ query: [brand, model].filter(Boolean).join(' '), precision: 'exact_model' })
  return dedupe(rungs)
}

/**
 * Plans the query cascade for a market-evidence provider, respecting its
 * capabilities (§5.1) instead of assuming a relevance-ranked search engine.
 * Never returns an empty array when the identity has any usable signal at
 * all (see the item-name fallback above) — an empty result means there was
 * truly nothing to search on.
 */
export function planMarketEvidenceQueries(
  identity: IdentityCandidate,
  caps: MarketEvidenceProviderCapabilities,
): QueryCandidate[] {
  if (caps.queryMatching === 'identifier_only') return planIdentifierOnlyQueries(identity)
  return planTermMatchedQueries(identity, caps.maxUsefulQueryTerms)
}
