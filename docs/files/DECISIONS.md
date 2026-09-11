# ScanForProfit — Decision Log

Key product, technical, and business decisions with reasoning.
This file exists so future sessions don't relitigate settled decisions.
Add decisions here when something is locked. Reference `docs/DOC_HIERARCHY.md` for which doc wins when sources disagree. Reference `CLAUDE.md` for implementation rules.

---

## Product Decisions

### Scan decision labels: HOT / LIST / SKIP
**Decision:** In-app scan outcomes are **HOT**, **LIST**, and **SKIP** — not FLIP, not PASS.
**Why:** FLIP was retired in the 2026 rebrand. The live app (`app.html`) implements three tiers: HOT (high-demand buy-now), LIST (worth listing), SKIP (pass on it). Shelf scan sorts HOT → LIST → SKIP.
**Marketing shorthand:** "LIST or SKIP" is acceptable in landing copy as plain English for the binary sourcing question, but PASS always maps to SKIP in product UI and docs. Never use FLIP in new user-facing copy.
**Do not revert** to FLIP/PASS without explicit product approval.

### No app access codes — email registration only
**Decision:** There are no early-access codes, invite codes, or gatekeeper passwords for the app.
**How users get in:** Go to `scanforprofit.com/app.html` → Sign Up → verify email → log in with password. Session is a JWT stored client-side.
**Waitlist vs app access:** The landing page "Get early access" CTA captures waitlist emails — that is **not** an app unlock code. Do not document or build access-code flows.
**Legacy:** Pre-JWT access codes are rejected at session restore. The stale "Access code required" toast was fixed in `app.html` (P2-21, 2026-08-27) — it now shows "Please log in first."

### Live product is the web app (app.html), not the RN scaffold
**Decision:** The shipped product is `apps/web/public/app.html` at `/app.html`. The Expo mobile app in `apps/mobile/` is a future rebuild reference — not live, not authoritative for feature status.
**Why:** Phase 04 RN output was scrapped (2026-06-17). All feature truth audits start from `app.html` + Supabase edge functions.
**Do not mark mobile features as "complete"** in docs unless the mobile app is actually shipped.

### 5 tabs — IDs fixed, display names evolved
**Decision:** 5 tabs only. Never add a 6th without explicit justification and Britt's approval.
**Tab IDs (code):** `sourcing` · `inventory` · `photo` · `growth` · `dashboard`
**Display names (live app, 2026-06-24):** Profit Scanner · Inventory · Photos · Profit Compass · Profit Hub
**Why:** Matches the reseller workflow: scan → track → photos/listings → market pulse → P&L hub. Display names may evolve; tab IDs must not change without a migration plan.
**Do not relitigate** the 5-tab structure. Update copy to match live labels when docs disagree.

### eBay fee is configurable, never hardcoded
**Decision:** eBay fee percentage is always from user settings (`ebayFee`). Default 13%. Never hardcode.
**Why:** eBay's fee structure varies by seller level, category, and store subscription. Hardcoding breaks trust in profit calculations — which are the core value of the app.

### No fake metrics or testimonials in any copy
**Decision:** All metrics and testimonials that appeared on the landing page were written speculatively. Must not be used publicly.
**Why:** Fabricated social proof is a legal liability and a trust killer the moment a real user fact-checks it.
**What to do:** Only use verified claims. Leave placeholder slots for real testimonials once users provide them.

### Freemium model with usage-based gates
**Decision:** Scout (free, limited), Hustle ($19/mo), Stack ($49/mo), Empire ($199/mo).
**Why:** The value metric is clear — scans per month. Free users who hit the limit have already experienced the value and have a concrete reason to upgrade. Tier names use reseller language, not generic SaaS language.
**Status:** Model locked. Pricing to be validated with real users (research file not yet created).

