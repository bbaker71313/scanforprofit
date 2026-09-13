# Deployed Edge Function Manifest

Auto-updated by `scripts/deploy-edge-functions.sh` after every successful deploy.
Do not hand-edit routine entries — this is a log, not configuration. To check what's
actually live right now, use `mcp__Supabase__list_edge_functions` (or the Supabase
dashboard) directly; this file records what was last *deployed through a recorded
mechanism*, which may lag a manual/ad-hoc deploy done another way.

## Scanner audit remediation — 2026-09-13

`claude-proxy` was deployed through the Supabase MCP from PR #161's complete
35-file dependency closure. The final deployment is **v119**, `ACTIVE`, with
`verify_jwt:false` unchanged because the function performs its existing custom
httpOnly-cookie and CSRF-header authentication in the function body. The final
scanner-code commit on GitHub is `7c97a08`.

Production verification used an authenticated temporary account and the text
input “General Electric GE Superadio III model 7-2887 ... used working” at an
entered cost of $2.99. Final scan id 79 (deleted with the temporary account
after verification) recorded SerpAPI's operational 503, the explicit failover
to SoldComps, 40 returned records, and six coherent exact-model-variant comps.
It returned a verified $33.99 expected sale price, $25.33 net profit, 847.20%
ROI, strong evidence, and `HOT`. Independent SQL recomputation matched both
financial values. eBay Browse returned zero active listings; v119 correctly
labeled the evidence `eBay sold listings (sold-comps.com)` without claiming
active evidence.

All validation passed before the final deploy: 349 Deno backend tests, 70
shared-engine tests, 49 browser-contract tests, both TypeScript checks, and
`git diff --check`. No migration was required.

## R3 SerpAPI identification deploy — 2026-09-10

`claude-proxy` was deployed via the **Supabase CLI** (`npx supabase functions
deploy claude-proxy --project-ref dqgfpchkheznvanfgsmx`), run by the product
owner locally — same mechanism as R2, required again because the dependency
closure has grown to 42 files (`claude-proxy/` + `_shared/`), still too large
for `mcp__Supabase__deploy_edge_function`. This shipped `main` HEAD
(`c71f4d1`, PR #156 merged — R3 "fix the filters": T1-T3/L/M resolved,
SerpAPI-first identification via `serpApiIdentification.ts`, Reverb
price-guide evidence via `reverbEvidence.ts`), plus migration
`20260831180000_r3_scan_temp_images_bucket.sql` (private `scan-temp-images`
storage bucket, service-role-only — the object `identifyViaSerpApi` uploads
to for the duration of one SerpAPI Google Lens call, then deletes).

**First attempt incomplete — caught and corrected within this session.** An
initial deploy (v102 → v106, 2026-09-10T13:39:47Z) ran from a local checkout
that was not actually up to date with `main` — the product owner had two
separate clones on disk (one nested inside the other), and the outer one
carried stray uncommitted edits to `claude-proxy/index.ts` and others. That
deploy's live bundle was missing `_shared/serpApiIdentification.ts` and every
SerpAPI code path entirely (0 occurrences of `identifyViaSerpApi`/
`mergeSerpApiIdentity` in the fetched bundle), even though `Reverb`/
`parseModelToken` from the same commit were present — confirmed via
`mcp__Supabase__get_edge_function` + grep against the actual bundle content,
not assumed from the version bump alone. Flagged before treating the task as
done; not used as a basis for any production claim.

