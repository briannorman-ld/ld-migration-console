# Demo walkthrough

A 12–15 minute script for the LaunchDarkly Migration Console, following the **Migration guide**
(the workspace landing page) from top to bottom. The StatSig side is the simulated "Acme Retail"
dataset (PLAN §19); the LaunchDarkly side is real: the demo writes into the `statsig-migration`
project on the US instance with the token you paste.

The guide has nine steps. Steps 1–3 are account-level and done once; steps 4–9 repeat per
environment, staging first and production last. Every step shows where things stand and runs
only what you confirm; nothing is written to LaunchDarkly until you click a Migrate button.

## Before the demo

- Open the deployed site, `https://briannorman-ld.github.io/ld-migration-console/` (GitHub Pages
  publishes `main` on every push), or run `pnpm dev` and open http://localhost:5173. Rehearse on
  the same URL you will present from, and stop pushing to `main` once you have.
- Have a LaunchDarkly access token for the `statsig-migration` project at hand. It is held in
  memory or encrypted on the device, never in a workspace file.
- Reset the LaunchDarkly project so it starts empty (see "After the demo" below), and reload the
  tab so the StatSig timeline is back at step 1 of 2.
- Keep a second browser profile with the demo already mid-story (staging migrated) as a fallback.

## 1. Start: Try the demo (1 min)

Click **Try the demo** on the start screen. It creates the **Acme Retail (Demo)** workspace with
three sources already attached:

- `acme-web` (StatSig Console API, Cloud): 59 gates, 9 dynamic configs, 11 segments, 8 experiments,
  2 layers, 2 holdouts, 6 autotunes, 7 metrics, 2 prompts, 4 teams.
- `acme-mobile` (StatSig Console API, Warehouse Native): 16 gates, 4 configs, 2 segments, with 2
  metric sources. Six gate names overlap with `acme-web` (consolidation).
- `acme-legacy (LaunchDarkly)`: an acquired business unit's LaunchDarkly project read as a source
  (PLAN §20): nine `legacy-*` flags and three segments, with `organization` and `device` context
  kinds.

The two StatSig sources sync through the *real* Console API adapter against an in-browser Mock
Service Worker that injects occasional 429s; watch the retry messages in the **Sources** panel.

## 2. Guide step 1, Connect (1 min)

Three ticks: sources synced, LaunchDarkly connected, and how members and teams are managed.

- Click **LaunchDarkly** (left nav: *LaunchDarkly & capabilities*). Paste the **Access token**;
  instance `us`, **Target project** `statsig-migration` are preselected for the demo. The probe
  runs read-only and fills the **Capability matrix**: which features *this* token and plan allow,
  with the fallback the console uses when one is missing.
- Back in the guide, answer **Members and teams are managed** → *In LaunchDarkly*. (The SCIM and
  Okta team-sync answers make the Teams and People steps wait for the identity provider instead
  of writing anything; worth one sentence.)

## 3. Guide steps 2 and 3, Teams and People (2 min)

Both carry the **Account-wide** marker: they write to the LaunchDarkly *account*, not just the
project.

- **Teams**: the four StatSig teams of `acme-web` and the two of `acme-mobile`, matched by name
  against LaunchDarkly teams. **Create all N teams** creates the missing ones with the members
  that already exist in LaunchDarkly; nobody is emailed. Each row can also be skipped
  (*No LaunchDarkly team*).
- **People**: every StatSig owner across the sources, matched by email against the LaunchDarkly
  member list; items per owner and their team. For owners that are not members: pick a member or
  a team as maintainer, mark them *unassigned*, or invite. **Invite all N people…** opens the
  typed confirmation (type `invite`): show the modal with the full address list and the
  **Account-wide** warning, then cancel unless you want LaunchDarkly to send real emails to the
  `.example` addresses. A flag whose owner is still missing is created without a maintainer and
  picks it up on the next sync.

## 4. Guide step 4, Choose an environment (1 min)

**Source environment** `staging` (also the selector in the header) maps to LaunchDarkly `test`;
`production` → `production`; `development` and the custom `qa` tier stay *not migrated*. For an
unmapped environment the step offers **Create "qa" in LaunchDarkly**. The full table, and the unit
types, are on the **Mapping** page.