### Compete on shelf scan + integrated workflow, not scan speed
**Decision:** ScanForProfit's primary differentiators are shelf scan (one photo ranks everything visible) and the integrated workflow (sourcing → inventory → listing → P&L). Not raw speed or barcode support.
**Why:** Underpriced.ai does single-item scanning. ThriftMagic does book shelves (slow, unreliable). No competitor does mixed-category shelf scan + full integrated workflow. That is the defensible position.

### P0 market-data rules: sell-through rate, demand thresholds, Best Offer handling
**Decision (approved 2026-08-26):**
- **Sell-through rate:** `STR = soldCount90d / (soldCount90d + activeCount) * 100`, where `soldCount90d` is verified matching sold listings from SoldComps (90-day window) and `activeCount` is verified matching active listings from eBay Browse. `null` (never a fabricated 0%) when both counts are zero, or when active-listing evidence is unavailable.
- **Demand level:** derived from verified STR + verified market-turnover days, evaluated highest tier down — VERY HIGH (STR≥70% & turnover≤30d), HIGH (STR≥50% & turnover≤45d), MEDIUM (STR≥30% & turnover≤90d), LOW (below those). Missing STR or turnover → `null` (unavailable), never LOW. HOT still requires demand = VERY HIGH plus all other thresholds.
- **Best Offer handling:** `bestOfferAccepted` comps are excluded from the primary median/average sold-price calculation (the displayed price on such a listing is not the confidential accepted amount) but are preserved in evidence via `excludedBestOfferCount` and still count toward sales-velocity (STR/turnover) numerators.
- **Market turnover (previously approved):** `marketTurnoverDays = activeInventory / averageVerifiedSalesPerDay`, `averageVerifiedSalesPerDay = verifiedSoldCount / soldWindowDays`.
**Why:** These were the last undefined pieces of the P0 market-data-authority remediation (replacing AI-generated market facts with verified SoldComps/eBay Browse evidence). AI never computes these — see `packages/shared/src/utils/marketMetrics.ts` (`computeSellThroughRate`, `computeDemandLevel`) and its Deno mirror.
**Do not** reintroduce an AI-confidence-based STR/demand estimate, a `sourcingStyle` modifier on these thresholds, or a Best-Offer down-weighting scheme without new explicit approval.

### AI market estimate must never enter the authoritative decision engine (Chapter 02 follow-up, approved/fixed 2026-08-27)
**Decision:** A scan's HOT/LIST/SKIP decision, net profit, ROI, and max-buy-price may be computed ONLY when verified marketplace evidence (SoldComps sold comps + eBay Browse active listings) is available (`marketDataSource: 'verified'`). When verification fails, the scan result is `decisionAvailable: false` / `decisionStatus: 'insufficient_market_data'` — every authoritative field is `null`, never computed from Claude's own price/STR/days/demand estimate. The AI's estimate may still be shown, but only in a separate `aiEstimate` field, clearly labeled informational-only, structurally never passed into `calcProfit`/`decide`/`calcMaxBuyPrice`.
**Why:** The live implementation previously fell back to feeding the AI's own (non-null) market values into the same deterministic `decide()` engine used for verified evidence. Because those AI values are never `null`, they passed `decide()`'s null-means-missing-evidence checks and could produce a fully authoritative-looking recommendation from an unverified guess — violating Anti-Drift Contract rule 7 ("AI is not market or financial authority"). Fixed in `resolveScanResultCore()`, the single gate now shared by single/text and shelf scan (`supabase/functions/claude-proxy/index.ts`).
**Do not** revert to feeding an AI market estimate into `evaluateScanEconomics`/`decide`/`calcMaxBuyPrice` when verification fails, and do not silently convert "insufficient evidence" into a SKIP, a zero, or a fabricated verified-looking value.

