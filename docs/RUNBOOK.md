# Runbook: migrating a StatSig project to LaunchDarkly with the console

*For the person running the migration. The console's **Guide** page walks the same order with live status for the environment you are on; this document is the plan around it: what to settle before you open the console, what is done once versus once per environment, the cutover and decommission criteria, and what to do when something goes wrong. The reasoning behind each mapping is in [LIMITATIONS.md](LIMITATIONS.md); row-level differences are in [KNOWN-EDGE-CASES.md](KNOWN-EDGE-CASES.md).*

## The shape of a migration

The console copies StatSig state into LaunchDarkly **one environment at a time**, and only when you click Migrate. StatSig keeps running and is never written to. A flag exists in every LaunchDarkly environment the moment it is created, but it is off and serves nothing until that environment's targeting is written, so the environments you have not reached keep serving StatSig.

The whole thing has three layers:

| Layer | Done | Steps |
|---|---|---|
| Account | Once | Connect, Teams, People |
| Project | Once, before the first environment | Unit types → context kinds, environment mapping, decision policies, set-asides |
| Environment | Once per environment, staging first, production last | Context kinds, Segments, Flags, Experiments and bandits, Cut over |

Most migrations that go badly skipped the project layer and answered the same question two hundred times, or migrated production before any SDK had been switched anywhere. Do the layers in order.

## 0. Before you open the console

**Count the StatSig projects first.** A StatSig project is a hard boundary: every gate, config, segment and experiment belongs to exactly one, and a Console API key reads exactly one. There is no API call that lists an organization's projects, so neither the console nor a script can discover them for you. Ask the customer to list them from the StatSig web console: the project switcher shows every project the signed-in person belongs to, and on Enterprise the organization settings show all of them. Teams inside a project are not projects. Expect more than one when several apps or business units adopted StatSig separately.

**Decide the target.** Each StatSig project becomes a *source* in the console. The simple shape is **one StatSig project → one LaunchDarkly project**, a workspace each. **Consolidation**, several StatSig projects into one LaunchDarkly project, is for projects that share gates or an application: add every source to one workspace; the explorer marks the names that appear in more than one source, and the mapping profile gives each source a key prefix. Migrating the same name from two sources in one run is not supported yet, so decide per overlap which source wins and set the other aside. Do not consolidate projects from different StatSig organizations; the company call on each source reports the organization. Then decide which StatSig tiers map to which LaunchDarkly environments. A tier with no LaunchDarkly counterpart can be created from the Guide, or left *not migrated*.

**Get the credentials.**

- StatSig: a **read-only Console API key** per project (`omni_read_only`). The console warns if the key has write scopes; it never uses them. Where a key is not an option, export the project's config spec (`download_config_specs`, v1 or v2) and upload it; a spec source has no metrics and no raw ID-list members, so prefer a key.
- LaunchDarkly: an access token with a **custom role scoped to the target project** (flags, segments, metrics, experiments, context kinds). Only the Teams and People steps need account-level rights (teams, members); leave those out of the token if an identity provider manages people.
- Decide where the token lives: encrypted on the device, a passphrase vault, or memory only. It is never written to a workspace file.

**Prepare StatSig.** Nothing here is required, but each item removes work later:

- Archive gates and configs nobody uses. The explorer shows 7-day exposure counts and a *No exposures in 7 days* filter, so you can also do this from the console with **Don't migrate these**.
- Let running experiments finish, or decide which ones you will restart in LaunchDarkly. Nothing is moved mid-flight; a running experiment stays in StatSig until it ends.
- Agree a **change freeze on StatSig for each environment's migration window**. Changes made after the snapshot are not lost, but they show up as drift and need a re-sync. Fewer moving parts, fewer re-syncs.

**Prepare LaunchDarkly.**

- Create the project and its environments, or let the Guide create missing environments.
- **Do not turn on required approvals in a target environment yet.** Every console write would file an approval request instead of landing. Turn approvals on at Cut over, after the writes.
- If experiments will use warehouse-native metrics, a LaunchDarkly admin creates the data source in the UI first; the API cannot.
- Tell the team that migrated flags carry the `migrated-from-statsig` tag, `migration.*` custom properties and audit-log comments naming the run. Those are the migration's ledger; do not strip them.

**Prepare the browser.** The console is a static page: state is in the browser's IndexedDB plus the provenance written into LaunchDarkly. Run a migration from **one machine and one browser profile**, keep the tab open during a run (a run interrupted by closing the tab resumes when you reopen it, but there is no reason to test that in production), and do not clear site data until the migration is decommissioned.

## 1. Account layer, once

### Connect

