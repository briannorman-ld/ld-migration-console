import type { CoverageStatus } from '@sslm/coverage';
import type { Tone } from '../components/ui.tsx';

/** Badge tone per coverage status. Its own module so the eager entity list does not pull in the coverage view. */
export const COVERAGE_TONE: Record<CoverageStatus, Tone> = {
  migrates: 'green',
  decisions: 'blue',
  guided: 'violet',
  planned: 'amber',
  none: 'red',
};
