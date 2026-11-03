/**
 * The mapper (M3): pure and deterministic (CLAUDE.md, PLAN §8.1).
 *
 *   map(canonical, profile, resolutions, capabilities, env) → { desired, fidelity, unresolved }
 *
 * `mapGate`, `mapConfig`, `mapSegment` and `mapAutotune` take those inputs as one object (plus `now`, because StatSig `time`
 * conditions compare the current time). Golden tests use packages/demo-fixtures.
 */
export * from './types.ts';
export * from './profile.ts';
export * from './decisions.ts';
export { caseFoldedPattern, toTimestamp, LIST_SEGMENT_MAX, readableName } from './conditions.ts';
export { mapGate, SOURCE_KIND, TAG_MIGRATED, sourceTag, PASS, FAIL, chooseClientSideAvailability, provenanceProperties, type GateMapResult, type MapArgs, type MapOutcome } from './gate.ts';
export { mapConfig, DEFAULT as CONFIG_DEFAULT, type ConfigMapResult, placeholderVariationValue, UNUSED_VARIATION } from './config.ts';
export { mapSegment, type SegmentMapResult } from './segment.ts';
export { estimateEnvBytes, estimateShellBytes, envBudget, migratedEnvCount, FLAG_SIZE_LIMIT, FLAG_SIZE_BUDGET, type FlagEnvState } from './size.ts';
export { mapAutotune, percent as banditPercent, BANDIT_REALLOCATION_MS, type AutotuneMapResult, type AutotuneState } from './autotune.ts';
export { mapNeutralFlag, mapNeutralSegment, resolveSourceKind, LD_OPERATORS, type NeutralFlagMapResult, type NeutralSegmentMapResult } from './neutral.ts';
export { mapPrompt, type PromptMapResult } from './prompt.ts';
export { chooseMaintainer, memberIdForEmail, memberOption, teamKeyFor, teamKeyForName, teamOption, type MaintainerAssignment } from './maintainer.ts';
