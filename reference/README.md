# Reference material

Research inputs for the build. Collected 2026-10-07. See `../PLAN.md` §1 for what we learned from each.

## statsig/
- `console-api-openapi-20240601.json`: StatSig Console API OpenAPI spec, from `https://api.statsig.com/openapi/20240601.json`. **The source of truth for Console API field names.**
- `docs-llms.txt`: index of the StatSig docs (`docs.statsig.com/llms.txt`).
- `dcs-fixtures/`: real StatSig SDK config-spec ("download_config_specs") files, taken from StatSig's open-source SDK test suites (ISC license). Use them as fixtures for the config-spec adapter.
  - `v2/`: from `statsig-io/statsig-server-core` @ `06c0055`, `statsig-rust/tests/data/`. DCS v2 format (`response_format: "dcs-v2"`, `condition_map`).
    - `eval_proj_dcs.json` (430 KB) is the richest.
    - `perf_proj_dcs.json.gz` is a large-project stress test (8.7 MB unzipped).
    - `get_id_lists.json` + `company_id_list` show the ID-list manifest and the hashed-ID file format.
    - `*.pb.br` is the protobuf+brotli form, which the app should reject with instructions.
  - `v1/`: from `statsig-io/node-js-server-sdk` @ `bda4127`, `src/__tests__/data/`. DCS v1 format (arrays of specs).
    - `rulesets_e2e_full_dcs.json` is the richest.
    - `initialize_response.json` is a *client* initialize response, which the app must reject.

## launchdarkly/
- `openapi.json`: LD REST API OpenAPI spec, from `https://app.launchdarkly.com/api/v2/openapi.json`. Marks which routes are beta.
- `semantic-patch-flags.md`, `semantic-patch-segments.md`: full semantic-patch instruction references.
- `docs/`: LD docs pages on roles, context kinds, approvals, scheduled changes, Federal, OAuth and warehouse native. Used for the capability matrix (PLAN §5.2).
- `docs-llms.txt`: index of the LD docs.

## growthbook/ (collected 2026-11-03, for PLAN §21)
Pinned to `growthbook/growthbook` @ the commit in `SOURCE_COMMIT` (`fff4ec3`).
- `openapi.yaml`: GrowthBook REST API spec (5.2.0), from `packages/back-end/generated/spec.yaml`. **The source of truth for GrowthBook field names.** Use the `/v2/features` routes (`/v1/features` is deprecated; v2 has a flat `rules` array with per-rule `allEnvironments` / `environments` scope and a compiled `definition` per environment).
- `sdk-test-cases.json`: the GrowthBook SDK spec test cases (spec 0.12.0; `packages/sdk-js/test/cases.json`, MIT). `evalCondition` (583 cases) is the fixture for the condition translator; `feature` (61) and `run` (88) show payload rules and bucketing.
- `sdk-types.ts`, `sdk-mongrule.ts`: the JS SDK's payload types (`FeatureDefinition`, `FeatureRule`, `SavedGroupsValues`) and condition evaluator, i.e. the exact semantics of every `$operator`.
- `docs-llms.txt`: index of the GrowthBook docs (`docs.growthbook.io/llms.txt`).

## tools/
- `python3 -I tools/growthbook_schema_dump.py FeatureV2 SavedGroup Attribute` prints resolved GrowthBook schemas; `--paths [prefix]` lists GET routes with their query parameters; `--tags` prints the tag descriptions. Needs PyYAML (`python3 -m venv .venv && .venv/bin/pip install pyyaml`).
- `python3 tools/statsig_schema_dump.py '/console/v1/gates/{id}'` prints a resolved response schema from the StatSig spec.
- `python3 tools/ld_schema_dump.py FeatureFlagBody MetricPost` prints LD schema properties.

## repos/ (gitignored; re-clone with `./fetch-repos.sh`)
- `statsig-to-ld`: launchdarkly-labs Go CLI, StatSig → LD. Prior art for the operator and condition mapping (it has known bugs; see PLAN §1) and for **metrics conversion** (`metrics convert`, `warehouse`), which is worth porting.
- `ld-migration-scripts`: launchdarkly-labs Deno tool, LD→LD + Split. Architecture patterns: fidelity ledger (`src/utils/split/mapping.ts`), rate limiter, dependency ordering, big-segment CSV import.
- `node-js-server-sdk`, `python-sdk`, `statsig-server-core`: StatSig SDKs. The **evaluator source** defines the exact DCS semantics (`node-js-server-sdk/src/Evaluator.ts`, `statsig-server-core/statsig-rust/src/evaluation/evaluator.rs`) and the hashing used by ID lists (`src/utils/Hashing.ts`).

## Facts checked live (2026-10-07), not from docs
- **GrowthBook CORS (read from source 2026-11-03, not yet with a key):** `packages/back-end/src/app.ts` mounts `/api` with `cors({ origin: "*", credentials: false })` and header auth, so `/api/v1` and `/api/v2` REST routes are callable from a browser. Whether `api.growthbook.io` exposes any rate-limit headers is the G0 spike (PLAN §21.6).
- **LD API CORS:** `Access-Control-Allow-Origin: *` on every route we need, including PATCH/PUT/DELETE. **No `Access-Control-Expose-Headers`**, so JS can't read `X-Ratelimit-*` or `Retry-After`.
- **StatSig CORS:** the preflight succeeds, but 401 responses from `statsigapi.net` and `api.statsigcdn.com` carry **no** `Access-Control-Allow-Origin`. Whether 200 responses do is **unverified**: this is M0 spike #1 and needs a real key.
- **LD semantic patch (checked 2026-10-22, M3):** custom-property instructions can't be combined with environment instructions in one flag PATCH (400 "must not be in a patch for flag configuration instructions"). Several writes to one flag within a second or two return 429; backing off for several seconds succeeds.
- **LD deletes (2026-10-22):** deleting a flag that is another flag's prerequisite, or a segment a flag still targets, returns 409.
- **LD flag list (2026-10-22):** `GET /flags/{p}?summary=true` includes `customProperties` and per-environment `on`/`version`, so migration status can be read from provenance in one call.
