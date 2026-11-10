# Security review, 2026-11-09

Scope: the whole repository at commit `6e5187f` (main), read-only. Method: a manual read of
the token vault, CSP, build and hosting configuration, plus four focused audits (token flow
and request construction; untrusted input parsing; rendering, navigation and browser APIs;
LaunchDarkly write and delete paths), every reported finding re-checked against the code.
`pnpm audit` and a credential scan of the tracked files and the git history were run.

Threat model: customers paste read-only StatSig keys and writer LaunchDarkly tokens into a
static SPA and point it at production LaunchDarkly projects. Attackers are (a) anyone who can
influence a StatSig project's content or an uploaded file, (b) anything else running on the
app's web origin, and (c) the operator's own mistakes.

## Status (same day)

Fixed in the working tree on 2026-11-09, each with tests: **H1** (shared Pages origin: new
workspaces, the demo included, keep tokens in memory only on `*.github.io`, the start screen and
the keys card say why, `DEMO.md` marks the Pages URL demo-only; the hosting itself is still a
deployment decision), **H2** (project reset plans only resources carrying the console's
provenance and counts the rest as kept; context kinds are recognised by the marker the executor
writes), **H3** (planner raises a blocking `ld_drift_on_sync` decision when a flag environment's
`lastModified` moved after `syncedAt`; the executor refuses to write, and undo refuses to
restore, over such an edit; `ldChange` moved from monitoring into the planner), **M1** (Add
Source lists projects on a click, to the instance chosen at that moment, with the EU/Federal
disclaimer shown), **M2** (`sdk_keys_to_app_ids` and its hashed variant are deleted at parse time
and refused by the store), **M3** (zod 4.6.7, `pnpm audit --prod` clean), **M7** (`csvCell`
prefixes a leading formula trigger with an apostrophe in all three CSV exports).

Still open: M4, M5, M6, M8, M9, M10, every Low and every Info item.

## Summary

The core design holds: tokens go only to the StatSig and LaunchDarkly API hosts in headers,
never in URLs, logs, exports or React-rendered text; the vault is AES-GCM-256 with a fresh IV
per write and PBKDF2-SHA-256 at 600 000 iterations; the production CSP is strict and tested;
there is no HTML injection sink anywhere in the UI; writes to StatSig do not exist.

The risks that matter for a customer launch are not in the crypto. They are: the hosting origin
(one GitHub Pages origin shared with four unrelated sites), one button that wipes an entire
LaunchDarkly project, silent overwriting of edits made in LaunchDarkly, and a handful of
input-handling and export-hygiene gaps.

| Severity | Count |
| --- | --- |
| High | 3 |
| Medium | 10 |
| Low | 9 |
| Info | 8 |

## High

### H1. Customer tokens live on a GitHub Pages origin shared with four other sites

`DEMO.md:14` sends users to `https://briannorman-ld.github.io/ld-migration-console/`, and
`.github/workflows/pages.yml` deploys there. On GitHub Pages every project site of one account
shares the origin `briannorman-ld.github.io`. The GitHub API lists five Pages sites under that
account today (`flagship-store`, `ld-migration-console`, `ld-traffic-simulator`, `react_qr_app`,
`time-tracking-demo`). The browser's same-origin policy therefore gives every one of those sites,
and any future one, full access to this app's IndexedDB (`statsig-ld-migrator`), including the
`vaults` table with the encrypted token blobs **and** the non-extractable device key. A
non-extractable key cannot be exported, but same-origin script can call `decrypt` with it, so
one script injection in any sibling site reads every customer token this app has stored. Those
sites also carry no CSP, and GitHub Pages cannot send response headers, so `frame-ancestors`,
COOP and `nosniff` from `vercel.json` do not apply there (the JS frame check in `main.tsx` is
the only clickjacking guard).

Fix: host customer-facing builds only on an origin this app has to itself (the Vercel deployment
with `vercel.json` headers, or a dedicated custom domain for Pages). Until then, say in the
README that the Pages URL is for demos and that tokens should be kept in memory only there.

