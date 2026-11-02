/** LaunchDarkly instances the app can connect to (PLAN §3.1, §3.5). */
export type LdInstanceId = 'us' | 'eu' | 'federal';

export interface LdInstance {
  id: LdInstanceId;
  label: string;
  /** Origin of the REST API; paths are under /api/v2. Must match CSP connect-src. */
  origin: string;
  /** Acknowledgement text shown before connecting (PLAN §3.5); stored in the workspace. */
  disclaimer?: { title: string; body: string[] };
}

export const LD_INSTANCES: Record<LdInstanceId, LdInstance> = {
  us: { id: 'us', label: 'LaunchDarkly (commercial, US)', origin: 'https://app.launchdarkly.com' },
  eu: {
    id: 'eu',
    label: 'LaunchDarkly EU',
    origin: 'https://app.eu.launchdarkly.com',
    disclaimer: {
      title: 'EU instance',
      body: [
        'The static app is served from a US CDN.',
        'Your configuration data is processed only in your browser and sent only to StatSig and your LaunchDarkly instance.',
      ],
    },
  },
  federal: {
    id: 'federal',
    label: 'LaunchDarkly Federal',
    origin: 'https://app.launchdarkly.us',
    disclaimer: {
      title: 'Federal instance',
      body: [
        'This tool is not FedRAMP-authorized. Confirm that connecting it to your Federal instance is permitted.',
        'Warehouse-native experimentation is unavailable on Federal.',
      ],
    },
  },
};

export const LD_API_VERSION = '20240415';
