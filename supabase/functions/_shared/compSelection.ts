// R3 (docs/files/DECISIONS.md "R3 tightenings T1–T3..."): scored/banded
// comparable matching, replacing the old hard-exclude filter. The old filter
// rejected a comp for lacking a majority of family tokens — P0-2, which
// discarded 34 of 34 real comps for the GE-radio regression. T1 fixes the
// root cause structurally: a token that is merely ABSENT from a comp title
// scores zero, it never rejects. Only a genuine CONTRADICTION (a different
// brand/model actually present, or a contamination marker) short-circuits to
// a hard reject. See selectComparableSoldComps below for the full pipeline:
// normalize -> hard-reject -> score -> band.
import type { IdentityCandidate, SoldCompListing } from "./marketData.ts"
import { parseConditionToken } from "./identityNormalization.ts"

export interface QueryCandidate {
  query: string
  // R2 (§5.4): 'exact_identifier_variant' added for queryPlanner.ts's GTIN
  // rung (rung 1) — a validated barcode match is the strongest identity
  // signal available, matching CompMatchPrecision's existing top tier.
  precision: 'exact_identifier_variant' | 'exact_model_variant' | 'exact_model' | 'product_family' | 'substitute'
}

export interface ExcludedComp {
  itemId: string
  title: string
  soldPrice: number
  reason: string
}

export interface CompSelectionResult {
  retained: SoldCompListing[]
  excluded: ExcludedComp[]
}

// R3 (§6.1): the scored-match result for one comp against one identity.
export interface CompMatchScore {
  score: number                        // 0-100 (uncapped additive score, clamped for display)
  band: 'exact' | 'usable' | 'reject'
  signals: string[]                    // audit: what scored, e.g. "model +40"
  rejection: string | null             // set iff hard-rejected (band === 'reject' from a hard rule)
}

const CONTAMINATION_MARKERS = [
  'for parts', 'parts only', 'not working', 'repair only', 'as is',
  'manual only', 'box only', 'empty box', 'case only', 'replacement only',
  'charger only', 'adapter only', 'remote only', 'cover only', 'stand only',
  'lot of', 'bundle of', 'wholesale lot',
]