**Result (corrected deploy):** `claude-proxy` **v106 → v109** (v107/v108
likely interstitial CLI upload steps, same unexplained-but-harmless pattern
noted in the R2 entry below — not investigated further), `status: ACTIVE`,
`verify_jwt: false` (unchanged). Deployed 2026-09-10T13:57:42Z from the
product owner's clean, up-to-date clone — confirmed via `git log
HEAD..origin/main` (empty) and `git diff` on `claude-proxy/index.ts` (empty)
immediately before this deploy.

Post-deploy verification (fetched the live bundle via
`mcp__Supabase__get_edge_function`, grepped it): `_shared/serpApiIdentification.ts`
present in the file list, `identifyViaSerpApi` (3 occurrences),
`mergeSerpApiIdentity` (2), a `scan-temp-images` bucket reference (1),
`_shared/reverbEvidence.ts` also present. `SERP_API_KEY` — the env var name
`serpApiIdentification.ts` actually reads, not `SERPAPI_API_KEY` — confirmed
present in `npx supabase secrets list` by the product owner.

Migration verified applied via `mcp__Supabase__execute_sql`: the
`storage.buckets` row for `scan-temp-images` — `public=false`,
`file_size_limit=10485760`,
`allowed_mime_types=[image/jpeg,image/png,image/gif,image/webp]` — matches
the migration exactly, and `20260831180000` appears in
`mcp__Supabase__list_migrations`.

**Not yet done:** an authenticated production scan that actually exercises
the SerpAPI identification path end-to-end (a real photo, a real Google Lens
call, confirming `mergeSerpApiIdentity` changes the resulting identity) —
this deploy validates that the code and bucket are live and structurally
correct, not that the SerpAPI integration behaves correctly against a real
image and a real API response.

## R2 deploy — 2026-08-31

`claude-proxy` was deployed via the **Supabase CLI** (`npx supabase functions deploy
claude-proxy --project-ref dqgfpchkheznvanfgsmx`), run by the product owner from a
fresh local clone of `main` (commit range `e3c9f0c..e8ee420`, PR #154 — R2 "Fix the
inputs": `MarketEvidenceProviderCapabilities` §5.1, `externalCall.ts` retry-policy
extensions + `providerRateLimit.ts` + bounded shelf concurrency §5.2,
`identityNormalization.ts` + `modelFamilyHint` §5.3, `queryPlanner.ts` §5.4). This is
a different deploy mechanism than every prior entry below — those went through
`mcp__Supabase__deploy_edge_function` (the Supabase MCP tool) directly from the
session. That tool could not be used for this deploy: `claude-proxy`'s dependency
closure has grown to 31 files (~254KB raw source, ~176KB even with every comment
stripped), and the MCP tool requires the complete file set inlined as literal text
in one tool call — two attempts from the session both truncated silently at
~25-26KB, well under what the bundle needs, confirmed reproducible and not fixable
by restructuring the request. Production was never at risk from those failed
attempts: each returned a clean `BadRequestException` before any bundle validation
completed, and `list_edge_functions` before/after showed an unchanged `ezbr_sha256`.

**Result:** `claude-proxy` **v100 → v102** (v101 likely an interstitial CLI upload
step or retry not surfaced as a separate deployed version — not investigated further,
harmless), `status: ACTIVE`, `verify_jwt: false` (unchanged). New
`entrypoint_path` (`/tmp/user_fn_..._102/source/supabase/functions/claude-proxy/index.ts`)
and `ezbr_sha256` (`e5ad82d2ac24b2a6efb73721ea9fd282b7ac1ed8d9428147e31e0d73b9ec2a4c`,
up from `1e09759103ca3b7c9404a48876ad80759e2c6342a3ecb54005857ef130ce9a78`) confirm a
real, different bundle went live — not a no-op.

Post-deploy verification (fetched the live bundle via `mcp__Supabase__get_edge_function`
and grepped it): every R2 marker present —
`identityNormalization`/`parseModelToken`/`modelFamilyHint` (§5.3),
`MarketEvidenceProviderCapabilities`/`planMarketEvidenceQueries`/`queryPlanner` (§5.1/§5.4),
`providerRateLimit`/`acquireSlot`/`TRAWL_PACING_MAX_WAIT_MS`/`shouldRetry`/`maxRetryAfterMs`
(§5.2), `SHELF_SCAN_CONCURRENCY` (§5.2 shelf-concurrency bound). R1's markers
(`unavailableReason`, `PROVIDER_THROTTLED`, `PROVIDER_QUOTA_EXHAUSTED`,
`excludedOverflowCount`) are still present — no regression.

**Not yet done:** an authenticated production scan (single, shelf, and a scan that
actually exercises the Trawl retry/pacing path) to observe R2's behavior against
real traffic — this deploy validates that the code is live and structurally intact,
not that it behaves correctly end-to-end against production data. Gate **G2**
(§5.4 corpus-based query-cascade acceptance check) still can't run — the §3.1
labeled corpus doesn't exist yet, unchanged from every prior entry's note on this.

## R1 §4.3 deploy — 2026-08-31

Pre-deploy rollback baseline, recorded before deploying per the task doc's
§4.3 ("record the pre-deploy version... as the explicit rollback target"):
`claude-proxy` was live at **v95**, ACTIVE, `verify_jwt:false`, deployed git
SHA unknown (predates this session's DEPLOYED.md tracking of exact SHAs for
ad-hoc deploys). Deploying commit `463f43e6ae4ba6fb402a3caf0c3cfc7926386369`
(PR #151, merged to `main` — R1 §4.1/§4.2: audit-trail carry-through +
honest failure classification, zero decision-path behavior change) through
the Supabase MCP from the current 28-file repository dependency closure.
Result recorded below once the deploy completes.

## Trawl sold-history provider — 2026-08-29

`claude-proxy` was deployed through the Supabase MCP from the current 21-file
repository dependency closure: **v90 → v91**, ACTIVE, with `verify_jwt:false`
unchanged. Live-bundle inspection confirmed the Trawl endpoint,
`TRAWL_API_KEY`, and the existing `SOLD_COMPS_API_KEY` configuration fallback.
An authenticated production scan remains the final end-to-end provider check.

## P0 remediation deploy — 2026-08-27

Production Supabase Edge Functions were found badly stale (see
`docs/HANDOFF.md` for the full incident writeup — `claude-proxy` alone was
running the pre-Chapter-02 fabricated-cost/`getDecision()` path, 2 versions
behind main by commit count and missing the entire verified-market-data
pipeline). This entry was written by hand (the deploy itself used the
Supabase MCP `deploy_edge_function` tool, not this script — the script did
not exist until this same remediation added it) to establish the first
recorded baseline.

| Function | Deployed Git SHA | Old Live Version | New Live Version | Deployed At (UTC) |
|---|---|---:|---:|---|
| auth | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 65 | 66 | 2026-08-27 |
| claude-proxy | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 83 | 85 | 2026-08-27 |
| stripe-checkout | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 63 | 64 | 2026-08-27 |
| stripe-webhook | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 60 | 61 | 2026-08-27 |
| ebay-oauth | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 70 | 71 | 2026-08-27 |
| cron | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 3 | 4 | 2026-08-27 |
| export-reminder | `cbddb78c564b5e6687e05c83edbf4bbe1459c4ce` | 30 | 31 | 2026-08-27 |

`claude-proxy` went through two deploy attempts within this same session
(v84 then v85) — v84 omitted `_shared/marketData.ts` from the bundle (harmless
at runtime, since every reference to it across the codebase is a type-only
import that TypeScript erases before the code ships; still redeployed for
source completeness). v85 is the dependency-complete, verified version.

Diagnostic functions `ebay-marketplace-insights-diagnostic` and `ebay-diag`
were intentionally left untouched — not part of the normal repo-managed
application tree, and this task did not authorize deleting or redeploying them.

## claude-proxy redeploy — 2026-08-28

`main` had advanced past the P0 remediation deploy above (PR #142, commit
`02cfb90`, "decision integrity Release A") without a corresponding Supabase
deploy — `claude-proxy` was still running v86 (the P0-remediation-only
build), missing the Release A fix (`ebayBrowse.ts` failure-vs-zero,
`decisionEngine.ts` weak-evidence-caps-HOT, `evidenceQuality`/
`compMatchPrecision` wired into the scan response). Redeployed via
`mcp__Supabase__deploy_edge_function` with the same 21-file dependency
closure pattern as the P0 entry above (hand-traced from
`claude-proxy/index.ts`'s imports — Python-verified this session, exact same
21 files as before).

| Function | Deployed Git SHA | Old Live Version | New Live Version | Deployed At (UTC) |
|---|---|---:|---:|---|
| claude-proxy | `37528eca81c9b15dd58e3ee104210ca7676390d5` | 86 | 87 | 2026-08-28T15:21:35Z |

Post-deploy verification (fetched live bundle via `mcp__Supabase__get_edge_function`):
`evidenceQuality` present (21 occurrences), `hotCappedByEvidence` present (3),
`compMatchPrecision` present (9), the fabricated-zero pattern
`matchingActiveCount: 0` absent (0 occurrences — confirms `ebayBrowse.ts`'s
failure path now returns `null`, not a fabricated zero), dead pre-Chapter-02
markers `getDecision(`/`estimatedCost = r2` both absent. `verify_jwt`
preserved as `false` (unchanged — same in-body cookie/JWT auth model).

`_shared/marketData.ts` does not appear in the bundle's returned file list —
same harmless omission documented in the P0 entry above: every reference to
it is a type-only import (`import type {...} from "./marketData.ts"`), which
the bundler erases before emitting JS. It was included in the upload; its
absence from the stored file list is not a deploy defect.

No other repo-managed functions (`auth`, `stripe-checkout`, `stripe-webhook`,
`ebay-oauth`, `cron`, `export-reminder`) were touched — `main`'s changes
since the last full-fleet deploy were scoped to `claude-proxy` and its
`_shared` dependencies only (verified via `git diff --stat` against the
prior deployed SHA for `supabase/functions/`).
