/**
 * The planner (M3): dependency closure (segments, context kinds, prerequisite gates),
 * topological ordering with cycle detection (PLAN §10.4), and per-(item, env) operations.
 */
export * from './plan.ts';
export * from './drift.ts';
