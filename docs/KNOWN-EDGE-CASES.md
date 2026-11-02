# Known edge cases: StatSig → LaunchDarkly (and LaunchDarkly → LaunchDarkly, §18)

A running list of every place where a StatSig resource does not migrate cleanly to LaunchDarkly,
across all resource types. It is the mapper's conscience: anything listed as a **gap** here is
work the mapper still owes (CLAUDE.md: *every imperfect mapping becomes a Decision*).

**How to keep it current.** When you find a new mismatch:
1. Add a row in the right section below (StatSig behaviour, LD behaviour, how the app handles it).
2. Add a demo example to `packages/demo-fixtures/src/acme/web.ts` (or `mobile.ts`) whose
   description names the edge case, then run `pnpm fixtures:generate`.
3. Add a test under *known edge cases* in `packages/mapper/test/mapper.test.ts`, and review the
   golden-file diff (`packages/mapper/test/golden/`), which is what lands in a customer's LD project.

**Sources of truth.** StatSig semantics come from the SDK evaluator, not the docs:
`reference/repos/node-js-server-sdk/src/Evaluator.ts` and `src/utils/EvaluatorUtils.ts`. LD
semantics come from `reference/launchdarkly/openapi.json`, `semantic-patch-*.md` and the live
checks recorded in `reference/README.md`. Field names come from the OpenAPI specs.

**Handling legend**

| Mark | Meaning |
|---|---|
| ✅ Decision | Raised as a Decision of the named type (PLAN §8). The user must answer. |
| 📝 Note | Handled automatically but reported as a fidelity note (partial fidelity where it says so). |
| ⚙️ Static | Translated exactly, silently. |
| 🚧 Gap | Known mismatch the app does **not** yet surface. Mapper backlog; see §17. |
| 📅 Later | Belongs to a later milestone (M5 monitoring, M6/M7 experiments, M8 consolidation). Fixtures are already seeded. |
| ❌ Manual | No LD equivalent. Guidance only. |
| ❓ Verify | Believed true; not yet checked against a live LD project or StatSig key. |

Decision types referenced below are defined in `packages/mapper/src/types.ts` (`DecisionType`).

---

