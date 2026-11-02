# Migrating from StatSig to LaunchDarkly: what moves, what needs a decision, and what doesn't exist on the other side

*Working notes for the migration console and the source material for a blog post. The tables under "Coverage matrix" are generated from `packages/coverage/src/matrix.ts` (`pnpm coverage:generate`) and are the same data the console shows on its **What migrates** page. Row-level detail lives in [KNOWN-EDGE-CASES.md](KNOWN-EDGE-CASES.md). Last reviewed 2026-10-22 against the StatSig docs, the StatSig Console API spec (20240601), the StatSig SDK evaluator source, the LaunchDarkly docs and the LaunchDarkly REST API spec (20240415).*

## TL;DR

- **Feature gates, dynamic configs, segments and Autotune migrate automatically**, per environment, with every inexact translation surfaced as a Decision you answer once. Nothing is dropped or approximated silently.
- **Experiments, layers and holdouts don't move mid-flight.** Running experiments finish in StatSig; their structure (flags, metrics, layers, holdouts) is carried over so new experiments start in LaunchDarkly. The console inventories them today and writes drafts in a later milestone.
- **Metrics translate; events don't.** Metric definitions can be converted, but the events behind them must be re-sent through the LaunchDarkly SDK. The console produces the instrumentation checklist.
- **Some things have no LaunchDarkly equivalent**: contextual bandits, composite metrics, switchback experiments, JSON-schema validation of config values, StatSig's product analytics, session replay and dashboards. They are listed, not hidden.
- **StatSig has no "all projects" API.** A Console API key belongs to one project, so the console reads one project per source and can consolidate several sources into one LaunchDarkly project.

## 1. The two platforms are organized differently

| | StatSig | LaunchDarkly |
|---|---|---|
| Top level | Organization (Enterprise-only; owners can see every project) | Account |
| Unit of configuration | **Project**: a hard boundary; every entity belongs to exactly one | **Project**: flags, segments, metrics, experiments live here |
| Environments | Tiers (`development`, `staging`, `production`, custom). Rules are project-wide and may be *scoped* to tiers | Environments. **Targeting is per environment**; a flag exists in every environment |
| Identity | Unit ID types: `userID`, `stableID`, custom IDs | Context kinds: `user` built in, any other kind created per project |
| Segments | Project-wide | **Per environment** |
| API access | Console API key, **scoped to one project** | Service token, scoped by role; can see every project |
| SDK key scoping | By environment and by **target app** | By environment; flags opt in to client-side SDKs |

Three consequences for a migration:

1. **One Console key reads one project.** `GET /console/v1/project` returns the one project the key belongs to and `GET /console/v1/company` returns the company; there is no call that lists an organization's projects, so a tool cannot "pull in all projects". StatSig itself steers teams toward *target apps*, not projects, when several apps share gates. The console asks for a key per project (a *source*) and lets a workspace hold several sources that write into one LaunchDarkly project. Gates with the same name and identical targeting across sources merge into one flag; different targeting gets prefixed keys. A read-only key (`omni_read_only` scope) is all it needs.
2. **Environment scoping becomes per-environment targeting.** A StatSig rule enabled only in `staging` is dropped from `production` with a note. `environment_tier` conditions are resolved statically. Creating a flag creates it in every LaunchDarkly environment, off; environments you have not migrated show as *not migrated* and keep serving StatSig.
3. **Target apps have no counterpart.** They scope StatSig SDK keys, nothing more. In LaunchDarkly each flag decides whether client-side and mobile SDKs may read it, so every migrated flag asks this once (a policy answers it for all).

## 2. What migrates automatically

Gates become boolean flags, dynamic configs become JSON multivariate flags, segments become per-environment segments and Autotune becomes a drafted multi-armed bandit. The mapper is pure and deterministic: the same StatSig snapshot, mapping profile and answers always produce the same LaunchDarkly state, and golden tests pin what lands in a customer's project.

What carries over exactly:

- **Evaluation order.** StatSig evaluates ID overrides, then conditional overrides, then holdouts, then rules top-down, and stops at the first rule whose conditions match. LaunchDarkly evaluates prerequisites, individual targets, then rules top-down. Overrides-before-rules and first-match carry over exactly; the holdout and prerequisite differences are decisions (below).
- **Launched and disabled gates.** A Launched gate skips its rules and returns true for everyone; a Disabled gate returns false. The console maps status, not just the on/off bit, because the Console API can report a Launched gate with `isEnabled: false` and no rules.
- **Pass percentages.** Verified in the StatSig SDK evaluator (`_evalConfig`): a user who matches a rule but falls outside its pass percentage gets *fail* (gates) or the *default value* (configs); evaluation does **not** continue to the next rule. That is exactly an LD rule serving a percentage rollout between the rule's variation and the fail/default variation.
- **Overrides** become individual targets per context kind, scoped to the environment they apply to.
- **Gate references** (`passes_gate` / `fails_gate`) are inlined when the referenced gate has only 100% rules, or become an LD prerequisite when every rule requires the same gate.
- **Names, descriptions, tags, lifecycle** (`PERMANENT` → permanent flag, everything else temporary; stale gates get a "hard-code me" note), and **provenance**: `migrated-from-statsig` / `migration-src-<alias>` tags, `migration.*` custom properties (source-neutral keys, so a second source can share the LD project) and an audit comment naming the StatSig version and the run. Resources written by builds before 2026-10-30 (`statsig-migrated`, `statsig.*`) are still recognised.
- **Drift after the sync is detected from the same provenance.** The Monitoring page compares the fingerprint recorded at sync with the current StatSig snapshot (StatSig changed), the flag's LaunchDarkly modification time with the sync (LD changed), and flags both (conflict); an entity archived or deleted in StatSig after migration is listed for retirement rather than re-synced. LaunchDarkly flag statuses (`new`, `inactive`, `active`, `launched`) drive a per-environment cutover funnel: migrated, dual-running, cut over (LaunchDarkly traffic and no StatSig checks for 7 days), safe to archive in StatSig. Re-syncs are always a person's decision; the monitor never writes.

## 3. What needs a decision, and why

The two platforms disagree on a handful of evaluation details. Each one becomes a **Decision** with a recommended option, answered once per item or once per workspace as a policy. These are the ones customers hit most:

