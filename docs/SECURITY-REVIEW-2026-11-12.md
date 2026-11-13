# Security review, 2026-11-12 (PostHog source and console flags)

Scope: the changes since the 2026-11-09 review's last fix commit (`3b9a56e`) up to `e3cee5a` on
main: the PostHog source (adapter, mapper, planner, demo, UI), the console's own LaunchDarkly
flags (`apps/web/src/lib/flags.ts`), the CSP additions and the dependency set. Method: a read of
every non-reference file in the diff that touches tokens, network, parsing, storage, rendering or
hosting; `pnpm audit` and `pnpm outdated`; a credential scan of the new commits; a check of the
JSON parser against prototype-polluting input. The threat model is that of the 2026-11-09 review.

## Status

No High or Medium finding. All four Low items were fixed the same day, with tests: **L1**
(lockfile bump, `pnpm audit` clean), **L2** (`sdkOptions` in `flags.ts` sets `fetchGoals: false`
next to `diagnosticOptOut`), **L3** (Add Source forgets the key, the listings and the chosen file
when a tile of another provider is picked; the two PostHog inputs share theirs), **L4**
(`demoBaseUrl` in `apps/web/src/lib/sourceOrigin.ts`: a stored `baseUrl` is used only on a demo
source and only when same-origin; `sync.ts` and `migration.ts` apply it to the StatSig,
LaunchDarkly and PostHog clients, so a real source always reads its production API host).

| Severity | Count |
| --- | --- |
| High | 0 |
| Medium | 0 |
| Low | 4 |
| Info | 9 |

## Low

### L1. Dev-only dependency advisories (fixed)

`pnpm audit` reported 12 advisories, none reachable from the shipped bundle (`pnpm audit --prod`
was clean before and after):

| Package | Installed | Via | Advisories |
| --- | --- | --- | --- |
| undici | 8.11.2 | jsdom 30.1.2 (vitest) | 4 high, 4 moderate (TLS validation bypass, cache poisoning, several DoS) |
| fast-uri | 3.1.8 | ajv 8 (tests) | 2 moderate, 2 low (scheme spoofing, host confusion) |

Both ranges already admitted the patched versions, so the fix is a lockfile bump:
`pnpm update undici fast-uri` → undici 8.12.4, fast-uri 3.1.9. `pnpm audit` is now clean for dev
and prod.

### L2. The console-flags SDK fetches experimentation goals on every load (fixed)

`flags.ts` initialises `launchdarkly-js-client-sdk` 3.9.6 with an anonymous context and
`diagnosticOptOut: true`, but leaves `fetchGoals` at its default (`true`). Each page load then
requests the project's click and pageview goals, and if one were ever defined in the
`statsig-migration` project the SDK would start sending the console's page URL (workspace id and
route) to `events.launchdarkly.com`. The console runs no experiments on itself.
Fix: `fetchGoals: false`. If flag-evaluation events are not wanted either, `sendEvents: false`
lets `events.launchdarkly.com` leave `connect-src`.

### L3. One key field is shared by the three API source tiles (fixed)

`AddSource.tsx` keeps one `key` state for the StatSig, LaunchDarkly and PostHog tiles, and
switching tiles does not clear it. A key pasted for one provider can be sent to another with the
next "List projects" click. The send is user-initiated, only to a CSP-allowed API host, and the
receiving API rejects it, but a read key still leaves its intended service.
Fix: clear `key`, both listings and the chosen project when `kind` changes.

### L4. A persisted source's `baseUrl` redirects where its key is sent (fixed)

`SourceDescriptor.baseUrl` (StatSig), `ld.baseUrl` and now `posthog.baseUrl` override the API
origin; `sync.ts` honours them for any source, demo or not. Only the demo writes them (same-origin
`/__demo/...`), there is no workspace import path, and `connect-src` bounds the destination to the
listed API hosts, so exploiting it needs write access to this origin's IndexedDB, which is already
the shared-Pages-origin concern (H1 of the previous review). Pre-existing pattern, extended to
PostHog.
Fix: honour `baseUrl` only when `isDemo` is set and the URL is same-origin; otherwise use the
region or instance.

## Info

### I1. PostHog key handling follows the existing pattern

Password input with `autoComplete="off"`; the key is sent once, on a click, to the region chosen
at that moment, as `Authorization: Bearer`; the client holds it in a private field; it lives in the
in-memory vault as kind `ph_source` and is persisted only inside the AES-GCM blob; the device-vault
card and the unlock summary list it. Transport events carry no headers or bodies; `HttpError`
messages pass through `redactUrl`; `PostHogAuthError` names status and path only. No `console.*`
call was added anywhere in the diff.

### I2. Loose PostHog schemas pass unknown fields through in memory, none reach storage

Responses are validated with zod 4.6.7 `looseObject`, so `/api/projects/{id}/` keeps its
`api_token` (the public ingestion token) and, on current PostHog, `secret_api_token`. The
normalizer reads only `project.name` and never copies a raw PostHog object into the canonical
snapshot; person `properties` are dropped and only `distinct_ids` persist. Checked that zod's
loose parse of `{"__proto__": …, "constructor": …}` neither keeps those keys nor pollutes a
prototype.

### I3. PII that does persist

Organization members (email, name) and flag creators' emails are kept for owner matching, as
they are for StatSig and LaunchDarkly sources, in the unencrypted snapshot (PLAN §3.3).

### I4. CSP additions

`connect-src` gained `us.posthog.com`, `eu.posthog.com`, `clientsdk.launchdarkly.com`,
`clientstream.launchdarkly.com` and `events.launchdarkly.com`; the `<meta>` tag and `vercel.json`
are generated from one list and kept equal by `csp.test.ts`. No inline or third-party script. The
events host is the one new outbound data path (anonymous flag evaluations, see L2).

### I5. The flag cache is trusted as bootstrap

`localStorage["console-flags"]` seeds the SDK; on a shared origin a sibling site could flip
`posthog-source`. It gates UI visibility and the sync entry points only; nothing
security-sensitive sits behind it.

### I6. Payload upload

A 50 MB cap is checked before `JSON.parse`; client `/flags` and `/decide` responses are recognised
and refused with a pointer to the right route; a payload with some bad entries keeps the flags
that parse and reports the rest. Parsing runs on the main thread, as the StatSig spec upload does.

### I7. No new LaunchDarkly write path

PostHog scheduled changes feed the existing scheduled-change step (journaled before the write,
M10). The executor diff is dry-run wording only.

### I8. Repository hygiene

No token-like string in the new commits: the demo keys are `phx_DEMO-acme-hog-not-a-real-key`
and `phc_demo-staging-not-real`. `.env*` is ignored except `.env.example`, whose values are empty.

### I9. Toolchain and dependency versions

| Component | Installed | Latest | Note |
| --- | --- | --- | --- |
| Node | 22.22.3 | | engine `>=22.13` |
| pnpm | 11.25.0 | | |
| TypeScript | 7.0.2 | | |
| Vite | 8.3.3 | 8.3.8 | patch bumps available, no advisory |
| Vitest | 5.0.3 | 5.1.0 | |
| React / react-dom | 19.3.0 | 19.3.1 | |
| zod | 4.6.7 | | M3 of the previous review |
| launchdarkly-js-client-sdk | 3.9.6 | 3.9.6 | new |
| msw | 3.0.2 | 3.0.5 | |
| dexie | 4.4.6 | 4.4.7 | |
| jsdom (dev) | 30.1.2 | 31.0.0 | major; not needed for L1 |

The Low and Info items of the 2026-11-09 review that were open then are still open.
