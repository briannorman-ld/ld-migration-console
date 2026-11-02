# LaunchDarkly Migration Console — Plan (v4)

> The console started as a StatSig → LaunchDarkly migration, and the StatSig path (canonical model §4, mapper §10) still speaks StatSig's vocabulary. Since 2026-10-30 it also reads **another LaunchDarkly project** as a source (§20), through a small provider-neutral core that the StatSig adapters are meant to move onto later. The name, the repository and the provenance written into LD projects are source-neutral, so further sources (FeatureHub, Unleash, Split, …) can be added without renaming anything a customer already has.

A **browser-only** web app (a static site with no backend, no accounts and no server-side storage) that reads one or more StatSig projects and writes to one LaunchDarkly project. Migration is one-way only, StatSig → LD.

- **StatSig input:** a read-only Console API key, *or* an uploaded config-spec file.
- **LaunchDarkly input:** a writer token.
- **UI:** every migratable resource shown side by side, StatSig on the left and LD on the right.
- **Migration:** per item or in bulk, scoped **per environment**.
- **Imperfect mappings:** wherever the mapping isn't exact, the user is asked to make a decision.
- **Monitoring:** tracks a phased migration until StatSig traffic reaches zero.

---

## 0. Requirements captured so far

| Topic | Decision |
|---|---|
| Hosting / data | **Browser-only.** A static site served from Vercel (portable to any static host). All data stays in the user's browser (IndexedDB) or in their own LD project. **We store nothing server-side.** A server is reconsidered only if a benefit is big enough (§3.6). |
| Users | **LD staff only for now, customers later.** No accounts are needed. Browser-only makes the customer handoff simpler, because their tokens never leave their browser. |
| EU / Federal customers | **Disclaimer only**, no block yet (§3.5) |
| Consolidation key collisions | Left to us: **source-prefixed keys** by default, with a discriminator flag offered as an advanced option (§12) |
| Demo | **A seeded demo mode** that shows every feature without a StatSig token, writing to a real LD project with a real LD token (§19) |
| Spec-only customers | Accept the raw spec file and **re-upload it regularly**, or fetch it in the browser with a spec-scoped key. Suggest a Console key as the better option, never require it (§4.2). |
| StatSig flavours | **Cloud and Warehouse Native** both supported |
| LD feature coverage | **Everything the API allows.** Detect the plan / permissions and degrade gracefully. |
| Experiments | **End them in StatSig, launch new ones in LD.** Running experiments are not moved mid-flight. |
| Project mapping | Usually 1 StatSig → 1 LD. **Consolidating 2+ StatSig projects into 1 LD project** must be possible. |
| Initial state | **Mirror StatSig** (on/off and targeting) |
| Sync policy | **Only when the user says to sync.** Never sync automatically. Monitoring is read-only. |
| No Console API key | **Upload a StatSig config spec** instead |
| Imperfect mappings | **Prompt the user for a decision** |
| Granularity | **Migrate per environment** |

## 1. Research findings that shape this plan