| Difference | StatSig | LaunchDarkly | Decision |
|---|---|---|---|
| Case | `any`, `str_contains_any`, `str_starts_with_any`, … lower-case both sides | All string operators are case-sensitive; no case-insensitive variants exist | `case_insensitive_match`: case-folded regex (exact), lower/upper variants, or exact |
| Types | `any [2, 3]` matches `2` and `"2"`; comparisons coerce numeric strings | `in` compares typed values: `"2" ≠ 2` | `value_type`: emit both forms, numbers only, or strings only |
| Missing attributes | `none`, `neq`, `str_contains_none` **pass** when the attribute is absent | A clause on a missing attribute never matches, negated or not | `negated_missing_attribute` (acknowledge) |
| Null checks | `is_null` / `is_not_null` | No "is set" operator | `null_check`: `is_not_null` ≈ `matches ".*"`; `is_null` must drop the rule or skip |
| Versions | Any number of parts, suffix after `-` stripped, missing parts padded | Strict semver; 4-part strings never match; `1.0.0-beta < 1.0.0` | `version_format`: truncate, drop, or skip |
| Regex | JavaScript `RegExp` | Each SDK's engine; no lookbehind/lookahead anywhere | `regex_dialect` when non-portable constructs are found |
| Derived attributes | Browser, OS, device model parsed from the user agent; country from IP | SDKs never derive attributes | `derived_attribute`: the app must send the attribute (goes into the context contract) |
| Time | `time` conditions read the SDK clock | No clause can read the clock | Past windows resolve statically; future flips become LD scheduled changes (Enterprise) or a `time_condition` decision to resolve as of the sync |
| Bucketing | `sha256(salt.ruleSalt.unitID)` | `sha1(flagKey.salt.key)` | `partial_rollout_rebucket`: same percentage, different users; acknowledged per rule |
| Prerequisite order | Overrides are evaluated before rules | Prerequisites are evaluated **before** individual targets | Reported as partial fidelity when a prerequisite flag also has pass overrides |
| Holdouts on gates | Hold out N% before the rules | A separate holdout population (a prerequisite flag under the hood) | `holdout_attached` (acknowledge) until LD holdouts are created |
| No equivalent clause | `target_app`, `url`, `javascript`, `experiment_group` | — | `unsupported_condition`: drop condition, drop rule, or skip |

Two more differences are handled without a decision but worth knowing:

- **Segment rules with percentages fall through in LaunchDarkly.** In StatSig a segment is evaluated like a gate: the first matching rule decides, and users outside its pass percentage *fail*. In LaunchDarkly a context that misses a segment rule's percentage **continues to the next segment rule**. For a segment with one weighted rule the result is identical; with several rules it is not, and the console notes it.
- **Rollouts and context kinds.** If LaunchDarkly evaluates a rollout keyed on a context kind the evaluated context does not have, it serves the first variation with weight > 0 rather than the off variation. Multi-context requirements are listed in the generated context contract so SDK calls send every kind a flag needs.

## 4. What has no LaunchDarkly equivalent

These are the genuine limitations. The console lists each affected item so nobody discovers them after cutover.

- **Contextual bandits (Autotune AI).** LaunchDarkly bandits are plain Thompson-sampling bandits; there is no per-context policy. Use a bandit, or an experiment per segment.
- **Composite and user-accounting metrics** (DAU/WAU/retention, metrics built from other metrics). Rebuild from the underlying events, or as a metric group.
- **Switchback experiments**, and StatSig-specific analysis options. LaunchDarkly offers Bayesian and frequentist (fixed-horizon and sequential) analysis, CUPED and stratified sampling, configured per experiment.
- **JSON-schema validation of dynamic config values.** JSON variations are free-form; the schema is kept in the flag description.
- **Per-parameter config reads.** `getConfig("x").get("p", default)` becomes one `jsonVariation("x", default)` and a field read; StatSig never merged rule values with the default either, so behaviour is unchanged.
- **Experiment results and exposures.** Results stay in StatSig (archived to a file and linked from the flag). LaunchDarkly cannot import a finished experiment's data or a finished bandit's learning.
- **Product analytics, web analytics, session replay, dashboards, alerts, reports.** LaunchDarkly Observability is a different product with its own instrumentation.
- **Release pipelines, review settings, integrations, keys, users and roles.** Organizational configuration is set up directly in LaunchDarkly.
- **Config-spec-only sources** cannot provide metrics or raw ID-list members (lists above 1,000 IDs are not in the spec payload at all, and larger ones ship as one-way hashes); a Console API key or a raw-ID CSV fills the gap. A spec exported with a target-app-scoped key is partial.
- **Size limits differ.** StatSig allows config values up to 100 KB; LaunchDarkly caps a JSON variation at 32 KB. StatSig ID lists go to 10 million IDs; LaunchDarkly list segments stop at 15,000 and larger lists need the big-segment CSV import.
- **Scheduled rollouts** (per-rule automated steps, and dynamic-config "Switch" schedules) migrate at their *current* percentage; the pending steps have to be recreated as a progressive rollout or scheduled changes.

## 5. Experiments: why nothing moves mid-flight

Re-randomizing a running experiment invalidates its results: StatSig and LaunchDarkly bucket differently, so the same user would land in a different group. The console therefore treats experiment state as the deciding factor:

| StatSig state | What the console does |
|---|---|
| `setup` (not started) | JSON flag (a variation per group) and a **draft** LaunchDarkly experiment with the hypothesis, treatments, allocation, randomization unit and metrics |
| `active` | "Running in StatSig, migrate after it ends." Optionally pre-stage the draft |
| `decision_made` / shipped | Flag serving the shipped group at 100%; results archived |
| `abandoned` / `archived` | Skipped, listed for completeness |
| `experiment_stopped` / `assignment_stopped` | Drafted like a not-started experiment, or skipped |

Only plain A/B experiments (`experimentType: BASE`) have a LaunchDarkly shape. Switchback, geo, grid-search and no-code sidecar experiments are listed as having no equivalent; prompt experiments belong to LaunchDarkly AgentControl.

Layers become LaunchDarkly layers (which reserve traffic for whole experiments, not for shared parameters, so code using `getLayer().get()` gets a `layer_parameters` decision). Holdouts become new populations with the same percentage. Metrics are the critical path: a new LaunchDarkly experiment needs its metrics first, and LaunchDarkly's own warehouse-native path (Snowflake, BigQuery, Databricks, Redshift, ClickHouse) needs a data source created by an LD admin in the UI before any metric can be written through the API.

## 6. Things LaunchDarkly has that StatSig customers should adopt on the way in

A migration is a chance to pick up capabilities that have no StatSig counterpart, or a stronger one:

- **Context kinds and multi-contexts** replace custom unit IDs with first-class kinds that can target, roll out and experiment on `company`, `device`, `organization` and more, together in one evaluation.
- **Guarded rollouts** (Release Guardian) monitor metrics during a rollout and roll back automatically, the natural home for StatSig safeguards once metrics exist in LD. **Progressive rollouts** schedule percentage steps over time.
- **Approvals, scheduled changes and custom roles** give production change control; where an environment requires approvals the console files an approval request with the same change instead of writing directly, and records the sync only once a reviewer applies it.
- **Flag views** group flags, segments and configs for access scoping; projects can require every flag to belong to one.
- **Code references** (`ld-find-code-refs`) find every call site because migrated keys equal StatSig names.
- **Migration flags**, **AgentControl** (AI configs), **Observability** and **Vega** are separate LaunchDarkly products available after the move.

