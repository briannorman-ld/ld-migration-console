import type { ConditionSeed } from '../console/builders.ts';
import { PEOPLE as P } from './people.ts';
import type { ProjectSeed } from './seed-types.ts';

const STAFF_EMAIL: ConditionSeed = { type: 'email', operator: 'str_contains_any', targetValue: ['@acmeretail.example'] };

/**
 * `acme-mobile`: the iOS/Android apps' StatSig project, on Warehouse Native. Overlaps with
 * `acme-web` on purpose to demo consolidation (PLAN §12, §19.2).
 */
export function acmeMobile(): ProjectSeed {
  return {
    alias: 'mobile',
    projectName: 'acme-mobile',
    companyName: 'Acme Retail',
    isWarehouseNative: true,
    environments: [
      { name: 'development', isProduction: false },
      { name: 'staging', isProduction: false },
      { name: 'production', isProduction: true },
    ],
    unitTypes: [
      { name: 'userID', description: 'Logged-in customer ID' },
      { name: 'stableID', description: 'Install-stable anonymous ID' },
      { name: 'companyID', description: 'B2B account ID' },
      { name: 'deviceID', description: 'Hardware device ID' },
    ],
    tags: [
      { name: 'mobile', description: 'Mobile apps' },
      { name: 'checkout', description: 'Checkout team' },
      { name: 'platform', description: 'Platform / infra' },
    ],
    targetApps: ['acme-ios', 'acme-android'],
    teams: ['Mobile', 'Platform'],
    teamMembers: { Mobile: [P.dana, P.sam], Platform: [P.alice] },
    reviews: { configReviewRequired: false },
    defaultUnitType: 'deviceID',
    users: [
      { ...P.dana, role: 'Admin' },
      { ...P.sam, role: 'Member' },
      { ...P.alice, role: 'Member' },
    ],
    gates: [
      // --- Shared with acme-web: identical (auto-merge) -------------------------------------
      {
        id: 'employees_only',
        description: 'Anyone with an Acme email address.',
        owner: P.alice,
        tags: ['platform'],
        type: 'PERMANENT',
        rules: [{ name: 'Acme staff', conditions: [STAFF_EMAIL] }],
      },
      {
        id: 'maintenance_mode',
        description: 'Show the maintenance screen.',
        owner: P.sam,
        tags: ['platform'],
        type: 'PERMANENT',
        rules: [{ name: 'Internal IPs', conditions: [{ type: 'ip_address', operator: 'any', targetValue: ['10.0.0.1', '10.0.0.2'] }] }],
      },
      {
        id: 'kill_switch_payments',
        description: 'Emergency kill switch for the payments provider integration.',
        owner: P.sam,
        tags: ['platform'],
        type: 'PERMANENT',
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
      },
      // --- Shared with acme-web: different (prefix decision) --------------------------------
      {
        id: 'new_checkout_flow',
        description: 'Native one-page checkout on app 5.2+.',
        owner: P.dana,
        tags: ['checkout', 'mobile'],
        rules: [
          { name: 'Staff', conditions: [STAFF_EMAIL] },
          { name: 'App 5.2+ (50%)', passPercentage: 50, conditions: [{ type: 'app_version', operator: 'version_gte', targetValue: '5.2.0' }] },
        ],
      },
      {
        id: 'dark_mode',
        description: 'Dark mode follows the OS on iOS 13+ and Android 10+.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [
          { name: 'iOS 13+', conditions: [{ type: 'os_name', operator: 'any', targetValue: ['iOS'] }, { type: 'os_version', operator: 'version_gte', targetValue: '13.0' }] },
          { name: 'Android 10+', conditions: [{ type: 'os_name', operator: 'any', targetValue: ['Android'] }, { type: 'os_version', operator: 'version_gte', targetValue: '10' }] },
        ],
      },
      {
        id: 'search_v2',
        description: 'New search backend, all mobile users.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
      },
      // --- Mobile-only: app version operators ------------------------------------------------
      {
        id: 'ios_rating_prompt',
        description: 'Ask for an App Store rating on recent iOS builds.',
        owner: P.dana,
        tags: ['mobile'],
        targetApps: ['acme-ios'],
        rules: [
          {
            name: 'iOS 5.x',
            conditions: [
              { type: 'os_name', operator: 'any', targetValue: ['iOS'] },
              { type: 'app_version', operator: 'version_gt', targetValue: '5.0.0' },
              { type: 'app_version', operator: 'version_lt', targetValue: '6.0.0' },
            ],
          },
        ],
      },
      {
        id: 'force_upgrade_banner',
        description: 'Force upgrade for app versions at or below 4.9.9.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'Old builds', conditions: [{ type: 'app_version', operator: 'version_lte', targetValue: '4.9.9' }] }],
      },
      {
        id: 'push_v2_pilot',
        description: 'Push notifications v2 on exactly build 5.1.0.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: '5.1.0', conditions: [{ type: 'app_version', operator: 'version_eq', targetValue: '5.1.0' }] }],
      },
      {
        id: 'android_min_version',
        description: 'Four-part build versions (5.2.0.100) compare fine in StatSig but are not valid semver for LD.',
        owner: P.dana,
        tags: ['mobile'],
        targetApps: ['acme-android'],
        rules: [{ name: 'Build 5.2.0.100+', conditions: [{ type: 'app_version', operator: 'version_gte', targetValue: '5.2.0.100' }] }],
      },
      {
        id: 'beta_channel_features',
        description: 'Prerelease suffix: StatSig strips “-beta” before comparing; LD orders prereleases below the release.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'Beta builds 5.3+', conditions: [{ type: 'app_version', operator: 'version_gte', targetValue: '5.3.0-beta' }] }],
      },
      {
        id: 'tablet_layout',
        description: 'Two-column layout on tablets.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'Tablets', conditions: [{ type: 'device_model', operator: 'any', targetValue: ['iPad13,1', 'SM-X700'] }] }],
      },
      {
        id: 'device_beta_program',
        description: 'Beta features for enrolled devices (deviceID unit type, ID list).',
        owner: P.dana,
        idType: 'deviceID',
        tags: ['mobile'],
        rules: [{ name: 'Enrolled devices', conditions: [{ type: 'passes_segment', targetValue: 'ios_beta_devices' }] }],
      },
      {
        id: 'beta_feature_flags',
        description: 'Beta testers on mobile.',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'Beta', conditions: [{ type: 'passes_segment', targetValue: 'beta_testers' }] }],
      },
      {
        id: 'webview_checkout_fallback',
        description: 'Checkout in a webview when a JS check passes (javascript condition: no LD equivalent).',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'JS check', conditions: [{ type: 'javascript', operator: 'any', targetValue: ['window.ApplePaySession === undefined'] }] }],
      },
      {
        id: 'onboarding_followup',
        description: 'Follow-up tips for users in the carousel experiment test group (experiment_group condition).',
        owner: P.dana,
        tags: ['mobile'],
        rules: [{ name: 'Carousel group', conditions: [{ type: 'experiment_group', field: 'onboarding_carousel', operator: 'any', targetValue: ['Carousel'] }] }],
      },
    ],
    configs: [
      {
        id: 'app_theme',
        description: 'Brand colours by platform.',
        owner: P.dana,
        tags: ['mobile'],
        defaultValue: { primary: '#0055ff', radius: 8 },
        rules: [{ name: 'Android', conditions: [{ type: 'os_name', operator: 'any', targetValue: ['Android'] }], returnValue: { primary: '#0044cc', radius: 12 } }],
      },
      {
        id: 'onboarding_steps',
        description: 'Onboarding steps, shorter in development.',
        owner: P.dana,
        tags: ['mobile'],
        defaultValue: { steps: ['welcome', 'notifications', 'location', 'done'] },
        rules: [{ name: 'Dev short', environments: ['development'], conditions: [{ type: 'public' }], returnValue: { steps: ['welcome', 'done'] } }],
      },
      {
        id: 'checkout_config',
        description: 'Checkout tunables for mobile (differs from web).',
        owner: P.dana,
        tags: ['checkout', 'mobile'],
        defaultValue: { max_items: 30, express_enabled: true, payment_providers: ['apple_pay', 'google_pay'] },
        rules: [],
      },
      {
        id: 'api_endpoints',
        description: 'API base URLs per environment.',
        owner: P.sam,
        tags: ['platform'],
        defaultValue: { base_url: 'https://api.acmeretail.example' },
        rules: [
          { name: 'Staging', environments: ['staging'], conditions: [{ type: 'public' }], returnValue: { base_url: 'https://staging-api.acmeretail.example' } },
          { name: 'Dev', environments: ['development'], conditions: [{ type: 'public' }], returnValue: { base_url: 'https://dev-api.acmeretail.example' } },
        ],
      },
    ],
    segments: [
      {
        id: 'beta_testers',
        type: 'rule_based',
        description: 'Mobile beta testers (TestFlight / Play beta). Same name as acme-web, different rules.',
        owner: P.dana,
        rules: [{ name: 'Beta channel', conditions: [{ type: 'custom_field', field: 'release_channel', operator: 'any', targetValue: ['testflight', 'play_beta'] }] }],
      },
      {
        id: 'ios_beta_devices',
        type: 'id_list',
        idType: 'deviceID',
        description: 'Enrolled beta devices.',
        owner: P.dana,
        idList: { pattern: 'device-{n}', count: 40, pad: 4 },
      },
    ],
    experiments: [
      {
        id: 'onboarding_carousel',
        description: 'Carousel vs single-page onboarding.',
        hypothesis: 'A carousel increases notification opt-in.',
        owner: P.dana,
        tags: ['mobile'],
        status: 'active',
        allocation: 100,
        groups: [
          { name: 'Control', size: 34, parameterValues: { style: 'single' } },
          { name: 'Carousel', size: 33, parameterValues: { style: 'carousel' } },
          { name: 'Video', size: 33, parameterValues: { style: 'video' } },
        ],
        primaryMetrics: [{ name: 'wh_purchases', type: 'sum' }],
        startedDaysAgo: 12,
      },
    ],
    layers: [],
    holdouts: [{ id: 'mobile_global_holdout', description: 'Mobile global holdout.', owner: P.dana, passPercentage: 1, isGlobal: true }],
    autotunes: [],
    metrics: [
      {
        name: 'wh_purchases',
        type: 'sum',
        description: 'Warehouse-native purchase revenue.',
        owner: P.dana,
        warehouseNative: { aggregation: 'sum', metricSources: [{ metricSourceName: 'orders', criteria: [], valueColumn: 'order_total' }] },
      },
      {
        name: 'wh_sessions_per_user',
        type: 'mean',
        description: 'Warehouse-native sessions per user.',
        owner: P.dana,
        warehouseNative: { aggregation: 'count', metricSources: [{ metricSourceName: 'app_sessions', criteria: [] }] },
      },
    ],
    metricSources: [
      {
        name: 'orders',
        description: 'Orders fact table.',
        sql: 'select user_id, order_ts, order_total from analytics.orders',
        timestampColumn: 'order_ts',
        idTypeMapping: [{ statsigUnitID: 'userID', column: 'user_id' }],
        tableName: 'analytics.orders',
        owner: P.dana,
      },
      {
        name: 'app_sessions',
        description: 'App session starts.',
        sql: 'select device_id, user_id, session_start from analytics.app_sessions',
        timestampColumn: 'session_start',
        idTypeMapping: [{ statsigUnitID: 'userID', column: 'user_id' }, { statsigUnitID: 'deviceID', column: 'device_id' }],
        owner: P.dana,
      },
    ],
    paramStores: [],
    gateOverrides: [{ gate: 'new_checkout_flow', passingUserIDs: ['user-qa-1'], failingUserIDs: [] }],
    experimentOverrides: [],
  };
}
