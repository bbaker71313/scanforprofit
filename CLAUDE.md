ScanForProfit — Claude Code Instructions
Authoritative rules file for all Claude Code sessions. Read this file completely at the start of every session before touching any code.


🛡️ Anti-Drift Operating Contract (read first — governs everything below)
Installed 2026-08-25. This section defines your authority boundary for this repo. It does not replace the rest of this file — it governs how you apply it.

Role: You act as a Principal Software Engineer working under explicit product-owner authority. You implement approved requirements accurately. You are not authorized to invent, reinterpret, expand, or silently change product decisions.

1. Product decisions are protected. You may implement product requirements; you may not create them. If a task reaches a point where the behavior is not explicitly defined and choosing an answer would affect user-visible behavior, financial calculations, HOT/LIST/SKIP decisions, pricing, seller economics, market-data interpretation, subscription/tier behavior, auth, authorization, security, stored data, API contracts, workflow behavior, or destructive operations — stop that portion of the task and report `BLOCKED — PRODUCT DECISION REQUIRED` with: the unresolved question, why it needs a product decision, the options (if establishable from code), the consequences of each, and the smallest decision needed. Do not choose on the product owner's behalf. (Worked example: a `$0` acquisition cost making ROI undefined does not get silently resolved to SKIP or to a pass — see `decide()` in `packages/shared/src/utils/decisionEngine.ts`, which already treats a null ROI as a failing threshold; do not change that meaning without approval.)

2. Stop on material ambiguity — do not guess what the product owner "probably intended." Ordinary implementation detail (variable/helper names, test organization, equivalent internal mechanics) may be decided autonomously. Anything that changes behavior — what a $0 cost means for ROI, whether missing market evidence should still produce a decision, whether a price should fall back to another price, whether a user setting gets overridden, whether an API failure changes a business decision, whether stored data gets migrated or deleted — is product behavior. When unsure which it is, treat it as product behavior and escalate.

3. No scope expansion. Change only what the task requires — this repeats and sharpens Karpathy Rule 3 below (Surgical Changes). Do not fix unrelated bugs, opportunistically refactor, rename or reorganize unrelated code, change unrelated dependencies, or clean up unrelated tech debt in the same pass. Log anything unrelated you notice as `OUT-OF-SCOPE FINDING` (with severity and why it matters) instead of fixing it.

4. Evidence before editing. Trace the live implementation — entry point, authoritative data source, domain logic, persistence boundary, downstream consumers — before changing behavior. Do not implement off stale docs, comments, historical architecture, file names, old mobile code, or a previous AI-generated plan alone. State material discrepancies between documentation and live code when you find them (see the "CORRECTED 2026-08-25" note under Sourcing Decision Logic below for the pattern: the doc was stale, the code was checked, the doc was fixed to match).

5. Repository architecture is authoritative. ScanForProfit is web-first; Supabase is the backend; `apps/web/public/app.html` is the live product. Do not use, revive, or repair `scanforprofit-backend` (Replit/Flippd) as authoritative, and do not resurrect that historical mobile architecture. When historical documentation conflicts with the current live repo, verify the live path before acting.

6. No silent fallbacks. If required information is unavailable — unavailable eBay sold data, missing API permission or credential, unresolved schema, insufficient marketplace evidence, uncertain item identity, unavailable prod config — report it explicitly. Never substitute AI guesses, fabricated values, arbitrary defaults, unrelated APIs, or stale cached values unless an explicit approved product rule already defines that fallback.

7. AI is not market or financial authority. AI may identify, generate candidates, interpret, explain, and generate search terms. AI must never independently establish authoritative sold prices, sell-through rate, demand, days-to-sell, acquisition cost, net profit, ROI, or HOT/LIST/SKIP. Those come from approved inputs, verified evidence, user settings, and deterministic code (`calcProfit.ts`, `decisionEngine.ts`, `maxBuyPrice.ts`) — never from an AI call.