## 7. Another LaunchDarkly project as the source

Since 2026-10-30 the console also reads an existing LaunchDarkly project (same or another account or instance) and migrates its flags and segments into the target project with the same side-by-side, decision-driven, manual-sync workflow. Because the vocabulary is the target's, almost everything copies verbatim: shell, variations, per-environment targeting, individual targets, segment rules and lists. What differs between two projects still becomes a decision: context kinds the target lacks, percentage rollouts (a new flag has a new salt, so the same percentages land on different contexts), prerequisites on plans without them, big segments (membership is not readable through the API), the flag's own custom properties, and key collisions. Experiments, metrics, maintainers and approval settings are not carried (they belong to the source account or end there), and are noted. The rows are under *Another LaunchDarkly project as the source* in the matrix below and in `docs/KNOWN-EDGE-CASES.md` §18.

## 8. Prior art and why this console exists

LaunchDarkly's built-in flag importer supports Split and Unleash and copies flag shells only (name, key, variations, tags; flags land off with no rules or targets). StatSig publishes a guide for the opposite direction and, tellingly, advises against importing large ID-list segments. The earlier `statsig-to-ld` CLI mapped rules but had known operator bugs, no decision model, and no per-environment state. This console is browser-only, writes only to LaunchDarkly, records the migration ledger in the LD project itself (tags, custom properties, audit comments) and treats every imperfect mapping as a decision a person answers.

## Coverage matrix

<!-- coverage:start (generated by pnpm coverage:generate; edit packages/coverage/src/matrix.ts) -->

### Legend

| Mark | Status | Meaning | Rows |
|---|---|---|---|
| ✅ | **Migrates** | Translated exactly and written automatically; at most an informational note. | 11 |
| 🟡 | **Migrates with decisions** | Written automatically once you answer a Decision or acknowledge a documented difference. Nothing is dropped silently. | 35 |
| 🧭 | **Guided / manual** | The console does not write it; it produces a checklist, a generated document or step-by-step guidance and a person finishes it in LD or in code. | 16 |
| 🚧 | **Planned** | LD has an equivalent and the mapping is specified, but the console does not write it yet. The item is inventoried and its blockers are listed. | 12 |
| ❌ | **No LD equivalent** | LaunchDarkly has no equivalent, or it is a different product that is set up on its own. | 13 |

### Projects, environments and identity