// R3: strips hyphens/apostrophes (joins, doesn't space) BEFORE the general
// punctuation->space pass, so "X-700" and "X700" normalize to the identical
// token "x700", and "1960'S"/"1960s" both normalize to "1960s" — neither
// matched before this fix (normalize() used to turn "X-700" into "x 700",
// two tokens, and "1960'S" into "1960 s").
function normalize(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/['-]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokens(value: string | null | undefined): string[] {
  return normalize(value).split(' ').filter(Boolean)
}

// Word-aware containment — checks the TOKEN ARRAY, never a raw substring, so
// "all" never matches inside "wall" (both single-token phrase and title are
// split before comparing). A multi-word phrase (e.g. brand "general
// electric") requires every one of its words present in the title's token
// set, not necessarily adjacent — matches the pre-R3 family-token behavior,
// now applied consistently to model/brand too.
function titleContainsPhrase(titleTokens: string[], phrase: string): boolean {
  const phraseTokens = tokens(phrase)
  if (!phraseTokens.length) return false
  return phraseTokens.every((t) => titleTokens.includes(t))
}

// Exported for reuse by queryPlanner.ts (R2 §5.4) and extractProductType()
// below — the normalized remaining family tokens after brand/model/filler
// removal. Not the authoritative product-type noun; use extractProductType()
// for that.
export function productFamily(identity: IdentityCandidate): string {
  const removals = [identity.brand, identity.model, identity.variant]
    .map(normalize).filter(Boolean)
  return normalize(identity.itemName)
    .split(' ')
    .filter(token => !removals.some(value => value.split(' ').includes(token)))
    .filter(token => !['model', 'series', 'vintage', 'rare', 'tested', 'working'].includes(token))
    .join(' ')
}

// Trailing tokens in AI-generated item names that describe form factor, color,
// size, or placement — they routinely appear AFTER the true product noun.
// "General Electric All Transistor AM Radio Vintage 1960s Table Top" is the
// production failure case: "table" and "top" trail "radio", the real noun.
const TRAILING_DESCRIPTOR_TOKENS = new Set([
  // form factor / placement
  'table', 'top', 'tabletop', 'desktop', 'portable', 'handheld', 'floor',
  'wall', 'ceiling', 'countertop', 'pocket', 'tower',
  // size / style
  'large', 'small', 'big', 'mini', 'micro', 'compact', 'standard',
  'classic', 'style', 'type',
  // color
  'black', 'white', 'silver', 'gold', 'red', 'blue', 'green', 'brown',
  'grey', 'gray', 'chrome', 'tan', 'beige',
  // era / edition
  'edition', 'version',
])

// Four-digit year or decade token: "1960s", "2000s", "1965" — appears as a
// trailing era descriptor after the product noun ("Radio Vintage 1960s Table Top").
function isYearToken(t: string): boolean {
  return /^\d{4}s?$/.test(t)
}

/**
 * Extracts the authoritative product-type noun from the item identity by
 * scanning productFamily() tokens right-to-left and skipping trailing
 * form-factor, color, size, and era tokens. Returns null when all tokens are
 * descriptors — callers fall back to the broader family/query path rather
 * than inventing a noun.
 *
 * One authoritative implementation used by both scoreComp() and
 * queryPlanner.ts (CLAUDE.md Anti-Drift Contract rule 11).
 */
export function extractProductType(identity: IdentityCandidate): string | null {
  const familyTokens = productFamily(identity).split(' ').filter((t) => t.length >= 3)
  if (!familyTokens.length) return null

  let end = familyTokens.length - 1
  while (end >= 0) {
    const t = familyTokens[end]
    if (!TRAILING_DESCRIPTOR_TOKENS.has(t) && !isYearToken(t)) break
    end--
  }

  if (end < 0) return null
  const candidate = familyTokens[end]
  if (TRAILING_DESCRIPTOR_TOKENS.has(candidate) || isYearToken(candidate)) return null
  return candidate
}

function scannedItemIsContaminationType(identity: IdentityCandidate, marker: string): boolean {
  const identityText = normalize([identity.itemName, identity.conditionHints].filter(Boolean).join(' '))
  return identityText.includes(normalize(marker))
}

// A token "shaped like" a model number: contains a digit, mostly
// alphanumeric. Used only to find a CONFLICTING model candidate inside a
// title — never to reject on absence (T1).
const MODEL_SHAPED = /^[a-z]*\d+[a-z0-9]*$/

// Same length AND same letter/digit skeleton as our model, but a different
// value — "x700" vs "x900" (LDDD/LDDD), "sm57" vs "sm58" (LLDD/LLDD), and
// (hyphens already stripped by normalize) "72880" vs "72885" (DDDDD/DDDDD).
// Deliberately conservative — same length is required — so it targets "same
// product line, different number," the realistic false-positive case,
// rather than any unrelated alphanumeric token in a broad-precision title.
function conflictsInShape(a: string, b: string): boolean {
  if (a === b || a.length !== b.length) return false
  const skeleton = (s: string) => s.replace(/[a-z]/g, 'L').replace(/[0-9]/g, 'D')
  return skeleton(a) === skeleton(b)
}

// T1: "a token that is merely missing scores zero, it never rejects." A
// hard reject requires an actual CONTRADICTION — our validated model is
// absent from the title AND a different, same-shaped model token IS present.
function conflictingModel(identity: IdentityCandidate, titleTokens: string[]): boolean {
  const model = normalize(identity.model)
  if (!model) return false
  if (titleContainsPhrase(titleTokens, model)) return false // present -> not a conflict
  return titleTokens.some((t) => MODEL_SHAPED.test(t) && t.length >= 3 && conflictsInShape(t, model))
}

// Words that legitimately lead a resale listing title without being a brand
// name — excluded so the leading-capitalized-word heuristic below doesn't
// misfire on "Vintage Widget..." or "New In Box...".
const GENERIC_LEADING_WORDS = new Set([
  'vintage', 'new', 'used', 'rare', 'antique', 'lot', 'set', 'nice',
  'genuine', 'authentic', 'original', 'the', 'a', 'an', 'for', 'with',
])

// T1's hard-conflict counterpart for brand. No general brand database is
// available, so this is a deliberately narrow heuristic: our brand is
// nowhere in the title AND the title's own leading word looks like a real
// brand token (capitalized in the raw title, not a generic lead-in word,
// long enough to plausibly be a name) — resale listing titles conventionally
// lead with the brand. This under-rejects (a genuinely different brand
// buried mid-title with no distinguishing leading word survives, which is
// the T1-safe direction to err in) rather than over-rejecting on absence.
function conflictingBrand(identity: IdentityCandidate, rawTitle: string, titleTokens: string[]): boolean {
  const brand = normalize(identity.brand)
  if (!brand) return false
  if (titleContainsPhrase(titleTokens, brand)) return false
  const leadingWordMatch = rawTitle.trim().match(/^[A-Z][a-zA-Z0-9]*/)
  if (!leadingWordMatch) return false
  const leading = leadingWordMatch[0]
  const leadingNorm = normalize(leading)
  if (!leadingNorm || leadingNorm.length < 3) return false
  if (GENERIC_LEADING_WORDS.has(leadingNorm)) return false
  // A shared prefix means this is very likely the SAME brand, spelled out
  // or abbreviated differently ("General Electric" vs "GE" — "general"
  // starts with "ge"), not a genuinely different one. Without a real brand
  // database this is the only cheap, reliable way to avoid rebuilding T1's
  // exact defect on brand instead of model: a false "conflict" from a mere
  // spelling difference would hard-reject a real match.
  if (leadingNorm.startsWith(brand) || brand.startsWith(leadingNorm)) return false
  return true
}

// R3 (DECISIONS.md binary condition): a conflict is ONLY ever scored (never
// a hard reject) and only ever derived from a PARSED binary condition on
// both sides — never free prose. "knobs appear new" in condition notes does
// not parse to NEW (parseConditionToken requires the NEW pattern to match
// the whole supplied text, not a fragment describing one part), so it can
// never manufacture a false conflict.
function conditionConflict(identity: IdentityCandidate, comp: SoldCompListing): boolean {
  const wanted = parseConditionToken(identity.conditionHints)
  const actual = parseConditionToken(comp.condition)
  if (!wanted || !actual) return false // missing on either side -> neutral, T1
  return wanted !== actual
}

const EXACT_BAND_MIN = 80
const USABLE_BAND_MIN = 60

/**
 * R3 (§6.1): scores one comp against the scanned item's identity. Hard
 * rejects (score 0, band 'reject') ONLY for a contamination marker (unless
 * the scanned item is itself that type) or an actual contradictory
 * brand/model. Everything else is additive scoring — a missing signal
 * simply doesn't contribute points, it never rejects (T1).
 */
export function scoreComp(
  comp: SoldCompListing,
  identity: IdentityCandidate,
  candidate: QueryCandidate,
): CompMatchScore {
  const titleTokens = tokens(comp.title)

  const contaminationMarker = CONTAMINATION_MARKERS.find((marker) =>
    normalize(comp.title).includes(normalize(marker)) && !scannedItemIsContaminationType(identity, marker)
  )
  if (contaminationMarker) {
    return { score: 0, band: 'reject', signals: [], rejection: `contamination marker: ${contaminationMarker}` }
  }
  if (conflictingModel(identity, titleTokens)) {
    return { score: 0, band: 'reject', signals: [], rejection: 'conflicting model' }
  }
  if (conflictingBrand(identity, comp.title, titleTokens)) {
    return { score: 0, band: 'reject', signals: [], rejection: 'conflicting brand' }
  }

  const signals: string[] = []
  let score = 0

  // GTIN: comps don't carry a structured GTIN field, so a validated GTIN
  // query rung (every result already resolved through an identifier lookup)
  // stands in for a per-comp exact match.
  if (candidate.precision === 'exact_identifier_variant' && identity.gtin) {
    score += 45; signals.push('gtin +45')
  }
  const model = normalize(identity.model)
  if (model && titleContainsPhrase(titleTokens, model)) {
    score += 40; signals.push('model +40')
  }
  const brand = normalize(identity.brand)
  if (brand && titleContainsPhrase(titleTokens, brand)) {
    score += 25; signals.push('brand +25')
  }
  const familyTokens = productFamily(identity).split(' ').filter((t) => t.length >= 3)
  const headNoun = extractProductType(identity)
  if (headNoun && titleTokens.includes(headNoun)) {
    score += 15; signals.push('head noun +15')
  }
  const otherFamilyTokens = familyTokens.filter((t) => t !== headNoun)
  const additionalMatches = otherFamilyTokens.filter((t) => titleTokens.includes(t)).length
  if (additionalMatches > 0) {
    const points = Math.min(20, additionalMatches * 10)
    score += points; signals.push(`descriptive tokens +${points}`)
  }
  if (conditionConflict(identity, comp)) {
    score -= 15; signals.push('condition conflict -15')
  }

  score = Math.max(0, score)
  const band: CompMatchScore['band'] = score >= EXACT_BAND_MIN ? 'exact' : score >= USABLE_BAND_MIN ? 'usable' : 'reject'
  return { score, band, signals, rejection: band === 'reject' ? 'score below usable threshold' : null }
}

export function selectComparableSoldComps(
  comps: SoldCompListing[],
  identity: IdentityCandidate,
  candidate: QueryCandidate,
): CompSelectionResult {
  const retained: SoldCompListing[] = []
  const excluded: ExcludedComp[] = []

  for (const comp of comps) {
    const result = scoreComp(comp, identity, candidate)
    if (result.band === 'reject') {
      excluded.push({ itemId: comp.itemId, title: comp.title, soldPrice: comp.soldPrice, reason: result.rejection ?? 'reject' })
    } else {
      retained.push(comp)
    }
  }
  return { retained, excluded }
}

// Generic p20/p80 spread coherence check — used for sold-comp prices
// (isCoherentPriceSet below) and, by marketDataPipeline.ts, for active-market
// asking-price evidence (Profit Scanner v2 evidence-quality assessment).
// Prices don't need to be sorted on input.
export function isCoherentPriceSpread(prices: number[]): boolean {
  if (prices.length < 3) return false
  const sorted = [...prices].sort((a, b) => a - b)
  const p20 = sorted[Math.floor((sorted.length - 1) * 0.20)]
  const p80 = sorted[Math.floor((sorted.length - 1) * 0.80)]
  return Number.isFinite(p20) && Number.isFinite(p80) && p20 > 0 && p80 / p20 <= 6
}

export function isCoherentPriceSet(comps: SoldCompListing[]): boolean {
  return isCoherentPriceSpread(comps.map(comp => comp.soldPrice))
}

// R3 (§6.3): Median Absolute Deviation outlier rejection for a retained sold-
// comp set. Specified here, not delegated to tests, per the repo's own rule
// (tests verify approved behavior, they don't define it) — this is the price
// basis behind every profit/ROI/max-buy number downstream.
//   - drop comps beyond 3*MAD from the median
//   - drop at most 20% of the retained set
//   - require >=3 survivors, else the whole set fails (no rescue)
//   - every dropped comp and its reason is returned, never silently dropped
export interface OutlierRejectionResult {
  survivors: SoldCompListing[]
  dropped: ExcludedComp[]
  failed: boolean // true when survivors < 3 after dropping — caller must not use `survivors`
}

export function rejectOutliers(comps: SoldCompListing[]): OutlierRejectionResult {
  if (comps.length < 3) return { survivors: comps, dropped: [], failed: comps.length === 0 }

  const prices = comps.map((c) => c.soldPrice).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid]
  const deviations = prices.map((p) => Math.abs(p - median)).sort((a, b) => a - b)
  const dMid = Math.floor(deviations.length / 2)
  const mad = deviations.length % 2 === 0 ? (deviations[dMid - 1] + deviations[dMid]) / 2 : deviations[dMid]

  const maxDrops = Math.floor(comps.length * 0.20)
  if (mad === 0) return { survivors: comps, dropped: [], failed: false } // no spread to measure outliers against

  const withDeviation = comps.map((c) => ({ comp: c, deviation: Math.abs(c.soldPrice - median) / mad }))
  const outliers = withDeviation.filter((x) => x.deviation > 3).sort((a, b) => b.deviation - a.deviation)
  const toDrop = outliers.slice(0, maxDrops)
  const dropIds = new Set(toDrop.map((x) => x.comp.itemId))

  const survivors = comps.filter((c) => !dropIds.has(c.itemId))
  const dropped: ExcludedComp[] = toDrop.map((x) => ({
    itemId: x.comp.itemId, title: x.comp.title, soldPrice: x.comp.soldPrice,
    reason: `price outlier: ${x.deviation.toFixed(1)}x MAD from median`,
  }))

  if (survivors.length < 3) return { survivors, dropped, failed: true }
  if (!isCoherentPriceSpread(survivors.map((c) => c.soldPrice))) return { survivors, dropped, failed: true }
  return { survivors, dropped, failed: false }
}