### Profit-scanner evidence qualification and safe fallback (approved 2026-08-28)
**Decision:** Scanner market evidence follows an exact-to-broad query cascade and qualifies only after identity-aware comp filtering. At least 3 coherent matching price comps are required for a limited result, 5 for normal/moderate evidence, and 8 for strong evidence. A retained sample fails qualification when `p80 / p20 > 6`. Expected sale price remains the cleaned median; the displayed conservative/optimistic range uses cleaned 35th/70th percentiles, never raw minimum/maximum. Sold and active evidence must describe the same item population; zero or contaminated active evidence cannot become 0-day turnover or 100% STR.
**Fallback:** When evidence does not qualify, preserve item identification and provide an eBay completed-listings search. Do not request, return, or display AI-created price, range, STR, demand, or days-to-sell values.
**ROI presentation:** Deterministic ROI remains unchanged for decisioning. Display ROI is suppressed for free and positive acquisition costs below $1; cash profit remains visible. `$0` continues to produce `roi: null` and bypasses the ROI threshold under the existing approved rule.
**Why:** Deterministic math is not trustworthy when its comp population is unrelated, incoherent, or too small. These gates address the observed false insufficient-evidence results, `$0.99–$99` ranges, `0 days`, and misleading giant low-cost ROI display without changing seller economics or HOT/LIST/SKIP formulas.
**Do not** restore single-query lookup, raw min/max ranges, one-comp recommendations, zero-active instant-turnover claims, or AI numerical market fallback.

### SoldComps API secret name
**Decision (confirmed 2026-08-26):** The Supabase secret is `SOLD_COMPS_API_KEY` (exact name). No fallback aliases.
**Why:** Two candidate names were floated before the exact one was confirmed; `supabase/functions/_shared/soldCompsProvider.ts` now reads this single name only.

### Profit Scanner v2 — cross-market resale opportunity architecture (approved 2026-08-29)
**Decision:** The Profit Scanner's authoritative HOT/LIST/SKIP decision no longer depends on sell-through rate, days-to-sell, or demand level. The decision engine (`decisionEngine.ts`) is now `netProfit` + `roi` + a marketplace-independent `evidenceQuality` tier only: **HOT** = profit and ROI both pass AND evidence is **STRONG** (3+ coherent, exact-identity-matched verified sold comps, or equivalent); **LIST** = profit and ROI both pass AND evidence is **MODERATE** (broader-precision sold comps, 1-2 verified comps with supporting active-market evidence, or strong active-market evidence alone); **SKIP** = profit or ROI fails with strong/moderate evidence. **LIMITED EVIDENCE** (`decisionAvailable:false`) is a distinct evidence state, not a sourcing decision, for weak/no evidence — no fabricated HOT/LIST/SKIP, profit, ROI, or max-buy price. The scanner is a cross-market resale opportunity engine: a `MarketplaceRouter` (`marketplaceRouter.ts`) routes each identified item to relevant marketplaces by category (eBay always; Etsy/Reverb/Discogs/Poshmark/Mercari/Amazon/Facebook-local by fit), a `MarketplaceOpportunityEngine` (`marketplaceOpportunity.ts`) computes marketplace-specific economics (`marketplaceEconomics.ts` — approximate flat fee-percentage profiles per marketplace, eBay still using the user's own configured `ebayFee`) and selects the best overall opportunity (qualifying beats non-qualifying; stronger evidence beats weaker within the qualifying pool; net profit breaks ties) — never simply the highest asking price. eBay is the only marketplace with a real, live-verified evidence provider (`marketDataPipeline.ts` — Trawl/SoldComps sold evidence + eBay Browse active evidence); Etsy/Reverb/Discogs/Amazon/Mercari/Poshmark are explicit `NOT_CONFIGURED` provider-boundary placeholders (`marketplaceProviders.ts`) — no official API credentials are configured in this environment, so they are never scraped or fabricated. Facebook/local has no evidence provider of its own; it borrows a defensible valuation from the best other marketplace opportunity and applies its own $0-fee/no-shipping local-sale economics.
**Why:** The product owner supplied a detailed implementation spec (`SFP_PROFIT_SCANNER_V2_IMPLEMENTATION_PROMPT.md`) explicitly redesigning the Profit Scanner around this architecture, superseding the STR/demand-gating design below. eBay-sold/active-listing sell-through rate and demand level are eBay-specific signals that don't generalize across marketplaces and made the scanner structurally an "eBay sell-through scanner" rather than a cross-market sourcing tool.
**Supersedes (for the scanner's decision authority specifically):** the "P0 market-data rules: sell-through rate, demand thresholds, Best Offer handling" decision below (STR/demand are no longer decision gates — the STR/demand *formulas* themselves, and the Best-Offer sold-price-exclusion rule, are unchanged and still used for the informational-only `sellThroughRate`/`demandLevel` fields kept for Inventory's `SourcingMeta`/Listing Generator) and the "Decision Integrity remediation (Release A)" `hotCappedByEvidence` comp-count-cap mechanism recorded in the "Profit-scanner evidence qualification and safe fallback" decision below (replaced by the LIMITED EVIDENCE state — weak/none evidence never reaches a decision at all, rather than being capped to LIST). The evidence-qualification cascade (exact-to-broad query, contamination/condition filtering, p20/p80 coherence guard, comp-count minimums) is preserved and reused, feeding the new marketplace-independent evidence-quality assessment (`evidenceQuality.ts`) instead of the old comp-count-only bucketing.
**Do not** reintroduce sell-through-rate/days-to-sell/demand-level as a scanner decision gate, or the `hotCappedByEvidence` cap-to-LIST mechanism, without new explicit product-owner approval. Do not build a real Etsy/Reverb/Discogs/Amazon/Mercari/Poshmark evidence integration without official, supported API access — the provider boundary exists in `marketplaceProviders.ts` for exactly this future work.

