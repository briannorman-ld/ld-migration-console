# LaunchDarkly Migration Console

A browser-only app (static Vite SPA, no backend) that reads feature-flag projects from another
provider and compares them with one LaunchDarkly project. Sources today: a StatSig project (Console
API key or uploaded config spec) and another LaunchDarkly project (PLAN §20, read through a
provider-neutral model that further sources will use; GrowthBook is next, PLAN §21); the name, the repository and the provenance
written into LD are source-neutral (see the note at the top of PLAN.md). The spec is [PLAN.md](PLAN.md); project rules are in
[CLAUDE.md](CLAUDE.md). How to run a migration end to end is in
[docs/RUNBOOK.md](docs/RUNBOOK.md); what migrates and what does not is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md). Status: **M0 + M1** (foundations, source adapters, canonical model, demo
dataset, LD connect + capability probe) **+ M3 for gates and dynamic configs** (mapper with
decisions, mapping profile, planner, dry run, journaled executor with LD provenance, undo; configs
become JSON multivariate flags with append-only variations). M0 spike #1 is still open:
[docs/TODO-m0-spike-1-statsig-cors.md](docs/TODO-m0-spike-1-statsig-cors.md).

## Run
Requires Node ≥ 22.13 (`nvm use`) and pnpm 11.

```bash
pnpm install
pnpm dev            # http://localhost:5173 — click "Try the demo"
pnpm test           # all unit tests (Vitest)
pnpm typecheck
pnpm build          # static site in apps/web/dist (strict CSP <meta>; vercel.json sends headers)
pnpm test:live      # read-only checks against real LD; needs LD_API_TOKEN in .env.local
pnpm test:live:write # writes zz-live-* flags/segments to the demo LD project (statsig-migration), then undoes them
pnpm fixtures:generate   # regenerate the committed demo dataset + sample spec files
pnpm coverage:generate   # regenerate the coverage tables in docs/LIMITATIONS.md from packages/coverage
```

## Layout
| Path | What |
|---|---|
| `apps/web` | React + Vite SPA. Pipeline Web Worker (`src/pipeline`), in-memory token vault (`src/lib/secrets.ts`), CSP (`csp.ts`). |
| `packages/http` | Shared transport: AIMD concurrency limiter, sliding-window rate budgets, jittered retries, opaque-failure handling. |
| `packages/canonical` | Source-agnostic model (PLAN §4), per-environment rule resolution, effective-targeting fingerprints, snapshot diff, cross-source matching. |
| `packages/statsig-client` | Console API client: pagination, odd shapes, lenient Zod schemas, capture hook. |
| `packages/adapters` | Console API crawl + normalize; config-spec (DCS v1/v2) parse + normalize. |
| `packages/ld-client` | LD REST client (read-only so far) + capability probe (PLAN §5.2). |
| `packages/store` | Dexie/IndexedDB workspace store; refuses token-like fields. |
| `packages/demo-fixtures` | "Acme Retail" dataset (PLAN §19), MSW mock of the Console API, config-spec generator, sample files. |
| `packages/mapper` | Pure, deterministic StatSig → LD mapping (PLAN §8, §10): gates → boolean flags, dynamic configs → JSON multivariate flags, segments → LD segments, every imperfect mapping a `DecisionPoint`. Golden files in `test/golden/`. |
| `packages/coverage` | The coverage matrix (every StatSig construct → LD target → how completely it migrates). Drives the in-app **What migrates** page and the generated block in [docs/LIMITATIONS.md](docs/LIMITATIONS.md) (`pnpm coverage:generate`). |
| `packages/planner` | Dependency closure (segments, context kinds, prerequisite gates), ownership guard (`key_collision`), ordering, provenance status. |
| `packages/executor` | Runs a plan against LD: journaled steps, pre-images, dry run, resume, undo. |