1. Create a workspace and add every source. A Console API source syncs immediately; the **Sources** panel shows pagination, retries and warnings.
2. Connect LaunchDarkly: instance, token, target project. The **capability matrix** fills from read-only probes: which features this token and plan allow and which fallback the console uses when one is missing. **Read it before going on.** A missing permission found here costs a minute; found during a run it fails steps.
3. Answer **Members and teams are managed**: in LaunchDarkly, by SCIM, or by Okta with team sync. With a provider, the Teams and People steps list what is missing and wait instead of writing.
4. Open **Source warnings**. Hashed ID lists, lists too large for the API, spec exports taken with a target-app-scoped key and other partial reads are listed here with their remedies (load from StatSig with a key, or reconcile a raw-ID CSV).

### Teams, then People

Both write to the LaunchDarkly **account**, not the project, and the console marks them so.

- **Teams** first: StatSig teams matched by name to LaunchDarkly teams; create the missing ones, or mark a team *No LaunchDarkly team*. Teams exist before people so that an invitation can place a person into them.
- **People**: every StatSig owner matched by email to LaunchDarkly members. For each missing owner pick a maintainer (member or team), mark them *unassigned*, or invite. **Invite all** sends real emails and asks for a typed confirmation.

Neither step blocks the environment work. A flag whose owner is still missing is created without a maintainer and picks it up on the next sync once the person exists.

## 2. Project layer, once, before the first environment

These settings change the shape of every flag, so settle them before the first plan.

1. **Unit types** (left nav). One row per unit ID type the sources use: `userID`, `stableID`, every custom ID. Choose where each lands: its own context kind, or an attribute of a kind. A custom unit ID is never mapped onto the `user` context's key. Settling this here means no per-item `unit_type_kind` decision later, and the multi-context shape your SDK calls will need is fixed from the start.
2. **Mapping**: the environment table (tier → LaunchDarkly environment, or *not migrated*), key prefixes for consolidated sources, and whether flag names are derived from IDs.
3. **Decisions → by type → Set a policy.** Answer the workspace-wide questions once: case-insensitive matching, numeric-versus-string values, client-side availability, version formats, regex dialect. **Use recommended** clears the rest. Blocking decisions and acknowledgements (a 20,000-ID list, an `is_null` condition, a deleted segment, re-bucketing of a percentage rollout) still need a per-item answer; that is deliberate.
4. **Set aside** what will not migrate: unused segments (*Used by* is empty), gates without exposures, anything the team has agreed to retire. Set-aside items stay listed, drop out of every count and are never planned.
5. **What migrates** shows the coverage matrix with your inventory counted against it. Anything in *No LaunchDarkly equivalent* (contextual bandits, composite metrics, switchback experiments, JSON-schema validation, topline alerts) needs an owner and a plan outside the console. Write those down now.

## 3. Environment layer, once per environment

Start with the lowest environment that has real traffic, usually staging. Production last, and only after the SDKs have been switched in at least one other environment and Monitoring there has been quiet.

### 3.1 Choose an environment

Set the source environment in the Guide (also the header selector). The step confirms the LaunchDarkly environment it maps to and offers to create one if it does not exist.

### 3.2 Context kinds

The step lists the kinds this environment's rules, rollouts and targets need and the project lacks. **Create them** (one run, project-level). If the token may not, the step lists the keys for an admin and a re-probe button. Nothing below works without them.

### 3.3 Segments

Flags reference segments, so segments go first.

1. In the explorer, check the three kinds of segment that need attention: lists above 15,000 IDs (migrate as big segments, filled by CSV import), lists read from StatSig on demand, and segments that inline a gate reference.
2. **Migrate N segments to <env>…** → **Dry run** → **Migrate**. A dry run is validated by LaunchDarkly and saves nothing.

### 3.4 Flags and AI Configs

1. **Sync the sources first** if the last sync is older than the StatSig change freeze. The plan is built from the snapshot.
2. Clear the **blocking** decisions for this environment (the Decisions badge counts them). Items with an open blocking decision are left out of the plan, not approximated.
3. Spot-check the condition-level translation on a handful of rows: a percentage rollout, a negated gate reference, a rule with `environment_tier`, a dynamic config with several return values. The drawer shows StatSig rules on the left and the generated LaunchDarkly targeting on the right, with fidelity notes.
4. **Migrate N flags to <env>…** The plan pulls in dependencies (segments, context kinds, prerequisite gates) and orders prerequisites first. Check **Configure targeting in**: only the ticked environments get rules; the others stay off.
5. **Dry run**, read the failures, fix (usually a permission or a decision), dry run again until clean.
6. **Migrate.** Production asks you to type the environment name. Watch the progress window; a run stops itself on systemic errors (auth, rate limit exhaustion) and **Runs** shows each failed step with its distinct error and a downloadable report.
7. Open LaunchDarkly and check three flags: targeting matches the drawer, the tags and `migration.*` properties are present, the maintainer is set.

### 3.5 Experiments and bandits

