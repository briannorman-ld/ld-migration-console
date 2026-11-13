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

## posthog/ (collected 2026-11-12, for PLAN §22)
Pinned to the commits in `SOURCE_COMMIT`.
- `openapi.yaml.gz`: the PostHog API schema (OpenAPI 3.1, 11 MB unpacked), from `https://us.posthog.com/api/schema/`. **The source of truth for PostHog field names.** The routes that matter are `/api/projects/{project_id}/feature_flags/`, `/cohorts/`, `/cohorts/{id}/persons/` (person actors, no distinct ids; `/persons/{id}/` has `distinct_ids[]`), `/groups_types/`, `/property_definitions/`, `/scheduled_changes/`, `/early_access_feature/`, `/experiments/`, `/api/projects/`, `/api/organizations/{id}/members/` and `/api/users/@me/`. There are no `/api/environments/` routes: a PostHog *project* is the unit, and flags have no per-environment state.
- `server-flag_models.rs`, `server-property_models.rs`: the Rust flags service's `FlagFilters` (`groups[]` with `properties`, `rollout_percentage`, `variant`, `aggregation_group_type_index`; `multivariate.variants[]`; `payloads`; `holdout`; `early_exit`; `feature_enrollment`), the `OperatorType` enum (every operator a filter can carry) and `PropertyType` (`person`, `person_metadata`, `cohort`, `group`, `flag`). MIT.
- `server-flag_matching.rs`, `server-property_matching.rs`: the server's evaluator, i.e. the exact semantics of each operator, of condition-set order, of `early_exit` and of the rollout hash. The Python SDK mirrors it.
- `sdk-python-feature_flags.py`: the Python SDK's local evaluator (`_hash`, `get_matching_variant`, `match_feature_flag_properties`, `match_property`, `match_cohort`). Hashing: `sha1("<flag key>.<distinct_id>")[:15] / 0xFFFFFFFFFFFFFFF`, variants with the salt `variant` appended, holdouts `sha1("holdout-<id>")`. MIT.
- `sdk-python-test_feature_flags.py`: the SDK test suite, 360 KB of inline flag definitions and `/flags/definitions` payloads (`flags`, `group_type_mapping`, `cohorts`). The fixture source for the condition translator until a real export is on hand.
- `sdk-node-feature-flags.ts`: the Node SDK's evaluator, for cross-checking (`flag_evaluates_to`, `is_not_set`, regex fallbacks).
- `docs-llms.txt`: index of the PostHog docs (`posthog.com/llms.txt`; every page is readable as Markdown by appending `.md`).

## tools/
- `python3 -I tools/growthbook_schema_dump.py FeatureV2 SavedGroup Attribute` prints resolved GrowthBook schemas; `--paths [prefix]` lists GET routes with their query parameters; `--tags` prints the tag descriptions. Needs PyYAML (`python3 -m venv .venv && .venv/bin/pip install pyyaml`).
- `python3 -I tools/posthog_schema_dump.py FeatureFlag Cohort GroupType PropertyOperator` does the same for the PostHog schema (`--paths /api/projects/{project_id}/feature_flags` lists routes). Same venv.
- `python3 tools/statsig_schema_dump.py '/console/v1/gates/{id}'` prints a resolved response schema from the StatSig spec.
- `python3 tools/ld_schema_dump.py FeatureFlagBody MetricPost` prints LD schema properties.

## repos/ (gitignored; re-clone with `./fetch-repos.sh`)
- `statsig-to-ld`: launchdarkly-labs Go CLI, StatSig → LD. Prior art for the operator and condition mapping (it has known bugs; see PLAN §1) and for **metrics conversion** (`metrics convert`, `warehouse`), which is worth porting.
- `ld-migration-scripts`: launchdarkly-labs Deno tool, LD→LD + Split. Architecture patterns: fidelity ledger (`src/utils/split/mapping.ts`), rate limiter, dependency ordering, big-segment CSV import.
- `node-js-server-sdk`, `python-sdk`, `statsig-server-core`: StatSig SDKs. The **evaluator source** defines the exact DCS semantics (`node-js-server-sdk/src/Evaluator.ts`, `statsig-server-core/statsig-rust/src/evaluation/evaluator.rs`) and the hashing used by ID lists (`src/utils/Hashing.ts`).

## Facts checked live (2026-10-07), not from docs
- **PostHog CORS (checked 2026-11-12 without a key):** the private API on `us.posthog.com` answers the preflight for `/api/projects/…` with `Access-Control-Allow-Origin: *`, `Allow-Methods: DELETE, GET, OPTIONS, PATCH, POST, PUT` and `authorization` among the allowed headers, and the 401 of an unauthenticated GET carries `Access-Control-Allow-Origin: *` too. So **PostHog Cloud needs no relay**; a 200 with a real key is the P0 spike. `Access-Control-Expose-Headers` lists only `X-PostHog-Events-Default-After`, so rate-limit headers are not readable from JS (documented limits: 480/min and 4800/hour per personal key for CRUD routes, 600/min for local evaluation). The local-evaluation route (`/api/feature_flag/local_evaluation`, `/flags/definitions`) reflects the request origin with `Allow-Credentials: true` and exposes `x-posthog-rate-limit-warning`.
- **PostHog shapes assumed, not seen (2026-11-12):** the demo fixture and adapter assume `/cohorts/{id}/persons/` returns person actors whose `id` is the person uuid (the adapter joins them to `/persons/` rows on `id` or `uuid`), that `/persons/?cohort=<id>` filters by cohort (not in the published schema; the adapter falls back to one GET per member), that `surveys` and `features` on a flag are lists in practice (objects in the schema), that `scheduled_changes` carry `is_recurring` / `recurrence_rule`, and that LD accepts `null` and `""` as the "Not served" JSON / string variation. All P0 items (PLAN §22.6).
- **GrowthBook CORS (read from source 2026-11-03, not yet with a key):** `packages/back-end/src/app.ts` mounts `/api` with `cors({ origin: "*", credentials: false })` and header auth, so `/api/v1` and `/api/v2` REST routes are callable from a browser. Whether `api.growthbook.io` exposes any rate-limit headers is the G0 spike (PLAN §21.6).
- **LD API CORS:** `Access-Control-Allow-Origin: *` on every route we need, including PATCH/PUT/DELETE. **No `Access-Control-Expose-Headers`**, so JS can't read `X-Ratelimit-*` or `Retry-After`.
- **StatSig CORS:** the preflight succeeds, but 401 responses from `statsigapi.net` and `api.statsigcdn.com` carry **no** `Access-Control-Allow-Origin`. Whether 200 responses do is **unverified**: this is M0 spike #1 and needs a real key.
- **LD semantic patch (checked 2026-10-22, M3):** custom-property instructions can't be combined with environment instructions in one flag PATCH (400 "must not be in a patch for flag configuration instructions"). Several writes to one flag within a second or two return 429; backing off for several seconds succeeds.
- **LD deletes (2026-10-22):** deleting a flag that is another flag's prerequisite, or a segment a flag still targets, returns 409.
- **LD flag list (2026-10-22):** `GET /flags/{p}?summary=true` includes `customProperties` and per-environment `on`/`version`, so migration status can be read from provenance in one call.