### H2. "Reset LaunchDarkly project" deletes everything in the project, not what the tool wrote

`apps/web/src/lib/reset.ts:150-170` plans the deletion of every flag, segment and metric in the
project, stops running experiments by declaring the first treatment the winner and archives
them, and archives every custom context kind. Only environments are filtered by provenance
(`:173-182`). The danger zone is shown for every connected workspace, not only demo ones
(`apps/web/src/screens/LdPanel.tsx:137`). The copy is honest ("delete every flag, segment and
metric"), a preview is shown, and three typed confirmations gate it, so this is a deliberate
feature. But the demo callout four lines above it promises that "Reset demo only ever removes
those [tagged]" (`LdPanel.tsx:131-134`), PLAN §19.3 says the same, and LaunchDarkly has no undo
for a deleted flag. A customer who tries the tool against a production project and reaches for
"clean up what the tool wrote" loses the project.

Fix: scope the plan to resources carrying this console's provenance (`hasMigratedTag`,
`readFlagProvenance`), or hide the button outside `isDemo` workspaces. Add a test that a flag
without our tag never appears in `plan.flags` (`reset.test.ts` only covers environments).

### H3. Edits made in LaunchDarkly are silently overwritten on the next run

`packages/executor/src/executor.ts:1007` replaces a flag's whole targeting (rules, targets,
fallthrough, off variation, prerequisites) and `:811-823` replaces segment rules and lists
wholesale. The only skip is "already identical" (`:997`). Nothing compares the environment's
`version` or `lastModified` with the `syncedAt` recorded in provenance, so a change a customer
made by hand in LaunchDarkly after the first run is reverted on the second with no warning.
Monitoring computes `ld_changed` (`packages/monitoring/src/status.ts:28-36`) but neither the
planner nor the Migrate modal reads it; the pre-write re-read in `MigrateModal.tsx:251-275`
compares only step and decision counts. PLAN §8.3 `ld_drift_on_sync` ("show the three-way
diff, keep LD") is not implemented. Undo has the same gap: `executor.ts:1225-1260` restores a
pre-image without checking that the environment is still what the run left.

Fix: feed `ldChange()` into the planner per (flag, env) and raise a blocking `ld_drift_on_sync`
decision when LD moved since `syncedAt`; refuse undo on the same condition.

## Medium

### M1. A LaunchDarkly token is sent on every keystroke, to whichever instance is selected

`apps/web/src/screens/AddSource.tsx:46-74`: once the field holds eight characters, an effect
builds an `LdClient` against the currently selected instance and lists projects after 400 ms.
Every partial paste or edit sends a token-shaped prefix as an `Authorization` header, and
changing the instance dropdown re-sends the full token to the other instance (commercial, EU,
Federal) with no click. `LdPanel.tsx` sends only on Connect and gates EU/Federal behind an
acknowledgement; this screen has neither.

Fix: list on an explicit button (or on paste/blur), read the instance at click time, reuse the
acknowledgement gate.

### M2. Uploaded config specs are stored in clear and can contain StatSig client SDK keys

`apps/web/src/lib/sync.ts:173-182` saves the whole parsed spec via `store.saveSpecUpload`,
which skips `assertNoSecrets` (`packages/store/src/store.ts:344-354`), and the secret-key regex
would not match `sdk_keys_to_app_ids` anyway. DCS v2 specs carry that field with plaintext
client keys (see `reference/statsig/dcs-fixtures/v2/dcs_target_app_filtering.json`). Those keys
sit unencrypted in IndexedDB next to the vault.

Fix: delete `sdk_keys_to_app_ids` and `hashed_sdk_keys_to_app_ids` in `parseSpecBytes` before
the spec leaves the worker, and extend `assertNoSecrets` and apply it in `saveSpecUpload`.

### M3. Zod below 4.6.6 (GHSA-mrhx-c7xc-m5w5), the only production dependency advisory

`pnpm audit --prod` reports zod `<4.6.6` can exhaust memory while validating oversized
constrained collections. This app validates untrusted StatSig and LD responses and uploaded
specs with zod. The range `^4.6.5` already allows the fix; a lockfile update is all it takes.
The remaining 12 advisories are dev-only (`jsdom>undici`, `ajv>fast-uri`) and do not ship.

### M4. Prototype members leak through the spec condition lookup tables

`packages/adapters/src/spec/conditions.ts:71,81,116` index plain-object tables with the
condition's `field` or `type` and test truthiness. `constructor`, `toString` or `__proto__`
return a Function or `Object.prototype`, which then sits in the snapshot. A Function value fails
structured clone when the worker posts the snapshot, so one such condition fails the entire
upload with a generic error. A legitimate custom field named `constructor` breaks the same way.
`packages/mapper/src/conditions.ts:279` and `profile.ts:32` have the same pattern.

Fix: `Object.hasOwn` guards, or `Map` / `Object.create(null)` tables. Add tests with
`field: "constructor"` and `type: "__proto__"`.

### M5. Schema mismatch returns the raw body cast to the schema type; normalizers then crash

`packages/statsig-client/src/client.ts:217-228` and `packages/ld-client/src/client.ts:531-536,
566-570` log the issue and return the unvalidated body. Consumers are not defensive:
`adapters/src/console/normalize.ts:137,148,212,251,272,311` map over arrays that may be missing,
`adapters/src/launchdarkly/normalize.ts:43,61,62,118,137,159` likewise. One malformed item
kills the whole crawl after the rate budget is spent, and the user sees "failed", not the schema
issue. On the LD side the `TokenSchema` transform that drops `token` is also skipped on mismatch
(SDK keys are still stripped by `stripSdkKeys` before validation).

Fix: in `list()`, drop invalid items with a `SchemaIssue`; in `get()`, throw a typed error the
crawl's `optional()` turns into a skipped entry; or give the array fields `.catch([])`.

### M6. `assertNoSecrets` walks data-derived keys, so a unit type named `apiKey` blocks saving

`packages/store/src/store.ts:27-53` refuses any object key matching the secret regex, and is
applied to the mapping profile (`unitTypeKinds[<StatSig unit type>]`, `envMapping[<env name>]`)
and monitor state (`statuses[<env>][<LD flag key>]`). A StatSig project keyed by a custom unit
type `apiKey`, or an LD flag with key `secret`, makes the profile or monitoring unsaveable for
that workspace.

Fix: assert only on app-shaped paths, or store data-keyed maps as `{name, value}` arrays.

### M7. CSV exports do not neutralise spreadsheet formulas

`apps/web/src/lib/migration.ts:921`, `apps/web/src/lib/runErrors.ts:57` and
`packages/monitoring/src/reports.ts:4` only double quotes. StatSig ids, names and LD error text
flow into cells. A gate named `=HYPERLINK(...)` or a DDE payload executes when the CSV is
opened in Excel or Sheets. The UI advertises these files "for a spreadsheet".

Fix: prefix cells that start with `=`, `+`, `-`, `@`, tab or CR with `'` before quoting.

### M8. `ensure_context_kind` is a blind PUT; undo archives a kind that pre-existed

`executor.ts:755` upserts without a read; the planner adds the step whenever the key is missing
from the cached listing (`plan.ts:329`); `rec.created = true` is set unconditionally (`:766`), so
undo (`:1134`) archives it. A stale cache overwrites a customer's context kind name and
description and an undo hides it from targeting.

Fix: GET first; set `created` only when absent; fail or adopt via a decision otherwise.

### M9. After a 409, a resource created by an earlier run is treated as created by this one

`executor.ts:574-581`: on conflict, "ours" (by provenance id or tag pair) sets `rec.created =
true`. The usual cause of a 409 is a previous run or a concurrent tab having created it. Undoing
this run then deletes (`:1267-1274`) a flag other runs migrated to other environments.

Fix: compare the resource's `creationDate` with `run.startedAt`; older means adopt, not create.

### M10. Journal is coalesced to one write per two seconds; resume can orphan scheduled changes

`apps/web/src/lib/journal.ts:13-45` batches writes (the header of `executor.ts` still claims
per-step journaling). `createScheduledChange` (`executor.ts:1049`) is journaled after the call,
so a crash in the window leaves a scheduled change the next sync does not know to delete, and
`ignoreConflicts: true` lets duplicates coexist. Pre-images can be lost the same way, and on
resume the "pre-image" re-read is our own targeting.

Fix: flush synchronously around non-idempotent calls, or reconcile via `listScheduledChanges`
on resume.

## Low

- **L1. Single-click invite of a StatSig-controlled email, role up to admin.**
  `GuideView.tsx:610` invites `entity.owner.email` (from StatSig) with no confirmation; the role
  selector includes `admin`. "Invite all" is properly gated with a list and typed `invite`.
  Fix: confirm address and role for the single invite too; default `reader`.
- **L2. "Undo this run" in the Migrate modal is one click.** `MigrateModal.tsx:627` calls
  undo directly; `RunsView.tsx:166-200` has the two-step confirm it should reuse.
- **L3. OS notification body is attacker-chosen text under a trusted title.**
  `monitor.ts:220` puts `describeAlert(row)`, which starts with the StatSig id, into a
  notification titled "LaunchDarkly migration". Opt-in and capped at five per tick, but the id
  is unbounded. Fix: lead with a fixed verb, quote and truncate the id, strip newlines and URLs.
- **L4. Adopted big segments: membership replaced irrecoverably while the decision text
  promises undo.** `executor.ts:867` imports with `mode: 'replace'`; undo restores only
  description and tags. `plan.ts:301-304` says "the current state is saved first".
- **L5. ID-list and hash uploads have no size cap or `accept`, and parse on the main thread.**
  `WarningsView.tsx:298,324,458`. A mis-picked multi-hundred-MB file freezes the tab; hash lines
  are not validated (StatSig hashes are exactly eight base64 characters).
- **L6. Spec cap of 256 MiB is far above what the worker can parse, and a worker crash hangs
  the UI.** `parse.ts:38`; `apps/web/src/pipeline/client.ts` has no `onerror`, so pending
  promises never settle. Decompression itself is correctly bounded.
- **L7. A StatSig key entered for a config-spec source is never forgotten on removal.**
  `WarningsView.tsx:249` stores it under `statsig:<id>`; `kinds.ts:27` returns `null` for
  `config_spec`, so `WorkspaceScreen.tsx:230-232` skips it. Stays encrypted in the vault.
- **L8. `baseUrl` / `ld.baseUrl` on a source record decides where a token is sent; nothing
  validates it.** `canonical/src/model.ts:33,40`, consumed at `sync.ts:61,103,126`,
  `migration.ts:489`. Today only the app sets it (constants or same-origin demo paths) and there
  is no import feature, so CSP is the only backstop. Add an https plus host allowlist in both
  client constructors and `store.addSource` before any import or GrowthBook self-host work.
- **L9. Length limits enforced only for tags.** Names, descriptions with footer, custom
  property values and team keys are unbounded; a 400 mid-run leaves a partial run (resumable).

## Info

- **I1. No workspace export/import exists**, although PLAN §3.3 and CLAUDE.md describe an
  encrypted `.sslm` file. Less surface today; the latent items above (L8, baseUrl) become real
  the day it lands.
- **I2. PLAN §3.4 claims Subresource Integrity; the build has none** (`dist/index.html` has no
  `integrity` attribute). All assets are same-origin so SRI adds little, but a customer's security
  team reading the plan will notice. Either add `vite-plugin-sri` or drop the claim.
- **I3. Source maps ship with the build** (31 `.map` files, `vite.config.ts` `sourcemap: true`).
  Fine for an open-source tool; say so, or set `sourcemap: 'hidden'`.
- **I4. Provenance written into LD includes the owner email and a StatSig permalink carrying the
  company id** (`mapper/src/gate.ts:593-594`); PLAN §3.3 lists neither. Make them opt-in or
  document them. No salt, hashed id, token or baseUrl reaches LD.
- **I5. `api.statsigcdn.com` is in the CSP but nothing fetches it.** Remove until the in-browser
  spec fetch exists. When it does, note that StatSig puts the client key in the URL **path**
  (`download_config_specs/<key>.json`), which `redactUrl`, transport events and
  `SyncActivity.shortPath` would all expose. Mask that segment first.
- **I6. The LD source token is handed to a full `LdClient`**; read-only is a TypeScript
  narrowing (`adapters/src/launchdarkly/read.ts:11`), not a runtime guard.
- **I7. GitHub Actions are pinned to tags (`@v4`), not SHAs, and there is no Dependabot
  config.** Low supply-chain hygiene for a tool that handles customer credentials.
- **I8. The demo MSW service worker ships in production** (`public/mockServiceWorker.js`) and
  is registered at the app root. It is same-origin, passes unhandled requests through, and
  `stopStaleDemoMock` unregisters it outside the demo. Acceptable; worth knowing it intercepts
  every fetch while registered.

## Verified safe

- Tokens are sent only as `STATSIG-API-KEY` and `Authorization` headers to https constants;
  query strings carry paging and filters only; every path segment is `encodeURIComponent`-ed.
- Token inputs are `type="password"` with `autoComplete` off; no token is ever rendered,
  logged, placed in the URL hash, localStorage, sessionStorage, run journal, monitor state,
  exports or worker-to-main messages. `stripSdkKeys` scrubs `apiKey` / `mobileKey` from every
  LD body before validation and storage.
- Vault: AES-GCM-256, 12-byte random IV per write, 16-byte random salt, PBKDF2-SHA-256 at
  600 000 iterations, NFKC-normalised passphrase, non-extractable keys, plaintext parsed only
  after authentication and filtered to strings.
- Production CSP: `default-src 'none'`, `script-src 'self'`, no `unsafe-inline` or
  `unsafe-eval`, `connect-src` limited to five API hosts, `object-src`, `base-uri` and
  `form-action` none; `csp.test.ts` keeps `vercel.json` and the meta tag in step; verified in
  `dist/index.html`.
- No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, dynamic `RegExp`, string
  timers, markdown rendering or `window.open`. All ten `target="_blank"` links have
  `rel="noreferrer"`. Every href is a constant or begins with an LD https origin; no StatSig
  field is ever used as a URL.
- Hash router accepts only `[A-Za-z0-9._-]+`; storage values are validated on read.
- One-way: the StatSig client issues GET only; monitoring imports no transport.
- Dry run writes nothing (LD `dryRun=true` for patches, early return for creates); approvals
  are never bypassed; typed confirmation for production environments; project reset refuses
  unless plan, session and saved workspace agree on the project key and LD echoes it back.
- Spec intake: 256 MiB pre-check, decompressed size bounded chunk by chunk, protobuf and
  initialize-response files rejected, parsing in a Web Worker with transferred bytes.
- No credentials in tracked files or in git history; `.env*` is ignored and only
  `.env.example` was ever committed.

## Not confirmed

- Whether a `customProperties` PATCH bumps the LD environment `version` (affects the H3 fix).
- LD's hard limits on name, description and custom-property length (L9).
- Live behaviour of approvals, scheduled changes, big-segment import and member invites: per
  the project notes none has been exercised against a real LaunchDarkly account.
- Whether any live StatSig response actually fails the lenient schemas (M5 is a code-path
  finding).

## Suggested order

1. H1: move the customer-facing URL off the shared Pages origin, or label it demo-only.
2. H2: scope or hide project reset. H3: block on LD drift before writing and before undo.
3. M3 (zod bump), M1 (explicit list button), M2 (strip SDK keys from stored specs), M7 (CSV).
4. M4, M5, M6: input robustness in the adapters and store.
5. M8, M9, M10, L1, L2, L4: executor and UI safety around undo, conflicts and invites.
6. The rest as hygiene.
