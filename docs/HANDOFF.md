# ScanForProfit — Session Handoff

This file is the current session context. Keep only the three most recent
sessions and no more than 250 lines. Git history preserves older handoffs.
Update it at the end of every Claude Code session with what changed.

---

## Session: 2026-09-13 — Claude context-window startup fix

**Root cause:** Every Claude session was required to preload `CLAUDE.md`,
`CURRENT_STATE.md`, the full append-only `HANDOFF.md`, and `FEATURE_TRIAGE.md`.
Together they contained 75,197 words / 583,455 bytes before task-specific
inspection. `HANDOFF.md` alone had grown to 5,343 lines / 469,958 bytes. A
profit-scanner audit then opened the 483,699-byte live `app.html`, the
95,623-byte `claude-proxy/index.ts`, and shared pipeline files, exhausting the
context window before the first synthesized response.

**Changes:**
- Capped `HANDOFF.md` at the three most recent sessions and 250 lines; Git
  history remains the archive.
- Removed unconditional startup loading of `FEATURE_TRIAGE.md`; it is now read
  only for feature-scope and approved AI-prompt work.
- Added a context-budget rule requiring targeted search and bounded reads for
  the large live scanner files.
- Corrected the impossible blanket 500-line rule: legacy live monoliths are
  explicit exceptions and must not trigger an unrelated refactor.

**Measured result:** Mandatory startup material fell from 75,197 words /
583,455 bytes to approximately 9,300 words / 70 KB, an 88% reduction before
task-specific work.

**Files changed:** `CLAUDE.md`, `docs/HANDOFF.md`.

**Behavior changed:** Claude session loading and repository-agent workflow only.
No application, scanner, API, database, or production behavior changed.

**Tests:** `git diff --check`; handoff session-count and size checks; instruction
search for duplicate unconditional `FEATURE_TRIAGE.md` startup rules.

**Assumptions made:** Claude Code automatically loads root `CLAUDE.md` and then
follows its explicit mandatory startup reads. This matches the observed session
transcript and repository instructions.

**Out-of-scope finding:** `CURRENT_STATE.md` was last updated 2026-08-31 and its
scanner status is stale relative to the September commits. Refresh separately
when scanner work resumes.

**Product decisions needed:** None.

**Blockers:** None.

---

## Session: 2026-09-13 — Recovery: verify v112 deployment state and scoring fix

**Summary:** Previous session errored before making any changes. This session
confirmed the deployed state is current and the comp-matching + SerpAPI
sold-provider fixes are live and correct.

**Deployment state confirmed (via `mcp__Supabase__list_edge_functions` +
`mcp__Supabase__get_edge_function` bundle grep):**
- `claude-proxy` is at **v112**, `ACTIVE`, deployed **2026-09-11**. This version
  was deployed by the product owner after PR #158 merged — it is current with
  `main` HEAD (`83380d1`).
- Bundle contains: `SerpApiEbaySoldProvider`, `getSoldMarketDataProvider` (SerpAPI
  factory), `extractProductType` (comp-matching fix), `identifyViaSerpApi`/
  `mergeSerpApiIdentity` (R3 SerpAPI identification). All expected markers present.
  `TrawlProvider` present as deprecated rollback class (expected).
- All other functions (auth v80, stripe-webhook v75, stripe-checkout v79,
  ebay-oauth v86, export-reminder v53, cron v18) remain ACTIVE and unchanged.

**Scan id=72 analysis (the GE radio test scan, 2026-09-11 11:51:17):**
- This scan ran on the **old code** (v109, before the fix was deployed). Result:
  0 retained comps across both qualifying queries; `PROVIDER_THROTTLED` on the
  3rd query. This is the known pre-fix regression, not a post-fix failure.

**Scoring fix verified by source inspection (`compSelection.ts` v112):**
- `extractProductType("General Electric All Transistor AM Radio Vintage 1960s
  Table Top")` → returns `"radio"` (skips "top", "table", "1960s" right-to-left).
- Comp "Vintage General Electric GE P-808A All Transistor AM Radio White Working"
  scores: brand +25 + head noun +15 + descriptive tokens ("all","transistor") +20
  = **60 → usable band**. Per R3: `score >= USABLE_BAND_MIN (60)` → retained.
