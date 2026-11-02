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
export { caseFoldedPattern, toTimestamp, LIST_SEGMENT_MAX } from './conditions.ts';
export { mapGate, SOURCE_KIND, TAG_MIGRATED, sourceTag, PASS, FAIL, chooseClientSideAvailability, provenanceProperties, type GateMapResult, type MapArgs, type MapOutcome } from './gate.ts';
export { mapConfig, DEFAULT as CONFIG_DEFAULT, type ConfigMapResult } from './config.ts';
export { mapSegment, type SegmentMapResult } from './segment.ts';
export { mapAutotune, percent as banditPercent, BANDIT_REALLOCATION_MS, type AutotuneMapResult, type AutotuneState } from './autotune.ts';
export { mapNeutralFlag, mapNeutralSegment, resolveSourceKind, LD_OPERATORS, type NeutralFlagMapResult, type NeutralSegmentMapResult } from './neutral.ts';