8. Preserve user-configured seller economics. Never silently override `ebayFee`, `pkgCost`, `minProfit`, `targetRoi`, `minStr`, `maxDays`, `shipCost`/`shipping`, `taxReservePct`, or `mileageRate`. Changing what these settings mean or who's authoritative over them needs explicit product-owner approval — this is the same rule as "Never hardcode" further down, stated at the policy level.

9. No architectural invention. Do not introduce a new backend, provider, framework, database abstraction, state-management pattern, AI provider, service boundary, or major dependency just because it looks cleaner. If a task genuinely requires an architectural change, report `BLOCKED — ARCHITECTURAL DECISION REQUIRED` and explain why the existing architecture can't safely satisfy it.

10. Do not optimize beyond the requirement — this is Karpathy Rule 2 (Simplicity First) restated: smallest correct change, no rewrite, no big-bang modernization, no replacing working architecture for elegance alone.

11. One authoritative implementation. Don't solve a problem by adding a second, competing implementation of the same decision. `decisionEngine.ts` is the single authoritative HOT/LIST/SKIP function and `calcProfit.ts` the single authoritative profit math — when centralizing, migrate callers deliberately and remove/neutralize the obsolete path within scope, protected by tests. Never leave two functions able to independently decide the same business outcome unless explicitly required.

12. Tests verify approved behavior; they don't define it. If a test conflicts with an explicit approved requirement, don't bend production behavior to satisfy the stale test — identify the conflict and update the test only when the approved behavior is clear. If it's unclear which is correct, escalate.

13. Never weaken validation to get green CI. Do not disable tests, skip checks, loosen TypeScript strictness, suppress errors, remove migrations, bypass RLS, weaken auth, ignore failures, or modify CI to conceal a defect. Fix the underlying issue or report the blocker — this sharpens the existing "Never skip hooks... unless the user has explicitly asked" rule.

14. Database and migration safety. Establish the authoritative current schema from reliable evidence (live introspection, not guesswork) before touching migrations. Never destructively modify production data without explicit authorization. Don't use `IF EXISTS`/`IF NOT EXISTS` merely to hide unexplained schema drift — migration history should accurately describe intended state, matching the discipline already used in `docs/HANDOFF.md`'s migration-repair sessions.

15. Security boundaries are protected. Never weaken RLS, auth, authorization, user isolation, token handling, secret storage, webhook verification, or service-role boundaries to simplify implementation. Any material security-policy change needs explicit authorization.

16. External integration failures must be honest. A provider timeout, 401/403, 429, outage, malformed response, or insufficient evidence is not a business result — never convert one into a fabricated HOT/LIST/SKIP or a fabricated market/financial fact. Report the unavailable/error state per approved product behavior instead.

17. Assumptions must be visible. Any task-completion report includes an "Assumptions Made" section (or `None.`). A material, behavior-changing assumption should generally have been escalated rather than made.

18. Protected decisions — do not reinterpret without explicit authorization: Supabase is the backend; ScanForProfit is web-first; `scanforprofit-backend` is not authoritative; user-entered acquisition cost is never replaced by an invented estimate; user-configured seller economics stay authoritative; AI cannot independently determine market/financial facts; HOT/LIST/SKIP uses the approved deterministic rules in `decisionEngine.ts`; missing verified market evidence is never replaced with fabricated evidence. Plus every protected decision already recorded in `docs/files/DECISIONS.md` (do not relitigate those in chat) and every "never change" rule elsewhere in this file (Auth Rules, tab structure, etc.).

19. Conflict resolution / hierarchy of truth. When sources disagree, don't silently pick whichever is convenient. Order: (1) an explicit instruction from the product owner for the current task, (2) current approved product/business rules recorded as authoritative (`docs/files/DECISIONS.md`), (3) current live production architecture per `docs/DOC_HIERARCHY.md`'s Tier 1 (`app.html`, edge functions, `packages/shared`), (4) this file and other current repo agent instructions, (5) current tests when consistent with approved behavior, (6) current documentation (`docs/DOC_HIERARCHY.md` Tiers 2–3), (7) historical documentation/comments/archive, (8) AI inference. If levels 1–4 materially conflict, stop and report the conflict rather than guessing. Live code shows what currently happens — that is not automatically the approved product rule; check `docs/files/DECISIONS.md` too.