### Evidence ladder: HOT/LIST/SKIP is the terminal outcome for every reasonably identifiable item — supersedes the LIMITED EVIDENCE terminal state (approved 2026-08-31)
**Decision:** For every **reasonably identifiable** scanned item, the Profit Scanner's normal terminal outcome set is **HOT / LIST / SKIP** — there is no fourth "no decision" market-evidence outcome. Evidence quality controls decision **confidence and the allowed decision strength** (specifically, whether HOT is reachable at all — see the evidence-class ceiling below), not whether a decision is produced. The evidence pipeline moves down an explicit evidence ladder instead of terminating because the strongest tier was unavailable or one provider/marketplace/evidence class came back empty:
1. verified completed-sale / transaction evidence;
2. specialist transaction-derived price guides;
3. relevant active-market evidence;
4. cross-market evidence from another defensible marketplace;
5. other conservative, explicitly labeled market-derived fallback evidence approved by product.

Weaker evidence must bias the result toward a more conservative **LIST/SKIP** and a lower-confidence presentation. Weak evidence must never be presented as, or silently promoted to, strong/verified transaction evidence, and it must never be used to reach a fabricated HOT. **HOT remains harder to earn than LIST/SKIP** — this decision is not license to weaken HOT's evidence bar to eliminate no-result cases; HOT still requires the strongest evidence standard (only `verified_transaction`-class evidence at exact-identity match may reach HOT, per the implementation plan's evidence-class ceiling). AI may identify, generate search candidates, and reason about evidence; it may never independently establish an authoritative sold price, market fact, fee, or profit input — `calcProfit.ts`, `decisionEngine.ts`, and `maxBuyPrice.ts` remain the sole deterministic decision authority, unchanged.

An **identification failure** — the item itself could not be reasonably identified from the photo — is a distinct, separate outcome from a market-evidence gap, and is the only case that may still decline to produce HOT/LIST/SKIP.

A provider outage, authentication failure, quota exhaustion, throttling, or other infrastructure failure is a **system failure**, not an economic result. It must be recorded and surfaced as an operational diagnostic (the `ScanUnavailableReason` classification R1 added: `PROVIDER_THROTTLED`, `PROVIDER_QUOTA_EXHAUSTED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_NOT_CONFIGURED`, `MARKETPLACE_AUTH_FAILED`, etc.), and must never be silently rewritten into a SKIP or presented as a market-evidence result.