- Many of the 20 query-1 comps and 138 query-2 comps will now score ≥ 60 with
  v112, so a fresh GE radio scan should achieve Case A (≥3 retained comps).

**`DEPLOYED.md` note:** The product owner deployed v112 outside the recorded
script (same pattern as R2/R3), so `DEPLOYED.md` still shows R3 as the last
recorded entry. The live version (v112) is current; no re-deploy is needed.

**Files changed this session:** `docs/HANDOFF.md` only (this update).

**Commits this session:** see below.

**Next task:** Run a live production scan of the GE radio (the same scan that
produced scan_log id=72) and inspect `scan_log.raw_response.decisionAudit` to
verify retained comp counts. Expected outcome: Case A (≥3 retained comps on
rung 1 or 2, resulting in `decisionAvailable: true` with a HOT/LIST/SKIP). If
Case B or C, report the actual `rejectionReason` and `retainedCompCount` from
the decisionAudit for each attempted query.

**No code changes needed.** v112 is deployed and correct.

**Assumptions made:** None material — every claim above is evidence-based
(live function list, bundle grep, source inspection, scan_log query).

**Out-of-scope findings:** None.

**Blockers:** Cannot run a live production scan from a remote session (egress
proxy blocks direct calls to `*.supabase.co`). The product owner must run the
verification scan from `scanforprofit.com/app.html`.

---

## Session: 2026-09-11 — SerpAPI replaces Trawl as primary eBay sold-history provider

**Summary:** Replaced Trawl with SerpAPI (`engine=ebay&show_only=Sold`) as the primary eBay sold-data provider per executive directive. `SERP_API_KEY` (already configured in Supabase for Google Lens identification) is now reused for sold searches — no new credential needed.

**Provider priority after this session:** `SERP_API_KEY` → `SOLD_COMPS_API_KEY` → null. `TRAWL_API_KEY` is deprecated and no longer in the selection path.

**Files changed:**
- `supabase/functions/_shared/serpApiEbaySoldProvider.ts` — NEW. `SerpApiEbaySoldProvider` class + `parseSerpApiSoldItem()` parser (exported for tests). Uses `externalCall` with 12s timeout, 1 retry, Retry-After-aware `shouldRetry`.
- `supabase/functions/_shared/serpApiEbaySoldProvider_test.ts` — NEW. 28 tests covering parser variants, transport error cases, and GE radio regression.
- `supabase/functions/_shared/soldCompsProvider.ts` — Added `import { SerpApiEbaySoldProvider }`. Exported `TrawlProvider` class (deprecated, kept for rollback). Updated `getSoldMarketDataProvider()` factory: SerpAPI → SoldComps → null. Replaced `TRAWL_API_KEY_ENV_NAME` with `SERP_API_KEY_ENV_NAME`.
- `supabase/functions/_shared/soldCompsProvider_test.ts` — Added `TrawlProvider` import. Updated `trawlProvider()` helper to construct directly (no longer uses factory). Overhauled `withEnv` to support clearing keys. Added 4 factory selection tests.
- `supabase/functions/_shared/marketDataPipeline.ts` — Updated `SOLDCOMPS_NOT_CONFIGURED` error detail string (TRAWL_API_KEY → SERP_API_KEY).
- `docs/files/DECISIONS.md` — Replaced "Trawl is the preferred sold-history provider" with "SerpAPI is the primary eBay sold-history provider" (decision date 2026-09-11).

**Tests:** 52/52 pass (28 new SerpAPI provider tests + all 24 existing soldCompsProvider tests).

**Next task:** Deploy the updated `claude-proxy` / `_shared` Edge Functions to Supabase production so the live scanner uses SerpAPI. Then run a production replay: scan 1 item and confirm the scan log shows a `serpapi.com/ebay` provider in the evidence audit. No code changes needed — the key is already in Supabase secrets.

**Decision preserved:** `SERP_API_KEY` must never be exposed client-side. All SerpAPI calls go through Edge Functions only.

---