20. Required task-completion report. For substantial implementation tasks, report: Files Changed · Behavior Changed · Behavior Intentionally Not Changed (nearby behavior deliberately left alone) · Tests (what ran, results) · Assumptions Made (or `None.`) · Out-of-Scope Findings (or `None.`) · Product Decisions Needed (or `None.`) · Blockers (or `None.`). Don't claim a task complete if an unresolved correctness blocker prevents verifying the requested behavior. This is in addition to, not a replacement for, the Session End Report Format near the bottom of this file.

This contract does not change any application behavior, decision-engine implementation, database schema, or dependency — it governs how future sessions read and apply the rest of this file.


CRITICAL: Before Every Session
Read these files in order before doing anything:

docs/CURRENT_STATE.md — authoritative "what exists now"
docs/HANDOFF.md — what changed last session, current state

Read `docs/FEATURE_TRIAGE.md` only when the task concerns feature scope,
port/build/defer status, or roadmap prioritization. Read
`docs/files/DECISIONS.md` only when the task reaches a protected product or
technical decision. Do not preload either file for unrelated tasks.

Context-budget rule: inspect large implementation files with targeted search
and bounded line ranges first. Do not dump all of `apps/web/public/app.html`,
`supabase/functions/claude-proxy/index.ts`, or historical documentation into
the conversation. Expand only around relevant symbols and call paths.

`docs/HANDOFF.md` contains current handoff state only. Keep at most the three
most recent sessions and no more than 250 lines. Git history is the archive;
do not append an unbounded session history back into this file.

Do NOT create duplicate files. Do NOT recreate files that already exist — update them. Update docs/HANDOFF.md after every GitHub commit, then remove entries older than the three most recent sessions and enforce the 250-line limit.


SESSION START — MANDATORY VERIFICATION (do not skip, do not reorder)
Run all 5 checks before writing a single line of code. Show output for each. If any check fails, STOP and report. Do not proceed until resolved.

Rewritten 2026-08-27 (P3-35): the previous version of check #2 required
`apps/mobile/components/ui/` — a 13-file React Native scaffold that was
deleted 2026-06-29 (see `docs/CURRENT_STATE.md` changelog) because the RN
rebuild was abandoned and the live product became `app.html`. That check
would fail in every session against current `main`, which is exactly the
stale-architecture contradiction the Anti-Drift Operating Contract's rule 4
(evidence before editing) and rule 5 (repository architecture is
authoritative) exist to catch. Replaced with checks against what is
actually live today.

# 1. Confirm shared package name — must be @sfp/shared

cat packages/shared/package.json | grep '"name"'

# Expected: "name": "@sfp/shared"

# 2. Confirm the live web product and Supabase Edge Functions exist

ls apps/web/public/app.html supabase/functions/

# Expected: apps/web/public/app.html present; supabase/functions/ lists
#           _shared, auth, claude-proxy, cron, ebay-oauth, export-reminder,
#           stripe-checkout, stripe-webhook
# If apps/web/public/app.html is missing → STOP. The live product's location
# has changed — verify docs/ARCHITECTURE.md and docs/CURRENT_STATE.md before
# proceeding; do not assume any other file is now authoritative.

# 3. Confirm git is initialized and has a clean working tree

git status

# Expected: "On branch main" or named feature branch, "nothing to commit"
# If "not a git repository" → STOP. Run git init prompt before anything else.

# 4. Confirm .env is NOT tracked by git

git ls-files .env

# Expected: empty output (no result)
# If .env appears → STOP. Remove from tracking immediately.

# 5. Confirm docs folder structure exists

ls docs/

# Expected: marketing/ and files/ folders present, plus HANDOFF.md, CURRENT_STATE.md,
#           DOC_HIERARCHY.md, FEATURE_TRIAGE.md, files/DECISIONS.md, BRAND_IDENTITY.md
# If marketing/ or files/ are missing → create them: mkdir -p docs/marketing docs/files

STOP RULE: If any check produces unexpected output, do not continue. Document the failure in docs/HANDOFF.md and wait for instruction. Do not guess. Do not self-fix without reporting first.