## 1. Keys, names, tags, owners (the project-level flag shell)

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 1.1 | Name characters | Names may contain spaces, capitals and `.` (`^[a-zA-Z0-9_\-. ]*$` in the Console OpenAPI). | Keys allow only letters, digits, `.`, `_`, `-`. | ⚙️ `sanitizeKey` replaces other runs with `_` and strips leading `._-`; 📝 note when the key differs. 🚧 Two StatSig names can sanitize to one key (`a b` vs `a_b`); only collisions with existing LD keys are checked today (`key_collision`). | `Holiday Banner 2026` → `Holiday_Banner_2026` |
| 1.2 | Shared names across resource types | A gate, a config and an experiment may all be called `x`. | One key space per project. | ⚙️ Plan error when a gate and a config in one plan produce the same key, or when the LD flag was migrated from the other resource type (`migration.type` in provenance). Experiments: 📅 M6. | gate + config `maintenance_mode` |
| 1.3 | Names differing only by case | Distinct resources. | Distinct keys (keys are case-sensitive), but easy to confuse. | ⚙️ nothing to do; worth a UI hint. | — |
| 1.4 | Tags | Any text, including symbols. | Letters, digits, `.`, `_`, `-`, ≤ 64 chars. | ⚙️ `sanitizeTag` (NFKD, lower-case, truncate); 📝 note per renamed tag. 🚧 Lower-casing can merge `Checkout` and `checkout`. | `★ Core` → `core` on `eu_cookie_banner` |
| 1.5 | Owner → maintainer | Owner email, possibly of someone who left. | Maintainer must be an LD member (`maintainerId`), or a team (`maintainerTeamKey`). | ⚙️ matched by email against the LD member list (the guide's People step reads it); ✅ `maintainer_unknown` (choice) when nobody matches: no maintainer (owner kept in `migration.owner`), the team, or a member picked on the People step (`member:<id>`). Inviting the owner from the People step makes them the maintainer on the next sync; “Invite all” asks for a typed confirmation first, since LD emails every address. 📝 note when unassigned. | gates owned by `jordan.former@…` (`stale_promo_ribbon`) |
| 1.6 | Lifecycle → `temporary` | `type`: PERMANENT / TEMPORARY / STALE / TEMPLATE. | `temporary: boolean`. | ⚙️ PERMANENT → `false`, else `true`. 📝 STALE gates get a "consider hard-coding" note. | `stale_promo_ribbon`, `stale_reviews_widget` |
| 1.7 | Target apps → SDK visibility | Client SDKs can evaluate every gate; target apps only scope keys. | Flags are sent to client / mobile SDKs only when `clientSideAvailability` allows it. | ✅ `client_side_availability` on every gate (recommended: both). | every gate; `storefront_url_banner` is client-only |
| 1.8 | Provenance | — | Custom properties can't be in the same semantic patch as environment instructions (400); several writes to one flag within seconds return 429. | ⚙️ executor writes the shell and each environment separately and backs off. | every migration |
| 1.9 | Review settings, release pipelines, safeguards, automated rollouts, metric lifts | Per-gate settings. | Approvals / release pipelines / guarded rollouts, configured differently. | ❌ Manual (PLAN §6). | `kill_switch_payments` (PERMANENT) |
| 1.11 | Teams | Teams with members, admins and team-level defaults (metrics, templates, review rules). | Teams (Enterprise): key, name, members, roles; **account-level**, shared by every project. | ⚙️ Teams step (marked account-wide in the guide, as is People: members and teams are not project resources) (its own guide step, before People, so teams can be created without inviting anyone yet): one click creates the LD team (`key = sanitizeKey(name).toLowerCase()`) with the members that exist in LD, or **Create all** creates every missing team in turn (no email is sent, so no typed confirmation); a flag whose owner is unknown can take its team as maintainer. ❌ team-level defaults and review rules not carried. 🚧 a team whose sanitized key collides with an existing LD team of another name is matched, not flagged. | `Checkout`, `Search` |
| 1.12 | Prompts / AI Configs | Name, description, tags, owner, team, target apps, holdouts, a `version` counter. Versions (messages, model, parameters) have no read endpoint in the 20240601 Console API. | AI Config: key, name, description, tags, maintainer; variations hold the prompt. | ⚙️ the shell is created (`upsert_ai_config`), provenance in a description footer + tags; 📝 fidelity *manual*: add the variations in LD. ❌ evals, prompt holdouts and the live version per environment. | `support_reply_assistant`, `product_description_writer` |
| 1.13 | ID vs display name | `id` is derived from the name at creation and never changes; `name` is the display name, so a renamed gate's two differ; names allow only letters, digits, `_`, `-`, `.` and spaces (3–100 chars). A config spec carries only the ID. | Flag `key` (immutable) and `name` (editable). | ⚙️ `key = sanitizeKey(id)`, `name = name ?? id`, description copied; the ID is also kept in the `migration.id` custom property. 📝 spec sources name the flag after the ID until a Console API sync fills the display name in. | `new_checkout_flow` → “New checkout flow - one page”, `search_v2`, config `checkout_config` |
| 1.10 | Name and description length | Names 3–100 chars; descriptions ≤ 1000 chars (Console API). | Key/name/description limits are not documented; 5,000 flags per project by default. | ⚙️ nothing to do today; ❓ confirm LD accepts 100-char keys. | — |

## 2. Environments

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 2.1 | Tier with no LD environment | Custom tiers (e.g. `qa`). | Fixed environment list per project. | ✅ mapping profile (`envMapping: null`); rules that only apply there are dropped with a 📝 note in mapped environments. | `qa`, `qa_debug_panel` |
| 2.2 | Two ways to scope a rule | Console API: `rule.environments`; config spec: an `environment_tier` condition. | Per-environment targeting. | ⚙️ both resolved statically per environment (`resolveRulesForEnvironment`). | `perf_monitoring_v2`, `staff_debug_tools` |
| 2.3 | `environment_tier` with a non-static operator | `str_matches`, `version_*` on the tier name. | — | ✅ `unsupported_condition` (blocking). | — (test only) |
| 2.4 | Tier name case | Compared case-insensitively. | n/a | ⚙️ case-insensitive match. | — |
| 2.5 | A flag exists in every LD environment | Gate state is per environment. | Creating a flag creates it in all environments, off. | ⚙️ unmigrated environments serve `false` even if switched on (`defaults.onVariation = Fail`); shown as *Not migrated*. | any gate migrated to staging only |
| 2.6 | Several sources → one LD environment | — | — | 📅 M8 consolidation. | `acme-web` + `acme-mobile` → `production` |
| 2.7 | Reviews → approvals | `requiresReview` per environment; project-wide `is_config_review_required`. | `approvalSettings.required` per environment (Enterprise). | ⚙️ cut-over step lists each mapped LD environment whose source requires reviews; one click turns required approvals on (`PATCH /environments/{e}`). Done after the migration writes, because required approvals turn every write into an approval request (PLAN §5.1). ❌ reviewer groups and minimum approvals are set up in LD. | `production` requires review in both Acme projects |

## 3. Unit types → context kinds

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 3.1 | Custom unit IDs | `userID`, `stableID`, custom (`companyID`, `deviceID`). | Context kinds; `user` is built in. | ⚙️ `userID` → `user`, `stableID` → `device`, `fooID` → `foo`; the **Unit types** page sets once for every item where each unit type goes, in the mapping profile (`unitTypeKinds`): the key of a kind, or an attribute of any context kind (`attribute:<name>` on `user`, `attribute:<kind>/<name>` on an existing kind or one the migration creates, which then also gets an `ensure_context_kind` step); ✅ `unit_type_kind` per item when the kind doesn't exist in LD and the page has no entry: create it (proposed or typed key), keep the unit type as a `user` attribute (clauses, `bucketBy`, overrides → a rule), or reuse a kind another unit type creates. Never the `user` key (CLAUDE.md). | `b2b_bulk_ordering`, `anon_homepage_variant`, mobile `device_beta_program` |
| 3.2 | Two unit types defaulting to one kind | `stableID` and `deviceID` in one project. | Both default to `device`. | ⚙️ The Unit types page warns when two unit types of one source map to one kind, by default or by choice (`sharedKinds`); the user gives one another kind or keeps it as a `user` attribute. The mapper itself still lets them share. | `acme-mobile` has both |
| 3.3 | Unit type lookup | `customIDs` are looked up case-insensitively. | n/a | ⚙️ `configuredUnit` / `kindFor` match the profile case-insensitively; the Unit types page merges case variants into one row. | — |
| 3.4 | Custom-ID overrides on a userID gate | `passingCustomIDs` without saying which unit type. | Targets need a context kind. | 🚧 Adapter warns `ambiguous_override` and records unit type `customID`; the mapper then asks for a context kind named `custom`, which is misleading. Should ask *which* unit type. | `search_v2` override `acct_3001` |
| 3.5 | Conditions on another unit's attributes | A `userID` gate may test `unit_id(companyID)`. | The SDK must send a multi-context with both kinds. | 📝 implied by the clause's context kind; 🚧 the generated *context contract* (PLAN §10.5) is not built yet. | `b2b_bulk_ordering`, `enterprise_sso` |
| 3.6 | `segmentMatch` and context kinds | Segment `idType` decides whose ID is checked. | The mapper emits `contextKind: "user"` on every `segmentMatch` clause; LD segments carry `includedContexts` per kind. | ❓ Verify that LD ignores the clause's kind for `segmentMatch` with non-user segments. | `enterprise_sso` (companyID segment), mobile `device_beta_program` |

## 4. Gate rules and rollouts

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 4.1 | Partial rollout | `sha256(salt.ruleSalt.unitID)`. | `hash(flagKey.salt.key)`. The same percentage, different users. | ✅ `partial_rollout_rebucket` (acknowledge); 📝 partial. | `new_checkout_flow` 20 %, `perf_monitoring_v2` 10 %, `anon_homepage_variant` 50 % |
| 4.2 | 0 % rule | Matching users fail and evaluation stops: an exclusion. | A rule serving `false`. | ⚙️ exact. | `reviews_v2` |
| 4.3 | Public 100 % rule | Everyone passes; later rules are unreachable. | Fallthrough. | ⚙️ becomes the fallthrough; 📝 note counts the dropped rules. | `free_returns`, `kill_switch_payments` |
| 4.4 | Public partial rule | Everyone is bucketed. | Fallthrough rollout. | ⚙️ + ✅ re-bucket acknowledgement. | `new_checkout_flow` |
| 4.5 | No rules | Everyone fails. | On, serving `false`. | ⚙️; 📝 STALE_NO_RULES note. | `payments_v3_scaffold` |
| 4.6 | Disabled gate | Everyone fails, overrides included. | Off, serving the off variation. | ⚙️ exact; 📝 note. | `old_cart_drawer` |
| 4.7 | Archived gate | Not evaluable. Absent from config specs. | — | ⚙️ skipped. ✅ M5 Monitoring: an entity archived *after* migration shows as **archived in StatSig** with a "Retire in LD" link; it is never re-synced. An entity that disappears from every snapshot shows as **gone from StatSig**. | `legacy_wishlist`; `legacy_browser_banner` in snapshot 2 |
| 4.8 | Holdouts attached to a gate | A holdout forces `false` for its share of users *before* the rules. | LD holdouts are separate populations (PLAN §11). | ✅ `holdout_attached` (acknowledge), one per attached holdout that is enabled in the snapshot, naming the share; 📝 partial note. "Skip" keeps the gate in StatSig until the holdout ends. A disabled, archived or 0 % holdout is a note only; an id the snapshot lacks is a partial note. The holdout's share feeds the StatSig fingerprint, so a changed percentage is drift. Only `holdoutIds` count: a global holdout not listed on the gate isn't detected. | `new_checkout_flow` (5 % `checkout_holdout`), `global_holdout` 2 % |
| 4.9 | Rule-level unit type | A rule may bucket on a different `idType` than the gate (spec sources). | Rollout `contextKind` per rule. | ⚙️ `serveFor` uses the rule's `idType`. | — |
| 4.10 | Rule expansion | One rule with several OR-ish conditions (`not_array_contains_all`, `on`, inlined gates). | One LD rule per DNF term. | ✅ `rule_expansion` (blocking) above 10 LD rules. | `cross_sell_matrix` (4 × 3 = 12) |
| 4.11 | Pass-percentage precision | Decimals allowed. | Weights in thousandths of a percent. | ⚙️ `Math.round(p × 1000)`: exact to 0.001 %. | — |
| 4.12 | Unreachable duplicate rules | Allowed. | Allowed. | ⚙️ copied as is (only rules after a public 100 % rule are dropped). | — |
| 4.13 | `status` vs `isEnabled` | **Launched**: rule evaluation is skipped and the gate returns `true` for everyone; **Disabled**: always `false`. The Console API can return a Launched gate with `isEnabled: false` and `rules: []` ([launch example](https://docs.statsig.com/api-reference/gates/launch-gate)). | On/off plus targeting. | ✅ Static: `Launched` → on, fallthrough `true`, rules ignored (📝 note when rules were present); `Disabled` → off, whatever `isEnabled` says. Before this fix a launched gate could land in LD **off**. ❓ Verify the exact Console shape with a real launched gate. | `launched_dark_mode_v1`, `stale_promo_ribbon` |
| 4.15 | Rules that serve what the default rule serves | A 0 % rule fails the users it matches; so does the implicit default. Trailing 0 % rules change nothing; a 0 % rule *before* a pass rule is an exclusion. | Same semantics (first matching rule wins, then the default rule). | ✅ `redundant_rules` (choice, one per gate), listing each such rule as *trailing* (dropping it is exact) or *exclusion* (dropping it changes the result for users who also match a later rule). **Keep every rule** is recommended, so the flag mirrors StatSig; `trim_trailing` drops the exact ones (📝 full note); `trim_all` also drops the exclusions (📝 partial note). Rules serving a rollout are never redundant, and a 0 % rule before a public 100 % rule isn't either (the default then serves Pass). | `account_plan_tier_targeting` (Starter and Student 0 % before Pro and Org, Enterprise 0 % trailing) |
| 4.14 | Scheduled (automated) rollouts | Per-rule `pendingAutomatedRollouts` steps in 15-minute increments; dynamic configs also have "Gradual" and "Switch" (time-range) schedules. | Progressive rollouts (one per flag, timed steps) and scheduled flag changes (Enterprise). | 🚧 The current pass percentage migrates; pending steps are not yet listed or recreated. | — |

## 5. Condition types

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 5.1 | Derived attributes | `browser_*`, `os_*`, `device_model`, `user_agent` are parsed from the UA; `country` from the IP, when the app doesn't send them. | SDKs never derive attributes. | ✅ `derived_attribute` (map; the app must send the attribute). 📝 partial. | `dark_mode`, `legacy_browser_banner`, `eu_cookie_banner`, `bot_detection_challenge` |
| 5.2 | `country` provenance | The Console API can't say whether a `country` condition relies on IP lookup or on `user.country`. | — | 📝 Conservative: every Console `country` is treated as IP-derived, so the decision is always raised. The spec distinguishes `ip_based` from `user_field`. | `checkout_targeting_gate` |
| 5.3 | `time` conditions | Compared to the SDK clock at evaluation. | No clause can read the clock; a scheduled change (Enterprise) can flip the targeting at a moment. | ⚙️ resolved statically when the answer can't change (past window); ✅ `time_condition` otherwise: **schedule** (mirror StatSig now, plus an LD scheduled change carrying the whole targeting as of the flip; see 15.18), resolve as of the sync and re-sync later, or skip. 🚧 `on` is "same day in the SDK host's local time zone" in StatSig; the mapper uses UTC days (a scheduled `on` flips at UTC midnight). | `holiday_sale_2025` (static), `black_friday_2027` (decision) |
| 5.4 | `target_app`, `javascript`, `experiment_group`, `url`, `user_bucket`, unknown types | Evaluated inside StatSig only. | No equivalent. | ✅ `unsupported_condition` (blocking: drop condition / drop rule / skip). Never dropped silently. | `storefront_app_only`, `storefront_url_banner`, mobile `webview_checkout_fallback`, `onboarding_followup`, `legacy_partner_allowlist` |
| 5.5 | Segment references | `passes_segment` / `fails_segment`. | `segmentMatch` (negated for fails) + the segment as a dependency in the same environment. | ⚙️; ✅ `missing_reference` when the segment isn't in the snapshot or is archived; `big_segment` / `hashed_id_list` / `id_list_unavailable` for lists that can't be built yet. | `referral_bonus` (missing), `block_fraudulent_checkout`, `wholesale_portal` |
| 5.6 | Several segments in one condition | Spec `multi_pass_gate` on `segment:` names: *any* listed segment. | — | ⚙️ "passes any" → one clause with several segment keys; "fails any one" → one rule per segment. | — |
| 5.7 | Referencing a segment that can't migrate | — | — | 📝 The gate itself maps as *full*; the **planner** blocks it as a dependency problem. Don't read gate fidelity as "ready". | `early_adopter_badge` → `early_adopters` |
| 5.8 | Custom field names | Looked up as given, then lower-cased, then under `custom` and `privateAttributes` (`getFromUser`). | Attribute names are case-sensitive; `key`, `kind`, `_meta`, `anonymous` are reserved. | ⚙️ reserved names → `custom_<field>` with a 📝 note. 🚧 Case-insensitive fallback isn't reproduced: the app must send the exact name (context contract). | — |
| 5.9 | Private attributes | `privateAttributes` are evaluated but not logged. | Same, via `_meta.privateAttributes`. | ⚙️ no mapping needed; 🚧 belongs in the context contract. | — |
| 5.10 | User agents over 1000 chars | Treated as missing. | Evaluated. | ⚙️ ignore (trivia). | — |

## 6. Operators

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 6.1 | `any`, `none`, `str_contains_any/none`, `str_starts_with_any`, `str_ends_with_any` | Both sides lower-cased (`stringCompare(true, …)`). | `in`, `contains`, `startsWith`, `endsWith` are case-sensitive. | ✅ `case_insensitive_match`: case-folded `matches` regex (exact, recommended), lower/upper variants, or exact. ⚙️ skipped when no value has cased letters. | `search_v2`, `employees_only`; `maintenance_mode` (IPs: no decision) |
| 6.2 | `any` on numbers | Both sides go through `String()`: target `2` matches attribute `2` and `"2"`. | `in` compares typed JSON values: `"2"` ≠ `2`. | ✅ `value_type` (choice) when a target is a number or boolean: **both** (recommended, exact) emits the number and the string of every value, **number** keeps the values typed, **string** stringifies them (both partial, with a note), skip. Also for `any_case_sensitive` / `none_case_sensitive`. | `loyalty_tier_perks` (`[2, 3]`) |
| 6.3 | Negative operators on a missing attribute | `none`, `none_case_sensitive`, `str_contains_none`, `neq` **pass** when the attribute is absent. | A clause on a missing attribute never matches, negated or not. | ✅ `negated_missing_attribute` (acknowledge); 📝 partial. Not raised for `user.key`. | `search_typo_tolerance` |
| 6.4 | `is_null` / `is_not_null` (spec: `eq null` / `neq null`) | Attribute presence. | No "is set" clause. | ✅ `null_check`: `is_not_null` ≈ `matches ".*"` (strings only); `is_null` is **blocking** (drop rule / skip). | `missing_email_prompt`, `sms_notifications` |
| 6.5 | `eq` / `neq` | Loose equality (`==`): `"5" == 5`. Spec-only (not in the Console enum). | `in` (negated for `neq`), typed. | ⚙️ mapped; ✅ `value_type` as 6.2 when the target is a number or boolean; `neq` also hits 6.3. | — (test only) |
| 6.6 | Numeric `gt` / `gte` / `lt` / `lte` | `Number()` coerces numeric strings. | Numeric operators need numeric attribute values. | ⚙️ mapped; 📝 one note per attribute that the app must send a number (StatSig coerced numeric strings; LD doesn't). | `gift_card_upsell` |
| 6.7 | Version comparisons | Missing parts padded with `0`; anything after `-` stripped; any number of parts (`5.2.0.100`). | SemVer: 4-part strings are invalid (clause never matches); `5.3.0-beta` sorts **below** `5.3.0`; missing minor/patch tolerated ❓. | ⚙️ `version_gte` → `semVerLessThan` + negate, `version_lte` → `semVerGreaterThan` + negate, `version_neq` → `semVerEqual` + negate (CLAUDE.md pitfall). 📝 one- and two-part targets padded to three (`1.2` → `1.2.0`; exact, StatSig pads too). ✅ `version_format` (choice) for 4+ parts or a `-` suffix: **truncate** (recommended; partial: the app must send three-part versions, and prerelease builds sort below the release), drop condition, drop rule, skip. Non-numeric parts are left alone (StatSig can't compare them either). | mobile `android_min_version`, `beta_channel_features`; `windows_download_cta`, `pwa_offline_mode`, `pos_firmware_sync`, `legacy_browser_banner` |
| 6.8 | Dates: `before` / `after` / `on` | Targets and values: date strings, then epoch seconds or ms (heuristic). `on` = same local calendar day. | `before` / `after` need RFC 3339 strings or epoch **milliseconds**; `on` has no operator. | ⚙️ targets normalised (`toTimestamp`); `on` → `after day−1 ms` ∧ `before day+1` in UTC (📝 expands). 🚧 Attribute values in epoch seconds read as 1970 in LD; local-day vs UTC-day. | `new_customer_onboarding` |
| 6.9 | `str_matches` | JavaScript `RegExp`; values ≥ 1000 chars never match; invalid pattern → false. | `matches`, evaluated by each SDK's regex engine (RE2 in Go has no lookbehind, backreferences, …). | ✅ `regex_dialect` when non-portable constructs are detected (keep / drop / skip). | `sku_preview` |
| 6.10 | Array operators | `array_contains_*` also match `parseInt(target)` against numeric arrays. | `in` on array attributes, typed. | ⚙️ `any`/`none` → one clause; `all` → one clause per value; `not_array_contains_all` → one **rule** per value (📝). ✅ `value_type` as 6.2 when a target is a number, boolean or integer string: a *number* target matches numbers only in StatSig (`Set.has` + `parseInt`), so **number** is the exact option there; **both** is exact when an integer string is present. `*_all` keep one clause per target, each accepting both forms. | `wishlist_sharing`, `bundle_recommendations`, `clearance_category_badge` |
| 6.11 | `encoded_any` | In the Console enum; the current SDK evaluator returns *unsupported* (false). | — | ✅ `unsupported_condition` (blocking). | `legacy_partner_allowlist` |
| 6.12 | `in_segment_list` / `not_in_segment_list` (spec) | Hashed ID-list membership. | `segmentMatch` against the reconciled list segment. | ✅ `hashed_id_list` blocks the rule until the raw IDs are uploaded and reconciled (9.4); then `segmentMatch`. | spec `wholesale_partners` |
| 6.13 | `user_id any [...]` with cased IDs | Case-insensitive on the ID. | `user.key` is case-sensitive. | ✅ same `case_insensitive_match`; the regex option works on `key`. | — |
| 6.14 | Unknown operator string | — | — | ✅ `unsupported_condition`; adapters keep the operator verbatim and warn. | — |

## 7. Gate references (`passes_gate` / `fails_gate`, PLAN §10.4)

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 7.1 | Referenced gate has only 100 % rules | Evaluate X inline. | — | ⚙️ inlined: OR of X's rules, plus X's pass overrides, minus its fail overrides (trailing 0 % rules ignored). Drift in X is drift in the referrer (fingerprint). | `checkout_promo_banner` → `employees_only` |
| 7.2 | Referenced gate disabled | Always fails. | — | ⚙️ `passes` → never, `fails` → always. | — |
| 7.3 | Referenced gate has a partial rollout, required by **every** rule | — | Prerequisite flag (Enterprise). LD checks prerequisites **before** individual targets, so pass overrides on the referrer stop applying to users who fail X. | ✅ `gate_reference` (choice, recommended: prerequisite; 📝 partial when the referrer has pass overrides). X is migrated first in the same environment. | `checkout_express_pay` → `new_checkout_flow` |
| 7.4 | …required by only **some** rules | — | A prerequisite would gate every rule. | ✅ `gate_reference` (blocking: drop condition / drop rule / skip). | `checkout_upsell_v2` |
| 7.5 | `fails_gate` on a partial-rollout gate | — | No negated prerequisite. | ✅ `gate_reference` (blocking). | `express_pay_fallback` |
| 7.6 | `fails_gate` on an inlinable gate | — | — | ⚙️ De Morgan over the inlined DNF (capped at 10 rules). | `non_staff_survey` |
| 7.7 | `fails_gate` on a gate with overrides | Overrides make "fails X" depend on IDs. | — | ✅ `gate_reference` (blocking): can't inline exactly. | `consumer_pricing` → `b2b_bulk_ordering` |
| 7.8 | Reference cycles | A → B → A. | Prerequisite cycles are rejected. | 🚧 The mapper still offers *prerequisite* when every rule requires the gate; the **planner** reports "Prerequisites form a cycle" and refuses. Should be blocking in the mapper. | — (test only) |
| 7.9 | Nesting deeper than 4 | — | — | ✅ `gate_reference` (not inlinable). | — |
| 7.10 | `multi_pass_gate` / `multi_fail_gate` (spec) | Any listed gate. | — | ⚙️ OR of the inlined gates. | — |
| 7.11 | Prerequisite availability unknown | — | Enterprise feature. | ✅ offered when the capability probe says `unknown`; checked on the first write. Not offered when `not_permitted` / `unavailable` (then blocking). | — |
| 7.12 | Referenced gate archived or not in the snapshot | — | — | ✅ `gate_reference` (blocking) with the reason. | — |

## 8. Overrides → individual targets

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 8.1 | One ID overridden both ways | Allowed: all-environment fail + environment pass. | Each key can be in one variation per flag. | 📝 environment-specific overrides win, then the first; the conflict count is a partial note. | `new_checkout_flow`: `user-vip-complainer` (fail everywhere, pass in staging) |
| 8.2 | Overrides evaluated before rules | Yes. | Individual targets are evaluated before rules, but **after prerequisites**. | 📝 see 7.3. | `checkout_express_pay` |
| 8.3 | Overrides in an unmapped environment | — | — | ⚙️ dropped for the mapped environments. | `qa` |
| 8.4 | Custom-ID overrides | Per unit type. | Targets per context kind. | ⚙️ `contextKind` from the unit type; 🚧 3.4 when the type is unknown. | `b2b_bulk_ordering` |
| 8.5 | Very long override lists | Unbounded. | Individual targets are fine, but LD recommends segments for large lists ❓ limit. | 🚧 no threshold check. | — |
| 8.6 | Experiment group overrides | Force a group. | Individual targets on the experiment flag. | 📅 M6. | `search_ranking_v3` → `user-search-qa` |
| 8.7 | Spec encoding of environment-scoped overrides | Rule `pass:<env>:id_override` + `environment_field` condition (UNVERIFIED, our generator's guess). | — | ❓ confirm with a real spec that has environment overrides. | generated specs |

## 9. Segments

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 9.1 | Scope | Project-wide. | Per environment. | ⚙️ one LD segment per mapped environment, same key. | every segment |
| 9.2 | ID lists ≤ 15 000 | Plaintext via the Console API (deferred above the eager limit). | List segment (`included` for `user`, `includedContexts` otherwise). | ⚙️; ✅ `id_list_unavailable` until fetched (the plan fetches on demand). | `vip_customers` (25), `wholesale_partners` (2 500) |
| 9.3 | ID lists > 15 000 | — | Big segment (`unbounded: true`, one context kind, no rules) filled by a CSV import (Enterprise). | ✅ `big_segment` (choice, recommended: import) once the list is loaded; the segment is created unbounded and the IDs imported in `replace` mode on every sync, so LD mirrors the list. The import answers 204 with a `Location` the browser can't read, so completion is confirmed by sampling membership (first, middle, last key). A refused create/import marks the capability unavailable and the option disappears. 📝 Undo of an *adopted* big segment restores only its metadata (no bulk member read). Lists above the automatic load limit (15 000) are loaded on request from Source warnings, per list or all at once, up to 250 000 IDs (the Console API returns 100 per request); above that, a CSV export is uploaded. | `fraud_blocklist` (20 000) |
| 9.4 | Hashed lists (spec) | `get_id_lists` ships `base64(sha256(id))[0:8]`, one `+hash` / `-hash` per line. The Console API (`GET /segments/{id}/id_list`) returns the plaintext members. | — | ✅ Source warnings › ID lists: **Load from StatSig** reads the members through the Console API with a read-only key entered for the spec source, or the key of a Console API source in the workspace (preferring one whose snapshot has the segment), and checks them against the `get_id_lists` hashes when those are uploaded (StatSig's members stay authoritative: a hash the files don't know is not an extra). Fallback without a key: upload the hash file(s), then a raw-ID CSV; the browser hashes the IDs (WebCrypto, in the pipeline worker) and reports coverage. 100 % verified or a Console read: no decision. A gap: `hashed_id_list` acknowledgement (accept the matched IDs, or skip until a fuller load). No members: blocking. Upload without a hash file: count-based, marked unverified. The demo CSV is 99.6 % complete; the demo's Console source reads the full list. | spec `wholesale_partners` |
| 9.5 | Empty ID list | 0 members. | Empty segment. | ⚙️. | `beta_waitlist` |
| 9.6 | Rule with a pass percentage | Sample of matching users. | Weighted segment rule (re-bucketed). | ✅ `partial_rollout_rebucket` (acknowledge). | `churn_risk` (10 %) |
| 9.7 | Disabled segment | Nobody matches. | Segment with no rules. | 📝 note. | `legacy_partners` |
| 9.8 | Gate reference inside a segment | Allowed. | Segments have no prerequisites. | ⚙️ inlined when exact; otherwise the segment is **skipped** (and gates using it are blocked in the plan). | `staff_or_beta` (inlined), `early_adopters` (skipped) |
| 9.9 | "Everyone" rule | `public`. | A segment rule needs a clause. | ⚙️ `key matches ".*"` on the segment's kind. | — |
| 9.10 | `analysis_list` / `user_store_id_list` types | Other list kinds. | — | 🚧 treated like `id_list`; untested. | — |
| 9.11 | Deleting a segment a flag still targets | — | 409. | ⚙️ undo deletes flags before segments. | runs → Undo |
| 9.12 | Same segment name in two sources with different rules | — | — | 📅 M8 `source_collision`. | `beta_testers` (web vs mobile) |
| 9.13 | Percentage rule followed by more rules | Evaluated like a gate: the first matching rule decides, and users outside its pass percentage **fail** the segment. | A context outside a weighted segment rule's percentage **continues to the next segment rule** ([docs](https://launchdarkly.com/docs/home/flags/rule-based-segments)). | 📝 Exact for a single weighted rule, or when the weighted rule is last; otherwise a partial note (later rules can now match users the StatSig rule excluded). 🚧 Not yet raised by the segment mapper. | `churn_risk` (single rule: exact) |
| 9.14 | ID-list size | Up to 10 M IDs per project; lists above 1,000 IDs are not in the config-spec init payload (separate `get_id_lists` sync). | List segments ≤ 15,000 targets; big segments via CSV import (40 MB, 1 M contexts per file). | ✅ `big_segment` above 15 k; 🚧 CSV import not built; the spec adapter already treats > 1,000-ID lists as hashed. | `fraud_blocklist` |
| 9.15 | Segment rules that match other segments | `passes_segment` / `fails_segment` inside a segment rule. | `segmentMatch` clauses are allowed in segment rules, but the matched segment must already exist in the same environment ("Targeted segment must exist in the same environment as parent segment"). | ⚙️ the planner adds the matched segments as dependencies of the segment, so they are written first; a cycle blocks both with a reason. | `beta_or_vip` (web) |
| 9.16 | Writing more than 1,500 members | Any list size. | "Total number of operations on targets must not exceed batch limit of 1500" per request, JSON or semantic patch alike. | ⚙️ the executor writes rules, description and tags first, then the members in semantic patches of at most 1,500 targets each. | `wholesale_partners` (2,500 IDs) |

## 10. Dynamic configs (`packages/mapper/src/config.ts`)

A config becomes a JSON multivariate flag: variation 0 is `defaultValue` (named *Default*; fallthrough
and off variation), then every distinct rule, variant and override value in source order, deduplicated
by value (stable key order) and named after its rule or variant. The list is built from **every** rule
of the config, not just the environment being migrated, so the project-level shell is the same
whichever environment goes first. Conditions, gate references, segments, context kinds, client-side
availability and provenance (`migration.type = config`) work exactly as for gates (§3–§8).

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 10.1 | Values are per rule; variations are project-level | A new `returnValue` in one environment. | The variation list is shared by all environments. | ⚙️ append-only: the executor adds missing variations at the end and never removes or reorders one. ✅ `variation_change_affects_migrated_env` (acknowledge) when the flag is already synced to an environment outside the plan (PLAN §7). The planner needs the LD listing to carry `variations`; without it the executor still only appends. | `shipping_thresholds` gains `Australia` in snapshot 2 |
| 10.2 | Rule value equal to the default | Allowed. | No new variation needed. | ⚙️ deduplicated by value; the rule serves variation 0 (it still ends evaluation, see 10.4). | `legacy_pricing_rules` |
| 10.3 | Rule variants (split within a rule) | Cumulative bucket split of the rule's passing units. | Rollout across the variant variations, weight = passPercentage × share. | ⚙️ + ✅ `partial_rollout_rebucket` (acknowledge). Shares that don't add up to 100 % leave the rest to the rule's own value (📝 note); a pass percentage below 100 sends the rest to the default. | `homepage_hero` (50/30/20) |
| 10.4 | Partial-rollout rule on a config | The **first** rule whose conditions match ends evaluation. Inside its pass percentage → its value (or variant); outside → `defaultValue`. No fall-through to later rules. | Rule serving a rollout `{value p %, default rest}`. | ⚙️ verified against the SDK evaluator (`Evaluator.ts` `_evalConfig`: `_evalPassPercent` false → `defaultValue`, never the next rule). 0 % rules serve the default. ✅ `partial_rollout_rebucket` as for gates (same decision id, so one policy covers both). | `api_rate_limits` (50 %), `loyalty_checkout_perks` (25 % then a second rule) |
| 10.5 | JSON schema | Validates rule values in the console. | No schema on JSON variations. | 📝 note (full fidelity: serving is unaffected). | `checkout_config` |
| 10.6 | Disabled config | Returns the default for everyone. | Off, serving the default variation. | ⚙️ + 📝 note. | `legacy_pricing_rules` |
| 10.7 | Per-parameter reads | `getConfig("x").get("p", d)` falls back per key. | `jsonVariation` returns the whole value. | ❌ code-change note (PLAN §10.5); rule values are not merged with the default in StatSig either. | `checkout_params` param store |
| 10.8 | Name shared with a gate | Separate namespaces. | One key space. | ⚙️ plan error naming the other item (1.2); an LD flag migrated from the gate of the same name is refused for the config and vice versa. | `maintenance_mode` |
| 10.9 | Custom unit type configs | `idType: companyID`. | Rollouts by that context kind. | ⚙️ as for gates (`unit_type_kind`). | `b2b_order_limits` |
| 10.10 | Config overrides | The Console API has no overrides for dynamic configs; a config spec may carry `…override` rules with a forced `returnValue`. | Individual targets. | ⚙️ spec overrides with a value → targets on that value's variation (appended if new); 📝 a pass/fail override without a value can only target the default. | — (unit test only; the Console fixtures can't express one) |
| 10.11 | Holdouts attached to a config | Held-out users get the default before the rules. | No holdout is created (PLAN §11). | 📝 partial note with the holdout's share; see 4.8 for the gate side. | — |
| 10.12 | Numeric `custom_field` conditions | Coerces numeric strings. | Typed comparison. | 📝 as 6.2 (the gate handling applies). | `loyalty_checkout_perks` (`account_age_days gte 30`) |
| 10.13 | Value size | Config values up to 100 KB. | String/JSON variations up to 32 KB each. | 🚧 Not checked before planning; LD rejects the flag at create time. | — |

## 11. Experiments, layers, holdouts, autotune (M6/M7; PLAN §11)

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 11.1 | Running experiment | `active`. | Can't move assignments mid-flight. | 📅 `experiment_running` (wait, or pre-stage a draft). | `search_ranking_v3`, `checkout_cta_copy` |
| 11.2 | Concluded experiment | `decision_made` + `launchedGroupID`. | Flag serving the shipped group at 100 %. | 📅 `experiment_concluded`. | `homepage_layout_test`; `search_ranking_v3` in snapshot 2 |
| 11.3 | Not started / abandoned / archived | `setup` / `abandoned` / `archived`. | Draft / skip / skip. | 📅. Archived experiments are absent from specs. | `checkout_button_color`, `free_shipping_banner`, `old_banner_test` |
| 11.4 | Custom randomization unit | `idType: companyID`. | Experiment on the `company` context kind. | 📅. | `b2b_discount_tiers` |
| 11.5 | Targeting gate | `targetingGateID`. | Audience = flag targeting rules. | 📅 inline or prerequisite as in §7. | `search_ranking_v3` → `checkout_targeting_gate` |
| 11.6 | Explicit layer with shared parameters | `getLayer().get()`. | LD layers; one flag per experiment. | 📅 `layer_parameters`. Implicit layers are dropped. | `checkout_layer`; `checkout_button_color_layer` (implicit) |
| 11.7 | Holdouts | Global or attached to gates / experiments. | New holdout populations per environment. | 📅; see 4.8 for gates. | `global_holdout`, `checkout_holdout`, mobile `mobile_global_holdout` |
| 11.8 | Autotune | Bandit with a success event; variants return JSON. | JSON multivariate flag (a variation per arm) + custom metric for the success event + experiment `type: mab` created as a **draft** on the flag's default rule. Flag is off until the bandit is started in LD. | ⚙️ Static for a not-started autotune. ✅ Decision `autotune_running` while it runs (default **wait**; or pre-stage: the LD bandit relearns from equal traffic). ❓ Verify: a draft iteration on an off flag. | `hero_image_autotune` (not started), `promo_banner_autotune` (running) |
| 11.9 | Group sizes | Percent of allocation; may be unequal, and StatSig rounds autotune arms down (33/33/33 = 99). | Thousandths of a percent summing to 100 000; `allocationPercent` strings. | 📝 Normalized, remainder on the first arm; noted when sizes don't sum to 100. Experiments: 📅. | `promo_banner_autotune`; mobile `onboarding_carousel` (34/33/33) |
| 11.10 | Concluded autotune | `winner` set: StatSig serves the winner. | Flag serves the winner at 100 %; no bandit (LD can't import a finished bandit). | 📝 Note. | `pricing_page_autotune` |
| 11.11 | Autotune without a success event | Possible via the API; config specs never carry it. | A bandit needs a primary metric. | ✅ Decision `missing_metric` (blocking): flag only (manual) or skip. | `cart_upsell_autotune` |
| 11.12 | Variants with identical values | Allowed. | Flag variations must be distinct. | ✅ Decision `duplicate_variant_value`: merge into one arm (partial) or skip. | `free_shipping_copy_autotune` |
| 11.13 | Autotune on a custom unit ID | `idType: companyID`. | Bandit randomized by the mapped context kind, which must be enabled as a randomization unit in the project's experimentation settings. | ⚙️ Static: `ensure_randomization_unit` step (PUT experimentation-settings, additive; undone with the run). | `b2b_pricing_autotune` |
| 11.14 | Baseline arm | No control concept. | A bandit needs one `baseline` treatment. | 📝 First variant is the baseline. | every autotune |
| 11.15 | Existing LD metric under the success event's key | — | Metric keys are project-wide. | ⚙️ Reused silently when it is a custom metric on the same event; ✅ `key_collision` otherwise. | — |
| 11.16 | Experiment types | `experimentType`: `BASE`, `GEO`, `SWITCHBACK`, `PROMPT`, `SIDECAR` (no-code), `GRID_SEARCH`. | Unit-randomized experiments only; prompts belong to AgentControl. | 📅 Only `BASE` will be drafted; the others are listed as *no equivalent* on the coverage page. | — |
| 11.17 | Holdout percentage range | API `passPercentage` 0–10 (default 5); UI docs say 1–50 %. | `holdoutamount` string percent. | 📅 Pass through whatever the API returns. | `global_holdout` 2 % |
| 11.18 | Experiments enabled in non-production environments | `enabledNonProdEnvironments[]` decides where an experiment runs besides production. | Experiments are created per environment. | 📅 Draft only in the mapped environments the experiment is enabled in. | — |

## 12. Metrics

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 12.1 | Cloud metric types | `event_count_custom`, `sum`, `mean`, `ratio`, `funnel`, `composite`. | Custom / numeric / ratio / funnel; no composite. | 📅 port `statsig-to-ld metrics convert`; `metric_unsupported` for composite. | `engagement_score` (composite) |
| 12.2 | Events need instrumentation | Events are logged to StatSig. | `track()` with the same event key. | ❌ instrumentation checklist. | `purchase`, `checkout_start` |
| 12.3 | Warehouse Native | Metric sources + SQL. | Data source must be created in the LD UI by an admin; custom and ratio only, no funnels; not on Federal. | 📅 guided checklist. | mobile `orders`, `app_sessions` |
| 12.4 | Metric identity | `name::type`; two metrics may share a name. | Unique metric keys. | 📅 key from name + type when needed. | `purchase_count` vs `revenue` share the `purchase` event |
| 12.5 | Metrics from a spec source | Not in the spec. | — | 📅 "needs Console key or manual definition". | spec upload |

## 13. Param stores

| # | Edge case | StatSig | LaunchDarkly | Handling | Demo example |
|---|---|---|---|---|---|
| 13.1 | Static, gate-, experiment- and config-backed parameters | One store, mixed references. | JSON flag for statics; references point at the migrated flags. | 📅 MANUAL → PARTIAL (PLAN §6); code-change notes. | `checkout_params` |
| 13.2 | Spec v1 | No param stores in v1. | — | 📅 needs v2 or the Console API. | generated v1 spec |

## 14. Source differences (Console API vs config spec)

| # | Edge case | Console API | Config spec | Handling | Demo example |
|---|---|---|---|---|---|
| 14.1 | Metadata | Names, descriptions, tags, owners, timestamps, lifecycle, checks, archived. | Only `version`; rule names are opaque IDs. | 📅 enrichment CSV; `completeness.missing` drives "needs Console key" labels. | spec upload |
| 14.2 | Archived entities | Returned with `includeArchived=true`. | Absent. | 📝 an archive looks like a *removal* on re-upload. | `legacy_browser_banner` in snapshot 2 |
| 14.3 | ID lists | Plaintext. | Hashed, behind `get_id_lists`. | ✅ 9.4: read from StatSig with a Console key, else reconciled from a CSV. | `wholesale_partners` |
| 14.4 | Environment scoping | `rule.environments`. | `environment_tier` conditions; environment list inferred and confirmed by the user. | ⚙️ 2.2. | all environment-scoped rules |
| 14.5 | Operators only the spec has | Enum lacks `eq`, `neq`, `version_neq`, `str_starts_with_any`, `str_ends_with_any`, `in_segment_list`. | All present in real specs. | ⚙️ covered by mapper tests; they can't appear in the Console-API demo. | — (test only) |
| 14.6 | Salts | Not exposed. | Present. | 📅 exact parity tester (PLAN §17). | — |
| 14.7 | `country` provenance | Unknown (5.2). | `ip_based` vs `user_field`. | 📝. | — |
| 14.8 | Partial files | — | A key scoped to an environment or target app yields a partial spec. | ✅ warning on upload. | — |
| 14.9 | Wrong file | — | Protobuf+brotli, or a client `initialize` response. | ✅ rejected with instructions. | reference fixtures |
| 14.10 | Browser access | 401/429 responses carry no CORS header (look like network errors); 200 responses unverified (M0 spike #1). | CDN 200 responses unverified. | ✅ `StatsigUnreachableError` after backoff; ❓ `docs/TODO-m0-spike-1-statsig-cors.md`. | demo mock injects 429s |
| 14.11 | Recent usage (gates and configs that are not worth migrating) | `/exposure_count` gives `pastDay` / `past7Days` exposure events per entity (25 ids per kind per call, all environments together); `/gates/{id}/checks` gives `has_production_checks_in_last_7_days` (one call per gate, production only); `checksPerHour` is a current rate. Exposure counts come from SDK exposure events, so a gate checked with exposure logging off looks unused. | Nothing. | ⚙️ Every sync reads exposure counts for live gates and configs (`Gate.usage`), then the checks flag for gates with no exposures (up to 200 per sync). The explorers show a **Usage, 7 d** column and a **No exposures in 7 days** filter; "unused" is claimed only when both signals say nothing happened. The user marks items **Don't migrate** (per workspace, with a reason): they stay listed but leave Select all, the guide's counts and every plan. StatSig's own `STALE_*` reasons stay a separate badge. | `stale_reviews_widget`, `old_cart_drawer`, `payments_v3_scaffold` (no checks); `new_checkout_flow` (busy) |

## 15. LaunchDarkly platform and API quirks that shape the mapping

| # | Quirk | Consequence | Handling |
|---|---|---|---|
| 15.1 | A clause on a missing attribute never matches, even negated. | Drives 6.3 and 6.4. | ✅ decisions. |
| 15.2 | Prerequisites are evaluated before individual targets. | Drives 7.3. | 📝 partial. |
| 15.3 | Regex is evaluated by each SDK's engine. | Drives 6.9. | ✅ `regex_dialect`. |
| 15.4 | SemVer operators need valid semver. | Drives 6.7. | 🚧. |
| 15.5 | List segments hold at most 15 000 IDs (`LIST_SEGMENT_MAX`); bigger lists are big segments (`unbounded`), which have no rules, target one context kind and can't be previewed. | Drives 9.3. | ✅ `big_segment` → unbounded segment + CSV import. ❓ confirm the current limit. |
| 15.6 | Prerequisites, big segments, scheduled changes, approvals, holdouts, layers are plan-gated. | Options appear only when the capability probe allows them; `unknown` ones are offered (not recommended) until a write settles them. | ✅ capability matrix (PLAN §5.2); ✅ the executor reports the first allowed or refused write per capability and the matrix is updated (`learnCapability`), so a refused option disappears and the decision is asked again. |
| 15.7 | Custom-property and environment instructions can't share a semantic patch; rapid writes to one flag return 429. | Two PATCHes per flag; backoff. | ⚙️ executor (reference/README). |
| 15.8 | Deleting a prerequisite flag or a targeted segment returns 409. | Undo must order deletes. | ⚙️ executor. |
| 15.9 | No `Access-Control-Expose-Headers`. | The browser can't read `X-Ratelimit-*` / `Retry-After`. | ⚙️ adaptive backoff. |
| 15.10 | A flag is created in every environment at once. | Unmigrated environments exist, off. | ⚙️ 2.5. |
| 15.11 | Keys: letters, digits, `.`, `_`, `-`; tags ≤ 64 of the same. | Drives 1.1 and 1.4. | ⚙️ + 📝. |
| 15.12 | A rollout keyed on a context kind the evaluated context lacks serves the **first variation with weight > 0**, not the off variation ([docs](https://launchdarkly.com/docs/home/releases/percentage-rollouts)). | A `companyID` rollout evaluated with a user-only context passes some users it should not. | 🚧 Belongs in the context contract (every kind a flag buckets on must be sent). |
| 15.13 | Limits: 5,000 rules and 50,000 clause values per flag; 64 custom properties per flag; 32 KB per string/JSON variation; list segments ≤ 15,000 targets, 1,500 targets per bulk operation; > 10,000 individual targets per environment degrades performance ([docs](https://launchdarkly.com/docs/home/flags/target-rules)). | Expansion (4.10), big lists (9.3), provenance (1.8), large configs. | ⚙️ `rule_expansion` caps at 10; ✅ `big_segment` above 15k; 🚧 no check for variation size, custom-property count or override-list size (8.5), team-key collisions (1.11). |
| 15.14 | Prerequisites are "available on select plans"; a flag in an LD holdout is implemented with a prerequisite and may have no other prerequisite. | Drives 7.3 and 4.8. | ✅ capability probe; 🚧 holdout + prerequisite conflict not detected. |
| 15.15 | Projects may enforce flag key conventions (casing, prefix) that also apply to API creation. | A sanitized StatSig name can be rejected at create time. | 🚧 Not probed; surfaces as a run error. |
| 15.16 | LD's built-in flag importer covers Split and Unleash only, and copies flag shells without rules, targets or prerequisites ([docs](https://launchdarkly.com/docs/home/flags/import)). | No official StatSig path. | ⚙️ this console. |
| 15.17 | An environment that requires approvals answers a direct flag or segment PATCH with **405**; approval requests take the same semantic-patch instructions (flag-scoped route for flags; generic `/approval-requests` with `resourceId: proj/…:env/…:segment/…` for segments). `dryRun=true` also 405s there (PLAN §19 open question 5, assumed). | Drives the approvals fallback. | ✅ executor: the instructions go into an approval request, the step is `pending_approval`, and the sync provenance is written only once "Check approvals" (Runs page) sees `status: completed`. Scheduled changes put their `executionDate` on the request. Undo withdraws pending requests and files the restore as a request. 📝 Weighted segment rules can't be expressed as approval instructions (`addRule` takes no weight): refused with an explanation. |
| 15.18 | Scheduled changes carry semantic-patch instructions and an `executionDate`; two changes touching the same things conflict unless `ignoreConflicts=true`; the record has no comment or tag to recognise ours by. | Drives 5.3. | ✅ each flip is a *full-state* scheduled change (turn on/off, off variation, fallthrough, rules, targets, prerequisites as of that moment), created with `ignoreConflicts`; their ids are stored in `migration.sync.<env>` as `sc:<id>` entries, so a re-sync deletes the previous set and recreates it, and undo deletes what the run created. |
| 15.19 | A big-segment import (`POST …/imports`, multipart CSV, `mode: replace`) returns 204 with the import id only in `Location`, which the browser can't read (no `Access-Control-Expose-Headers`); there is no list-imports route. | Drives 9.3. | ✅ completion is confirmed by sampling membership through `GET …/contexts/{key}`; the run log says how many sampled keys were visible. |
| 15.20 | `GET /flag-statuses/{p}/{e}` items (`FlagStatusRep`) carry no flag key. | The key has to be read from `_links.parent.href` (`/api/v2/flags/{p}/{key}`) or `_links.self.href`. | ⚙️ `flagStatusKey`; items without links are dropped and logged as a schema issue. |
| 15.21 | A flag environment's `lastModified` / `version` move on our own writes too: the targeting PATCH and, moments later, the provenance PATCH. | "LD changed" must not fire on the sync itself. | ⚙️ Monitoring ignores modifications within 2 minutes of the `syncedAt` in the provenance; the journaled post-write version is only used when the summary has no modification time. ❓ Verify live whether a custom-property PATCH bumps the environment `version`. |

## 16. Consolidation (N StatSig projects → 1 LD project; M8)

| # | Edge case | Handling | Demo example |
|---|---|---|---|
| 16.1 | Same name, identical targeting | 📅 auto-merge; provenance lists both sources. | `employees_only`, `maintenance_mode`, `kill_switch_payments` |
| 16.2 | Same name, different targeting | 📅 `source_collision`: prefix both (`web.x`, `mobile.x`), primary wins, pick a source, or a discriminator flag. Renames propagate to `segmentMatch`, prerequisites and inlined references. | `new_checkout_flow`, `dark_mode`, `search_v2` |
| 16.3 | Shared segment name, different rules | 📅 as 16.2. | `beta_testers` |
| 16.4 | Shared event across sources | 📅 confirm once per event that it means the same thing. | `purchase` |
| 16.5 | Unit types with the same name | ⚙️ The Unit types page's *Across sources* table lists unit types that more than one source uses and flags the ones the sources send to different kinds, so the user aligns them (or keeps them apart on purpose). 📅 a `source_collision`-style decision when their meaning differs. Also 3.2 within one source. | `companyID` in both |
| 16.6 | Same key from both sources today | ⚙️ refused (DEMO.md). | — |

---

## 17. Mapper backlog (every 🚧 above, in priority order)

1. **Custom-ID overrides on a userID gate** (3.4): ask which unit type, instead of inventing a `custom` kind. The Unit types page lists `customID` as an undeclared unit type meanwhile.
2. **Prerequisite cycles** (7.8): make the mapper decision blocking instead of relying on the planner error.
3. **Sanitized-key collisions between StatSig names** (1.1) and **tag merges by lower-casing** (1.4).
4. **Dates** (5.3, 6.8): `on` in UTC vs local day; attribute values in epoch seconds; add to the context contract.
5. **Context contract** (3.5, 5.8, 5.9, 6.6): generate the document PLAN §10.5 promises, so the attribute-name, type and multi-context requirements collected above reach developers.
6. `analysis_list` / `user_store_id_list` segments (9.10), override-list size (8.5).

---

## 18. Another LaunchDarkly project as the source (PLAN §20; `packages/mapper/src/neutral.ts`)

The vocabulary is the target's, so the differences are between two *projects*, not two platforms. Demo examples are in `packages/demo-fixtures/src/ld/acme-legacy.ts`; tests in `packages/mapper/test/neutral.test.ts` and the golden files `acme-legacy.*.json`.

| # | Edge case | Source LD project | Target LD project | Handling | Demo example |
|---|---|---|---|---|---|
| 18.1 | Flag shell | Key, name, description, kind, variations (values, names), tags, temporary, client-side availability, defaults. | Same fields. | ⚙️ copied verbatim; provenance tags and `migration.*` properties added. Archived flags skipped; `deprecated` noted; `purpose` migration/holdout skipped with a reason. A source that did not report `clientSideAvailability` gets a server-side-only flag, 📝 noted. | `legacy-kill-switch`, `legacy-archived-promo`, `legacy-cta-copy` |
| 18.2 | Per-environment targeting | on/off, off variation, default rule, rules (clauses with operator, context kind, attribute, values, negate), `targets` + `contextTargets`, `trackEvents`, disabled rules. | Same, in the environment the profile maps to. | ⚙️ copied one to one; environments map by key/name (§7). `targets` (user) and `contextTargets` are merged per (kind, variation). 📝 disabled rules left out (they do not evaluate); 📝 event tracking not copied. Operators the console cannot write → ✅ `unsupported_condition`. | `legacy-checkout-redesign` (test), `legacy-ios-min-version` |
| 18.3 | Percentage rollouts | Rule / default-rule rollouts, weighted segment rules, `bucketBy`, experiment `seed`. | Same weights; a new flag gets a new `salt`; `seed` is not settable through the API. | ✅ `partial_rollout_rebucket` (acknowledge) per rollout; `bucketBy` copied. | `legacy-checkout-redesign` (production), `legacy-pricing-tiers`, `legacy-internal-users` |
| 18.4 | Context kinds | Any kind in clauses, rollouts, targets, segment lists. | The target may lack the kind. | ✅ `unit_type_kind`: create it with the same key (an `ensure_context_kind` step) or use an existing kind. Archived source kinds are listed but not created. | `device` in `legacy-ios-min-version` |
| 18.5 | Prerequisites | `prerequisites: [{ key, variation }]`. | Enterprise feature; the referenced flag must exist first. | ⚙️ dependency on the source flag (migrated first in the same environment). ✅ `prerequisite_unsupported` (blocking: drop / skip) when the target plan or token lacks them; ✅ `missing_reference` when the flag is not in the source or archived. | `legacy-pricing-tiers`, `legacy-receipt-emails` |
| 18.6 | Segments | Per environment: rules (weight, `bucketBy`), `included` / `excluded`, `includedContexts` / `excludedContexts`. A key may exist in some environments only. | Same, per environment. | ⚙️ copied where the segment exists; `segmentMatch` pulls it in as a dependency; ✅ `missing_reference` for a rule matching a segment absent from that environment; `segmentMatch` inside a segment rule → ✅ `unsupported_condition`. Lists > 15,000 keys skipped with a reason. Name/description differing per environment: the first environment's wins, with a snapshot warning. | `legacy-beta-orgs`, `legacy-internal-users`, `legacy-fraud-shield` (test) |
| 18.7 | Big segments | `unbounded: true`; membership lives in the big-segment store and is readable only per key. | Big segment (Enterprise) filled by CSV import. | ✅ `big_segment` (blocking): create it empty for a manual import (fidelity *manual*), or skip. Skipped with a reason when the target has no big segments. Rules on a skipped segment block their flag. | `legacy-fraud-blocklist`, `legacy-fraud-shield` (production) |
| 18.8 | Custom properties and provenance tags | Flag-level custom properties; a source that was itself a migration target carries `migrated-from-*` / `migration-src-*` tags and `migration.*` properties. | Custom properties; the console's own provenance. | ✅ `copy_custom_properties` (choice, recommended copy) for the flag's own properties; ⚙️ earlier-migration provenance is never copied onward, 📝 noted. | `legacy-checkout-redesign` (`jira.issue`), `legacy-theme` |
| 18.9 | Maintainer and team | `maintainerId`, `_maintainer.email`, `maintainerTeamKey`. | Member and team IDs of another account mean nothing here. | ⚙️ matched by email against the target account's members and by key against its teams (1.5); ✅ `maintainer_unknown` when nothing matches; 📝 a source that gave only a member ID is noted. | `legacy-kill-switch` |
| 18.10 | Experiments, metrics, holdouts, guarded rollouts, release pipelines, approval settings, flag links | Attached to the flag or environment. | Set up again in the target. | ❌ not read (PLAN §11, §20.4); 📝 experiments running on a flag are noted on the flag. | `legacy-cta-copy` |
| 18.11 | Key already in the target | — | A flag or segment with the same key, not created by the console. | ✅ `key_collision` (adopt or skip), as for every source; a flag of the other kind (boolean vs multivariate) is a plan error. | planner test |
| 18.12 | Source environment without a target environment | Any environment key. | The target has a different environment list. | ⚙️ mapping profile (auto-mapped by key or name; create or map under Mapping); items planned for an unmapped environment are errors, as for StatSig. | `test` → `test`, `production` → `production` |