## 5. Guide step 5, Context kinds (1 min)

Unit types in this environment → LaunchDarkly context kinds: `userID` → `user`, `stableID` →
`device`, `companyID` → `company` (`acme-mobile` adds `deviceID`). Each is a decision (own context
kind, or an attribute of a kind). **Context kinds to create in LaunchDarkly** lists the kinds the
rules need and the project lacks; one click creates them, or the step shows the admin
instructions when the token may not.

## 6. Guide step 6, Segments (2 min)

The step line reads like *3 of 11 in sync · 8 not migrated · 1 waits for decisions*. Open the
**Segments** explorer:

- **Used by** shows which gates, configs and segments reference each one. Filter to the unused
  ones and click **Don't migrate these**: they stay listed as *set aside* and drop out of the
  guide's counts and every plan.
- `fraud_blocklist` has 20,000 IDs, above LaunchDarkly's 15,000 limit: it migrates as a big
  segment. `wholesale_partners` (2,500 IDs) is read from StatSig on demand; `churn_risk` is a 10 %
  rule; `staff_or_beta` inlines a gate; `early_adopters` cannot, so `early_adopter_badge` is
  blocked until decided.
- Back in the guide: **Migrate N segments to test…**, **Dry run** (LaunchDarkly validates,
  nothing is saved), then **Migrate**.

## 7. Guide step 7, Flags and AI Configs (4 min)

Tallies for **Gates**, **Dynamic configs** and **AI Configs** (the two StatSig prompts; shown only
when the plan has AI Configs). Three things to show before migrating:

**The explorer** (click **Gates**). Each row: StatSig on the left, fidelity, open decisions, the
7-day StatSig exposure count, and the per-environment LaunchDarkly status. Filters: *Open
decisions*, *Blocking decisions*, *Not migrated here*, *Changed since sync*, **No exposures in 7
days** (the pruning candidates: select them and **Don't migrate these**), *Set aside*. Click a
row for the condition-level translation: StatSig rules on the left, generated LaunchDarkly
targeting on the right, fidelity notes and the row's decisions inline. Good rows:
`new_checkout_flow` (20 % rollout → re-bucketing acknowledgement), `non_staff_survey` (a negated
gate reference, inlined exactly) next to `express_pay_fallback` (same shape, not inlinable),
`account_plan_tier_targeting` (0 % rules the default rule makes redundant: trailing ones can be
trimmed exactly, the ones before a pass rule act as exclusions), `free_returns` (a public 100 %
rule makes the later rules unreachable), `Holiday Banner 2026` (key sanitized). Configs:
`homepage_hero` (three variants → a 50/30/20 rollout across JSON variations), `api_rate_limits`
(a 50 % rule; the rest get the default), `legacy_pricing_rules` (disabled, its only rule returns
the default, so the flag gets a second *Unused* variation).

**Decisions** (left nav; the badge counts blocking ones). Over a hundred decisions, grouped by
*type* first: one row per decision type where **Set a policy…** answers every open one of that
type, then the same question grouped across items (e.g. case-insensitive `any` across dozens of
conditions), then per item. **Use recommended for N choices** clears the rest of the choices in
one click. Blocking decisions and acknowledgements always need an explicit answer: the 20k-ID
list, `is_null`, `url` and `target_app` conditions, the deleted segment behind `referral_bonus`,
the 12-rule expansion in `cross_sell_matrix`, the `encoded_any` allowlist, the gate references in
`express_pay_fallback`, `consumer_pricing` and `checkout_upsell_v2`. **Export log (.md)** gives
the decision log to take away. Every row of `docs/KNOWN-EDGE-CASES.md` has an item here, and the
gate descriptions say which edge case each one is for.

**The plan.** Back in the guide, **Migrate N flags to test…** (or select rows in the explorer and
**Plan migration…**). The modal lists every item with its type, flag key and LaunchDarkly status,
pulls in the segments and context kinds the flags depend on, and orders prerequisites first
(`new_checkout_flow` before `checkout_express_pay`). **Target environments** are ticks;
**Configure targeting in** says where rules are written. **Dry run**, then **Migrate**: steps run
in parallel with a progress window, and a finished run shows the failed steps and distinct
errors with **Download report** (Markdown or CSV). Open LaunchDarkly: the flags carry the
`migrated-from-statsig` and `migration-src-web` tags, `migration.*` custom properties, maintainers, and
audit-log comments naming the run. Production is still untouched.

## 8. Runs (1 min)

Left nav **Runs**: every run and dry run is journaled. **Undo…** deletes what a run created and
restores what it updated. A run interrupted by closing the tab shows **Resume**. Writes that
LaunchDarkly answers with "approval required" are filed as approval requests and tracked here.

## 9. Guide step 8, Experiments and bandits (1 min)

Autotunes migrate as flags with a **Migrate N autotunes…** button. Experiments, layers and
holdouts are listed as *end in StatSig, start new in LaunchDarkly*: nothing is moved mid-flight,
with a link to **What migrates** for the reasoning.

## 10. Guide step 9, Cut over, and Monitoring (2 min)

The step spells out the cutover: swap the SDKs in staging, watch Monitoring, re-sync when StatSig
changes, archive in StatSig once its checks are at zero, then the next environment. Two sub-items:
**Reviews → approvals** (StatSig "requires review" in an environment → turn on required approvals
in the LaunchDarkly environment *after* the writes, or every sync files an approval request) and
**Topline alerts to recreate** (no LaunchDarkly equivalent).

Open **Monitoring** and click **Advance StatSig timeline** (step 1 → 2 of 2; demo only). It
re-syncs the sources with scripted changes and the drift shows up:

- `new_checkout_flow`: the public rollout widened from 20 % to 50 %; StatSig checks/h shift.
- `shipping_thresholds` gains an Australia value → *variation change affects a migrated env*.
- `dark_mode` targets Safari too; `bot_detection_challenge` is switched off.
- `legacy_browser_banner` is archived in StatSig → retire the flag rather than sync it.
- `checkout_gift_wrap` is new in StatSig, not in LaunchDarkly yet.

Each row offers a re-sync plan showing exactly what would change; the **Cutover funnel** and
**StatSig checks/h** columns tell the traffic story.

## 11. Optional detours (pick one or two)

- **Production**: switch the header environment to `production` and repeat steps 4–7. The plan
  modal asks you to type the environment name before a production write.
- **Consolidation**: `acme-mobile` shares `employees_only`, `maintenance_mode`,
  `kill_switch_payments`, `new_checkout_flow`, `dark_mode` and `search_v2` with `acme-web`; the
  explorer marks them. Migrating the same name from both sources is still refused (M8 backlog).
- **LaunchDarkly as a source**: *Resources → LaunchDarkly source* shows `acme-legacy` flags mapped
  through the neutral model, with status by environment and the decisions a LaunchDarkly-to-
  LaunchDarkly move still raises (missing context kinds, rollout re-bucketing, prerequisites,
  segment references, big segments, custom properties, key collisions).
- **Spec-only path**: *Connections → Add a source → Config spec file* with
  `packages/demo-fixtures/generated/acme-web/download_config_specs.v2.json`. Re-uploading the same
  file is detected as a duplicate; `download_config_specs.v2.snapshot-2.json` produces a diff.
  *Source warnings → ID lists*: **Load from StatSig** reads the hashed `wholesale_partners` list
  with a Console key, or reconcile `wholesale_partners.raw-ids.csv` against the hashes (99.6 %
  coverage → a `hashed_id_list` acknowledgement).
- **What migrates**: the coverage matrix with the demo inventory counted against it, filterable
  by status; the same data is published as [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
- **Snapshots**: every sync is kept; tick two to compare them.

## After the demo

*LaunchDarkly & capabilities → Danger zone → Reset LaunchDarkly project…* previews what it will
delete, then asks for three typed confirmations (`yes`, the project key, `engage project reset`).
It only ever acts on the project this workspace targets. Reload the tab to put the StatSig
timeline back at step 1. Runs recorded in the browser still list what they wrote; their undo
will find nothing to restore.