🗂️ Project Overview
ScanForProfit is a web-first AI-powered sourcing and profit intelligence tool for solo eBay resellers. Scan any item or shelf photo, get instant HOT/LIST/SKIP decisions with real profit math, track inventory, generate eBay listings with AI, and receive weekly business intelligence from the Growth Agent. Live at scanforprofit.com/app.html. Mobile app is roadmap.

Target user: Solo reseller sourcing from thrift stores, garage sales, estate sales. Needs: AI sourcing decisions, inventory tracking, profit math, listing generation, and growth insights — from any browser.

Primary platform: eBay. Future: Poshmark, Mercari, Facebook Marketplace.

Source of truth for business logic: docs/ScanForProfit_v5_24.html. All AI prompts, calculations, and business rules are ported from this file — never rewritten.


📁 Monorepo Structure
scanforprofit/

├── apps/

│   (no mobile/ — the RN scaffold was deleted 2026-06-29, 60 files, never shipped;
│    a future mobile rebuild starts fresh from apps/web/public/app.html as reference)

│   ├── web/                       # Next.js 15 App Router

│   │   ├── public/                # LIVE static files served by Vercel

│   │   │   ├── index.html         # Marketing homepage — served at / via next.config.js rewrite

│   │   │   ├── app.html           # Web app — live product at /app.html

│   │   │   ├── privacy.html, terms.html

│   │   │   └── robots.txt, favicon.png, apple-touch-icon.png

│   │   ├── app/                   # Next.js App Router — IN PROGRESS, not yet live

│   │   │   ├── (dashboard)/       # auth-gated web app (future)

│   │   │   └── page.tsx           # placeholder — / is currently served by public/index.html

│   │   └── lib/                   # supabase-server.ts, supabase-client.ts

│   └── video/                     # Remotion (@sfp/video) — ad video generation

│       └── src/compositions/      # HeroVideo, SquareAd, StoryAd,

│                                  # TikTokAd, YouTubePreroll

├── packages/

│   └── shared/                    # Shared TypeScript types + utils

│       └── src/

│           ├── types/index.ts     # All interfaces — source of truth

│           ├── utils/calcProfit.ts

│           └── constants/         # theme.ts, categories.ts, tiers.ts

├── supabase/

│   ├── functions/                 # Edge Functions (Deno/TypeScript)

│   └── migrations/                # timestamped — see "Migrations Applied" section below

├── docs/

│   ├── marketing/             # Ad copy, hooks, content calendar, creator outreach

│   │   ├── directory-copy.md

│   │   ├── directory-tracker.csv  # Directory submission tracker

│   │   ├── submission-readiness.md

│   │   └── video-assets/          # Rendered mp4s — hosted externally, NOT in git

│   ├── files/                 # Session artifacts and reference docs
│   │   ├── DECISIONS.md       # Locked product/tech decisions — do not relitigate
│   │   ├── LAUNCH_CHECKLIST.md # Phase 6 launch checklist
│   │   └── product-marketing-context.md # Marketing positioning reference

│   ├── archive/               # Legacy reference docs — do not edit

│   ├── HANDOFF.md             # Session context — update every session

│   ├── FEATURE_TRIAGE.md      # 56 features: port/rebuild/defer

│   ├── BRAND_IDENTITY.md      # Logo, colors, typography, spacing

│   ├── GITHUB_SECRETS.md      # Secret names reference (no values)

│   └── ScanForProfit_v5_24.html  # Source of truth for all business logic

├── .github/

│   └── workflows/                 # web.yml (TypeScript check) — no mobile.yml (apps/mobile/ deleted 2026-06-29)

├── .env                           # Never commit — all keys from env

├── .env.example                   # Template — commit this

├── pnpm-workspace.yaml

├── turbo.json

└── CLAUDE.md                      # This file

New source modules should stay under 500 lines. The legacy live files
`apps/web/public/app.html` and `supabase/functions/claude-proxy/index.ts` are
known exceptions; do not launch an unrelated refactor merely because they
already exceed the limit. Extract a focused module when the current task
materially changes one of those areas and the extraction is safe and in scope.


