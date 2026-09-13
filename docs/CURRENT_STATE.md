# ScanForProfit — Current State

**Last updated:** 2026-09-13
**Audience:** Humans onboarding to the project, marketing review, and doc writers.  
**Authoritative for:** What exists today in production. When this disagrees with README or marketing copy, fix the lower-tier doc — not this file without verifying against `app.html`.

For doc architecture see [`DOC_HIERARCHY.md`](DOC_HIERARCHY.md). For known doc debt see [`DOC_AUDIT.md`](DOC_AUDIT.md).

---

## One-liner

ScanForProfit is an AI-powered sourcing and business tool for solo eBay resellers — scan any item or a full shelf, get a **HOT / LIST / SKIP** decision with real profit math, and run inventory, listings, trends, and P&L from one app.

---

## Who it's for

Solo resellers sourcing from thrift stores, estate sales, garage sales, and flea markets. Primary marketplace: **eBay** (Poshmark, Mercari, Facebook Marketplace are future).

---

## How to use it (users)

| Step | Action |
|------|--------|
| 1 | Go to [scanforprofit.com/app.html](https://scanforprofit.com/app.html) |
| 2 | **Sign Up** with email and password |
| 3 | Verify email from the link sent to your inbox |
| 4 | Log in and start scanning |

**There are no access codes, invite codes, or gatekeeper passwords.** The landing page “Get early access” button is a **waitlist** for product updates — it does not unlock the app.

Marketing may use “LIST or PASS” as plain English; in the app, **PASS = SKIP**.

---

## Live URLs

| URL | What it is |
|-----|------------|
| [scanforprofit.com](https://scanforprofit.com) | Marketing homepage + waitlist |
| [scanforprofit.com/app.html](https://scanforprofit.com/app.html) | **Live product** |
| [scanforprofit.com/privacy.html](https://scanforprofit.com/privacy.html) | Privacy policy |
| [scanforprofit.com/terms.html](https://scanforprofit.com/terms.html) | Terms of service |

---

## What's live today

### Core product (✅)

| Feature | Tab / location | Notes |
|---------|----------------|-------|
| Register, login, email verify, password reset | Auth screen | Supabase Auth via `auth` edge function |
| Single-item AI scan | Profit Scanner | Claude via `claude-proxy`; ~8s typical |
| Shelf scan (rank all visible items) | Profit Scanner | Sorted HOT → LIST → SKIP |
| — market evidence integrity | — | Profit Scanner v2 is live: decision authority is deterministic `netProfit`/`roi`/`evidenceQuality`, never AI-generated prices or demand. eBay sold evidence uses an explicitly audited SerpAPI → SoldComps → Trawl failover chain plus Browse active evidence; a failed/empty Browse lookup is never fabricated as support. Strong sold evidence can qualify alone, while reasonably identifiable items with a genuine evidence gap return the distinct zero-evidence SKIP. Only identification or provider/system failures withhold a decision. Authenticated production scan 79 verified the full path on 2026-09-13. |
| Scan decisions | HOT / LIST / SKIP | Three tiers — FLIP is retired |
| Inventory CRUD + status tracking | Inventory | Synced to Supabase |
| Item photos | Inventory + Photos | IndexedDB client-side; metadata on server |
| AI listing generator | Inventory / listing modal | Title, description, category |
| eBay CSV export + full ZIP backup | Export flow | JSZip backup with inventory, expenses, scan history |
| CSV / eBay import | Import view | Spreadsheet + eBay active listings + orders |
| Profit Compass (Growth Agent) | Profit Compass tab | Weekly-style business brief + trends |
| Profit Hub (P&L + expenses) | Profit Hub tab | Revenue, profit, expenses, mileage |
| Settings | Settings panel | eBay fee %, packaging, shipping, min profit, target ROI, tax reserve, mileage — all configurable |
| Photo Agent | Photos tab | Crop, enhance, optional remove.bg |
| Tier limits + upgrade UI | Banner + Profit Hub → Subscription | Scout free tier with usage gates |
| Waitlist capture | Landing page | Email only — not app access |

### Five tabs (live display names)

| Tab ID | Display name | Purpose |
|--------|--------------|---------|
| `sourcing` | Profit Scanner | AI scan — single item + shelf mode |
| `inventory` | Inventory | Items, cost, sell price, status, photos |
| `photo` | Photos | Photo management + listing prep |
| `growth` | Profit Compass | Market trends + Growth Agent |
| `dashboard` | Profit Hub | P&L, expenses, subscription |

---

## Built but not fully verified (🟡)

These exist in code and have been deployed; end-to-end production verification is still pending.

| Feature | Status | Blocker / next step |
|---------|--------|---------------------|
| Stripe upgrade checkout | 🟡 | Complete a test purchase on production |
| eBay OAuth connect | 🟡 | Migrations + `ebay-oauth` v67 (SEC-010 encrypted tokens, SEC-015 cookie auth + CSRF guard) live; needs a fresh connect to re-encrypt (only the expired sandbox token was affected) |
| eBay listing push (`/create-listing`) | 🟡 | Requires connected eBay account + sandbox/prod credentials |
| eBay order sync (`/sync-orders`) | 🟡 | Same as above |
| PostHog analytics | 🟡 | SDK initialized in app; event coverage not audited |

---

## Not live yet (⬜)

| Item | Notes |
|------|-------|
| Mobile app (Expo / React Native) | `apps/mobile/` scaffold deleted 2026-06-29 (60 files, never started/shipped) — future rebuild will start fresh from `app.html` |
| Sentry in live web app | Not wired in `app.html` |
| Cross-listing (Poshmark, Mercari, FB) | Future platforms |
| Public launch / App Store | Phase 6 — see `docs/files/LAUNCH_CHECKLIST.md` |

---

## Deprecated — do not document as current (🗄️)

| Item | Replacement |
|------|-------------|
| Flippd / Replit backend | Supabase edge functions |
| App access codes | Email + password auth (JWT) |
| localStorage-only architecture | Supabase Postgres + hybrid client cache |
| FLIP / FLIP-PASS scan labels | HOT / LIST / SKIP |

---

## Pricing tiers (monthly)

Annual plans are **not** offered in the live product UI. Source: `packages/shared/src/constants/tiers.ts`.

| Tier | Price | Scans/mo | Inventory items |
|------|-------|----------|-----------------|
| Trial | Free (7 days) | Unlimited | Unlimited |
| Scout | Free | 25 | 10 |
| Hustle | $19/mo | 250 | 250 |
| Stack | $49/mo | Unlimited | Unlimited |
| Empire | $199/mo | Unlimited | Unlimited (+ team seats in product roadmap) |

Configurable business defaults (never hardcoded in logic): eBay fee 13%, packaging $1.25, min profit $15, target ROI 200%, mileage $0.67/mi — all user-overridable in Settings.

---

## Technology stack

```
scanforprofit/                    pnpm monorepo + Turborepo
├── apps/web/public/app.html      ← LIVE PRODUCT (single-file HTML/JS)
├── apps/web/                     Next.js 15 shell (landing, API routes, deploy)
├── apps/video/                   Remotion ad compositions
├── packages/shared/              @sfp/shared — types, calcProfit, tiers, theme
└── supabase/
    ├── functions/                Edge Functions (Deno/TypeScript)
    └── migrations/               PostgreSQL schema + RLS
```

| Layer | Technology |
|-------|------------|
| Live UI | Vanilla JS + HTML/CSS in `app.html` |
| Hosting | Vercel |
| Database | Supabase PostgreSQL (`dqgfpchkheznvanfgsmx`) |
| Auth | Supabase Auth + custom `auth` edge function |
| AI | Claude Sonnet 4.6 via `claude-proxy` (key in Supabase secrets) |
| Payments | Stripe via `stripe-checkout` + `stripe-webhook` |
| eBay | `ebay-oauth` edge function |
| Client storage | httpOnly `sfp_auth` cookie (JWT never touches JS); settings cache + `sfp_session` UI flag in localStorage; photos in IndexedDB; inventory/expenses on server |

### Edge functions (7)

`auth` · `claude-proxy` · `stripe-checkout` · `stripe-webhook` · `ebay-oauth` · `export-reminder` · `cron`

Shared code lives in `supabase/functions/_shared/` (authentication, provider,
market-evidence, financial, and tier modules) — leading underscore = not
deployed as a standalone function.

**Live versions (verified via Supabase MCP, 2026-09-13):** `auth` v82 ·
`claude-proxy` v119 · `stripe-checkout` v81 · `stripe-webhook` v77 ·
`ebay-oauth` v88 · `cron` v20 · `export-reminder` v55. All are ACTIVE and
all retain their repo-declared custom-auth settings; see `supabase/DEPLOYED.md`
for deployment evidence.

**Auth model (SEC-015, deployed 2026-06-30):** JWT lives only in an httpOnly `sfp_auth` cookie (`Secure; SameSite=None`), never in localStorage or a Bearer header. `_shared/cors.ts` returns an exact locked-origin allowlist (required for `credentials: 'include'`). Every non-GET/OPTIONS route on `auth`, `claude-proxy`, `ebay-oauth`, and `stripe-checkout` requires an `X-Sfp-Client: 1` header as a CSRF guard.

---

## Known issues / tracked debt (security audit P1–P4 + SEC-015)

Small pre-existing issues surfaced during the audit, logged here so we fix them in advance. Full detail in [`HANDOFF.md`](HANDOFF.md).

- **`claude-proxy` financial/decision math** lives in `supabase/functions/_shared/{financialEngine,decisionEngine,maxBuyPrice}.ts` (2026-08-25) as hand-mirrored copies of `packages/shared/src/utils/{calcProfit,decisionEngine,maxBuyPrice}.ts` (P3-34, 2026-08-27: **live-verified BLOCKED**, not just unverified — a relative cross-package import failed to bundle via `mcp__Supabase__deploy_edge_function`, and this project's own already-deployed functions show the upload root varies by deploy mechanism, so the number of `../` segments needed is not stable. See `financialEngine.ts`'s header for the full evidence.). Both sides are behaviorally identical (verified line-by-line + matching parity test fixtures) and must stay in lockstep by hand until the repo standardizes on one deploy mechanism with a guaranteed upload root.
- **Verified market-data pipeline is wired into single/text/shelf scans.** `packages/shared/src/utils/marketMetrics.ts` (+ Deno mirror) and `supabase/functions/_shared/{ebayAppAuth,ebayTaxonomy,ebayCatalog,ebayBrowse,soldCompsProvider,serpApiEbaySoldProvider,itemIdentification,marketDataPipeline}.ts` implement provider-agnostic identification, eBay Catalog/Taxonomy/Browse, and verified sold history. Sold-provider priority is SerpAPI → SoldComps → Trawl with explicit per-attempt auditing; eBay Catalog remains best-effort because the current credentials are not entitled (403). The path is production-smoke-tested: scan 79 used SoldComps after a recorded SerpAPI 503 and qualified six exact-model-variant comps.
- **AI-market-authority gate (`resolveScanResultCore` in `supabase/functions/claude-proxy/index.ts`)** is the single place that decides whether HOT/LIST/SKIP and financial fields may be computed. AI-generated market numbers are neither requested nor authoritative. Strong/moderate verified evidence enables deterministic economics; a reasonably identifiable item with a genuine evidence gap returns `ok_no_evidence`/SKIP with all financial fields null; only identification or provider/system failures return `decisionAvailable:false`. `apps/web/public/scanResultContract.js` validates every wire-state combination.
- **`randomHex` duplicated** in `auth` + `ebay-oauth` (candidate for `_shared/`).
- **`ebay_connections.oauth_nonce`** likely orphan column (live nonce uses `users.ebay_oauth_nonce`).
- **Live DB advisor WARNs:** waitlist always-true INSERT RLS (unrelated to P2-30, not yet fixed). Resolved 2026-08-27 (P2-30, applied to production): `item-photos` public bucket listing (now private, zero client policies); `send_export_reminders` SECURITY DEFINER anon-callable (EXECUTE revoked). Remaining and classified as not fixable/not applicable: Auth leaked-password protection OFF (this app's real login never uses Supabase Auth's password endpoints — see `HANDOFF.md` P2-30 for the full writeup); `auth_rate_limits`/`stripe_webhook_events` RLS-no-policy (intentional, documented via `COMMENT ON TABLE`).

Resolved since last update (kept here as changelog, not open items): stripe-webhook NaN-timestamp + non-constant-time signature compare — fixed (SEC-019, v58+). SEC-002 wildcard CORS — superseded by SEC-015 locked-origin `_shared/cors.ts`.

---

## Local development (quick start)

```bash
git clone https://github.com/bbaker71313/scanforprofit.git
cd scanforprofit
pnpm install
cp .env.example .env          # fill in Supabase + PostHog keys
pnpm --filter @sfp/web dev    # Next.js dev server → localhost:3000
```

- **Live app logic:** edit `apps/web/public/app.html` directly
- **Landing page:** `apps/web/public/index.html`
- **Edge functions:** `supabase/functions/` — deploy with Supabase CLI
- **Secrets:** set via `supabase secrets set` — see `.env.example` comments

Full agent/dev rules: [`CLAUDE.md`](../CLAUDE.md)

---

## Documentation index (files that exist)

| Doc | Purpose |
|-----|---------|
| [`CURRENT_STATE.md`](CURRENT_STATE.md) | This file — what's live now |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Structural facts: monorepo layout, stack, edge functions, DB tables, client storage model |
| [`DOC_HIERARCHY.md`](DOC_HIERARCHY.md) | Which doc wins when sources disagree |
| [`DOC_AUDIT.md`](DOC_AUDIT.md) | Stale doc inventory + fix queue |
| [`FEATURE_TRIAGE.md`](FEATURE_TRIAGE.md) | Feature specs + AI prompts (port verbatim) |
| [`files/DECISIONS.md`](files/DECISIONS.md) | Locked product/tech decisions |
| [`HANDOFF.md`](HANDOFF.md) | Session log for AI agents |
| [`BRAND_IDENTITY.md`](BRAND_IDENTITY.md) | Logo, colors, typography |
| [`CLAUDE.md`](../CLAUDE.md) | Monorepo rules + session protocol |
| [`files/DOC_PROCESS.md`](files/DOC_PROCESS.md) | Feature PR DoD + monthly doc hygiene checklist |

---

## Roadmap snapshot

**Shipped in v1 web app:** AI scanning, shelf scan, inventory, listing generator, CSV export/import, Profit Compass, Profit Hub, settings, photo tools, tier gating.

**Next verification milestones:** Stripe E2E, eBay OAuth E2E on production, PostHog event audit.

**Future:** Mobile app rebuild, cross-platform listing, team features, public launch (Phase 6).

---

## Changelog

| Date | Change |
|------|--------|
| 2026-08-29 | **Profit Scanner v2 (cross-market resale opportunity architecture, implemented in source, production deployment pending):** sell-through rate, days-to-sell, and demand level removed entirely from scanner decision authority — `decisionEngine.ts`'s `decide()` is now `netProfit`/`roi`/`evidenceQuality` only (`HOT`=strong evidence, `LIST`=moderate evidence, both require profit+ROI to pass; `SKIP`=either fails). A new marketplace-independent evidence-quality assessment (`evidenceQuality.ts`) replaces the old comp-count-only bucketing, factoring identity-match precision and active-market support. `marketDataPipeline.ts` no longer hard-requires eBay active-listing evidence to reach a decision — strong sold evidence alone qualifies, and active-only evidence can independently support 'moderate'. New `MarketplaceRouter`/`MarketplaceOpportunityEngine`/`MarketplaceEconomicsEngine` (`marketplaceRouter.ts`, `marketplaceOpportunity.ts`, `marketplaceEconomics.ts`, `marketplaceProviders.ts`, `marketplaceTypes.ts`) route each scanned item to relevant marketplaces (eBay always; Etsy/Reverb/Discogs/Poshmark/Mercari/Amazon/Facebook-local by category) and select the best overall opportunity by evidence tier + net profit, not gross asking price — eBay is the only marketplace with a real provider today (Trawl/SoldComps + Browse); every other marketplace is an explicit `NOT_CONFIGURED` provider-boundary placeholder (no official API access available), never scraped or fabricated. Weak/no evidence now surfaces as `LIMITED EVIDENCE` (`decisionAvailable:false`) — the same wire shape the prior "insufficient evidence" state used — rather than the old "evidenceQuality caps HOT at LIST" mechanism, which is removed. Scan response contract adds `bestMarketplace`/`bestMarketplaceLabel`/`whyThisMarketplace`/`alternativeMarketplaces`; `app.html` shows a "Best Market" card + "Other Options" list. Sell-through-rate/days-to-sell/demand-level are kept as informational-only fields (never gating) purely for Inventory's `SourcingMeta` / Listing Generator backward compatibility. See `docs/files/DECISIONS.md` (supersedes the 2026-08-26/2026-08-28 P0 market-data-rules and evidence-qualification decisions for the scanner's decision authority specifically — those STR/turnover/Best-Offer formulas are unchanged and still used for the informational fields) and `docs/HANDOFF.md`. Not yet smoke-tested end-to-end against a live scan request; Etsy/Reverb/Discogs/Amazon/Mercari/Poshmark integrations remain placeholders pending official API access. |
| 2026-08-28 | **Profit-scanner evidence remediation implemented in source (production deployment pending):** exact-to-broad query cascade; identity/condition-aware parts, lots, accessory, repair, and model filtering; minimum 3 coherent comps; 5/8 moderate/strong thresholds; p20/p80 six-times coherence guard; cleaned median + 35th/70th percentile range; sold/active population alignment; zero-active evidence no longer becomes 0-day turnover; AI numerical market estimates removed from prompts and no-evidence UI; sub-$1 ROI display suppression; per-query/exclusion audit details persisted in `decisionAudit`. |
| 2026-08-27 | **P0 production deployment-drift remediation.** Live Supabase Edge Functions were found badly stale — `claude-proxy` (v83) still ran the pre-Chapter-02 path: fabricated `estimatedCost = r2(avgSell*0.10)`, the old `getDecision()` authority path, an import of the already-deleted `_shared/tierLimits.ts`, no `decisionAvailable`/`decisionStatus`/`resolveScanResultCore`, no verified-market-data pipeline at all — causing live scans to fail client-side with `decisionAvailable must be a boolean, got undefined`. All 7 repo-managed functions were stale to varying degrees: `auth` still signed 90-day JWTs via the deleted `tierLimits.ts` and pre-P2-28 rate limiting; `stripe-checkout`/`stripe-webhook` used inline hardcoded Stripe logic instead of the centralized `stripePricing.ts`/`stripeIdempotency.ts`/`stripeWebhookSignature.ts`; `ebay-oauth` had none of the P1/P2 sync-reconciliation, pagination, or token-refresh single-flight work; `cron` was missing the P2-27 durable-email retry queue; **`export-reminder` was missing its `CRON_SECRET` check entirely — a real production auth gap, not just a feature lag.** Root cause: no CI/CD step ever deploys `supabase/functions/` (`web.yml` only typechecks `apps/web`+`packages/shared`), so every prior deploy was ad hoc, and the live functions' bundled paths showed 3 different upload-root depths depending on which tool/session produced each one. Fixed: all 7 functions redeployed dependency-complete from `main` @ `cbddb78c` via the Supabase MCP deploy tool; post-deploy source fetch confirmed current markers present (`resolveScanResultCore`, `decisionAvailable`, `tierCatalog`, the 30-day JWT default) and obsolete markers absent (`estimatedCost = r2`, `getDecision(`, `tierLimits.ts`) in the live bundle. Added `scripts/deploy-edge-functions.sh` (deterministic CLI deploy from a fixed repo-root upload path) + `supabase/DEPLOYED.md` (deploy manifest — the repeatable answer to "which commit is this function running") + `supabase/config.toml` now declares `project_id` and all 7 functions' `verify_jwt` settings (previously missing `cron`/`export-reminder`, which would have defaulted to `verify_jwt=true` on a future CLI deploy and broken their custom-secret auth). See `docs/HANDOFF.md` for the full drift matrix and test results. **Live smoke test not run** — this sandbox's egress proxy blocks direct calls to `*.supabase.co` (pre-existing limitation, confirmed via `$HTTPS_PROXY/__agentproxy/status`); verification was via re-fetching the deployed bundle source and grepping for markers, not a live HTTP request. A manual authenticated scan test against production is still required — see HANDOFF. |
| 2026-08-27 | Chapter 02 follow-up: fixed a verified live defect where, on scan verification failure, Claude's own (non-null) market estimate was fed into the authoritative decision engine and could produce a fabricated-looking HOT/LIST/SKIP, profit/ROI, or max-buy-price. `resolveScanResultCore()` is now the single gate in `claude-proxy/index.ts` — authoritative fields are computed only when `marketDataSource: 'verified'`; otherwise the response is `decisionAvailable:false` / `decisionStatus:'insufficient_market_data'` with the AI's estimate kept separately, informational-only. `scanResultContract.js` validates the new shape (and fixes a pre-existing `decisionReasons` validation bug — see `HANDOFF.md`). `app.html` renders a distinct "no verified recommendation" state for single scans and a "Needs Verification" shelf section instead of ranking unverified items as SKIP. |
| 2026-08-27 | P3 remediation complete (P3-33 through P3-40, 8 items): one authoritative tier-configuration source (`_shared/tierCatalog.ts`) replacing 3 independently-maintained copies and fixing a real bug where the subscription-usage line always showed "unlimited"; calcProfit duplication live-verified as a genuine cross-package-import blocker (not just "unverified") via this session's Supabase deploy access — kept as documented, tested, hand-synced duplication (PARTIAL/BLOCKED); CLAUDE.md's mandatory SESSION START check no longer requires a directory deleted 2 months ago; `ARCHITECTURE.md`'s stale auth-model claims (90-day localStorage JWT) corrected to match the real 30-day httpOnly-cookie model; 6 confirmed-dead app.html functions + 1 dead/wrong shared-package const removed; AI model name + endpoint and eBay sandbox/prod URL switching centralized (were duplicated 6x and 2x respectively); 12 previously-undocumented env vars added to `.env.example`; new runtime-validated scan-result contract (`scanResultContract.js`) replacing unvalidated inline field mapping in the scanner. See `HANDOFF.md` for full detail. |
| 2026-08-27 | P2 remediation complete (P2-18 through P2-32, 16 items): shared external-call reliability wrapper; inventory optimistic concurrency (`version` column, 409 conflicts); recoverable photo persistence + real scanner thumbnails + shelf-photo carry-through in `app.html`; dead-UI audit (removed unused CSS, fixed a stale pre-JWT toast); stale-listing age now uses `listed_at`; eBay list-fetch pagination beyond the old 200-record ceilings; DB-level single-flight lock for eBay token refresh; Stripe Checkout idempotency keys; durable email retry queue; auth rate-limiter IP-trust fix + bounded fail-open + reset-confirm coverage; JWT session length aligned to the cookie (90d→30d); live production Supabase security-advisor cleanup (revoked an over-permissioned SECURITY DEFINER grant, locked down a public item-photos storage bucket that had zero ownership scoping); zero-cost ROI and verified-vs-AI-estimate evidence now correctly labeled throughout the scan UI. See `HANDOFF.md` for full detail. |
| 2026-08-26 | P0 market-data remediation completed: approved STR formula + demand-level thresholds + Best Offer policy implemented; SoldComps API contract live-verified (and corrected — numeric-string prices, `items` envelope key, several field-name fixes) via a temporary Supabase-hosted diagnostic function invoked through `pg_net`; eBay Browse/Taxonomy live-verified working, Catalog live-verified but not entitled (403, non-blocking); pipeline wired into single/text/shelf scans in `claude-proxy` with AI market values ignored whenever verified evidence is available, falling back to the AI-estimate path otherwise. Not yet smoke-tested end-to-end against a live scan request. See `HANDOFF.md`. |
| 2026-08-26 | P0 market-data remediation (infra phase): provider-agnostic identification interface + eBay Catalog/Taxonomy/Browse clients + SoldComps sold-history provider + deterministic price/turnover metrics built (`packages/shared` + `supabase/functions/_shared`), tested where pure logic. Not yet wired into any live scan path at this point in the changelog — see the entry above for when it was. |
| 2026-08-25 | Chapter 02 audit (Profit & Decision Engine) repair: deterministic HOT/LIST/SKIP + max-buy-price solver in `packages/shared` (mirrored in `supabase/functions/_shared/`), no more invented acquisition cost (`avgSell*0.10`) in any scan mode, sourcing-style multiplier removed from decision logic, `buyer`/`seller`/`free` shipping bug fixed client- and server-side. Real eBay market-data integration (Marketplace Insights/Browse/Taxonomy/Catalog) still not implemented — see `HANDOFF.md`. |
| 2026-06-24 | Initial version — Phase 2 doc cleanup |
| 2026-06-24 | Phase 4–5 complete: ARCHITECTURE.md created, marketing docs corrected, DOC_PROCESS.md added |
| 2026-06-25 | Security audit P1 (XSS/JWT/auth-injection fixes) + P2 (`_shared/` extraction, tier single-source, atomic scan RPC, token_version revocation, auth rate limiting; migrations 009–012 live) |
| 2026-06-26/27 | Security audit P3 (stripe-webhook NaN/timing fix, prompt injection sanitization, RLS gaps, eBay N+1 fix) + P4 (password min length 8, waitlist key fix, dead demo data removed) |
| 2026-06-29 | SEC-016 single-use password reset (auth v62); Phase 5A — legacy `/v1/messages` proxy removed from claude-proxy, all `app.html` callers migrated to typed actions; `apps/mobile/` deleted (60 files, never shipped) |
| 2026-06-30 | SEC-015 — JWT moved from localStorage to httpOnly cookie across all 6 edge functions, locked-origin CORS (`_shared/cors.ts`), `X-Sfp-Client` CSRF guard added to every mutating route; doc sync (versions, mobile removal, resolved debt) |