StatSig organizes an organization into projects; a Console API key belongs to exactly one project, so the console reads one project per source and can consolidate several sources into one LaunchDarkly project.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🧭 | Organization (company) with several projects | Account with several projects | One workspace targets one LD project; add a source per StatSig project you want in it, or create one workspace per StatSig project. | StatSig restricts every entity to a single project and has no Console API call that lists an organization’s projects (GET /project returns one project; GET /company returns the company). A Console API key is scoped to one project, so the console cannot discover your projects: you add each project with its own key (a read-only key is enough). Several sources in one workspace are consolidated (same name and identical targeting → one flag; different targeting → prefixed keys). Organizations themselves are an Enterprise-only StatSig feature. [StatSig](https://docs.statsig.com/console-api/introduction) · [LD](https://launchdarkly.com/docs/home/account/project) |
| 🟡 | Environments (tiers: development, staging, production, custom) | Environments | Each StatSig environment maps to an LD environment, or to "not migrated"; LD environments can be created from the mapping page. | Rules scoped to an unmapped tier are dropped from the mapped environments, with a note. Migration state is tracked per (resource, LD environment). Edge cases: 2.1, 2.2, 2.5. [StatSig](https://docs.statsig.com/guides/using-environments) · [LD](https://launchdarkly.com/docs/home/account/environment) |
| 🟡 | Unit ID types (userID, stableID, custom IDs) | Context kinds | userID → user, stableID → device, a custom unit type → a context kind of the same name, created on first use. | Custom unit IDs are never collapsed into user. The Unit types page sets, once per unit type, which context kind its IDs key (created by the migration if LD lacks it) or which attribute of the user context carries them, and warns when two unit types share a kind. A unit type left on its default whose kind is missing in LD raises a unit_type_kind decision per item (create it under the proposed key or a key you type, keep the unit type as an attribute of the user context, or pick an existing kind; never the user key). Decisions: `unit_type_kind`. Edge cases: 3.1, 3.2, 3.4, 3.5. [StatSig](https://docs.statsig.com/guides/experiment-on-custom-id-types) · [LD](https://launchdarkly.com/docs/home/observability/contexts) |
| 🟡 | Target apps | Client-side availability per flag (+ tags) | Target apps only scope StatSig keys, so each flag asks which LD SDK types may see it (client, mobile, server). | A config spec downloaded with a target-app-scoped key is partial (entities not linked to the key are missing, and a passes_gate on an untagged gate evaluates to false in StatSig). The console warns on partial specs; use an unscoped key for the export. Decisions: `client_side_availability`. Edge cases: 1.7. [StatSig](https://docs.statsig.com/sdks/target-apps) · [LD](https://launchdarkly.com/docs/sdk/concepts/client-side-server-side) |
| 🟡 | Tags, owners | Tags, maintainer | Tags are copied (sanitized to LD’s format). The owner becomes the flag maintainer when an LD member has the same email; the email is also kept in the migration.owner custom property. | An LD maintainer must be an account member, so the guide’s People step matches every StatSig owner against the LD member list before flags are written: owners without a member can be invited from the console (LD emails them; they become maintainers on the next sync), handed to their team, mapped to another member, or left unassigned. An owner nobody decided on raises maintainer_unknown on each of their items. Reading members needs a token that may list them; inviting needs Admin or createMember. Decisions: `maintainer_unknown`. Edge cases: 1.4, 1.5. [LD](https://launchdarkly.com/docs/home/flags/settings) |
| 🧭 | Teams (members, admins) | Teams (Enterprise) | StatSig teams are listed with their members; one click creates the LD team (key = sanitized name) with the members that exist in LD. A flag whose owner is not in LD can take its team as maintainer. | Team-level settings (default metrics, required templates, review approval rules) have no LD counterpart and are not carried. LD teams are an Enterprise feature; without them the team is skipped and the owner decision loses its team option. Edge cases: 1.11. [StatSig](https://docs.statsig.com/access-management/teams) · [LD](https://launchdarkly.com/docs/home/account/manage-teams) |
| 🧭 | Environments that require review; project-wide "config changes require review" | Required approvals per environment (Enterprise) | At cut over, every LD environment whose StatSig counterpart requires reviews is listed with its LD approval state; one click turns on required approvals there (approvalSettings.required). | Done at cut over rather than before the migration, because required approvals would turn every migration write into an approval request. Reviewer groups, minimum approvals and the review message are set up in LD. Edge cases: 2.7. [StatSig](https://docs.statsig.com/guides/setting-up-reviews) · [LD](https://launchdarkly.com/docs/home/releases/approvals) |
| 🧭 | Project settings: default unit type, visibility | Experimentation settings: default randomization unit | The default unit type’s context kind is offered as the default randomization unit for LD experiments (one click on the Context kinds step). Project visibility has no LD equivalent. | [LD](https://launchdarkly.com/docs/home/experimentation/randomization-units) |
| ❌ | Console API keys, server/client SDK keys | Service tokens, SDK keys | Keys are never migrated; the console uses a read-only Console key and an LD service token, both kept in memory (optionally encrypted on the device under a passphrase). | Each app re-initializes its SDK with an LD key for the right environment. Spec-only sources can be read with a client key that only downloads the config spec. [StatSig](https://docs.statsig.com/sdk-keys/api-keys) · [LD](https://launchdarkly.com/docs/home/account/api) |
| ❌ | Users, roles, SSO/SCIM | Members, roles, SSO/SCIM | Account administration is set up in LD directly; the console only reads StatSig users to resolve owner names. | [StatSig](https://docs.statsig.com/access-management/introduction) · [LD](https://launchdarkly.com/docs/home/account/members) |

### Feature gates

Gates become boolean flags with per-environment targeting, individual targets and prerequisites.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🟡 | Feature gate (rules, pass percentages, on/off) | Boolean flag with per-environment targeting | Each rule becomes an LD rule; a pass percentage becomes a percentage rollout; disabled gates are off; the shell carries name, description, tags, temporary and StatSig provenance. | The first StatSig rule whose conditions match ends evaluation, and users outside its pass percentage fail (no fall-through), which is exactly how an LD rule with a rollout behaves. Partial rollouts re-bucket users because the two platforms hash differently; this is acknowledged once per rule. Decisions: `partial_rollout_rebucket`, `rule_expansion`, `client_side_availability`. Edge cases: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.10, 4.11. [StatSig](https://docs.statsig.com/feature-flags/working-with) · [LD](https://launchdarkly.com/docs/home/flags/targeting) |
| ✅ | Overrides (user IDs, custom IDs, per environment) | Individual targets per context kind | Pass/fail overrides become individual targets on the matching variation, scoped to the environment they apply to. | An ID overridden both ways keeps the environment-specific (or first) override, and the conflict count is reported. Edge cases: 8.1, 8.2, 8.3, 8.4. [StatSig](https://docs.statsig.com/feature-flags/overrides) · [LD](https://launchdarkly.com/docs/home/flags/individual-targeting) |
| 🟡 | Rules that check another gate (passes_gate / fails_gate) | Inlined rules, or a prerequisite flag | A referenced gate with only 100% rules is inlined exactly; a gate every rule requires becomes an LD prerequisite (Enterprise); anything else is a gate_reference decision. | LD evaluates prerequisites before individual targets, so overrides on the referring gate stop applying to users who fail the prerequisite; this is reported as partial fidelity. Decisions: `gate_reference`. Edge cases: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9. [LD](https://launchdarkly.com/docs/home/flags/prerequisites) |
| 🟡 | Holdout attached to a gate | LD holdout (separate population) | The held-out share is acknowledged per gate (holdout_attached); LD holdouts are not created yet, so held-out users receive the feature in LD. | Decisions: `holdout_attached`. Edge cases: 4.8. [StatSig](https://docs.statsig.com/holdouts) · [LD](https://launchdarkly.com/docs/home/holdouts) |
| ✅ | Gate type and status (PERMANENT / TEMPORARY / STALE, Launched / Disabled) | temporary flag, on/off, flag status | PERMANENT → temporary: false, anything else → true; stale gates get a "consider hard-coding" note; a Launched gate skips its rules and serves true to everyone, a Disabled gate is off. | StatSig’s status wins over isEnabled and the rule list: the Console API can return a Launched gate with isEnabled false and no rules, and it still returns true for everyone. Edge cases: 1.6, 4.4, 4.13. [StatSig](https://docs.statsig.com/feature-flags/permanent-and-stale-gates) · [LD](https://launchdarkly.com/docs/home/flags/flag-status) |
| ❌ | Gate measurement (Pulse on a gate), diagnostics, exposure counts | Flag insights, experiments on a flag | Historical gate measurements stay in StatSig; LD starts measuring once traffic arrives. | Check counts and exposure counts from StatSig are used by the console for readiness and cutover reporting, not written to LD. [StatSig](https://docs.statsig.com/feature-flags/view-exposures) · [LD](https://launchdarkly.com/docs/home/flags/flag-insights) |
| 🧭 | Safeguards (metric-guarded rollouts with auto rollback or pause) | Guarded rollouts (Release Guardian: Enterprise + Guardian add-on) | Reported per rule; configured in LD by hand because the guardrail metrics have to exist in LD first and guarded rollouts need the Guardian add-on. | A StatSig safeguard attaches to one rule and reacts to a rollout or topline alert (rollback_to_0, rollout_to_100, pause). LD guarded rollouts monitor metrics per rollout stage and roll back on regression. Edge cases: 1.9. [StatSig](https://docs.statsig.com/feature-flags/safeguards) · [LD](https://launchdarkly.com/docs/home/releases/guarded-rollouts) |
| 🚧 | Scheduled (automated) rollouts per rule; dynamic-config "Gradual" and "Switch" schedules | Progressive rollouts; scheduled flag changes (Enterprise) | The current pass percentage migrates; the pending steps (pendingAutomatedRollouts) are listed so they can be recreated as an LD progressive rollout or scheduled changes. | StatSig steps are 15-minute increments on one rule; an LD progressive rollout is one per flag with timed steps. A Switch schedule (serve a variant during a time range) maps to scheduled flag changes. Edge cases: 4.14. [StatSig](https://docs.statsig.com/feature-flags/scheduled-rollouts) · [LD](https://launchdarkly.com/docs/home/releases/progressive-rollouts) |
| ✅ | Change reviews, pre-commit webhooks, change validation | Approval requests, workflows, custom roles | In an LD environment that requires approvals (HTTP 405 on the write), the same change is filed as an approval request; the step waits as "pending approval" and its sync provenance is written once a reviewer applies it. StatSig review settings themselves are not copied. | Flag targeting uses the flag-scoped approval route; scheduled changes carry their executionDate on the request; segments use the generic route with semantic-patch instructions (weighted segment rules cannot be filed that way). "Check approvals" on the Runs page re-reads the requests; undo withdraws pending ones and files the restore as a request. Edge cases: 15.17. [StatSig](https://docs.statsig.com/guides/change-management) · [LD](https://launchdarkly.com/docs/home/releases/approvals) |
| ❌ | Release pipelines | Release pipelines | Pipelines are organizational policy, not targeting; set them up in LD and attach migrated flags there. | [StatSig](https://docs.statsig.com/feature-flags/release-pipelines) · [LD](https://launchdarkly.com/docs/home/releases/release-pipelines) |

### Dynamic configs

Dynamic configs become JSON multivariate flags: the default value plus one variation per distinct rule value.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🟡 | Dynamic config (default value + per-rule return values) | JSON multivariate flag | The default value is variation 0; each distinct rule value becomes a variation; rules target their variation and partial rollouts split between the rule value and the default. | Verified against the StatSig SDK evaluator: a user who matches a rule but falls outside its pass percentage gets the default value, not the next rule. Variations are append-only: a new value seen after one environment was migrated is appended, never reordered. Decisions: `partial_rollout_rebucket`, `key_collision`, `variation_change_affects_migrated_env`. Edge cases: 10.1, 10.2, 10.4, 10.6, 10.8, 10.10, 10.11, 10.12. [StatSig](https://docs.statsig.com/dynamic-config) · [LD](https://launchdarkly.com/docs/home/flags/variations) |
| 🟡 | Rule variants (several values split by percentage inside one rule) | Percentage rollout across variations | Each variant becomes a variation; the rule serves a rollout with the variant weights (re-bucketed). | Decisions: `partial_rollout_rebucket`. Edge cases: 10.3. |
| ❌ | JSON schema validation of config values | — | LD does not validate JSON variations against a schema; the schema is noted and kept in the description. | StatSig enforces the schema only in the console and API, never at evaluation time, so runtime behaviour is unchanged. Edge cases: 10.5. |
| 🚧 | Config values up to 100 KB | JSON variations up to 32 KB each | Values above 32 KB are rejected by LD at create time; the console will flag them before planning. | Edge cases: 10.13. [StatSig](https://docs.statsig.com/dynamic-config/overview) · [LD](https://launchdarkly.com/docs/home/flags/variations) |
| 🧭 | Per-parameter reads: getConfig("x").get("p", default) | jsonVariation("x", default) returns the whole object | A code-change note: read the object once and pick fields; StatSig does not merge rule values with the default either. | Edge cases: 10.7. [LD](https://launchdarkly.com/docs/sdk/features/evaluating) |

### Segments

Project-wide StatSig segments become one LaunchDarkly segment per migrated environment.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🟡 | Rule-based segment | Segment with rules (one per migrated environment) | Rules translate like gate rules; a pass percentage becomes a weighted segment rule; a gate reference inside a segment is inlined when exact, otherwise the segment is skipped. | Decisions: `partial_rollout_rebucket`, `case_insensitive_match`. Edge cases: 9.1, 9.6, 9.7, 9.8, 9.9. [StatSig](https://docs.statsig.com/segments) · [LD](https://launchdarkly.com/docs/home/flags/segments) |
| ✅ | ID list segment up to 15,000 IDs | Segment with included targets | IDs are read through the Console API (on demand for larger lists) and written as included targets of the right context kind. | Decisions: `id_list_unavailable`. Edge cases: 9.2, 9.5. [StatSig](https://docs.statsig.com/segments/add-id-list) · [LD](https://launchdarkly.com/docs/home/flags/segments) |
| 🟡 | ID list segment above 15,000 IDs | Big segment (list-based, CSV import; Enterprise) | Once the list is loaded (on request from Source warnings, or from a raw-ID upload), a big_segment decision offers an unbounded LD segment filled by a CSV import in replace mode, so every sync mirrors the list; the referencing rules target it with segmentMatch. | Big segments have no rules and LD cannot preview their members, so the import is confirmed by sampling membership (first, middle and last key). A plan without big segments is learned from the first refused write and the option disappears. Undo of an adopted big segment restores only its metadata: LD has no bulk read of the previous members. Decisions: `big_segment`, `id_list_unavailable`. Edge cases: 9.3. [LD](https://launchdarkly.com/docs/home/flags/big-segments) |
| 🟡 | ID lists from a config spec (hashed IDs only) | Segment, after reconciliation with a raw-ID CSV | Config specs ship ID lists as one-way hashes. Under Source warnings the user uploads the get_id_lists files and a raw-ID CSV; the browser hashes the IDs and reports coverage. 100% needs no decision; a gap is a hashed_id_list acknowledgement (accept the matched IDs, or skip until a fuller upload); without raw IDs the decision is blocking. | Hashing runs in the pipeline worker with WebCrypto; uploads stay in IndexedDB. Without a hash file the upload is checked against the count only and marked unverified. A reconciled list above 15,000 IDs continues as a big segment. Decisions: `hashed_id_list`. Edge cases: 9.4. |
| 🚧 | Analysis lists and user-store lists | Segment (treated like an ID list) | Read like ID lists; not yet exercised against a real project, and StatSig does not document analysis_list semantics. | Edge cases: 9.10. |
| 🟡 | Segment rule with a pass percentage followed by more rules | Weighted segment rule | StatSig stops at the first matching rule (users outside the percentage fail); LD lets them continue to later segment rules. Exact for a single or last weighted rule; otherwise reported as partial. | Edge cases: 9.13. [LD](https://launchdarkly.com/docs/home/flags/rule-based-segments) |

### Rule conditions

Every StatSig condition type, and what clause it becomes.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| ✅ | public, user_id, unit_id (custom ID), email, country, locale, app_version, ip_address, custom_field | Clauses on the mapped attribute of the right context kind | Attribute names come from the mapping profile (email → email, custom_field f → f); reserved LD names (key, kind, _meta, anonymous) are prefixed. | Edge cases: 5.8, 5.9. [StatSig](https://docs.statsig.com/feature-flags/conditions) · [LD](https://launchdarkly.com/docs/home/flags/targeting-rules) |
| 🟡 | Derived attributes: browser_name/version, os_name/version, device_model, user_agent, IP-derived country | Clauses on attributes the app must now send | LD SDKs never parse user agents or geolocate IPs, so each derived attribute is a derived_attribute decision and goes into the context contract for developers. | Decisions: `derived_attribute`. Edge cases: 5.1, 5.2. |
| ✅ | environment_tier | Resolved statically per environment | True in this environment → condition dropped; false → rule dropped. Non-static operators on the tier name are an unsupported_condition. | Edge cases: 2.2, 2.3, 2.4. |
| ✅ | passes_segment / fails_segment | segmentMatch clause (negated for fails) | The segment is pulled into the plan as a dependency in the same environment; a missing or archived segment is a missing_reference decision. | Decisions: `missing_reference`. Edge cases: 5.5, 5.6, 5.7. |
| 🟡 | time (before/after a timestamp, evaluated against the SDK clock) | Scheduled flag change (Enterprise), or static resolution | A window entirely in the past is resolved statically. A future flip is a time_condition decision: schedule it (the flag mirrors StatSig now, and an LD scheduled change carrying the whole targeting as of the flip applies it at that moment), resolve it as of the sync and re-sync later, or skip. | Scheduled changes are full-state snapshots, so a re-sync deletes the ones the previous sync recorded (their ids live in the sync provenance) and recreates them. "schedule" is recommended once the probe or a successful write shows the plan allows it; a refused write removes the option. In an approval-required environment the executionDate goes on the approval request. Decisions: `time_condition`. Edge cases: 5.3. [LD](https://launchdarkly.com/docs/home/releases/scheduled-changes) |
| 🟡 | target_app, url, javascript, experiment_group, user_bucket, unknown types | — | No LD clause can express these; an unsupported_condition decision offers drop the condition, drop the rule, or skip the item. Nothing is dropped silently. | Decisions: `unsupported_condition`. Edge cases: 5.4. |

### Operators

StatSig compares loosely and case-insensitively; LaunchDarkly compares typed values. Each mismatch is a decision.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🟡 | any, none, str_contains_any/none, str_starts_with_any, str_ends_with_any (case-insensitive) | in, contains, startsWith, endsWith (case-sensitive) | A case_insensitive_match decision: an exact case-folded regex (recommended), lower/upper-case variants, or exact match. Skipped when no value has letters. | Decisions: `case_insensitive_match`. Edge cases: 6.1, 6.13. |
| ✅ | any_case_sensitive, none_case_sensitive, eq, neq, gt, gte, lt, lte, before, after | in (negated for none/neq), numeric and date operators | Direct translation; numeric targets add a note that the attribute must be sent as a number. | Edge cases: 6.5, 6.6, 6.8. |
| 🟡 | Numeric targets compared loosely ("2" == 2) | Typed comparison ("2" ≠ 2) | A value_type decision: emit both the number and the string form (recommended), numbers only, or strings only. | Decisions: `value_type`. Edge cases: 6.2, 6.10. |
| 🟡 | none / neq / str_contains_none pass when the attribute is missing | A clause on a missing attribute never matches, even negated | Acknowledged per rule (negated_missing_attribute); users without the attribute no longer match. | Decisions: `negated_missing_attribute`. Edge cases: 6.3, 15.1. |
| 🟡 | version_gt/gte/lt/lte/eq/neq (any number of parts, suffix stripped) | semVer* operators (strict semver) | version_gte → semVerLessThan negated, etc.; 1.2 is padded to 1.2.0; 4-part or pre-release targets raise a version_format decision. | Decisions: `version_format`. Edge cases: 6.7. [LD](https://launchdarkly.com/docs/home/flags/operators) |
| 🟡 | on (same calendar day, SDK local time) | after day−1 and before day+1 (UTC) | Expanded into two clauses with a note; the local-day vs UTC-day difference is documented. | Edge cases: 6.8. |
| 🟡 | str_matches (JavaScript regex) | matches (each SDK’s regex engine) | Patterns using lookbehind, backreferences or other non-portable constructs raise a regex_dialect decision. | Decisions: `regex_dialect`. Edge cases: 6.9, 15.3. |
| 🟡 | array_contains_any/none/all, not_array_contains_all | in on array attributes; all → one clause per value; not-all → one rule per value | Translated with expansion; large expansions raise rule_expansion. | Decisions: `rule_expansion`, `value_type`. Edge cases: 6.10, 4.10. |
| 🟡 | is_null / is_not_null | No "is set" operator | is_not_null ≈ matches ".*" (strings only); is_null is blocking: drop the rule or skip. | Decisions: `null_check`. Edge cases: 6.4. |
| 🟡 | encoded_any | — | The current StatSig SDKs themselves treat it as unsupported; raised as unsupported_condition. | Decisions: `unsupported_condition`. Edge cases: 6.11. |
| 🚧 | in_segment_list / not_in_segment_list (config spec only) | segmentMatch against the reconciled list segment | segmentMatch against the segment once its hashed list is reconciled with a raw-ID upload (Source warnings › ID lists). | Decisions: `hashed_id_list`. Edge cases: 6.12. |

### Experiments, layers, holdouts and Autotune

Nothing is moved mid-flight: running experiments end in StatSig and new ones launch in LaunchDarkly, with the structure (flags, layers, holdouts, metrics) carried over.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🚧 | Experiment not started (setup) | JSON flag (a variation per group) + draft LD experiment | The flag and a not-started experiment draft with hypothesis, treatments, allocation, randomization unit and metrics. | Edge cases: 11.3, 11.4, 11.5. [StatSig](https://docs.statsig.com/experiments-plus) · [LD](https://launchdarkly.com/docs/home/experimentation) |
| 🧭 | Running experiment (active) | Cannot be moved mid-flight | Shown as "running in StatSig, migrate after it ends"; optionally pre-stage the draft. Assignments and results never move. | Re-randomizing a live experiment would invalidate its results; finish or stop it in StatSig first. Edge cases: 11.1. |
| 🚧 | Concluded experiment (decision made, group shipped) | Flag serving the shipped group’s values at 100% | The shipped group becomes the fallthrough; results are archived (see Operations). | Edge cases: 11.2. |
| 🚧 | Layers (explicit) and layer parameters | LD layers with reservations | Layers are created so new experiments stay mutually exclusive; code reading getLayer().get() gets a layer_parameters decision. | Implicit (one-experiment) layers are dropped. StatSig layers carry separate parameter sets for users who fail the targeting gate and for each holdout; LD layers only reserve traffic for whole experiments, so those defaults land on the flags. Edge cases: 11.6. [StatSig](https://docs.statsig.com/layers) · [LD](https://launchdarkly.com/docs/home/experimentation/layers) |
| 🚧 | Holdouts (global or attached) | LD holdouts (new populations, per environment) | A new holdout population with the same percentage; the gates and experiments it covered become a checklist. Membership is re-randomized. | StatSig global holdouts auto-attach to new features of the same unit type; an LD holdout lists its flags explicitly. A gate in an LD holdout cannot also have a prerequisite. Edge cases: 11.7, 4.8, 15.14. [StatSig](https://docs.statsig.com/holdouts) · [LD](https://launchdarkly.com/docs/home/holdouts) |
| 🟡 | Autotune (multi-armed bandit) | JSON flag + custom metric + bandit experiment (type: mab), drafted | A variation per arm, the success event as a conversion metric, and a draft bandit on the default rule; a running Autotune waits (autotune_running) or is pre-staged. | LD cannot import a finished bandit’s learning: a concluded Autotune becomes a flag serving the winner at 100%. Decisions: `autotune_running`, `missing_metric`, `duplicate_variant_value`, `key_collision`. Edge cases: 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15. [StatSig](https://docs.statsig.com/autotune) · [LD](https://launchdarkly.com/docs/home/experimentation/bandits) |
| ❌ | Contextual bandits (Autotune AI) | — | LD bandits are not contextual; use a plain bandit or an experiment per context segment. | [StatSig](https://docs.statsig.com/autotune/contextual) |
| 🧭 | Analysis settings: frequentist / Bayesian / sequential (mSPRT), CUPED, Bonferroni / Benjamini-Hochberg, confidence interval, stratified sampling | LD analysis configuration: Bayesian or frequentist (fixed-horizon or sequential), CUPED, MCC, stratified sampling by CSV | Carried onto the draft experiment where LD has the setting (methodology, significance, MCC); the rest is listed for reference. | [StatSig](https://docs.statsig.com/experiments/advanced-setup/sequential-testing) · [LD](https://launchdarkly.com/docs/home/experimentation/analyze) |
| ❌ | Experiment types other than A/B: switchback, geo, grid search, sidecar (no-code), prompt | — | LD experiments randomize units into treatments; time- or geo-clustered designs and no-code sidecar experiments have no equivalent. Prompt experiments belong to LD AgentControl. | [StatSig](https://docs.statsig.com/experiments/types/switchback-tests) |
| 🚧 | Experiment / layer / Autotune overrides (forced groups, conditional overrides) | Individual targets on the experiment flag | Forced groups become individual targets; conditional overrides become rules ahead of the experiment rule. | Edge cases: 8.6. |

### Metrics and events

Metric definitions can be translated; the events behind them have to be re-instrumented through the LaunchDarkly SDK.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🚧 | Cloud metrics: event count, sum, mean, ratio, funnel | Custom conversion / numeric, ratio and funnel metrics | Definitions are translated (porting the statsig-to-ld metrics converter); events must then be sent through LD track(). | Metrics are the critical path for every new LD experiment, so they are a dependency of experiment migration. Edge cases: 12.1, 12.4. [StatSig](https://docs.statsig.com/metrics) · [LD](https://launchdarkly.com/docs/home/metrics) |
| ❌ | Composite metrics, user accounting (DAU/WAU/retention) and other derived types | — | No LD metric type composes other metrics; rebuild as separate metrics or a metric group. | Edge cases: 12.1. |
| 🧭 | Events logged to StatSig (logEvent) | Events sent through the LD SDK (track) | An instrumentation checklist per event: same event key, sent via track() with the same context. | Edge cases: 12.2. [LD](https://launchdarkly.com/docs/sdk/features/events) |
| 🧭 | Warehouse Native metric sources and SQL metrics | Warehouse-native metrics on an LD data source | The LD data source must be created in the LD UI by an admin; once it exists, metric sources and SQL can be mapped (custom and ratio only, no funnels). | Edge cases: 12.3. [StatSig](https://docs.statsig.com/statsig-warehouse-native/introduction) · [LD](https://launchdarkly.com/docs/home/metrics/warehouse-native) |
| ❌ | Metrics from a config-spec-only source | — | Config specs carry no metric definitions; add a Console API key or define metrics in LD by hand. | Edge cases: 12.5. |

### Parameter stores

Parameter stores are a StatSig SDK convenience over gates, configs and experiments.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🚧 | Parameter store with static parameters | One JSON flag per store | Static parameters become one JSON flag; gate-, config- and experiment-backed parameters point at the migrated flags with a code-change note. | Parameter stores exist only in StatSig client SDKs and Server Core SDKs; the LD equivalent is reading the underlying flags directly. Edge cases: 13.1, 13.2. [StatSig](https://docs.statsig.com/client/concepts/parameter-stores) |

### Operations, history and analytics

Things around the configuration: history, results, dashboards, alerts, integrations.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🧭 | Change history, audit log, versions | LD audit log (from the first sync onward) | StatSig history is kept in the console’s snapshots and exported with the workspace; every LD write names the StatSig version and run in its audit comment. | [StatSig](https://docs.statsig.com/console-api/audit-logs) · [LD](https://launchdarkly.com/docs/home/account/audit-log) |
| 🚧 | Experiment results (Pulse), cumulative exposures | — | Archived to a file per experiment and linked from the LD flag; LD cannot import results. | Edge cases: 11.2. |
| ✅ | (the migration itself) | Tags, custom properties and audit comments on every migrated resource | migrated-from-statsig and migration-src-<alias> tags, migration.* custom properties (the keys are source-neutral; the display names say StatSig), per-environment sync fingerprints; the LD project is the migration ledger. Resources tagged by earlier builds (statsig-migrated, statsig.*) are still recognised. | Edge cases: 1.8. |
| 🧭 | Changes after migration: edited, archived or deleted gates and configs; traffic still hitting StatSig | Monitoring page: drift from LD provenance, LD flag statuses, cutover funnel, reports | Read-only. Compares the StatSig fingerprint recorded at sync with the current snapshot and the flag’s LD modification time with the sync; reads LD flag statuses (new / inactive / active / launched) per environment; re-syncs stay manual. | Statuses: in sync, StatSig changed, decisions changed, LD changed, conflict (both), archived in StatSig (retire the LD flag), gone from StatSig, LD authoritative (a per-item switch that mutes StatSig changes after cutover). Lifecycle per environment: migrated → dual-running (LD traffic seen) → cut over (LD traffic and zero StatSig checks for 7 days, from samples taken while the tab is open) → safe to archive in StatSig. StatSig check counts come from the Console API and cover all environments; per-environment StatSig exposure sampling (the StatSig side of PLAN §14) is not built yet, and spec-only sources show StatSig traffic as unknown. Checks run on connect and every 15 minutes while the tab is open; there is no background polling or email/Slack alerting without a server. Edge cases: 4.7, 15.20, 15.21. [LD](https://launchdarkly.com/docs/home/observability/flag-status) |
| ❌ | Dashboards, alerts, reports, product and web analytics, session replay | LD Observability (different product, separate instrumentation) | Not migrated. StatSig analytics stay in StatSig; LD observability is set up on its own. | [StatSig](https://docs.statsig.com/product-analytics/overview) · [LD](https://launchdarkly.com/docs/home/observability) |
| ❌ | Integrations (Slack, Datadog, Jira, data warehouse exports, webhooks), Terraform provider, siggy CLI | LD integrations, Terraform provider, ldcli | Reconnected in LD by hand. Teams managing StatSig through Terraform can import the migrated LD flags into the LD Terraform provider after the first sync. | [StatSig](https://docs.statsig.com/integrations/introduction) · [LD](https://launchdarkly.com/docs/integrations) |
| 🟡 | Prompts / AI Configs (name, description, tags, owner, team, version counter); their versions and evals | LD AI Configs (shell); variations added by hand | Each StatSig prompt becomes an LD AI Config with the same key, name, description, tags and maintainer (fidelity manual): the Console API has no endpoint that reads prompt versions, so the messages, model and parameters are added as variations in LD. | Provenance goes in a description footer and the two migration tags, like segments (AI Configs have no custom properties). A re-sync updates the shell and never touches the variations. Evals, prompt-level holdouts and the per-environment live version stay in StatSig. Needs AI Configs on the LD project; otherwise prompts are listed to recreate by hand. Decisions: `maintainer_unknown`. Edge cases: 1.12. [LD](https://launchdarkly.com/docs/home/ai-configs) |
| 🧭 | Topline alerts (metric thresholds that notify people) | — | Listed on the cut-over step with their metrics, condition and subscriber count, to recreate as LD Observability alerts or experiment guardrails once the metrics exist in LD. | LD has no metric-threshold alert on flags; guarded rollouts watch metrics per rollout, and Observability alerts watch telemetry. Nothing is written. [StatSig](https://docs.statsig.com/product-analytics/alerts) · [LD](https://launchdarkly.com/docs/home/observability/alerts) |

### SDK and runtime behaviour

Behaviour the SDK provides at evaluation time, which a configuration migration cannot carry.

| | StatSig | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| 🟡 | Bucketing: sha256(salt.ruleSalt.unitID) | Bucketing: hash(flagKey.salt.key) | Every partial rollout re-buckets users; acknowledged once per rule. Finish or hard-code rollouts in StatSig first when continuity matters. | Decisions: `partial_rollout_rebucket`. Edge cases: 4.1. |
| 🧭 | A rule bucketing on a unit type the SDK call did not supply: nobody passes | A rollout on a context kind the evaluated context lacks serves the first variation with weight > 0 | The context contract lists every context kind a flag buckets on; SDK calls must send a multi-context with all of them. | Edge cases: 15.12. [LD](https://launchdarkly.com/docs/home/releases/percentage-rollouts) |
| 🧭 | checkGate / getConfig / getExperiment / getLayer calls | boolVariation / jsonVariation calls | LD keys equal StatSig names, so ld-find-code-refs finds every call site; the console lists the code changes per item. | [LD](https://launchdarkly.com/docs/home/observability/code-references) |
| 🧭 | Attributes the SDK derives or looks up loosely (user agent, IP, case-insensitive custom fields, numeric strings) | Attributes the app must send, exactly named and typed | Collected into a context contract for developers: attribute names, types, context kinds and multi-context requirements. | Edge cases: 3.5, 5.8, 6.6. |
| ❌ | Persistent assignment, bootstrapping, local evaluation, data adapters | LD equivalents configured per SDK (Relay Proxy, bootstrapping, persistent stores) | SDK runtime configuration is re-done in each app with the LD SDK. | [StatSig](https://docs.statsig.com/server/concepts/persistent_assignment) · [LD](https://launchdarkly.com/docs/sdk/features/bootstrapping) |

### Another LaunchDarkly project as the source

A LaunchDarkly project (same or another account or instance) attached as a source (PLAN §20). The vocabulary is the target’s, so most things copy verbatim; the rows below are the differences between two projects, and what the console asks.

| | Source LD project | LaunchDarkly | How the console handles it | Notes |
|---|---|---|---|---|
| ✅ | Flag (boolean or multivariate): name, description, variations, tags, temporary, client-side availability, defaults | Flag with the same key and settings | The shell is copied verbatim; provenance (migrated-from-launchdarkly, migration-src-<alias>, migration.* properties) is added. | Tags and custom properties that are themselves provenance from an earlier migration into the source project are never copied onward. Archived flags are skipped; deprecated ones are noted. Flags whose purpose is migration or holdout are skipped with a reason. Edge cases: 18.1, 18.8. [LD](https://launchdarkly.com/docs/home/flags) |
| ✅ | Per-environment targeting: on/off, rules and clauses, off variation, default rule, individual targets | The same targeting in the mapped environment | Clauses (operator, context kind, attribute, values, negate), individual targets per context kind and the default rule are copied one to one. | Source environments map to target environments by key or name (editable under Mapping); unmapped environments are not migrated. Disabled rules are left out because they do not evaluate. Event tracking on rules and the default rule is noted, not copied. Edge cases: 18.2. [LD](https://launchdarkly.com/docs/home/flags/targeting) |
| 🟡 | Percentage rollouts (rules, default rule, weighted segment rules), bucketBy | Same weights, same bucketBy | Weights and bucketBy are copied; the new flag has its own salt, so the same percentages land on different contexts (partial_rollout_rebucket). | LD buckets by a per-flag salt that the API cannot copy; experiment rollouts with a fixed seed cannot carry the seed either. Decisions: `partial_rollout_rebucket`. Edge cases: 18.3. [LD](https://launchdarkly.com/docs/home/flags/rollouts) |
| 🟡 | Context kinds used by clauses, rollouts, targets and segments | Context kinds of the target project | Kinds the target already has are used as they are; a missing one raises unit_type_kind (create it with the same key or a key you type, or use an existing kind). | Decisions: `unit_type_kind`. Edge cases: 18.4. [LD](https://launchdarkly.com/docs/home/observability/contexts) |
| 🟡 | Prerequisites | Prerequisites (Enterprise) | The prerequisite flag is migrated first in the same environment; prerequisite_unsupported when the target plan or token lacks prerequisites; missing_reference when the flag is not in the source. | Decisions: `prerequisite_unsupported`, `missing_reference`. Edge cases: 18.5. [LD](https://launchdarkly.com/docs/home/flags/prerequisites) |
| 🟡 | Segments: rules, included and excluded keys per context kind, weighted rules | Segments per environment | Copied per environment; segmentMatch clauses pull the segment in as a dependency; a weighted rule is acknowledged as re-bucketing. | A segment that exists in some source environments only is migrated where it exists; a rule that matches it elsewhere raises missing_reference. Lists above 15,000 keys are skipped with a reason. Decisions: `missing_reference`, `partial_rollout_rebucket`. Edge cases: 18.6. [LD](https://launchdarkly.com/docs/home/flags/segments) |
| 🟡 | Big (unbounded) segments | Big segment (Enterprise), filled by CSV import | Membership is not readable through the API (LD answers only per key), so big_segment offers to create the segment empty for a manual import, or to skip it. | Rules that match a skipped big segment block their flag. Without big segments in the target plan the segment is skipped with a reason. Decisions: `big_segment`. Edge cases: 18.7. [LD](https://launchdarkly.com/docs/home/flags/big-segments) |
| 🟡 | Custom properties of the flag | Custom properties | copy_custom_properties asks whether to copy the flag’s own properties; migration provenance is always written and never copied from the source. | Decisions: `copy_custom_properties`. Edge cases: 18.8. [LD](https://launchdarkly.com/docs/home/flags/custom-properties) |
| 🟡 | Maintainer, maintainer team | Maintainer, maintainer team | Member IDs belong to the source account, so the maintainer is matched by email against the target account’s members (and the team by key), like a StatSig owner; an unmatched one raises maintainer_unknown. | Decisions: `maintainer_unknown`. Edge cases: 18.9. [LD](https://launchdarkly.com/docs/home/flags/settings) |
| ❌ | Experiments, metrics, holdouts, guarded rollouts, release pipelines, approval settings, flag links | The same LaunchDarkly features, set up again in the target | Not read from the source (PLAN §11, §20.4): experiments end in the source and start new in the target; the flag notes which experiments ran on it. | Edge cases: 18.10. [LD](https://launchdarkly.com/docs/home/experimentation) |

<!-- coverage:end -->