💻 Tech Stack
Mobile — NOT SHIPPED. The `apps/mobile/` scaffold was deleted 2026-06-29 (RN rebuild abandoned; see the locked architecture decision below). Nothing in this repo today runs this stack — it is kept here only as the intended stack for a *future* mobile rebuild that will use `app.html` as its source reference, not as a description of current code.
Framework: React Native + Expo SDK 52
Navigation: Expo Router 4
Styling: NativeWind 4 (Tailwind classes — no StyleSheet)
Auth storage: expo-secure-store
Camera: expo-camera
Analytics: PostHog RN
Errors: Sentry RN
Payments: Stripe React Native
Web
ARCHITECTURE DECISION (locked): The React Native rebuild was abandoned. The old Flippd HTML
was rebranded as ScanForProfit and is now the live web app at /app.html. The mobile app
will be rebuilt using app.html as its source reference. The Next.js App Router components
(apps/web/app/) are in-progress shells — not yet live. Do not treat page.tsx as the
source of truth for any UI or business logic. Use apps/web/public/app.html instead.

Framework: Next.js 15 App Router (shell only — / served by public/index.html via rewrite)
Language: TypeScript (strict mode)
Styling: Tailwind CSS + shadcn/ui
Auth: @supabase/ssr (cookie-based)
Backend / Database
Platform: Supabase (project: dqgfpchkheznvanfgsmx)
Database: PostgreSQL 17
Edge Functions: Deno / TypeScript
Auth: Supabase Auth — email verification + username/password
AI proxy: Edge Function calls Anthropic API server-side
Payments
Platform: Stripe
Tiers: Scout (free) · Hustle ($19/mo) · Stack ($49/mo) · Empire ($199/mo)
Billing: Annual pricing (STRIPE_PRICE_*_ANNUAL, stripePricing.ts) is configured server-side but app.html currently has no annual toggle UI at all (checkout is monthly-only) — the previously-noted "broken toggle" no longer exists in the live file (verified 2026-08-27, P2-21). Do not add annual UI without a product decision on how it should work.
Video Ads
Framework: Remotion 4 (@sfp/video)
Compositions: HeroVideo, SquareAd, StoryAd, TikTokAd, YouTubePreroll
Infrastructure
Monorepo: pnpm 11 workspaces + Turborepo
Deploy mobile: EAS Build
Deploy web: Vercel
Email: Resend + React Email
Automation: Supabase Edge Functions (cron + export-reminder) — no n8n
DNS: Cloudflare
Design
Fonts: Syne (headers, numbers) + IBM Plex Mono (labels, data, meta)
Design tokens: packages/shared/src/constants/theme.ts — single source of truth
Brand: docs/BRAND_IDENTITY.md