**Why:** The product owner corrected the scanner's intended behavior: a user who scans a reasonably identifiable item is owed an actionable HOT/LIST/SKIP result built on the strongest defensible evidence available, not a dead end. The prior "weak/no evidence → `LIMITED EVIDENCE` / `decisionAvailable:false` / no decision" rule was a reasonable stop-gap while the pipeline was actively fabricating or discarding evidence (2026-08-28/29 remediation), but as a permanent product rule it conflicts with the scanner's actual purpose and was never intended to be the normal outcome of a correctly working pipeline.

**Supersedes:** the "Profit Scanner v2" decision above (2026-08-29), specifically its sentence *"LIMITED EVIDENCE (`decisionAvailable:false`) is a distinct evidence state, not a sourcing decision, for weak/no evidence — no fabricated HOT/LIST/SKIP, profit, ROI, or max-buy price."* That mechanism is replaced by the evidence ladder above. Everything else in the Profit Scanner v2 decision is unchanged: the HOT/LIST/SKIP profit+ROI formula gated by evidence tier, the marketplace-router/opportunity-engine architecture, the `NOT_CONFIGURED` provider-boundary placeholders, and the ban on scraping unsupported marketplaces all still stand. Also supersedes any reading of `docs/CURRENT_STATE.md`'s "weak/no evidence surfaces as `LIMITED EVIDENCE`" line as describing *approved* behavior going forward — as of this decision it describes only the current, not-yet-updated code path (see `docs/files/PROFIT_SCANNER_IMPLEMENTATION_PLAN_2026-08-30.md` Revision 3, R2/R3, for the implementation path that will change it).

**Do not** relitigate this in a future session, revert to a terminal "no decision" market-evidence state for a reasonably identifiable item, or weaken HOT's evidence requirement in order to make this rule easier to satisfy — both are explicitly barred as ways of "solving" the no-result problem. Source instruction: `docs/files/SFP_PROFIT_SCANNER_PLAN_CORRECTION_PROMPT_20260831.md`.

### R3 tightenings T1–T3 and the L/M open items — all approved (2026-08-31)
**Decision:** `SFP_R3_REMEDIATION_PLAN_UPDATE_20260831.md` (product owner) resolves every item the implementation plan's §13 flagged as blocking R3. All five are now **approved, not open**:

- **T1 — absence is not conflict.** A missing brand/model/variant token scores neutral in comp matching; it never rejects a comp. Only an actual **contradictory** brand/model/variant, or obvious contamination (parts/repair/box-only/lot listings, unless the scanned item is itself that type), hard-rejects a comp. The old majority-token filter that discarded a comp for merely lacking words is barred permanently.
- **T2 — the retained matched sample count is authoritative for evidence quality, not the provider's raw total.** A provider's unfiltered result count (`data.total` or equivalent) is informational competition-volume only and must never be treated as if every result were a valid comparable, and must never itself upgrade evidence quality. `ActiveMarketEvidence` carries `totalActiveResultCount` (informational) separately from `sampledCount`/`retainedCount` (the only counts evidence quality may read).
- **T3 — the `facebook_local` Best-Market threshold is a number.** Local may outrank the marketplace that supplied its borrowed valuation only when the item is genuinely local-suitable (already gated by `marketplaceRouter.ts`'s category rules) **and** local net profit is both **≥25% higher** and **≥$10 higher in absolute dollars** than the donor marketplace's. Local must never auto-win merely from its lower fee profile or zero shipping cost.
- **L — zero market evidence still resolves to a decision.** For every reasonably identifiable item (see M below), market-evidence weakness alone must not terminate the scan in `LIMITED EVIDENCE` / `decisionAvailable:false` / "not enough evidence." If the item is reasonably identified, providers executed successfully, and the full evidence ladder is genuinely exhausted with nothing defensible found, the scanner resolves conservatively to **SKIP — low confidence / no observed market support**, never a fabricated sale price. This is a **new, third decision-availability state** distinct from both a normal profit/ROI-gated SKIP and the identification-failure/system-failure `decisionAvailable:false` state: `decisionAvailable:true`, `decision:'SKIP'`, `decisionStatus:'ok_no_evidence'`, every financial field (`estimatedProfit`, `roi`, `feeAmount`, `maxBuyPrice`, `bestMarketplace`) stays `null` — nothing is backed into existence to produce this SKIP. A provider outage, auth failure, quota exhaustion, throttle, or config gap remains a **system failure** (`decisionAvailable:false` with the matching `ScanUnavailableReason`) and must never be silently folded into this SKIP — that distinction is load-bearing and enforced in `resolveScanResultCore` (`claude-proxy/index.ts`) by checking whether the market-data pipeline actually completed (`NO_MARKET_EVIDENCE`/`EVIDENCE_TOO_WEAK`) versus failed operationally.
- **M — "reasonably identifiable," operationalized.** An item is reasonably identifiable when it has at least one of: a validated UPC/ISBN/GTIN; a validated brand **and** model; an exact/near-exact product title resolved via SerpAPI visual product search (see below); or product type + brand/creator + enough distinguishing attributes to separate it from a materially different product. A bare generic noun ("radio," "shirt," "camera," "book") with nothing else does not qualify — that item still resolves to `IDENTIFICATION_UNRESOLVED` (`decisionAvailable:false`), the one exception L does not touch. Implemented as `isReasonablyIdentifiable()` in `identityNormalization.ts`, called once, used by both the L gate and (unchanged) the existing identification-failure gate — never two independently-maintained definitions of the same boundary.

**Why:** These were the five items the implementation plan's §13 explicitly listed as blocking R3; the product owner resolved all five in one update rather than case-by-case mid-implementation.
**Do not** relitigate T1–T3/L/M, reintroduce the majority-token filter, treat a provider's raw result total as a matched-comp count, let `facebook_local` win Best Market without clearing the 25%/$10 bar, or collapse the system-failure and zero-evidence-SKIP states back into one. Source instruction: `docs/files/SFP_R3_REMEDIATION_PLAN_UPDATE_20260831.md`.

### R3 identification is SerpAPI-first, AI-assisted — condition is binary NEW/USED only (approved 2026-08-31)
**Decision:** The scanner's primary identification flow is now **photo → Google visual product search via SerpAPI (`engine=google_lens`) → normalized product title/identity → marketplace evidence queries**, not an AI vision call's own free-text fields treated as the identity authority. Claude's vision identification (`buildSinglePrompt`/`buildShelfPrompt` in `claude-proxy/index.ts`) is retained and still supplies structured attributes SerpAPI's reverse-image match cannot reliably read from a photo — barcode/GTIN digits, condition notes, category hints, and the curated `search_keywords` fallback rungs — but a confident SerpAPI top visual match's product title takes priority over the AI's own `item_name` guess when both are present. SerpAPI's own visible prices are **supporting market signal only** (`evidenceType: 'other'`, capped at `weak` — they never become verified sold-price evidence, never feed `calcProfit`/`decide`/`maxBuyPrice` directly, and are always distinguishable from `verified_transaction`/`price_guide` evidence in the response). AI remains barred from independently establishing an authoritative sold price, STR, demand, or decision — unchanged.

**Mechanism note (implementation detail, recorded for review):** SerpAPI's Google Lens API requires a publicly-fetchable image URL — it does not accept a raw upload from this sandbox's verified, reachable API surface. Since `app.html` never uploads scan photos to server-side storage (photos live in client IndexedDB only, stripped before any persisted request — see `CURRENT_STATE.md`), `claude-proxy` now uploads the scan photo to a **private** Supabase Storage bucket (`scan-temp-images`) for the duration of one SerpAPI call only, generates a short-lived signed URL (120s), calls SerpAPI, and deletes the object in a `finally` block regardless of outcome — the photo is never retained beyond that single call. This is an implementation mechanism to satisfy the approved SerpAPI identification flow, not a new "we store user photos" product decision; if the product owner wants a different mechanism (e.g. SerpAPI's binary image-upload endpoint once its exact contract is verified — unverified from this sandbox's blocked egress to serpapi.com at implementation time), this bucket can be removed without touching the identification contract above.

**Condition:** The scanner's condition model is **binary only — NEW or USED.** There are no scanner condition tiers (Excellent/Very Good/Good/Fair/Poor/Acceptable), and there is no AI-generated percentage discount from perceived cosmetic condition. An item not clearly NEW is treated as USED. Comparable matching prefers the same binary condition where the provider supplies reliable condition data, but a condition difference is a **scoring signal**, never a hard rejection, and minor wording differences inside "used" listings (e.g. "knobs appear new" in condition notes) must never manufacture a false NEW-condition requirement. Marketplace routing (`marketplaceRouter.ts`) does not depend on condition grading — routing was already, and remains, a category/product-fit question only.

**Why:** Source instruction `docs/files/SFP_R3_REMEDIATION_PLAN_UPDATE_20260831.md` — the product owner corrected R3's identification source (AI-prose-first was the root cause R2 already fought once, in `identityNormalization.ts`) and explicitly simplified the condition model to remove a whole class of AI-invented discount risk.
**Do not** reintroduce a multi-tier condition grading system, an AI cosmetic-condition discount, condition-based marketplace routing, or treat a SerpAPI asking price as verified sold evidence, without new explicit approval.

### Reverb price-guide evidence pulled into R3 (not deferred to R5 federation)
**Decision:** Unlike the rest of cross-market federation (R5, still deferred — Etsy/Discogs/Amazon/Mercari/Poshmark remain `NOT_CONFIGURED` placeholders), a **Reverb adapter** is wired in R3, category-gated to the marketplaces `marketplaceRouter.ts` already routes to Reverb (guitars, pedals, amps, synths, pro audio, etc.). `REVERB_API_KEY` is configured in Supabase.

**Mechanism note (implementation detail, recorded for review):** the plan's own §8.0 flags Reverb's per-guide Price Guide/`transactions` path as **undocumented, unauthenticated, and already retired once** — not a stable foundation to build a financial-evidence pipeline on, and inconsistent with a configured API *key* (that anonymous path takes no auth at all). This adapter instead calls Reverb's official, documented, authenticated **Listings API** (`GET /api/listings`, `Authorization: Bearer REVERB_API_KEY`) for current active asking prices — the same `active_market` evidence class and proportional-support rule §6.2/T2 already define for eBay Browse, reused rather than re-invented. Reverb's evidence class is therefore `active_market`, capped at `moderate` evidence quality, never `strong`/HOT-qualifying — same evidence-class-ceiling principle the plan's §8.1 defines for full federation, applied early to this one adapter since the update instruction explicitly named Reverb as an R3 evidence-ladder source. If the product owner specifically wants the Price Guide's transaction-derived value range instead (a `price_guide`-class signal, once its exact live contract can be verified against a real account), that is a follow-up, not a blocker to this adapter shipping.
**Why:** The product owner's R3 update explicitly listed Reverb (not the other federation providers) as an R3-relevant evidence source and confirmed its credential is already configured. `SFP_R3_REMEDIATION_PLAN_UPDATE_20260831.md`'s own provider-generic-matching requirement means this adapter reuses the same scored matcher and capability contract R5's other adapters will use later — no scorer rewrite needed when R5 lands the rest.
**Do not** treat this as R5 having started — Etsy/Discogs/Amazon/Mercari/Poshmark are still explicit `NOT_CONFIGURED` placeholders, and R5's §8.1 class-ceiling table, call-budget layer, and rollout sequencing still apply in full once that release starts.

### SerpAPI is the primary eBay sold-history provider
**Decision (approved 2026-09-11):** When `SERP_API_KEY` is configured, the verified market-data pipeline uses SerpAPI's eBay sold endpoint (`engine=ebay&show_only=Sold`) as the primary sold-history source. `SOLD_COMPS_API_KEY` remains a fallback. Trawl (`TRAWL_API_KEY`) is deprecated and removed from the default selection path — `TrawlProvider` is retained in code for rollback only.
**Why:** `SERP_API_KEY` is already configured in Supabase secrets for visual identification (Google Lens). Reusing it for sold searches eliminates the separate Trawl credential dependency and removes Trawl's pacing/throttle overhead from the scan path. `show_only=Sold` returns only verified completed sales (not unsold completed listings). A `sold_date`-absent result is still admitted — the sold filter guarantees the item sold; the exact date is display-only. A SerpAPI request failure does not silently switch providers mid-scan.
**Do not:** expose `SERP_API_KEY` client-side, call SerpAPI from `app.html`, use results outside the existing comp-matching pipeline, treat `show_only=Complete` results as sold evidence, or convert provider errors into a sourcing decision.

---

## Technical Decisions

### Supabase Edge Functions replace Replit backend entirely
**Decision:** All backend logic runs in Supabase Edge Functions (Deno/TypeScript). The old Replit backend is decommissioned.
**Functions (7 deployed):** `claude-proxy`, `auth`, `stripe-webhook`, `stripe-checkout`, `ebay-oauth`, `export-reminder`, `cron`.
**Why:** Supabase is already the database and auth provider. Consolidating removes a dependency, improves latency, and keeps all secrets in one place.
**Do not reference:** `flippd-backend.bbaker71313.repl.co` or any Replit URL. Dead.

### Email verification + password auth only — no magic link
**Decision:** Auth is email verification + username/password. Magic link was removed in backend v3.0.0.
**Why:** Magic link required email round-trips that confused non-technical users and caused support requests. Email + password is universally understood.
**Dead endpoints — never implement:** `/auth/request-link`, `/auth/verify-link`.
**Live endpoints:** `POST /auth/register`, `GET /auth/verify`, `POST /auth/login`.

### AI calls go through Edge Function only — never from client
**Decision:** All Anthropic API calls go through `claude-proxy` Edge Function. The client never touches the Anthropic API directly.
**Why:** API key security. The `ANTHROPIC_API_KEY` lives in Supabase secrets, never in `.env` or client code.
**Pattern:** `supabase.functions.invoke('claude-proxy', { body: { ... } })`

### NativeWind only — no StyleSheet
**Decision:** All React Native styling uses NativeWind 4 (Tailwind classes). Never use `StyleSheet.create()`.
**Why:** Consistent with the web stack (Tailwind), faster iteration, and enforces design system tokens from `packages/shared/src/constants/theme.ts`.

### 500-line file limit
**Decision:** No file may exceed 500 lines. Refactor into sub-modules before hitting the limit.
**Why:** Large files slow down Claude Code context loading and make surgical edits harder. This was learned during single-file app development.

### All configurable values from user settings — never hardcoded
**Decision:** These values are always from user settings or constants files, never hardcoded inline:
- `ebayFee` (default 13%)
- `taxReservePct` (default 0.25)
- `mileageRate` (default 0.72 — IRS rate)
- Tier scan limits
**Why:** User contexts vary. Hardcoding creates incorrect math for many users and makes the app feel broken.

---

## Business Decisions

### No fake urgency or fake scarcity
**Decision:** Do not manufacture false urgency or scarcity in copy.
**Why:** Resellers are savvy buyers. Fake urgency erodes trust and contradicts the brand voice — direct, honest, reseller-to-reseller.

### Android (Google Play) ships before iOS
**Decision:** First mobile distribution is Android via EAS Build + Google Play. iOS (App Store) comes after.
**Why:** Google Play review process is faster and less restrictive for initial launch. Allows real-user testing before the more scrutinous App Store submission.
**Status:** Deferred — live product is app.html (web). Mobile rebuild not yet started.

### Source of truth for business logic is ScanForProfit_v5_24.html
**Decision:** All AI prompts, profit calculations, and business rules are ported from `docs/ScanForProfit_v5_24.html`. Never rewrite from scratch.
**Why:** Those prompts and calculations have been tested in production. Rewriting introduces errors. Port verbatim.
