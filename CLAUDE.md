# LaunchDarkly Migration Console (StatSig source today)

`PLAN.md` is the spec: read the sections relevant to your task before changing anything. Research inputs (API specs, real StatSig config-spec fixtures, prior-art repos) are in `reference/`; see `reference/README.md`.

## Constraints that must not change without asking the user
- **Browser-only.** A static Vite SPA with no backend, no accounts and no server-side storage. State lives in IndexedDB plus provenance written into the user's own LD project (PLAN §3.3). The only allowed server piece is a stateless StatSig relay, and only if M0 spike #1 shows StatSig blocks browsers.
- **One-way:** StatSig → LD only. Never write to StatSig.
- **Mirror StatSig, but sync only when the user triggers it.** Monitoring is read-only.
- **Migration is scoped per environment.** State is per (resource, LD environment).
- **Every imperfect mapping becomes a Decision** (PLAN §8). Never silently drop or approximate a condition.
- Two StatSig source types feed one canonical model: the Console API (read-only key) and an uploaded config spec (DCS v1/v2). A third source kind, another LaunchDarkly project (PLAN §20), fills the snapshot's provider-neutral block (`packages/canonical/src/neutral.ts`) read by `packages/adapters/src/launchdarkly` and mapped by `packages/mapper/src/neutral.ts`; new sources go onto the neutral model, not onto StatSig's vocabulary.
- Experiments end in StatSig and launch new in LD; nothing is moved mid-flight.
- A workspace is 1 LD project plus N StatSig sources (consolidation). Keep N-source support in the data model.
- Tokens are never logged, persisted unencrypted, or put in workspace files. By default they are kept on the device AES-GCM encrypted under a non-extractable WebCrypto key (PLAN §3.4); a passphrase vault or memory-only is the user's choice per workspace. CSP `connect-src` is limited to the StatSig and LD API hosts.

## Engineering conventions
- TypeScript everywhere. Domain logic goes in framework-free `packages/*`, so it runs in Web Workers and in Vitest.
- The mapper is **pure and deterministic**: `map(canonical, profile, resolutions, capabilities, env) → {desired, fidelity, unresolved}`. Test it with golden files.
- Validate every external API response with lenient Zod schemas (unknown fields allowed), because neither prior tool was tested against real StatSig responses. Log schema mismatches; don't crash.
- Use field names from `reference/statsig/console-api-openapi-20240601.json` and `reference/launchdarkly/openapi.json`, not from memory.
- Known mapping pitfalls (PLAN §10.3):
  - `version_gte` → `semVerLessThan` + negate.
  - `any` is case-insensitive in StatSig, so it needs a decision.
  - `environment_tier` is resolved statically per environment.
  - Custom unit IDs map to their own context kind, or to an attribute of the `user` context if the user chooses so; never to the `user` context's key.
- The demo (PLAN §19) uses MSW in front of the real adapters. Its dataset in `packages/demo-fixtures` is also the main test fixture.
- `packages/coverage/src/matrix.ts` is the **coverage matrix**: every StatSig construct, its LD target and how completely the console migrates it. It drives the in-app "What migrates" page and the generated block in `docs/LIMITATIONS.md` (`pnpm coverage:generate`; a test fails when the doc is stale). When a resource kind starts migrating, or a limitation is found, update the matrix row first. `docs/LIMITATIONS.md` also holds the hand-written narrative for the blog post.
- `docs/KNOWN-EDGE-CASES.md` is the running list of places where StatSig and LD differ. When you find a new one: add a row there, a demo example in `packages/demo-fixtures/src/acme/`, and a test in `packages/mapper/test/mapper.test.ts` (the golden files then cover it). Rows marked as gaps are the mapper backlog. LD-source differences go in its §18, with the demo example in `packages/demo-fixtures/src/ld/acme-legacy.ts` and the test in `packages/mapper/test/neutral.test.ts`.