1. **`ld-migration-scripts` contains no StatSig code.** It handles LD→LD migration and Split.io. The StatSig prior art is **[launchdarkly-labs/statsig-to-ld](https://github.com/launchdarkly-labs/statsig-to-ld)**, a Go CLI that is actively maintained (last commit 2026-10-05).
   - It covers gates, configs, overrides, environments, metrics and warehouse sources.
   - It has mapping bugs we must not copy: `version_gte`/`lte`, case-insensitive `any`, `time`, custom unit IDs collapsed to `user`, and gate/segment references and `environment_tier` dropped.
   - `ld-migration-scripts` is still useful for its patterns: a fidelity ledger, pure mappers, a rate limiter, dependency ordering and big-segment CSV import.
2. **LD has no built-in StatSig importer.** The native import supports only Split and Unleash, without targeting.
3. **Both StatSig APIs have specs.**
   - The Console API spec is at `https://api.statsig.com/openapi/20240601.json`.
   - The SDK config spec format (DCS v1/v2) is defined by the open-source SDKs: `node-js-server-sdk` for v1 and `statsig-server-core` for v2.
   - Neither existing tool has been run against real responses, so we validate every response at runtime.
4. **The config spec carries the targeting logic but not the metadata** (§4.2). Its big advantage is that it includes salts, so we can run StatSig's *real* evaluator in a parity tester.
5. **LD permission and plan constraints** (§5.2):
   - Service tokens require Enterprise.
   - Writer may not be able to create context kinds or look up members.
   - Warehouse data sources can't be created through the API.
   - Prerequisites, scheduled changes, approvals, big segments, teams and release pipelines are Enterprise or "select plans".
   - There is no entitlements endpoint, so capabilities have to be probed.

---

## 2. Goals / non-goals

**Goals**
- Inventory every StatSig resource, from either source type, and match each one to LD.
- Show a side-by-side, rule-level diff per environment, with fidelity marked on every condition.
- Upsert to LD, per item or in bulk, per environment. Dependencies are pulled in automatically.
- Make every imperfect translation an explicit, recorded **decision**.
- Track phased migrations: waves, per-environment state, drift detection and cutover tracking.
- Consolidate multiple StatSig projects into one LD project.

**Non-goals**
- Writing to StatSig.
- Moving historical data or results. These are archived instead.
- Preserving bucket assignments, which is impossible.
- Moving running experiments mid-flight.

---

## 3. Architecture: browser-only

```
Static site (Vercel; portable to S3+CloudFront, GitHub Pages, or a downloadable bundle)
        │  HTML/JS only. No API routes, no database, no accounts, no analytics
        ▼
User's browser
  ├─ UI (React + Vite SPA)
  ├─ Web Workers: crawl, parse specs, map, plan, hash ID lists (keeps the UI responsive)
  ├─ IndexedDB: snapshots, decisions, mapping profile, run journal, pre-images (per workspace)
  ├─ Tokens: held in memory only (optionally a passphrase-encrypted copy in IndexedDB)
  └─ fetch() directly to:
       statsigapi.net (Console API, read-only)   api.statsigcdn.com (config spec, optional)
       app.launchdarkly.com | app.eu.launchdarkly.com | app.launchdarkly.us (LD REST API)
  The user's own LD project also stores durable migration provenance (§3.3)
```

### 3.1 Feasibility: CORS checks (run 2026-10-07)
- **LD:** preflight succeeds with `Access-Control-Allow-Origin: *` on every route we need. That covers `GET/POST/PATCH/DELETE` on flags; `PUT` on context kinds; `POST` on segment imports, metrics, metric groups, experiments, layers, scheduled changes, approval requests and flag evaluate. `Authorization`, `LD-API-Version` and `Content-Type` are allowed headers. Error responses (401) also carry the CORS headers, so the status and body can be read.
  - **Catch:** LD sends no `Access-Control-Expose-Headers`, so the browser **can't read the `X-Ratelimit-*` or `Retry-After` headers**. Rate limiting therefore adapts to 429s (§5.1).
- **StatSig Console API:** the preflight succeeds and allows the `STATSIG-API-KEY` header, but the **401 error response has no `Access-Control-Allow-Origin`**. The browser therefore sees "network error" rather than "401 invalid key". The same likely applies to 429s.
  - **Verified 2026-10-22 with a real key (M0 spike #1, Console API part):** successful responses are readable from the browser, and a 401 for a bad key also came back with a readable status. Direct browser access works; the Console API needs no relay. The spec-CDN part of the spike is still open.
- **StatSig config-spec CDN:** same pattern, no CORS header on 401. StatSig's own browser on-device-evaluation SDK fetches specs from the browser, so success responses very likely allow it. Verify in the same spike.
- **Contingency if StatSig blocks browsers:**
  - A **stateless pass-through relay**: one Vercel Edge Function that forwards `GET`s to `statsigapi.net`.
  - It has no storage and no logging of headers or bodies, and it is open source so anyone can audit it. The key passes through server memory only for that request.
  - Spec-only sources need no relay, because uploads are local.
  - This is the only server component we'd ever accept by default, and only if the spike requires it.

### 3.2 Stack
- **Monorepo** (pnpm):
  - `apps/web`: React + Vite SPA, TanStack Query/Table (virtualized), shadcn/ui, Monaco diff.
  - Packages that run in workers and in tests: `packages/canonical`, `packages/adapters` (Console API, config spec v1/v2), `packages/mapper` (pure), `packages/planner`, `packages/ld-client`, `packages/statsig-client`, `packages/store` (Dexie over IndexedDB), `packages/demo-fixtures`.
- **No Next.js:** with no server there is no need for it. A Vite SPA is simpler and deploys anywhere.
- **Distribution:**
  - The hosted URL.
  - A **downloadable build** (zip, or `npx ld-migration-console`, served from localhost) for customers whose security teams want to run it themselves.
- **Libraries:**
  - Specs: `DecompressionStream` handles gzip; brotli needs a WASM decoder.
  - Hashing: WebCrypto SHA-256, for ID-list reconciliation.
  - Encryption: WebCrypto AES-GCM + PBKDF2, for passphrase-protected tokens and workspace files.

### 3.3 Where state lives
Two places, and nowhere else.
1. **The user's LD project: durable, shared provenance.** The scheme is source-neutral (`packages/canonical/src/provenance.ts`): every key names the *kind* of source, so resources migrated from StatSig and from a later source can share one LD project. Every resource the app writes carries:
   - **Flags:**
     - Tags `migrated-from-<kind>` (today `migrated-from-statsig`) and `migration-src-<alias>`.
     - `customProperties` (stable keys; the display names carry the provider, e.g. "StatSig ID"):
       - `migration.kind`, `migration.id`, `migration.type`, `migration.source`
       - one property per environment, `migration.sync.<envKey>`, set to `[<sourceFingerprint>, <sourceVersion>, <syncedAtISO>, <decisionSetHash>]`
     - Patch `comment`s, which show in the LD audit log.
   - **Segments** have no custom properties, so they get tags plus a machine-readable footer in the description (`[ld-migration: from=statsig; src=…; id=…; fp=…; d=…; at=…]`).
   - **Metrics, experiments, layers and holdouts** get tags and a description footer.
   - **Environments** the console creates get `migrated-from-<kind>`, so a project reset removes only those.
   - **Legacy:** builds before 2026-10-30 wrote `statsig-migrated` / `statsig-src-<alias>` tags, `statsig.*` properties and `[statsig-migration: …]` footers. The readers accept both schemes; writers emit only the new one, so a re-sync upgrades a resource in place.

   So *any* teammate, on any machine, who opens the app with the same tokens sees the true migration status, read from LD itself. The status survives a cleared browser. The LD audit log is the authoritative write history.
2. **The browser (IndexedDB), per workspace:**
   - StatSig snapshots (cached, refreshable)
   - decisions and resolutions
   - the mapping profile
   - waves
   - the run journal
   - pre-images for undo
   - spec uploads
   - cutover time series sampled while the app is open

   Losing this data is recoverable: snapshots can be re-fetched or re-uploaded, migration status is rebuilt from LD, and decisions are asked again (or re-imported).

**Workspace file (`.sslm`).** Export/import of everything in IndexedDB. Use it to share decisions with a teammate, move to another machine, hand off to a customer, or keep a backup.
- It's a JSON bundle, **encrypted with a passphrase by default**: it can contain PII from overrides and salts from specs. Tokens are never included.
- Importing merges per decision and per wave, with timestamps (last writer wins). The diff is shown before applying.
- The app prompts for an export after every run: "Back up this workspace".

### 3.4 Tokens
- Tokens never reach disk in the clear. By default they are **kept on this device**: AES-GCM encrypted under a non-extractable WebCrypto key that is stored in IndexedDB next to the blob, so they come back on every open without a prompt while a copy of the database yields only ciphertext (changed 2026-11-02: memory-only by default lost the tokens on every reload).
- Per workspace the user can instead **protect them with a passphrase** (key derived with PBKDF2, never stored, unlocked once per session; for shared machines) or **keep them in memory only** (closing the tab forgets them).
- **Strict Content-Security-Policy:** `connect-src` allows only the StatSig and LD API hosts (plus the relay, if one exists). No third-party scripts and no analytics. The build is open source with Subresource Integrity, so a customer's security team can check in DevTools that tokens go only to StatSig and LD.
- **IP allowlists:** calls come from the user's own network, so a customer's LD API-token IP allowlist behaves as it does for any of their own tooling. LD staff running the tool may need to be on an allowlisted network.

### 3.5 EU / Federal
- No data is hosted by us, so data residency is much less of a concern: calls go straight from the browser to the customer's LD instance.
- An acknowledgement modal and banner are still shown:
  - **EU:** "the static app is served from a US CDN; your configuration data is processed only in your browser and sent only to StatSig and your LD instance."
  - **Federal:** "this tool is not FedRAMP-authorized; confirm connecting it is permitted. Warehouse-native experimentation is unavailable on Federal."
- The acknowledgement is stored in the workspace.

### 3.6 What we give up without a server, and when one would be worth it
| Lost capability | Browser-only mitigation | How big a loss |
|---|---|---|
| **Background monitoring + alerts** (drift, cutover complete, token expiry) | Refresh on open plus periodic refresh while the tab is open, with browser notifications while open. The dashboard shows "last checked". | **Medium.** Phased migrations take weeks, and nobody gets told about drift until someone opens the app. |
| **Automated spec uploads** from customer cron/CI (the ingest endpoint) | Manual upload, or **Fetch spec** in the browser with a spec-scoped client key (§4.2). Staleness warnings. | **Medium for spec-only customers.** |
| **Live multi-user collaboration** | LD provenance gives everyone the same migration status. Decisions are shared through workspace files. | **Low–medium.** Fine for 1–3 operators. |
| **Runs that survive closing the tab** | A run journal in IndexedDB means an interrupted run resumes when reopened. A `beforeunload` warning, a Web Locks guard against two tabs, and an optional Wake Lock. | **Low.** |
| **Central audit log** | LD's audit log records every write, with our comments. Decisions are logged in the workspace file. | **Low.** |
| Readable rate-limit headers | Adaptive throttling | **Low.** |

**Recommendation:** browser-only is the right default, and the app is fully functional without a server. **One later option is worth considering if alerts or collaboration turn out to matter:** an opt-in *zero-knowledge team sync*.
- The workspace file is stored server-side, **encrypted in the browser with a key the server never sees**.
- It gives shared, persistent workspaces without us being able to read any data.
- It still **wouldn't** enable background monitoring, because that needs tokens server-side. That is the one benefit that requires actually holding customer tokens, and it should only be added if customers explicitly ask for alerts.

**A workspace is one LD project (target) plus N StatSig sources.** Each source is either a Console API key or a config-spec upload. 1:1 is the common case; consolidation (§12) is the same model with N > 1. Everything is local, and there are no accounts or tenancy: whoever has the browser profile, or the workspace file and the tokens, has access.

---

## 4. StatSig source adapters → canonical model

Both adapters produce the same **canonical model**: `Gate`, `Config`, `Experiment`, `Layer`, `Holdout`, `Segment`, `Autotune`, `Metric`, `Environment`, `UnitType`, `Tag`, `Owner`, `ParamStore`, `Rule`, `Condition`, `Override`. The mapper, UI and monitor see only the canonical model. Each object records its `sourceId`, `sourceKind` and a `completeness` flag that says which fields are present.

### 4.1 Console API adapter
- **Base URL and headers:** `https://statsigapi.net/console/v1`, with headers `STATSIG-API-KEY` and `STATSIG-API-VERSION: 20240601`.
- **Pagination:** `page` and `limit=100`; loop until `pagination.nextPage` is null.
  - Be defensive about odd shapes, e.g. `/gates/{id}/rules` returns `data.rules`.
  - `/logs` is cursor-based.
- **Rate limits:** StatSig documents about 100 requests per 10 seconds and 900 per 15 minutes per project. We budget **40 per 10 seconds** (raised from 12 on 2026-10-22: a real sync was paced far below the documented limit with no 429s) and the full **900 per 15 minutes**, which is the binding limit for any crawl over 900 requests (about one request per second sustained). Back off with jitter on 429. The ID-list endpoint has its own limit, and each ID list costs one request per 100 IDs. The sync log shows budget pauses as "pacing", distinct from a stall.
  - Refreshes while the app is open get their own rate budget, so they don't use up the customer's StatSig quota.
  - The app runs in the browser, and StatSig's error responses can't be read there (§3.1). A request that fails without a readable status is therefore treated as possibly rate-limited, retried with exponential backoff, and after N attempts shown as "StatSig unreachable, the key may be invalid".
  - The key is validated first with a single `GET /console/v1/project`.
- **Sync:** a full first sync, then incremental refreshes using `version` / `lastModifiedTime`, `/audit_logs` and `includeArchived=true`.
- **Coverage:** gates, configs, experiments, layers, holdouts, segments and ID lists, autotunes, param stores, metrics, metric sources (Warehouse Native), events, environments, unit types, tags, target apps, users/teams, overrides, versions, exposure counts and checks.
- **Detecting Warehouse Native:** metric sources or `/wh_connections` are present.

### 4.2 Config-spec (DCS) upload adapter
**Positioning.** When a source is created, the app recommends a read-only Console API key and explains what it adds: metadata, metrics, check and exposure counts for cutover tracking, archived items, and raw ID lists. It never requires one. A spec-only source is a fully supported, first-class path; the features it can't support are marked "needs Console key" rather than hidden.

**How the customer gets the file.** Two ways.
- **Fetch in the browser:** paste a spec-scoped client key, then click **Fetch spec**. The app downloads the spec straight from `api.statsigcdn.com`. The key stays in memory like any other token.
  - The browser-access check is part of M0 spike #1. If it isn't allowed, this option is hidden.
  - Refreshing a spec-only source becomes one click, which mostly makes up for not having a server-side ingest endpoint.
- **Upload a file**, fetched however they like. In-app instructions give copyable `curl` commands:
- `GET https://api.statsigcdn.com/v1/download_config_specs/{KEY}.json` or `/v2/...`, with **no query params**. With `sinceTime`, `checksum` or `accept_deltas` the response can be a delta, or just `{"has_updates": false}`.
- **Key choice:** recommend a **client key with only the "Allow Download Config Specs" scope** over a server secret, because a secret can also write events. Tell them to rotate it afterwards.
- The key **must cover all environments and all target apps**. A key scoped to an environment or target app produces a partial file. When the file looks partial, the app warns.
- Also accepted: the raw value from the customer's SDK data adapter (Redis or Edge Config, key `statsig|/v{1,2}/download_config_specs|plain_text|…`).
- `getClientInitializeResponse` output is rejected: it is hashed and evaluated for one user, so it contains no rules.

**Parsing**
- Accept JSON, `.gz` or `.br`. Detect v2 by `response_format == "dcs-v2"` or by `feature_gates` being an object.
- Resolve v2 `condition_map` IDs, and read `experiment_to_layer` (v2) or `layers` (v1).
- The protobuf form is rejected with instructions to fetch it as JSON.

**Normalizing DCS forms to canonical conditions**

| DCS | Canonical |
|---|---|
| `user_field` + `userID` / `email` / `ip` / `locale` / `appVersion` / `country` / custom (`additionalValues.custom_field`) | `user_id` / `email` / … / `custom_field` |
| `ip_based` + `country` | `country` |
| `ua_based` + `os_name` / `browser_name` / … | `os_name` / … |
| `environment_field` + `tier` | `environment_tier` |
| `pass_gate` / `fail_gate` on `segment:<name>` | `passes_segment` / `fails_segment` |
| `pass_gate` / `fail_gate`, `multi_pass_gate` / `multi_fail_gate` | `passes_gate` / `fails_gate` (multi = OR) |
| `current_time` | `time` |
| `unit_id` + `idType` | `unit_id(customID)` |
| `unit_id in_segment_list <list>` | ID-list segment reference |
| `user_bucket` | used internally to reconstruct experiment and layer allocation |

**Reconstructing entities**
- **By `entity`:**
  - `segment:<name>` gates become segments.
  - `entity: holdout` gates become holdouts; the size is the rule's `passPercentage`.
  - `entity: experiment` / `autotune` in `dynamic_configs` become experiments / autotunes.
  - `entity: layer` in `layer_configs` becomes a layer.
- **Experiment groups:**
  - Groups are the `isExperimentGroup` rules; `groupName` gives the name and `returnValue` the parameters.
  - The split comes from cumulative `user_bucket lt N` thresholds out of 1000.
  - Layer allocation comes from the bucket sets on `experimentAssignment`. `{"-1":true}` means 100% of the layer.
- **Experiment status:**
  - `isActive` → active
  - a lone `prestart` rule → setup
  - `launchedGroup` → shipped
  - `abandoned` → abandoned
- **Overrides:** rules whose `id` ends in `override` become override targets.
- **Small ID lists:** inline rules with `id: "id_list"` hold the IDs in plaintext.
- **Environments:** the list is inferred from every `tier` value in the file plus `default_environment`. The user confirms the environment list during setup.

**What the config spec is missing**
- Descriptions, tags, owners and teams, timestamps (only a `version` counter), and human-readable rule names (rule names are opaque IDs).
- Hypotheses, metrics and their definitions, durations, results, review state, lifecycle and stale labels, check counts, schemas, target-app names, and archived entities.
- **Large ID-list contents.** They live behind `get_id_lists`, and the IDs are **hashed**: the first 8 characters of base64(sha256(id)), which can't be reversed.

**How the gaps are handled**
- LD flags get generated names and descriptions. A per-workspace "enrichment CSV" can fill in names, descriptions, tags and owners.
- Metrics can't come from a config spec. The Metrics section shows "Needs Console API key or manual definition".
- **ID lists use reconciliation:**
  1. The customer uploads either the `get_id_lists` manifest and files (`+hash` / `-hash` lines), or just the list name and count.
  2. They then upload a CSV of the *raw* IDs.
  3. The app hashes each raw ID **in the browser** (WebCrypto, in a worker) and compares against the StatSig list, then reports coverage, e.g. "99.8% of 48,210 hashes matched; 96 missing". It only migrates once the user accepts that coverage. This is a decision (§8).

**Regular re-uploads (the refresh model for spec-only sources)**
- **Every upload becomes a new immutable snapshot.** It is diffed against the previous one: added, removed and changed entities, down to rule and condition level. The diff drives drift detection (§14), exactly as a Console API refresh does.
- **Ways to refresh:**
  1. **Fetch spec** with a spec-scoped key (above).
  2. **Drag and drop** a file. Each upload is versioned in IndexedDB and listed in the source history.
  3. **ID-list files** (the `get_id_lists` manifest and the `+`/`-` hash files) can be uploaded the same way, to keep reconciliation current.
  - Snapshots stay local. Customers who send files to an LD operator should share them through their usual secure channel; the files contain PII and salts.
- **Spec age:** shown prominently, e.g. "Spec uploaded 9 days ago". The migrate flow warns when you're syncing from an old snapshot, with a configurable threshold of 24 h by default.
- **Sanity checks on each upload:**
  - The `company_id` must match the previous snapshot, to stop the wrong project being uploaded.
  - Entities that disappeared are flagged; they were archived, deleted, or the key's scope is partial.
  - Uploads where only `time` changed are deduplicated.

**Hybrid source.** A Console API key and a spec upload can be attached to the same source. The Console API is authoritative for metadata, and the spec adds salts for the exact parity tester (§17).

---

## 5. LD client and capability detection

### 5.1 Client
- **Base URL and headers:** `/api/v2`. Headers are `Authorization: <token>` and `LD-API-Version: 20240415`, or `beta` for metric groups, release pipelines, flag links, approval settings, evaluation usage and the IP allowlist.
  - Beta routes return **403 without the beta header**, so a 403 doesn't always mean "no permission". Always send the header on beta routes before treating 403 as a permission failure.
- **Semantic patch everywhere:** `replaceRules`, `replaceTargets`, `replacePrerequisites`, `updateFallthroughVariationOrRollout`, `updateOffVariation`, `turnFlagOn` / `turnFlagOff`. One atomic PATCH per (flag, environment), so a re-sync converges.
  - *Checked live (M3):* LD rejects custom-property instructions in a patch that has environment instructions (400), so the `migration.sync.<env>` provenance is a second JSON patch, written only after the targeting patch succeeds.
  - *Checked live (M3):* writes to one flag in quick succession hit a per-flag rate limit (429). The client backs off up to 8 attempts / 30 s; a run that still fails can be resumed.
- **Rate limits:** the browser can't read the `X-Ratelimit-*` or `Retry-After` headers (§3.1), so we use **adaptive throttling**:
  - Start at modest concurrency (about 3 in flight). On a 429, halve the rate and back off exponentially with jitter, then slowly ramp back up. This is AIMD-style.
  - Retry 409 and 5xx a bounded number of times, with timeouts.
  - The duration estimate is based on the rate actually observed.
- **Preview:** `?dryRun=true` on flag PATCH.
- **Approvals:** a 405 means approval is required. Create an approval request instead: `POST /projects/{p}/flags/{f}/environments/{e}/approval-requests`, or for segments the generic `POST /api/v2/approval-requests` with `resourceId: "proj/x:env/y:segment/z"`.
  - Poll its `status` and `reviewStatus`.
  - Status shows as "Pending approval" in the UI.
- **Scheduled changes:** `POST /projects/{p}/flags/{f}/environments/{e}/scheduled-changes` with `{executionDate, instructions}`. When approvals are required, `executionDate` goes on the approval request instead.
- **Variation IDs:** variations are referenced by `_id`, so GET the flag after creating it.

### 5.2 Capability probe (run on connect, and again on demand)
There is no entitlements endpoint, so capabilities are inferred without side effects:
- **Token:**
  - `GET /caller-identity` → `tokenKind`, `serviceToken`, `memberId`.
  - `GET /tokens/{tokenId}` → `role` and `customRoleIds`; handle a 403.
  - A personal token gets a warning: it breaks if its creator is downgraded or removed. Service tokens need Enterprise.
- **Permissions:** `_access.allowed` / `_access.denied` on `GET /projects/{p}` and on environments and other resources tell us per action whether it's permitted, e.g. `createContextKind`, `createFlag`, `updateApprovalSettings`.
- **Environment settings:** `GET /projects/{p}/environments/{e}` → `approvalSettings` and `resourceApprovalSettings`.
- **Feature availability:** GET the list routes (teams, holdouts, layers, metric groups, release pipelines, members), with the beta header where needed. 200 means available; 403/404 means unavailable or not permitted.
- **Unknown until tried:** prerequisites, scheduled changes, big segments. The first failed write updates the matrix and creates a decision instead of failing the whole run.

**Capability matrix (shown in Settings and in the plan modal)**

| Capability | Typical requirement | Fallback when unavailable |
|---|---|---|
| Flags, rules, targets, segments | Writer | — |
| Context kinds (`PUT /projects/{p}/context-kinds/{k}`) | Possibly Admin / Project Admin | Generate a copyable list for an admin to create. SDK evaluations also auto-create kinds. |
| Prerequisites | Enterprise | Inline the referenced gate's conditions (§10.4) or decide |
| Big / unbounded segments, CSV import | Enterprise | Split the list or decide |
| Scheduled changes (StatSig `time` conditions) | Enterprise | Resolve statically or decide |
| Approvals | Enterprise | Approval-request fallback |
| Experiments, holdouts, layers, metrics | Experimentation add-on | Flags-only migration. Metrics/experiments are shown but blocked. |
| Metric groups (funnels) | Beta | Individual metrics |
| Release pipelines, guarded rollouts | Enterprise (beta) | Guidance only |
| Flag links | Beta | Custom property holding the permalink |
| Member lookup by email / teams | Admin / Enterprise | Default maintainer, or a manual member picker |
| Warehouse-native data sources | UI only (Admin) | **Guided manual setup checklist.** Metrics are created through the API once the data source exists. |

---

## 6. What can be migrated (inventory)

Fidelity: **FULL** = equivalent. **PARTIAL** = needs a decision, or the caveats are acknowledged. **MANUAL** = guidance only. **N/A** = no LD equivalent. **Scope** = whether LD stores the resource per project or per environment.

| StatSig | LD target | Scope | Fidelity | Config-spec source? |
|---|---|---|---|---|
| Environments | Environments (mapping; create on opt-in) | project | FULL | Inferred from tiers |
| Unit ID types | Context kinds | project | FULL | ✓ (`idType`) |
| Tags / owners / teams | Tags / maintainer / team | project | PARTIAL | ✗ (enrichment CSV) |
| Feature gates | Boolean flags | project shell + per-env targeting | FULL→PARTIAL | ✓ |
| Dynamic configs | JSON multivariate flags | project shell + per-env | FULL→PARTIAL | ✓ |
| Rule-based segments | Rule-based segments | **per env** | FULL→PARTIAL | ✓ (`segment:` gates) |
| ID-list segments | List segment (≤15k) / big segment (CSV import) | **per env** | FULL (API) / reconciliation (spec) | Hashed → reconciliation |
| Overrides | Individual targets | per env | FULL | ✓ (override rules) |
| Experiments | JSON flag + LD experiment (new; §11) | project flag + per-env experiment | PARTIAL | ✓ minus metrics and hypothesis |
| Layers (explicit) | LD layers + reservations | project + per-env reservation | PARTIAL | ✓ |
| Holdouts | LD holdouts (new population) | per env | PARTIAL | ✓ |
| Autotune | LD bandit (`type: mab`) | per env | PARTIAL | ✓ |
| Metrics (Cloud) | LD metrics / metric groups | project | PARTIAL | ✗ |
| Metrics (WHN) + metric sources | LD warehouse-native metrics (data source set up manually) | project | PARTIAL | ✗ |
| Events | Event keys referenced by metrics | — | MANUAL (instrumentation) | ✗ |
| Param stores | JSON flag per store (static params) + references | project | MANUAL→PARTIAL | ✓ (v2) |
| Target apps | Hint for client-side availability and tags | — | MANUAL | IDs only |
| Release pipelines / safeguards / automated rollouts | LD release pipelines / guarded / progressive rollouts | — | MANUAL | ✗ |
| Experiment results | Archive file + LD flag link | — | Archive | ✗ |
| Dashboards, alerts, reports | — | — | N/A | ✗ |

---

## 7. Core concepts: per-environment migration and manual sync

**Environment mapping, per source.** A table maps each StatSig tier/environment to an LD environment, or to *not migrated*. With consolidation, several sources can map to the same LD environment.

**State is tracked per (resource, LD environment).**
- **Durable part, in LD provenance (§3.3):**
  - the link from StatSig entity to LD key
  - per environment: `statsig_fingerprint_at_sync`, `statsig_version`, `synced_at`, `decision_set_hash`
- **Local part, in IndexedDB:**
  - per environment: `fidelity`, `pre_image`, `last_run_id`, `approval_request_id`, `ld_version_at_sync`
  - the computed `status`

**Migrating a gate to "staging" only**
1. The **flag shell** is created or updated at project level: key, name, variations, tags, custom properties, client-side availability.
   - LD creates the flag in *every* environment.
   - Environments that haven't been migrated keep LD's default (off, serving the off variation) and show **Not migrated** in that environment. Because the app in those environments still calls StatSig, this is harmless.
2. **Staging targeting** mirrors StatSig: on/off state, rules filtered and resolved for staging, overrides, fallthrough.
3. **Production stays untouched** until someone explicitly migrates production.

**Changes at project level affect every environment.**
- A dynamic config can gain a new `returnValue` after staging was migrated. The variation list is a project-level change.
- Policy: variations are **append-only**. The app never removes or reorders a variation that a migrated environment uses.
- A change that would affect environments that are already migrated becomes a decision.

**Mirroring and manual sync**
- Migrating (or "syncing") mirrors StatSig's state *as of the last snapshot* into the chosen environments. It is always user-initiated: single item, multi-select, "all StatSig-changed items in env X", or a whole wave.
- The monitor **never writes**. It only refreshes snapshots and computes drift.
- Each item has a per-environment **"LD authoritative"** switch, typically set after cutover. With it on, the item drops out of "StatSig changed" alerts, and a sync needs explicit override confirmation.

**Waves**
- A wave is a named set of (resources × environments), e.g. "W1: checkout gates → staging", then "W2: checkout gates → production".
- Adding an item pulls its dependency closure in with it.
- Each wave has its own progress, decisions queue, cutover chart and exit criteria.

---

## 8. The decision framework (imperfect mappings)

Every place where the translation isn't exact produces a **Decision**. The user resolves it before (or while) migrating, and the resolution is stored and reused.

### 8.1 Model
```
map(canonicalEntity, mappingProfile, resolutions, ldCapabilities, targetEnv)
  → { desiredLdState, fidelityReport, unresolved: DecisionPoint[] }   // pure, deterministic
```
- **DecisionPoint:**
  - `type`, `severity`
  - `subject`: source, entity, env, rule index, condition path
  - `sourceFragment`: the exact StatSig JSON
  - `options[]`: each with `{key, label, explanation, resultingFidelity, previewPatch}`
  - `recommended`
  - `fingerprint`: a hash of type plus the normalized fragment
- **Severity:**
  - **Blocking:** no safe default. The item can't migrate until it's resolved.
  - **Choice:** has a recommended default.
  - **Acknowledge:** information the user must accept, e.g. bucketing reshuffle.
- **Resolution:**
  - `{optionKey, scope, decidedBy, decidedAt, note}`
  - `scope` is one of: this instance · this resource (all envs) · all matching in this wave · **workspace policy**. A policy is stored in the mapping profile, so it travels with the workspace file.
- **Staleness:** resolutions are keyed by fingerprint. If the StatSig fragment changes, the resolution goes **stale** and the decision is asked again, showing the old answer.

### 8.2 UX
- **Decisions inbox** (left nav, with a badge count):
  - Decisions are grouped by type and fingerprint, e.g. *"Case-insensitive match (`any`) — 87 conditions in 41 gates"*.
  - Each group shows a plain-language explanation and the options as cards. Every option comes with a **live before/after preview** of a real affected item, plus "show all affected".
  - Resolve with **Apply to all**, **Decide individually** or **Save as workspace policy**.
- **Inline:**
  - In the detail drawer, yellow or red conditions open a decision popover.
  - The plan modal says *"5 decisions needed before these 12 items can migrate"* and lets you resolve them on the spot.
- **Bulk default:** "Use recommended for all *choice* decisions in this plan". Blocking and acknowledge decisions are still shown.
- **Decision log export** (CSV/markdown): every decision with who, when, why and the affected items. It doubles as the customer's sign-off document and migration runbook.

### 8.3 Decision catalog (initial)

| Type | Trigger | Options (recommended **bold**) |
|---|---|---|
| `case_insensitive_match` | `any`/`none` and `str_contains_*`/`str_starts_with_any`/`str_ends_with_any` (StatSig ignores case for all of them; LD `in`/`contains`/`startsWith`/`endsWith` don't) | **Case-folded regex `matches`** (`[pP][rR][oO]`: exact in every SDK regex engine) · add lowercase and uppercase variants · keep exact values (case-sensitive). *M3: the regex is recommended because it's the only exact option.* |
| `partial_rollout_rebucket` (ack) | 0 < pass% < 100 | **Acknowledge: users will be re-bucketed** · first set the StatSig rule to 0% or 100%, then come back |
| `gate_reference` | `passes_gate`/`fails_gate` that can't be inlined exactly | **Inline the referenced gate's rules** (when exact) · flag-level prerequisite (approximate; Enterprise) · convert the referenced gate into an LD segment · drop the condition · skip the item |
| `time_condition` | `time` / `current_time` | Already in the past → **resolve statically** · LD scheduled change at that time (Enterprise) · drop the rule · skip |
| `derived_attribute` | `browser_name`, `os_name`, `country` (from IP), … | **Map to attribute `X`** (the app must send it; added to the context contract) · drop the rule · skip |
| `unit_type_kind` | New unit type | **Create context kind `k`** · create a kind under a key you type (`create:<key>`, validated against LD's key rules) · keep it as an attribute of the `user` context (`attribute:<name>`: clauses on the attribute, rollouts `bucketBy` it, ID overrides become a targeting rule; the Unit types page can put the attribute on any kind, `attribute:<kind>/<name>`) · use a kind another unit type's answer creates · map to an existing kind other than `user` · ask an admin to create it (no permission) |
| `env_unmapped` | StatSig environment without an LD environment | **Map to an existing LD environment** · create the LD environment · don't migrate this environment |
| `key_collision` | The LD key exists and wasn't created by this app | **Adopt (link and overwrite on sync, keeping a pre-image)** · rename with a suffix · skip |
| `source_collision` | Same key from two consolidated sources (§12) | **Merge if identical** · separate keys with a source prefix · single flag with discriminator rules · pick a winning source |
| `variation_change_affects_migrated_env` | New or changed config value with environments already migrated | **Append the variation** (affects all environments' variation list only) · defer until those environments re-sync |
| `big_segment` | ID list > 15k | **Unbounded segment via CSV import** (Enterprise; needs a persistent store or Relay) · skip |
| `hashed_id_list` | Spec-sourced list | **Upload raw IDs and reconcile** · accept partial coverage at X% · skip the segment and any rules referencing it |
| `regex_dialect` | `str_matches` uses features not portable across SDK regex engines | **Keep as is** · rewrite (edit inline) · drop |
| `null_check` | `is_null` / `is_not_null` | `is_not_null`: **approximate with `matches ".*"`** (string attributes) · drop · skip. `is_null`: **blocking**, drop the rule or skip: an LD clause on a missing attribute never matches, even negated, so "is not set" can't be expressed. |
| `negated_missing_attribute` (ack) | `none`, `none_case_sensitive`, `str_contains_none`, `neq` on an attribute other than `user.key` | **Acknowledge**: StatSig passes users who don't send the attribute; LD doesn't match them · skip |
| `client_side_availability` | Every gate (StatSig client SDKs see all gates) | **Infer from target apps / client keys** · on for all · off for all |
| `maintainer_unknown` | Owner email not found in LD (owners are matched by email against the member list the People step reads; decided once per owner in `profile.maintainers`) | **No maintainer** (owner kept in `migration.owner`) · the owner's team · pick a member (`member:<id>`) · invite the owner from the People step |
| `experiment_running` | Experiment `active` in StatSig | **Wait until it ends in StatSig** · pre-stage a draft in LD (not started) |
| `experiment_concluded` | `decision_made` / `launchedGroup` | **Flag serves the shipped group at 100%** · don't migrate (recommend hard-coding) |
| `metric_unsupported` | composite / unsupported types | Approximate (e.g. components as separate metrics) · **skip with a note** |
| `layer_parameters` | Explicit layer with shared params | **One flag per experiment + a code-change note** · generate a combined "layer flag" |
| `ld_drift_on_sync` | LD changed since the last sync | **Show the 3-way diff, keep LD** · overwrite with StatSig · merge manually |
| `capability_missing` | Probe shows a feature is unavailable | Feature-specific fallbacks from §5.2 |

---

## 9. UI

**Guide (the workspace's landing page, added 2026-11-02)**
- One environment at a time, in dependency order: **Connect → Choose an environment → Context kinds → Segments → Flags → Experiments and bandits → Cut over**. Context kinds first because every rule, rollout and target refers to them; segments before the flags that reference them; experiments and bandits after the flags they wrap.
- Each step shows where it stands for the chosen environment (in sync / changed / not migrated / waiting for decisions, from the mapping results and LD provenance) and carries its own action: the environment mapping, the `unit_type_kind` decisions inline, and a **Migrate N …** button that opens the plan for everything in that step not yet in sync. The first unfinished step is expanded; all stay open to revisit. Cut over links to Monitoring and Runs and says when to switch SDKs and archive in StatSig.
- Model in `apps/web/src/lib/guide.ts` (pure), view in `screens/GuideView.tsx`. The resource explorers remain for item-level work.
- **Context kinds first** (added 2026-11-02): guide step 3 lists the kinds the environment's items will need and LD lacks, with **Create N context kinds in LD…** as a run of its own (`PlanRequest.contextKinds`; project-level, so it needs no target environment). When the capability matrix says the token cannot create kinds, it shows the keys for an admin to create and a re-probe button instead. In a run, a 403 on a kind step fails that step and skips only the items keyed by it; the run goes on and the matrix learns `context_kinds: not_permitted`.
- **Unit types page** (added 2026-11-02): one row per unit type a source declares or uses (keyed items, rule buckets, `unit_id` conditions and overrides counted), with the choice of where its IDs go in LD: the key of a context kind, or an attribute of any context kind, `user`, one LD has or one the migration creates (never the `user` key for a custom unit ID). Saved in the mapping profile (`SourceProfile.unitTypeKinds`: a kind key, `attribute:<name>` for a `user` attribute or `attribute:<kind>/<name>`), which the mapper reads through `configuredUnit`, so a configured unit type raises no per-item `unit_type_kind` decision; unit types left on their default still ask per item. Warns when two unit types of one source map to one kind (edge case 3.2) and shows, across sources, unit types the sources send to different kinds (16.5). Model in `apps/web/src/lib/unitTypes.ts`, view in `screens/UnitTypesView.tsx`; the Mapping page keeps environments only.
- **The plan is two-tier: flags at project level, targeting per environment** (2026-11-02): an LD flag exists in every environment as soon as it is created, so the modal first lists the plan's flags once each (`Plan.flags`: key, type, new / created by the console / foreign-and-adopted, and the outcome per environment) with no environment to choose for that part. Below it, **Configure targeting in** picks the LD environments whose rules, rollouts, targets and segments this run writes, pre-checked with what the header environment maps to; each chosen environment gets its own section listing the items configured there, dependencies included. Environments not chosen keep the flag off and show as not migrated (§7). Environments no source maps to cannot be chosen; a run with per-environment items needs at least one. The run is ordered the same way: context kinds, metrics and every flag shell first, then each environment in turn (`topoSort` env order).
- **One selection across the explorers** (`lib/selection.ts`, added 2026-11-02): ticks in Gates, Dynamic configs, Autotunes and the LD-source lists go into one workspace-wide set (kept for the tab in sessionStorage), a bar above the content shows what is picked, and its **Migrate N selected…** plans everything in one run. Each explorer's own button still plans just its kind; "Select all" and "Clear" there touch only that kind.

**Top bar**
- Workspace, LD instance and project, sources (Console API or spec, with last sync and refresh / "upload newer spec").
- **Environment selector** (also drives the grid's per-environment status), environment mapping, capability badge, and the Decisions count.

**Left nav**
- Resource types with counts, e.g. `Gates 142 · prod 38/142 · 4 drifted`.
- **Dashboard, Decisions, Waves, Activity log, Settings** (connections, mapping profile, capability matrix, members).

**Side-by-side grid**
- One row per logical resource.
- **Left cell:** the StatSig item, with a source badge when consolidating, status, rule count, checks/hour, tags, owner and a stale badge.
- **Right cell:** the LD item, with key, on/off for the selected environment, lastRequested and version.
- **Middle:**
  - A per-environment **status strip**, e.g. `dev ● stg ● prod ○`, with colors for not migrated, in sync, StatSig changed, LD changed, conflict, pending approval, failed, and LD authoritative.
  - Fidelity and decision icons.
- **Filters:** status in env X, fidelity, open decisions, source, tag, owner, stale, wave, client-side, "uses derived attributes".
- **Sticky action bar:** **Migrate / Sync to LD (n)** with environment checkboxes (defaulting to the selected environment), **Add to wave**, **Preview**, **Export**.

**Detail drawer**
- **Rules diff per environment** (environment tabs): StatSig rules after environment filtering on the left, generated LD config on the right. Conditions are colour-coded, and decision popovers open inline.
- **Dependencies, both directions**, with per-environment migration state.
- **JSON tab:** StatSig vs current LD vs proposed LD, as a 3-way Monaco view.
- **History:** app runs plus StatSig `/versions` (API source) or spec snapshot diffs.
- **Traffic:** cutover data per environment (§14).
- **Code snippet:** StatSig call → LD call.

**Migrate flow**
1. **Select** items and environments.
2. **Plan:**
   - The dependency closure is added automatically: segments in the same environments, context kinds, referenced gates and metrics.
   - Operations are listed per item and environment.
   - Open decisions are listed, along with the capability fallbacks that will be used and an estimated duration.
3. **Resolve decisions** inline.
4. **Dry run** with LD `dryRun`.
5. **Confirm.** Production needs a typed confirmation.
6. **Execute in the tab**, with live progress, per-item logs, bounded retries and an automatic stop on systemic errors.
   - Every operation is journaled to IndexedDB before and after it runs, so if the tab closes mid-run, the run **resumes when the tab is reopened**. Writes are idempotent, so repeating the last operation is safe.
   - A `beforeunload` warning and a Web Locks guard (one running tab per workspace) protect the run, with an optional Screen Wake Lock.
7. **Results**, with **Undo this run**.

---

## 10. Gate / dynamic config mapping

### 10.1 Flag shell (project level)
- **Key and name:**
  - LD `key` = StatSig name. Keeping them identical lets `ld-find-code-refs` find StatSig call sites, and makes code changes searchable.
  - Collisions across StatSig namespaces (gate, config and experiment can share a name) or across consolidated sources go to `key_collision` / `source_collision`.
  - `name`, `description` and `tags` are copied (enrichment applies for spec sources). `temporary` comes from `type`, and the maintainer from the owner.
- **Provenance:**
  - tags `migrated-from-statsig` and `migration-src-<alias>`
  - `customProperties`: `migration.kind`, `migration.id`, `migration.type`, `migration.source`, `migration.version` (§3.3)
  - a flag link (beta) to the StatSig `permalink`
  - every PATCH `comment` reads `"Synced from StatSig <type> <id> v<n> (source <alias>) by <user>, run #<id>"`
- **Gate:** boolean. Off variation and fallthrough are both `false`.
- **Config:** JSON variations. `defaultValue` comes first (fallthrough and off), then each unique `returnValue` / variant, deduplicated and named after the StatSig rule or variant. Append-only (§7).
- **Client-side availability:** set by the `client_side_availability` decision.

### 10.2 Per-environment targeting
1. **Filter rules for this environment.** Keep rules whose `environments` is null or includes this environment (Console API), and resolve every `environment_tier` / `environment_field` condition statically:
   - If it's true here, drop the condition.
   - If it's false here, drop the rule.
2. **Translate each rule:**
   - Conditions become ANDed clauses.
   - `passPercentage` becomes a rollout, using `rolloutContextKind` from `idType`. A gate's rollout is `{true: p×1000, false: rest}`. A config's is the rule value against the default, or spread across its variants.
   - 100% / 0% become fixed variations.
   - **Verify against a real project:** what a config returns when a user matches a rule but falls outside its pass percentage.
3. **Simplify:** rules after a `public` 100% rule can never be reached, so they're dropped. That rule becomes the fallthrough.
4. **Overrides** become `replaceTargets`, with the context kind per unit type and only the overrides that apply to this environment.
5. **On/off:** `isEnabled` or the status is mirrored.
6. **Apply** everything for the environment in one atomic semantic PATCH (or approval request).

### 10.3 Condition and operator table
**Condition types**

| StatSig | LD | Fidelity / decision |
|---|---|---|
| `public` | no clause | FULL |
| `user_id` | `user.key` | FULL |
| `unit_id(customID X)` | `<kind(X)>.key` | FULL (`unit_type_kind`) |
| `email`, `country`, `ip_address`, `locale`, `app_version`, `custom_field(f)` | the mapped attribute names in the mapping profile | FULL |
| `browser_*`, `os_*`, `device_model`, `user_agent`, IP-derived `country` | the mapped attribute | `derived_attribute` |
| `passes_segment` / `fails_segment` | `segmentMatch` (negated for `fails_`); the segment is a dependency in the same environment | FULL |
| `passes_gate` / `fails_gate` | §10.4 | `gate_reference` |
| `environment_tier` | resolved statically | FULL |
| `time` | — | `time_condition` |
| `target_app`, `javascript`, `experiment_group`, `url` | — | MANUAL / decision |

**Operators**

| StatSig | LD | Fidelity / decision |
|---|---|---|
| `any` / `none` | `in` (negated for `none`) | `case_insensitive_match` (+ `negated_missing_attribute` for `none`) |
| `*_case_sensitive` | `in` | FULL |
| `str_contains_any` / `none` | `contains` (negated for `none`) | `case_insensitive_match`: StatSig's evaluator lower-cases both sides (`stringCompare(true, …)`) |
| `str_starts_with_any` / `str_ends_with_any` | `startsWith` / `endsWith` | `case_insensitive_match` (same reason) |
| `str_matches` | `matches` | `regex_dialect` (only when non-portable features are detected) |
| `gt` `gte` `lt` `lte` | the numeric operators | FULL |
| `eq` / `neq` | `in` (negated for `neq`) | FULL |
| `version_gt` / `lt` / `eq` | `semVer*` | FULL |
| `version_neq` | `semVerEqual` + negate | FULL |
| `version_gte` / `version_lte` | `semVerLessThan` + negate / `semVerGreaterThan` + negate | FULL |
| `before` / `after` / `on` | `before` / `after` (both, for `on`) | FULL |
| `array_contains_any` / `none` | `in` (negated for `none`) | FULL |
| `array_contains_all` | one `in` clause per value | FULL |
| `not_array_contains_all` | De Morgan expansion into several rules (capped) | PARTIAL |
| `is_null` / `is_not_null` | — | `null_check` |
| `in_segment_list` / `not_in_segment_list` (spec) | `segmentMatch` against the ID-list segment | FULL once reconciled |

### 10.4 Gate references
1. **Every rule needs the same `passes_gate X`:** use an LD prerequisite. FULL; Enterprise.
2. **X has no partial rollouts:** inline X's rules (ORed, so one LD rule per X rule, capped). FULL, and works on any plan.
3. **Otherwise:** a `gate_reference` decision.

Referenced gates are dependencies, ordered by topological sort with cycle detection.

### 10.5 SDK and runtime gotchas (shown in the app)
- **Bucketing reshuffles.** StatSig hashes `sha256(salt.ruleSalt.unitID)` and LD hashes `flagKey.salt.key`. The user acknowledges this via `partial_rollout_rebucket`.
- **Derived attributes and multi-context requirements** are collected into a generated **context contract** for developers.
- **Code changes:**
  - `checkGate("x")` → `boolVariation("x", false)`
  - `getConfig("x").get("p")` → `jsonVariation("x", default).p`

---

## 11. Experiments, layers, holdouts, autotune: end in StatSig, launch new in LD

Policy: **no running experiment is moved mid-flight.** What carries over is the *structure* needed for new LD experiments: flags, metrics, layers and holdouts.

| StatSig state | What happens |
|---|---|
| `setup` (not started) | Create the JSON flag (a variation per group) and an LD experiment as a **draft, not started**, with the hypothesis, treatments, allocation, randomization unit and metrics. |
| `active` | `experiment_running` decision. Default: **wait.** The item shows "Running in StatSig, migrate after it ends". Optional: pre-stage the draft. |
| `decision_made` / shipped | `experiment_concluded`: the flag serves the shipped group's parameters at 100%. Results are archived (§13). |
| `abandoned` / `archived` | Skipped by default; listed for completeness. |

- **Layers:**
  - Create LD layers so *new* experiments stay mutually exclusive.
  - Map experiment reservations when pre-staging drafts.
  - `layer_parameters` decision for code that uses `getLayer().get()`.
- **Holdouts:** create LD holdouts per environment as **new populations** (`holdoutamount` from `passPercentage`). Attached gates and experiments become a checklist.
- **Autotune:** an LD bandit (`type: mab`), drafted. The success event becomes a metric.
- **Metrics are the critical path.** New LD experiments need them, so they are a dependency of every experiment migration.
  - **Cloud:** port the statsig-to-ld `metrics convert` logic. Event names must be emitted through LD `track()`; the app produces an **instrumentation checklist** per event.
  - **Warehouse Native:** a guided checklist to set up the LD warehouse integration and metric data source in the LD UI. This needs an LD Admin and is impossible through the API. Supported warehouses are Snowflake, BigQuery, Databricks and Redshift; not available on Federal.
    - Once the data source exists, the app creates warehouse-native metrics (`dataSource: {key, environmentKey}`, `valueColumn`, `denominator`), mapping StatSig metric sources and SQL. This reuses statsig-to-ld `warehouse`.
    - LD only supports custom and ratio metrics for warehouse native, so funnels are a decision.

---

## 12. Consolidation (N StatSig projects → 1 LD project)

- **Sources:** each source has an alias (e.g. `web`, `mobile`), its own environment mapping, unit-type → context-kind mapping and attribute mapping.
- **Matching:** entities are matched across sources by type and name, which gives three cases.

**Default collision policy** (our call; editable per workspace in Settings)

| Case | Default | Why |
|---|---|---|
| Name exists in only one source | **Keep the original key**, no prefix | Most items. Keys still match the StatSig names, so code search and `ld-find-code-refs` keep working. |
| Same name, **identical** after normalization (variations + per-environment targeting for every mapped environment) | **Auto-merge into one LD key.** Provenance lists both sources. | No behaviour change for either app. |
| Same name, **different** config | **Separate keys, prefix both:** `web.new_checkout`, `mobile.new_checkout` (`<alias><sep><key>`; separator `.` by default, `_` or `-` configurable) | Safe by default: no app can evaluate another app's targeting. Both apps are rewriting their SDK calls anyway, so a new key costs nothing extra. Prefixing *both* rather than only one source avoids a misleading unprefixed key that only one app should use. |

**Other options in the `source_collision` decision**
- **Keep the original key for a chosen primary source, prefix only the others.** Fewer code changes for the primary app.
- **Pick a winning source.** One key, the other source's config is discarded. Use it when one project's copy is known to be stale.
- **Single flag with discriminator rules (advanced).**
  - Only offered when both sources' unit types map to the same context kind, and a **workspace discriminator attribute** is configured, e.g. `ld_application.id` or a custom `platform`.
  - Each source's rules get a `discriminator in [<alias>]` clause.
  - The fallthroughs become one discriminator rule per source, followed by a safe fallthrough (false, or the default).
  - Adds the discriminator to the context contract.
  - Recommended only when teams want to manage the feature as one flag, e.g. a cross-platform kill switch.

**Rules that apply to every option**
- **Renames propagate.** When a segment or gate gets a prefixed key, every `segmentMatch` value, prerequisite key, inlined gate reference and experiment flag reference that points at it is rewritten. The planner validates that no reference dangles. *The old tool did not do this.*
- **Merged items keep watching both sources.** A merged item tracks drift from *each* source. If they later diverge in StatSig, the item gets a new `source_collision` decision, showing the earlier choice.
- **Shared resources:**
  - **Context kinds** are merged by unit-type name, with a decision if their meaning differs.
  - **Tags** are unioned.
  - **Metrics:**
    - Identical definitions merge.
    - Different definitions get prefixed metric keys.
    - The underlying **event key** stays shared by default, because both apps emit `purchase` into the same LD project. The user confirms once per event that the events mean the same thing.
  - **Environments:** each source maps independently. Several sources usually map to the same LD environment.
- **Grid:** a source column and filter, a "collisions" filter, and on merged rows a source badge for each source.

---

## 13. Preserving what doesn't migrate
- **Experiment results:** `pulse_results`, `cumulative_exposures` and decision metadata are archived to JSON/HTML per experiment. The archive is linked from the LD flag (flag link or custom property).
- **History:** StatSig `/versions` (API) or every uploaded spec snapshot is kept for the workspace's retention period.
- **The app's own audit log** and the decision log.

---

## 14. Monitoring (read-only, runs while the app is open)

**When it runs**
- On open, the app refreshes LD provenance and status, plus StatSig (Console API sources).
- While the tab is open, it re-checks every N minutes (default 15) within the rate budget.
- **Refresh now** forces a check.
- Every view shows "Last checked: …".
- Spec-only sources refresh when a new spec is fetched or uploaded.
- There is no background polling when the app is closed (§3.6).

**Drift, per (resource, environment)**
- **StatSig changed:** the StatSig fingerprint differs from the one at sync. Source: Console API refresh or a new spec upload.
- **LD changed:** the LD `_version` differs and the targeting diff isn't empty.
- **Conflict:** both changed.
- Fingerprints at sync time are read from the LD provenance (`migration.sync.<env>`), so drift detection works on any machine, even without the local workspace.
- Re-sync is always manual (§7), and shows the diff plus any new or stale decisions.

**Cutover, per (flag, environment)**
LD and StatSig only return *current* counts, so the history is built from samples the app takes while it's open. Samples are kept in IndexedDB and included in the workspace file.
- **StatSig side:**
  - `checksPerHour`, `/exposure_count` (`pastDay` / `past7Days`, batched 25 IDs per call)
  - `/gates/{id}/checks` → `has_production_checks_in_last_7_days`
  - Console API sources only. Spec-only sources show "unknown"; the user can attach a Console key later.
- **LD side:**
  - `GET /flag-statuses/{p}/{env}` → `new`, `active`, `inactive`, `launched`, plus `lastRequested`
  - beta `GET /usage/evaluations/{p}/{env}/{flag}` for per-variation counts
- **Lifecycle:** Migrated (no LD traffic) → Dual-running → **Cut over** (LD traffic, StatSig at zero for 7 days) → **Safe to archive in StatSig**. A human archives it in StatSig.

**Dashboard**
- A funnel per resource type and environment.
- A cutover chart per wave.
- A list of drift and open decisions.
- Stale StatSig gates (`STALE_*`) suggested as "don't migrate, hard-code".

**In-app alerts** (and browser notifications, if allowed, while the tab is open):
- drift detected
- an approval request decided
- a wave fully cut over
- a token failing (401)

There's no email or Slack, since that would need a server (§3.6).

**Reports** (CSV/markdown/PDF): inventory with fidelity, decision log, context contract, instrumentation checklist, wave status.

---

## 15. Safety
- **Pre-image** of every LD flag or segment environment before it's updated, stored in IndexedDB and in the workspace file.
  - **Undo run** deletes what the run created (flags, segments; context kinds can only be archived) and restores what it updated. *M3 deletes rather than archives created flags: an archived flag keeps its key, so re-migrating would collide, and nothing can depend on a flag created minutes earlier. Created flags are deleted at their environment step, newest first, because LD refuses to delete a flag that's a prerequisite or a segment a flag still uses.*
  - If the local pre-image is gone, undo falls back to the `previousVersion` in the LD audit log entry for that write. Verify this in M0.
- **Ownership guard:** LD resources without our provenance need a `key_collision` decision before we touch them.
- **Production confirmation:** typed confirmation for production syncs.
- **Rate budgets:** for the customer's StatSig and LD quotas, with a duration estimate before each run.
- **Least privilege:**
  - The Console key must be read-only; the app warns if `GET /keys/{id}` shows write scopes.
  - Recommend a scoped LD custom role for the service token where possible: flags, segments, metrics and experiments in the target project only.

---

## 16. Milestones

| # | Milestone | Scope |
|---|---|---|
| M0 | Browser foundations + spikes | **Spike #1: CORS with a real StatSig key** (Console API + spec CDN; decides whether the stateless relay exists). Vite SPA on Vercel static hosting, strict CSP, Dexie/IndexedDB store, Web Worker pipeline, in-memory tokens + optional passphrase vault, workspace file export/import (encrypted), LD instance selection with EU/Fed disclaimer, LD connect + **capability probe**, adaptive rate limiter |
| M1 | Source adapters + canonical model | Console API adapter, **config spec v1/v2 adapter** (upload + in-browser **Fetch spec**, snapshot diffing, sanity checks), response validation, capture-fixture mode, **simulated StatSig + the "Acme" demo dataset (§19)**. The dataset is also the main test fixture, so it gets built first. |
| M2 | Read-only explorer | Side-by-side grid for every resource type, per-environment status strip, matching, detail drawer, inventory/fidelity export. *Usable on its own for scoping deals.* |
| M3 | **Decision framework** + gates → flags | Mapper with decisions, mapping profile, environment mapping, context kinds, overrides, rule-based and small list segments, **per-environment migrate**, plan, dry run, in-tab executor with resumable journal, **LD provenance as the migration ledger**, undo, decision log |
| M4 | Configs, gate references, big segments | JSON flags (append-only variations), gate inlining / prerequisites, ID-list reconciliation, big-segment CSV import, approvals and scheduled-change fallbacks |
| M5 | Monitoring | Drift (from LD provenance), waves, cutover sampling + dashboard, in-app/browser alerts, reports, "LD authoritative" |
| M6 | Metrics | Cloud metrics + metric groups, instrumentation checklist, Warehouse Native guided setup + metrics |
| M7 | Experiments / layers / holdouts / autotune | Draft creation, concluded → shipped flag, results archive |
| M8 | Consolidation UI | Multi-source matching, auto-merge, `source_collision` options including discriminator rules (the data model has been ready since M0) |
| M9 | Polish | Parity tester, code snippets, enrichment CSV, release pipelines guidance |

**Demo readiness.** After each milestone, the demo scenario is extended so the new features can be shown (§19.5). The first useful demo comes after **M3**: the explorer, decisions, and migrating gates per environment into a real LD project.

**Testing**
- **StatSig sandbox projects:** two of them, so consolidation can be tested, each with every condition type and operator, every segment type, a layer with two experiments, a holdout, an autotune and every metric type. Both Cloud and a Warehouse Native trial if possible.
- **Spec fixtures:** download both v1 and v2 specs from those projects. Also use the public SDK test fixtures (`statsig-server-core/statsig-rust/tests/data/*.json`, `node-js-server-sdk/src/__tests__/data/*.json`).
- **Golden tests** for the mapper: canonical input + mapping profile + resolutions → expected LD state + decisions.
- **Adapter equivalence test:** the same sandbox project read through the Console API and through the spec must produce the same canonical targeting.
- **LD sandbox projects** on an Enterprise account and on a lower plan, to exercise the capability fallbacks. Also a Writer service token, to confirm the context-kind and member-lookup behaviour.

---

## 17. More ideas
1. **Parity tester (exact).** With a spec uploaded (or attached to an API source), run StatSig's own SDK in local or bootstrap mode against the spec, and LD through `POST /projects/{p}/environments/{e}/flags/evaluate`, for sample contexts that are pasted, uploaded, or generated from rule values. Show mismatches. Rollout mismatches are expected and labelled as such.
2. **Pruning before migrating.** StatSig `STALE_*` labels (Console API), or specs with all-true or all-false gates → "hard-code it, don't migrate". This often cuts scope substantially.
3. **Context contract + instrumentation checklist.** Generated docs for developers: attributes, context kinds, discriminators, and `track()` events.
4. **OpenFeature shadow mode.** Recommend an OpenFeature wrapper that evaluates both providers and logs mismatches during dual-running.
5. **Freeze guidance.** When a wave's items drift in StatSig after migration, show a banner suggesting a StatSig change freeze for migrated items.
6. **Coordinate with the statsig-to-ld maintainers** (`mrosenthal-ld`): reuse their metrics and warehouse conversion logic, share fixtures, and send the operator-mapping fixes upstream.

## 18. Open items

**Answered:** users and hosting (browser-only, §0 and §3), EU/Fed (§3.5), consolidation default (§12), spec-only sources (§4.2).

**One caveat on spec-only sources.** Re-uploading the config file regularly covers everything *except* the contents of large ID lists. StatSig only ships those as one-way hashes, in the separate `get_id_lists` files rather than in the config spec itself. For those segments a spec-only customer still has to provide one of:
- a raw-ID CSV, which the app hashes and reconciles against StatSig's list; or
- a Console key.

Small ID lists are inline in the spec as plaintext and are fine. The app lists affected segments under a `hashed_id_list` decision, so nothing is silently dropped.

**To verify empirically in M0–M1.** These are facts we can't settle from the docs.
1. Can a **Writer service token** create context kinds and look up members by email? The docs conflict. Probe with a real token.
2. **Browser access to StatSig (M0 spike #1).** Do successful Console API and spec-CDN responses carry `Access-Control-Allow-Origin`? If not, build the stateless relay (§3.1).
3. In StatSig, what does a dynamic config return when a user **matches a rule but falls outside its pass percentage**: the default value, or does evaluation fall through to the next rule? Test in a sandbox project.
4. Do **archived entities** appear in the config spec? We believe not.
5. Does LD `dryRun=true` still return **405** in environments that require approvals?
6. Do LD **custom-property** limits (count per flag, value length) leave room for one `migration.sync.<env>` property per environment? The fallback is a single packed property.
7. Do LD audit-log entries include a full `previousVersion`, so undo works without a local pre-image?

---

## 19. Demo mode

Purpose: show everything the app can do before a real StatSig Console token is available. The StatSig side is simulated. The LD side is **real**: the user enters their own LD token, and the app writes to a real LD project.

### 19.1 How the StatSig side is simulated
The demo doesn't take a shortcut around the real code. It sits **behind** the real adapters, so a demo also tests the production code paths.
- **Simulated StatSig Console API, entirely in the browser:** a mock transport, built with **Mock Service Worker (MSW)**, intercepts `fetch` calls to a demo base URL and serves the Console API endpoints from the seeded dataset. No server is involved.
  - It matches the real OpenAPI shapes: pagination envelope, `data`, odd shapes such as `/gates/{id}/rules`, and 429s injected occasionally so the backoff is visible.
  - A demo source is a normal **Console API source** whose base URL points at the mock, with a dummy key. Nothing else in the app knows it's a demo.
- **Sample config spec files** (DCS v1 and v2) generated from the *same* dataset, plus sample `get_id_lists` files and a raw-ID CSV. They demo the spec-only path: upload, re-upload diffing and ID-list reconciliation.
- **Simulated time series:** `checksPerHour`, `/exposure_count` and `/gates/{id}/checks` decline over the demo timeline, so the cutover view has a story to tell.
- **Seed dataset:** a versioned JSON file in `packages/demo-fixtures`. It's the same dataset as the M1 test fixtures and golden mapper tests, so one source of truth stays in sync with the code.

### 19.2 The "Acme Retail" scenario (seed contents)
Two StatSig projects, **`acme-web`** and **`acme-mobile`**, which also demos consolidation. Each is designed so every feature has at least one example:

| Area | Seeded examples |
|---|---|
| Environments | development, staging, production, plus a custom `qa` tier with no LD match (`env_unmapped` decision) |
| Unit types | `userID`, `stableID`, `companyID` (context-kind decisions) |
| Gates (~55) | Every condition type and operator in §10.3, and every row of `docs/KNOWN-EDGE-CASES.md` (the running list of StatSig/LD mismatches, with the mapper backlog). `version_gte`, case-insensitive `any`, regex, `is_null`, `time` (one in the past, one in the future), `browser_name` (derived attribute), `passes_gate` that can be inlined and one that can't, `passes_segment`, `environment_tier`, environment-scoped rules, partial rollouts (rebucket ack), overrides including per-environment, disabled gates, archived gates, `STALE_*` gates (pruning suggestion), a client-side-only target app |
| Dynamic configs (~10) | Multi-value configs with variants, a config gaining a new value in snapshot 2 (`variation_change_affects_migrated_env`), a JSON schema |
| Segments | Rule-based; small ID list; **big ID list (20k IDs)** → big-segment decision; hashed list for the spec-only demo, with a CSV that is 99.6% complete (reconciliation report) |
| Experiments | One in each status: `setup`, `active` (wait decision), `decision_made` (ships a group), `abandoned`. One in an explicit layer with shared parameters, one in an implicit layer, one with a targeting gate. |
| Layers / holdouts / autotune | An explicit layer with 2 experiments, a global holdout, a gate-linked holdout, an autotune |
| Metrics | Cloud: event_count, sum, mean, ratio, funnel, composite (unsupported → decision). Warehouse Native: 2 metric sources + metrics, to demo the guided setup checklist. |
| Param store | One, with static, gate and experiment-backed params |
| Tags / owners / teams | Owners with real-looking emails, some deliberately missing in LD (`maintainer_unknown`) |
| Consolidation | ~6 names in both projects: 3 identical (auto-merge), 3 different (prefix decision), one shared segment name, and a shared `purchase` event |

### 19.3 Demo-only controls
On the demo workspace only, there's a **Demo** panel:
- **Advance StatSig timeline:** applies the next scripted snapshot. A few gates change, a config gains a value, an experiment concludes and traffic shifts. This demos drift detection, re-sync and the cutover chart without waiting days.
- **Simulate LD traffic (optional):** a server SDK can't run in the browser, so this uses the **LD JavaScript client SDK**. It reads the demo environment's client-side ID through the API and evaluates the demo's client-side-available flags against a few synthetic contexts. LD flag statuses then become `active` and evaluation counts appear.
  - This is the only demo action that generates LD usage (client-side MAU), so it's off by default and capped at a small number of contexts.
- **Reset demo:**
  - Rolls the simulated StatSig back to snapshot 1 and clears the demo workspace's IndexedDB data: decisions, runs, snapshots.
  - Optionally **deletes the resources the app created in the demo LD project**. It only targets resources carrying the demo provenance tag *and* only in the LD project linked to the demo workspace. It requires typed confirmation, and it is refused if the project wasn't created by the demo setup, or isn't tagged `statsig-migration-demo`.
- **Sample downloads:** sample config-spec files, ID-list files and raw-ID CSV, for demoing the upload path.

### 19.4 LD side and setup
1. **Open demo mode.** A **Try the demo** button on the start screen creates an "Acme Retail (Demo)" workspace locally, with both demo sources preconnected.
2. **Enter an LD token.** The capability probe runs for real, so the demo honestly shows which features *their* LD plan supports.
3. **Choose the LD project.** **Create a fresh LD project** (recommended), e.g. key `statsig-demo-<yyyymmdd>`, tagged `statsig-migration-demo`, with environments created from the mapping. Or pick an existing one, with a warning to avoid real projects.
4. **Seeding** is just loading the bundled fixtures into IndexedDB. It can be repeated safely, so every deployment, including Vercel preview URLs for PRs, has the demo available with no setup.
5. **Demo workspace file:** a pre-built `.sslm` with decisions half-resolved and some items already migrated. Import it to jump to the middle of the story; the LD side is then reconciled from provenance.

### 19.5 Demo script
A `DEMO.md` walkthrough (10–15 minutes) is kept up to date with each milestone:
1. Connect the LD token and show the capability matrix.
2. Explore inventory side by side; show the fidelity report and the stale-gate pruning suggestions.
3. Open a gate with tricky conditions and walk the condition-level translation.
4. Use the Decisions inbox: resolve "case-insensitive match — N conditions" in one click, and save it as a policy.
5. Migrate checkout gates to **staging only**, with a plan, dry run, execution and undo. Open LD and show the flags, provenance and audit-log comments.
6. **Advance the timeline.** Show the "StatSig changed" drift, the 3-way diff, a manual re-sync, and the variation-append decision.
7. Migrate to **production**, then simulate LD traffic and show the cutover chart.
8. Consolidation: switch on `acme-mobile`, auto-merge the identical items, and show the prefix decision.
9. Experiments: a concluded experiment becomes a shipped flag, and a setup experiment becomes a draft LD experiment with metrics.
10. Spec-only path: upload the sample spec, re-upload a newer one to see the diff, and run the ID-list reconciliation report.
11. Export the decision log and the context contract.

---

## 20. Second source: another LaunchDarkly project, and the provider-neutral model

**Why.** "Copy this LD project into a new LD project" (a new account after an acquisition, splitting a project, moving to the EU instance) is a request that comes up often, and it is the cheapest second source: the target vocabulary *is* the source vocabulary. It also forces the question the multi-source direction depends on: what model sits between a source adapter and the LD mapper.

### 20.1 The decision: a neutral core now, StatSig stays put until the third source

The canonical model (§4, `packages/canonical/src/model.ts`) is StatSig's: `CONDITION_TYPES`, `OPERATORS`, gates vs dynamic configs, `passPercentage`, overrides. An LD source must not be squeezed into that (an LD clause has a typed operator, a context kind and `negate`; a rule serves a variation or a weighted rollout; a flag has N arbitrary variations). The intended end state is a provider-neutral intermediate model that every adapter emits and one LD mapper consumes. Three ways to get there were weighed:

| Option | What it means | Verdict |
|---|---|---|
| A. Force LD into StatSig terms | LD rules become StatSig `custom_field` conditions etc. | No. Lossy both ways; every operator would need a decision for a translation that is the identity. |
| B. Full neutral model first | Rewrite both StatSig adapters and the mapper onto a new model, then add LD | No, not yet. Weeks of churn with the golden files as the only safety net, before the second source proves the model. |
| **C. Neutral core alongside** (chosen) | Add a small neutral model; the LD adapter emits it; a new mapper path consumes it; the StatSig path is untouched | Yes. Ships the second source now; the neutral core is designed from the mapper's *output* types, which the StatSig path already produces, so moving StatSig onto it later is a refactor, not a redesign. |

**What the neutral core is** (`packages/canonical/src/neutral.ts`). The flag-platform concepts every source has, in LD-shaped vocabulary because LD is the target and the richest of the sources:
- `NeutralFlag`: key, name, description, kind (boolean / multivariate), ordered variations, tags, temporary, client-side availability, defaults, custom properties, maintainer, archived, and one `NeutralFlagEnv` per source environment: on, off variation, fallthrough, rules (clauses + serve a variation or a rollout), individual targets per context kind, prerequisites, version.
- `NeutralSegment`: key, name, description, tags, and one `NeutralSegmentEnv` per environment: rules (clauses, optional weight / bucketBy), included and excluded keys per context kind, `unbounded` (big segment) with its context kind, version.
- `NeutralClause`: context kind, attribute, operator (LD's operator names), values, negate. `NeutralRollout`: context kind, optional bucketBy, weighted variations in thousandths of a percent.
- Environments and context kinds of the source project.

**How it plugs in.** `CanonicalSnapshot` gains an optional `neutral` block (flags, segments, context kinds) next to the StatSig collections, and `SourceKind` gains `launchdarkly`. An LD-source snapshot has empty StatSig collections and a populated `neutral` block, so every piece of plumbing that moves snapshots around (store, snapshots view, pruning, run journal, workspace file) is unchanged. The planner accepts neutral flags and segments in a plan next to gates and configs; the executor is unchanged except that provenance carries the source kind. Step 2, when the third source arrives: the StatSig adapters emit `neutral` too, the StatSig mapper becomes a translator *into* the neutral model (its per-condition decisions move with it), and the one neutral → LD mapper writes everything. At that point the StatSig collections go away and `neutral.*` is hoisted to the top of the snapshot.

**Trade-offs accepted.** Two vocabularies live in one snapshot container until step 2; the UI branches on `snapshot.neutral` for inventory (a dedicated LD-source explorer rather than the gate/config grid); field names that say `statsig` (`statsigEnv`, `statsigFingerprint`, `statsigType`) now mean "source" and are documented as such rather than renamed across the executor, monitoring and journal in the same change.

### 20.2 The LaunchDarkly source adapter (`packages/adapters/src/launchdarkly`)

- **Input:** instance (US, EU, Federal), project key, an API token with read access to that project. The token lives in memory like the other tokens (`secrets` kind `ld_source`, keyed by source id). The source may be a different account or instance than the target; the CSP already allows the three LD API hosts.
- **Reads (never writes):** `GET /projects/{p}`, `/projects/{p}/environments`, `/projects/{p}/context-kinds`, `/flags/{p}` (summaries, for the count) then `GET /flags/{p}/{key}` per flag (every environment's targeting in one response), and `GET /segments/{p}/{env}` per environment. Lenient Zod schemas from `packages/ld-client` (field names from `reference/launchdarkly/openapi.json`); mismatches become snapshot warnings.
- **Not readable, and reported as such:** big-segment membership (LD only answers per-key membership), flag links, approval settings, experiments and metrics (out of scope by §11), member and team identities of another account.

### 20.3 Mapping an LD flag to an LD flag: near-identity, every difference a decision

The mapper is `packages/mapper/src/neutral.ts` (`mapNeutralFlag`, `mapNeutralSegment`), pure like the rest. What is copied verbatim: name, description, kind, variations (values and names), tags, temporary, client-side availability, defaults, on/off, off variation, fallthrough, rules and clauses, individual targets, segment rules and lists. What becomes a decision or a note:

| Difference | Handling |
|---|---|
| Source environment with no target environment | `envMapping` in the profile (auto-mapped by key or name, §7); unmapped environments are not migrated |
| Context kind missing in the target project | `unit_type_kind` (choice): create it (an `ensure_context_kind` step) or use an existing kind |
| Percentage rollouts (rules, fallthrough, weighted segment rules) | `partial_rollout_rebucket` (acknowledge): the new flag has a new salt, so the same percentage lands on different contexts |
| Prerequisites | Dependency on the referenced source flag, migrated first in the same environment. `prerequisite_unsupported` (blocking) when the target plan or token lacks prerequisites; `missing_reference` when the flag is not in the source |
| `segmentMatch` clauses | Dependency on the source segment in the same environment; `missing_reference` when it is not there |
| Big (unbounded) segments | `big_segment`: create it empty (membership is not readable; import the member list by hand), or skip. Rules that reference a skipped segment block their flag |
| Custom properties other than `migration.*` | `copy_custom_properties` (choice): copy or leave out. Provenance keys and `migrated-from-*` / `migration-src-*` tags from an earlier migration are never copied |
| Key already in the target and not created by the console | `key_collision` (blocking), as for every source |
| Maintainer, maintainer team | Not carried (member IDs belong to the source account); noted |
| Disabled rules, `trackEvents`, experiments on the flag, migration-purpose flags | Disabled rules are left out (they do not evaluate); event tracking and experiments are noted; migration flags are skipped with a reason |
| Operators the console does not know | `unsupported_condition` (blocking) |

**Provenance** (§3.3) is written with `kind = launchdarkly`: tags `migrated-from-launchdarkly` and `migration-src-<alias>`, custom properties `migration.kind = launchdarkly`, `migration.id` = the source flag key, `migration.type = flag`, `migration.source`, `migration.sync.<env>`; segments get the `[ld-migration: from=launchdarkly; …]` footer. The planner's ownership and drift checks work unchanged.

### 20.4 Out of scope for the first step
Experiments, metrics, holdouts and release pipelines (they end in the source and start new in the target, §11); flag links; approval settings; copying member and team assignments; reading big-segment membership; consolidation of an LD source with a StatSig source into one key (the data model allows it, the `source_collision` UI is M8).