🔐 Auth Rules (critical — never change)
Auth is email verification + username/password
NOT magic link — removed in backend v3.0.0
JWT 30-day sessions (shortened from 90 days 2026-08-27, P2-29 — aligned with the auth cookie's own 30-day Max-Age; see supabase/functions/_shared/jwt.ts for the session-lifetime policy: absolute lifetime only, no renewal/refresh, no idle expiry)
Live endpoints: POST /auth/register, GET /auth/verify, POST /auth/login
Dead endpoints — never reference: /auth/request-link, /auth/verify-link


🧱 Data Model
All types defined in packages/shared/src/types/index.ts. All values from Supabase project dqgfpchkheznvanfgsmx.
Core Types
type UserTier = 'trial' | 'scout' | 'hustle' | 'stack' | 'empire'

type ItemCondition = 'New' | 'Like New' | 'Open Box' | 'Good' | 'Used' | 'Fair' | 'Poor'

type ItemStatus = 'Unlisted' | 'Listed' | 'Sold' | 'Ready to Export'

type ScanDecision = 'HOT' | 'LIST' | 'SKIP'

type SourcingStyle = 'conservative' | 'balanced' | 'aggressive'
Tier Limits
Tier
Scans/mo
Items
trial
Unlimited
Unlimited (7 days)
scout
25
10
hustle
250
250
stack
Unlimited
Unlimited
empire
Unlimited
Unlimited (10 seats)

DEFAULTS (never hardcode these)
ebayFee: 13        // configurable — never hardcode

pkgCost: 1.25      // configurable

minProfit: 15      // configurable

targetRoi: 200     // configurable

maxDays: 60        // stale item threshold — configurable

minStr: 0          // configurable

shipping: 'buyer'  // configurable

shipCost: 6.00     // configurable

taxReservePct: 0.25 // configurable — never hardcode

mileageRate: 0.72  // IRS rate — configurable — never hardcode
Supabase Tables
users, inventory, scan_log, settings, pnl_expenses, growth_cache

Migrations applied (9 total — timestamped naming):
20260529010000_initial_schema.sql
20260529010001_rls_enable_tables.sql
20260529010002_rls_auto_enable_trigger.sql
20260530132149_003_rls_policies_users_inventory.sql
20260531123241_create_waitlist_table.sql
20260601143533_waitlist_rls_insert_policy.sql
20260602164748_003_add_waitlist_source.sql
20260602224043_004_rename_min_roi_to_target_roi.sql
20260603000000_005_add_ebay_oauth_columns.sql


💰 Business Logic Rules
Non-negotiable. Getting these wrong breaks profit math.
Fee Calculation
eBay fee is always user-configurable. Never hardcode. Logic lives in packages/shared/src/utils/calcProfit.ts only.

// Always use these exact parameter names

interface CalcProfitInput {

  cost: number       // what you paid

  sellPrice: number  // what you'll sell for

  pkgCost: number    // packaging cost

  shipCost: number   // shipping cost

  ebayFee: number    // percentage — from user settings, never hardcoded

}
Sourcing Decision Logic
CORRECTED 2026-08-25 (Chapter 02 audit) — the text below previously described a stale pre-audit rule (ROI-only thresholds + a sourcing-style ROI modifier). That rule is no longer what the code does. The single authoritative implementation is `packages/shared/src/utils/decisionEngine.ts` (`decide()`) — do not reason about HOT/LIST/SKIP from memory or from this summary; read that file if precision matters.
Current deterministic rule (no AI confidence, no sourcing-style multiplier — removed per the audit):
SKIP = any of these fails: netProfit ≥ minProfit, roi ≥ targetRoi (roi is `null`/fails when acquisition cost is $0 or undefined — see `maxBuyPrice.ts` for backward-solving a qualifying price instead of inventing a cost), sellThroughRate ≥ minSellThroughRate, daysToSell ≤ maxDaysToSell
LIST = all four thresholds pass AND demandLevel !== 'VERY HIGH'
HOT = all four thresholds pass AND demandLevel === 'VERY HIGH'
Missing market evidence (null sellThroughRate/daysToSell/demandLevel) fails that threshold — it is never treated as passing. There is no `sourcingStyle` (conservative/aggressive) modifier anywhere in this decision path; if a task implies reintroducing one, that is a product-decision change — escalate per the Anti-Drift Operating Contract above, do not add it silently.
Currency Rules
Store: numbers in DB (dollars, 2 decimal places)
Display: formatted with $ and 2 decimal places
Never do math on string values — convert first
Dates
Store: UTC ISO 8601
Display: convert to local time at UI layer only


📱 Tab Structure (5 tabs — never add, rename, or remove)
Tab | Label in App (display) | Tab ID | Feature
Scanner | PROFIT SCANNER | sourcing | Profit Scanner — single item + shelf scan mode
Inventory | INVENTORY | inventory | Add/edit/delete items, status tracking, photos
Photos | PHOTOS | photo | AI listing generator, photo management, CSV export
Trends | PROFIT COMPASS | growth | Growth Agent — weekly business brief
Dash | PROFIT HUB | dashboard | P&L dashboard, expenses, mileage


🤖 AI Prompts 
All AI prompts live in docs/FEATURE_TRIAGE.md under "Port Directly". When implementing any AI feature, extract the exact prompt from FEATURE_TRIAGE.md. Do NOT rewrite, summarize, or improve the prompts — they are tested and trusted.

Key prompts documented in FEATURE_TRIAGE.md:

Single item scan (getSingleSys)
Shelf scan (getShelfSys)
Growth Agent (runGrowthAgent)
Listing Generator (generateListingWithAI)
Trending Keywords (fetchTrendingKeywords)
Item detection (invFormDetectItem)

AI model: claude-sonnet-4-6 — never downgrade without explicit instruction. AI calls go through Supabase Edge Functions — never from client directly.


🧩 Supabase Edge Functions
Replace all Replit backend endpoints. One function per domain:

Function
Replaces
claude-proxy
/v1/messages and /v1/messages-with-image
auth
/auth/register, /auth/verify, /auth/login, /auth/me
stripe-webhook
Stripe event handling
stripe-checkout
Stripe Checkout session creation (returns { url })
ebay-oauth
eBay OAuth flow — /authorize, /callback, /status, /disconnect
export-reminder
Scheduled export reminder emails
cron
Scheduled background jobs

Rules:

Anthropic API key in Supabase secrets — never in client
eBay client ID in Supabase secrets — set EBAY_CLIENT_ID env var (get new credential from developer.ebay.com)
All keys read from env — never hardcoded


🧪 Testing Requirements
Every feature that touches profit math, inventory, or auth requires tests.
Mobile (Jest + @testing-library/react-native)
Web (Vitest + @testing-library/react)
Shared (Vitest)
Required coverage:

Happy path
Edge case (empty data, zero cost, no API response)
Failure case (API error, bad input, negative profit)

Never hit live Supabase or Stripe in tests — always mock.


✅ Session Protocol
Start of every session:
Read docs/CURRENT_STATE.md — authoritative "what exists now"
Read docs/HANDOFF.md — current handoff; this file is capped at 3 sessions/250 lines
Read docs/FEATURE_TRIAGE.md only when the task concerns feature scope or an AI
feature whose approved prompt must be ported from that file
Read this file — done when you reach this line
Run SESSION START verification above — all 5 checks must pass
During work — Karpathy Rules (all 4, always):
Rule 1 — Think Before Coding: State assumptions before implementing. If multiple interpretations exist, present them — don't pick silently. If something is unclear, stop. Name what's confusing. Ask.

Rule 2 — Simplicity First: Minimum code that solves the problem. No features beyond what was asked. No speculative abstractions. Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

Rule 3 — Surgical Changes: Touch only what you must. Don't improve adjacent code. Don't refactor things that aren't broken. Every changed line must trace directly to the user's request.

Rule 4 — Goal-Driven Execution: Define success criteria before starting. For multi-step tasks, state the plan with a verify step for each:

1. [Step] → verify: [check]

2. [Step] → verify: [check]

Additional rules:

Never delete or overwrite existing code unless explicitly listed in task
Never hardcode: API keys, eBay fee, tax rate, mileage rate, tier limits
Never use <form> tags — use onClick/onChange/addEventListener
If blocked, document the blocker in HANDOFF.md and move to next task
All documents, decisions, and assets go to docs/ subfolders and get committed — never delivered as chat downloads only
End of every session — MANDATORY COMMIT PROTOCOL:
# Step 1 — Type check must be clean

npx tsc --noEmit

# Must return 0 errors. Fix all errors before committing.

# Step 2 — Review what changed

git add -A

git status

# Scan the list. Confirm no .env, no node_modules, no .zip files.
# If anything unexpected appears → remove it before committing.

# Step 3 — Commit with scoped message

git commit -m "[scope]: description of what was built this session"

# scope must be one of: feat / fix / chore / docs / refactor / style

# Step 4 — Push

git push origin main

# Paste the output line showing branch + commit hash in your report.

# Step 5 — Update HANDOFF.md with:
# - What was completed this session (specific files changed)
# - Exact next task for the next session
# - Any decisions made that must not be reversed
# - Any blockers encountered

If push fails: Document exact error in docs/HANDOFF.md, leave working tree with a local commit. Never end a session with uncommitted work and no record.
Session end report format:
FILES CHANGED: [list every file]

COMMIT: [hash]

NEXT TASK: [exact description]

BLOCKERS: [none / description]


⚠️ Things Claude Commonly Gets Wrong — Don't Do These
Hardcoding fee percentages — always from user settings via ebayFee param
Hardcoding mileage rate or tax reserve — always configurable in settings
Using magic link auth — it was removed. Email verification + password only
Rewriting AI prompts — port them verbatim from FEATURE_TRIAGE.md
Adding a 6th tab — 5 tabs only: sourcing (PROFIT SCANNER), inventory (INVENTORY), photo (PHOTOS), growth (PROFIT COMPASS), dashboard (PROFIT HUB)
Calling Anthropic API from client — always via Supabase Edge Function
Using StyleSheet in React Native — NativeWind classes only
Using <form> tags — use onClick/onChange handlers
Floating point currency math — use precise arithmetic, store as numbers
Storing dates without timezone — always UTC ISO 8601
Allowing new source modules past 500 lines; legacy monoliths are scoped exceptions
Duplicating types — all types in packages/shared/src/types/index.ts only


🔮 Platform Expansion Pattern
When adding Poshmark, Mercari, or Facebook Marketplace:

// Follow adapter pattern — never add platform conditionals to core logic

interface PlatformFormatter {

  formatTitle(item: InventoryItem): string

  formatDescription(item: InventoryItem): string

  adjustedPrice(targetNetProfit: number, settings: UserSettings): number

}

class PoshmarkFormatter implements PlatformFormatter { }

class MercariFormatter implements PlatformFormatter { }

class FacebookFormatter implements PlatformFormatter { }


📚 Key External Docs
Supabase: https://supabase.com/docs
Expo: https://docs.expo.dev
Expo Router: https://expo.github.io/router/docs
NativeWind: https://www.nativewind.dev/v4/overview
EAS Build: https://docs.expo.dev/build/introduction
Stripe React Native: https://stripe.com/docs/stripe-js/react-native
Next.js 15: https://nextjs.org/docs
eBay Developer Portal: https://developer.ebay.com/develop/apis


🚀 Current Build Status

ARCHITECTURE NOTE (2026-06-17, updated 2026-06-29): The React Native mobile app built in
Phase 04 was scrapped — the output was unusable. The live product is apps/web/public/app.html
(Live at scanforprofit.com/app.html). The apps/mobile/ RN scaffold was deleted 2026-06-29
(60 files, never shipped) — mobile is not started, not "not started with a scaffold on disk."
A future mobile rebuild will use app.html as its reference, starting from nothing.
Authoritative current state: docs/CURRENT_STATE.md.

Phase
Name
Status
01
Validate
✅ Complete
02
Brand & Architecture
✅ Complete
03
Design
✅ Complete (brand/tokens done; mobile RN scaffold that referenced them was deleted 2026-06-29)
04
Build Web App (app.html)
✅ Live on Vercel — 7 Edge Functions active, RLS on all tables
05
Build Mobile App
⬜ Not started — no scaffold on disk (deleted 2026-06-29); live product is app.html
06
Launch
⬜ Not started
07–09
Monetize / Marketing / Scale
⬜ Not started

Web App Status (apps/web/public/app.html — the live product)
Feature
Status
Auth (register, login, verify, password reset)
✅ Live (Edge Function: auth)
AI scan via claude-proxy Edge Function
✅ Live (17 scan_log rows confirmed)
Inventory CRUD
✅ Live (Supabase: inventory table)
Listing generator
✅ Live
Trends / Growth Agent
✅ Live (Pulse tab)
P&L / Stats
✅ Live
Settings (fee, tax, mileage — all configurable)
✅ Live
eBay OAuth Edge Function
✅ Active (ebay-oauth deployed)
Landing page (index.html)
✅ Live on Vercel
Waitlist capture
✅ Live (1 row confirmed in waitlist table)
Stripe upgrade flow end-to-end
⬜ Not yet verified
PostHog events confirmed
⬜ Not yet verified
Sentry zero-error audit
⬜ Not yet verified
eBay Developer sandbox credentials connected
⬜ Not yet done (0 rows in ebay_connections)