- **Autotunes** migrate as flags with a drafted bandit.
- **Experiments, layers and holdouts** are listed as *end in StatSig, start new in LaunchDarkly*. For an experiment you want to continue: let it reach a decision in StatSig, ship the winning group, and the console migrates the shipped flag. For one not started yet: start it in LaunchDarkly. Nothing in between is moved.

### 3.6 Cut over

This is the only step the console cannot do for you, and it is where the time goes.

1. **Switch the SDK** in the applications that run in this environment. The code work:
   - Build contexts the way the Unit types page decided: one context per kind, multi-contexts where a flag needs several.
   - Send the attributes StatSig used to derive (browser, OS, device model, country). LaunchDarkly SDKs derive nothing; the `derived_attribute` decisions list exactly which attributes which flags need.
   - Replace `getConfig("x").get("p", default)` with one JSON variation read and a field access. Replace gate checks with boolean variation calls using the same key.
   - Re-send the events behind migrated metrics through the LaunchDarkly SDK.
2. **Dual-run.** Keep StatSig live. Open **Monitoring**: the cutover funnel per environment shows migrated → dual-running → cut over, from LaunchDarkly flag statuses and StatSig checks per hour.
3. **Re-sync on drift.** Monitoring flags *StatSig changed*, *LD changed* and *conflict* per item. Each row offers a plan that shows exactly what a re-sync would write. Re-syncs are always your click; the monitor never writes. An item archived in StatSig after migration is listed for retirement, not re-synced.
4. **Approvals.** If StatSig required reviews in this environment, turn on required approvals in the LaunchDarkly environment **now**, after the writes. The step has the button when the token allows it.
5. **Recreate topline alerts** that matter as LaunchDarkly Observability alerts or experiment guardrails. The step lists them.
6. **Declare LaunchDarkly authoritative** per item once StatSig checks have been at zero for about a week. The item drops out of *StatSig changed* alerts and a further sync needs an explicit override. Then archive those gates in StatSig and stop syncing this environment.
7. Next environment, from step 3.1.

### Production specifics

- Do the production run inside the agreed StatSig change freeze, at a low-traffic time, with the person who can approve LaunchDarkly changes present.
- Dry run first, always. The typed confirmation is the last stop.
- Switch the production SDK in a staged deploy (canary first), with StatSig still live. If anything looks wrong, point the deploy back at StatSig; the LaunchDarkly flags can stay as they are.
- Do not mark production items LaunchDarkly-authoritative until the SDK deploy is complete everywhere and StatSig checks are at zero.

## 4. Decommission

When every environment is LaunchDarkly-authoritative:

1. **Export the decision log** (Decisions → Export log). It is the record of every inexact mapping and who answered it; keep it with the project's documentation.
2. Download the reports of the production runs from **Runs**.
3. Archive the remaining gates, configs and segments in StatSig; stop the StatSig SDKs; revoke the Console API key.
4. Leave the `migrated-from-statsig` tags and `migration.*` properties on the LaunchDarkly flags. They cost nothing and answer "where did this flag come from" a year later.
5. The console workspace can be deleted. Everything durable about the migration is in LaunchDarkly.

## 5. When something goes wrong

| Situation | What to do |
|---|---|
| A run fails some steps | **Runs** lists each failed step with its error; the rest of the run completed. Fix the cause (permission, decision, rate budget) and plan again: the items already in sync are skipped. |
| A run was interrupted (tab closed, laptop slept) | Reopen the tab; **Runs** shows **Resume**. Every operation is journaled before and after it runs, and writes are idempotent. |
| The migrated targeting is wrong | **Undo…** the run: it deletes what the run created and restores what it updated from the pre-images taken before each write. Then fix the decision or mapping and re-plan. |
| StatSig changed during the window | Monitoring shows the drift; re-sync the affected items. Nothing is lost. |
| Someone edited a migrated flag in LaunchDarkly | Monitoring shows *LD changed* or *conflict*. Decide which side wins: re-sync to take StatSig's state, or mark the item LaunchDarkly-authoritative to keep the edit. |
| A flag key already exists in LaunchDarkly without the console's provenance | The plan raises a `key_collision` decision; the console never overwrites a flag it did not create unless you adopt it. |
| Approval required errors | The target environment has required approvals on. The console files approval requests and tracks them in **Runs**; a reviewer applies them, or turn approvals off until the writes are done. |
| The SDK switch misbehaves in an environment | Point the SDK back at StatSig. The console never wrote to StatSig, so it is exactly as you left it. |

## What this runbook does not cover

The SDK change itself is ordinary code work in your repositories, and the console only tells you what it must send. Experiment design in LaunchDarkly, warehouse-native metric sources and Observability setup belong to LaunchDarkly's own documentation.

*Status note (2026-11-03): approvals filing, scheduled changes, big-segment CSV import, member invitations and the exposure-count read are built from the API specifications and exercised against the demo, not yet against a live LaunchDarkly account with those features turned on. Expect to confirm them on your first staging run.*
