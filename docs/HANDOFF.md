# ScanForProfit — Session Handoff

This file is the current session context. Keep only the three most recent
sessions and no more than 250 lines. Git history preserves older handoffs.
Update it at the end of every Claude Code session with what changed.

---

## Session: 2026-09-13 — Scanner audit remediation and production proof

**Outcome:** The audited scanner path is repaired, deployed, and verified with
an authenticated production text scan. The final live function is
`claude-proxy` **v119**. GitHub PR #161 contains the remediation; its final
scanner-code commit is `7c97a08`.

**Primary production failure:** SerpAPI's eBay engine accepted the correct
`engine=ebay&show_only=Sold` request but its eBay scrape ended in provider 503
after roughly 90 seconds. The old single-provider path converted that outage
into `LIMITED EVIDENCE`, even though a working SoldComps credential was already
configured.

**Changes:**
- Added explicit, audited sold-provider failover: SerpAPI → SoldComps → Trawl.
  Only operational failures fall through; a successful empty result does not.
  Every provider attempt, failure reason, and latency is persisted.
- Corrected SerpAPI async submit/poll handling and bounded timeouts, preserved
  missing sold dates outside velocity math, and prevented ambiguous price
  ranges or Best Offer uncertainty from overstating evidence.
- Corrected exact-model query planning, identity merge rules, comparable
  filtering, provider failure classification, active-zero handling, and
  real-provider attribution.
- Removed AI price/comp instructions from the text-identification prompt;
  authoritative economics still come only from verified marketplace evidence.
- Repaired scan response/client contracts, truthful unavailable messages,
  image validation/timeouts, pre-quota input validation, shelf call budgets,
  and scan-to-inventory idempotency/ownership behavior.
- Fixed the final production-only truth-label issue: sold-only evidence no
  longer claims that active-market data also participated.

**Production proof (temporary scan id 79, deleted after verification):**
- Exact item: General Electric GE Superadio III, model 7-2887; confidence 97.
- SerpAPI failure recorded, then SoldComps returned 40 records; six coherent
  exact-model-variant comps qualified.
- Verified sold range $29.99–$37.99; median/expected sale price $33.99.
- At $2.99 entered cost, 13% eBay fee, $1.25 packaging, and buyer-paid
  shipping: independently recomputed profit $25.33 and ROI 847.20%.
- Result: `HOT`, `decisionAvailable:true`, `evidenceQuality:strong`, source
  exactly `eBay sold listings (sold-comps.com)`. eBay active count was zero and
  was not represented as active evidence.

**Validation:** 349 Deno backend tests, 70 shared-engine tests, 49 browser
contract tests, shared/web TypeScript checks, and `git diff --check` all pass.
Supabase v119 is ACTIVE. The temporary smoke-test account and all five of its
scan rows were cascade-deleted and verified absent from every referencing
table.

**Migrations:** None. **Blockers:** None.

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
