export * from './types.ts';
export { AREAS, COVERAGE, countByStatus } from './matrix.ts';
export { BLOCK_END, BLOCK_START, renderCoverageMarkdown, spliceCoverageBlock, STATUS_DESCRIPTION, STATUS_LABEL, STATUS_MARK } from './markdown.ts';
export { coverageFor, guidanceFor, summarizeInventory, type InventorySummary, type ItemGuidance } from './guidance.ts';
export { EXPLAINER_KEYS, explainMapping, type ExplainerKey, type MappingExplanation } from './explainer.ts';
