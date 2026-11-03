import type { ConditionSeed } from '../console/builders.ts';
import { FUTURE_START, LAUNCH_DAY, PAST_END, PAST_START, PEOPLE as P } from './people.ts';
import type { ProjectSeed } from './seed-types.ts';

const STAFF_EMAIL: ConditionSeed = { type: 'email', operator: 'str_contains_any', targetValue: ['@acmeretail.example'] };

/**
 * `acme-web`: the storefront's StatSig project (Cloud). Designed so every condition type and
 * operator the Console API can express appears at least once (PLAN §19.2, §10.3), and so every
 * mapping edge case in docs/KNOWN-EDGE-CASES.md has a demo example. When you add an edge case
 * there, add the example here (and a golden-file line follows automatically).
 *
 * Names shared with `acme-mobile` (consolidation demo):
 * - identical: employees_only, maintenance_mode, kill_switch_payments
 * - different: new_checkout_flow, dark_mode, search_v2
 * - shared segment name: beta_testers; shared event: purchase
 */
export function acmeWeb(): ProjectSeed {
  return {
    alias: 'web',
    projectName: 'acme-web',
    companyName: 'Acme Retail',
    isWarehouseNative: false,
    environments: [
      { name: 'development', isProduction: false },
      { name: 'staging', isProduction: false },
      { name: 'production', isProduction: true },
      // Custom tier with no LD match → env_unmapped decision.
      { name: 'qa', isProduction: false },
    ],
    unitTypes: [
      { name: 'userID', description: 'Logged-in customer ID' },
      { name: 'stableID', description: 'Device-stable anonymous ID' },
      { name: 'companyID', description: 'B2B account ID' },
    ],
    tags: [
      { name: 'checkout', description: 'Checkout team' },
      { name: 'search', description: 'Search & discovery' },
      { name: 'growth', description: 'Growth experiments' },
      { name: 'platform', description: 'Platform / infra' },
      { name: '★ Core', description: 'Core tag', isCore: true },
    ],
    targetApps: ['storefront-web', 'storefront-api', 'storefront-client-only'],
    teams: ['Checkout', 'Search', 'Growth', 'Platform'],
    // Checkout has members who exist in LD (Bob, Alice) and one who left (Jordan); Growth has none.
    teamMembers: { Checkout: [P.bob, P.alice, P.former], Search: [P.priya], Platform: [P.marco, P.sam] },
    // Production requires reviews in StatSig (environments[].requiresReview) and config changes need a review project-wide.
    reviews: { configReviewRequired: true },
    defaultUnitType: 'userID',
    users: [
      { ...P.alice, role: 'Admin' },
      { ...P.bob, role: 'Member' },
      { ...P.priya, role: 'Member' },
      { ...P.marco, role: 'Member' },
      { ...P.sam, role: 'Read Only' },
    ],
    gates: [
      // --- Checkout ---------------------------------------------------------------------------
      {
        id: 'new_checkout_flow',
        // Renamed in StatSig after creation: the display name no longer matches the ID (edge case 1.13).
        name: 'New checkout flow - one page',
        description: 'One-page checkout. Staff first, then beta testers, then a 20% public rollout.',
        owner: P.bob,
        tags: ['checkout'],
        team: 'Checkout',
        holdoutIDs: ['checkout_holdout'],
        rules: [
          { name: 'Acme staff', conditions: [STAFF_EMAIL] },
          { name: 'Beta testers', conditions: [{ type: 'passes_segment', targetValue: 'beta_testers' }] },
          // Partial rollout → partial_rollout_rebucket acknowledgement.
          { name: 'Public 20%', passPercentage: 20, conditions: [{ type: 'public' }] },
        ],
        checksPerHour: 48_000,
      },
      {
        id: 'checkout_express_pay',
        description: 'Express pay button. Depends on new_checkout_flow, which has a partial rollout (cannot be inlined exactly).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [
          {
            name: 'New checkout in North America',
            conditions: [
              { type: 'passes_gate', targetValue: 'new_checkout_flow' },
              { type: 'country', operator: 'any', targetValue: ['US', 'CA'] },
            ],
          },
        ],
      },
      {
        id: 'checkout_promo_banner',
        description: 'Promo banner for staff only; references a gate with no partial rollout (inlinable).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [{ name: 'Staff', conditions: [{ type: 'passes_gate', targetValue: 'employees_only' }] }],
      },
      {
        id: 'checkout_upsell_v2',
        description: 'Post-purchase upsell. Only one of two rules requires new_checkout_flow, so a prerequisite is not equivalent, and the reference cannot be inlined (partial rollout).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [
          { name: 'New checkout users', conditions: [{ type: 'passes_gate', targetValue: 'new_checkout_flow' }] },
          { name: 'Staff', conditions: [STAFF_EMAIL] },
        ],
      },
      {
        id: 'express_pay_fallback',
        description: 'Legacy pay button for users who fail new_checkout_flow (fails_gate on a gate with a partial rollout: no prerequisite can express it).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [{ name: 'Old checkout', conditions: [{ type: 'fails_gate', targetValue: 'new_checkout_flow' }] }],
      },
      {
        id: 'non_staff_survey',
        description: 'NPS survey for everyone who is not staff (fails_gate on an inlinable gate: inlined as a negation).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Not staff', conditions: [{ type: 'fails_gate', targetValue: 'employees_only' }] }],
      },
      {
        id: 'consumer_pricing',
        description: 'Consumer prices for accounts that fail b2b_bulk_ordering. That gate has overrides, so “fails” cannot be inlined exactly.',
        owner: P.bob,
        idType: 'companyID',
        tags: ['checkout'],
        rules: [{ name: 'Not bulk', conditions: [{ type: 'fails_gate', targetValue: 'b2b_bulk_ordering' }] }],
      },
      {
        id: 'free_returns',
        description: 'A public 100% rule serves everyone; the staff rule left below it can never match (KNOWN-EDGE-CASES 4.3).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [
          { name: 'Everyone', conditions: [{ type: 'public' }] },
          { name: 'Staff (leftover)', conditions: [STAFF_EMAIL] },
        ],
      },
      {
        id: 'launched_dark_mode_v1',
        description: 'Launched gate as the Console API launch example returns it: status Launched, isEnabled false, no rules. Everyone passes (KNOWN-EDGE-CASES 4.13).',
        owner: P.marco,
        tags: ['growth'],
        type: 'PERMANENT',
        status: 'Launched',
        isEnabled: false,
        rules: [],
      },
      {
        id: 'checkout_targeting_gate',
        description: 'Targeting gate for checkout experiments: US web users.',
        owner: P.bob,
        tags: ['checkout'],
        rules: [{ name: 'US', conditions: [{ type: 'country', operator: 'any', targetValue: ['US'] }] }],
      },
      {
        id: 'kill_switch_payments',
        description: 'Emergency kill switch for the payments provider integration.',
        owner: P.sam,
        tags: ['platform'],
        type: 'PERMANENT',
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
      },
      {
        id: 'maintenance_mode',
        description: 'Show the maintenance page.',
        owner: P.sam,
        tags: ['platform'],
        type: 'PERMANENT',
        rules: [{ name: 'Internal IPs', conditions: [{ type: 'ip_address', operator: 'any', targetValue: ['10.0.0.1', '10.0.0.2'] }] }],
      },
      {
        id: 'employees_only',
        description: 'Anyone with an Acme email address.',
        owner: P.alice,
        tags: ['platform'],
        type: 'PERMANENT',
        rules: [{ name: 'Acme staff', conditions: [STAFF_EMAIL] }],
      },
      // --- Search ------------------------------------------------------------------------------
      {
        id: 'search_v2',
        name: 'Search ranking rewrite',
        description: 'New search backend for paying plans. `any` is case-insensitive in StatSig.',
        owner: P.priya,
        tags: ['search'],
        team: 'Search',
        rules: [
          {
            name: 'Pro & Enterprise, English',
            conditions: [
              { type: 'custom_field', field: 'plan', operator: 'any', targetValue: ['Pro', 'Enterprise'] },
              { type: 'locale', operator: 'any', targetValue: ['en_US', 'en_GB', 'en_CA'] },
            ],
          },
        ],
      },
      {
        id: 'search_autocomplete',
        description: 'Autocomplete for specific QA accounts (case-sensitive match).',
        owner: P.priya,
        tags: ['search'],
        rules: [{ name: 'QA accounts', conditions: [{ type: 'user_id', operator: 'any_case_sensitive', targetValue: ['QA-Alpha', 'QA-Beta'] }] }],
      },
      {
        id: 'search_typo_tolerance',
        description: 'Typo tolerance, excluding test accounts and some locales.',
        owner: P.priya,
        tags: ['search'],
        rules: [
          {
            name: 'Real users outside JP/KR',
            conditions: [
              { type: 'email', operator: 'str_contains_none', targetValue: ['+test', 'loadtest'] },
              { type: 'locale', operator: 'none', targetValue: ['ja_JP', 'ko_KR'] },
              { type: 'user_id', operator: 'none_case_sensitive', targetValue: ['BOT-1', 'BOT-2'] },
            ],
          },
        ],
      },
      {
        id: 'reviews_v2',
        description: 'New reviews widget for everyone except load-test accounts: a 0% rule is an exclusion.',
        owner: P.priya,
        tags: ['search'],
        rules: [
          { name: 'Exclude load tests', passPercentage: 0, conditions: [{ type: 'email', operator: 'str_contains_any', targetValue: ['loadtest'] }] },
          { name: 'Everyone', conditions: [{ type: 'public' }] },
        ],
      },
      {
        id: 'cross_sell_matrix',
        description: 'Cross-sell for shoppers missing items in two category sets. Two not_array_contains_all conditions multiply into 12 LaunchDarkly rules (cap 10).',
        owner: P.priya,
        tags: ['search'],
        rules: [
          {
            name: 'Incomplete wardrobe and home',
            conditions: [
              { type: 'custom_field', field: 'purchased_categories', operator: 'not_array_contains_all', targetValue: ['tops', 'bottoms', 'shoes', 'outerwear'] },
              { type: 'custom_field', field: 'purchased_categories', operator: 'not_array_contains_all', targetValue: ['kitchen', 'bedding', 'decor'] },
            ],
          },
        ],
      },
      // --- Derived attributes (browser / OS / country from IP) ---------------------------------
      {
        id: 'dark_mode',
        description: 'Dark mode on browsers with good CSS variable support.',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Modern browsers', conditions: [{ type: 'browser_name', operator: 'any', targetValue: ['Chrome', 'Firefox', 'Edge'] }] }],
      },
      {
        id: 'legacy_browser_banner',
        description: 'Upgrade banner for old Safari.',
        owner: P.marco,
        tags: ['growth'],
        rules: [
          {
            name: 'Old Safari',
            conditions: [
              { type: 'browser_name', operator: 'any', targetValue: ['Safari'] },
              { type: 'browser_version', operator: 'version_lt', targetValue: '15.0' },
            ],
          },
        ],
      },
      {
        id: 'windows_download_cta',
        description: 'Desktop app CTA on Windows 10+. `version_gte` must map to semVerLessThan + negate.',
        owner: P.marco,
        tags: ['growth'],
        rules: [
          {
            name: 'Windows 10+',
            conditions: [
              { type: 'os_name', operator: 'any', targetValue: ['Windows'] },
              { type: 'os_version', operator: 'version_gte', targetValue: '10.0.0' },
            ],
          },
        ],
      },
      {
        id: 'pwa_offline_mode',
        description: 'Offline mode for PWA shell 1.2+. Two-part version target: StatSig pads it to 1.2.0; LaunchDarkly semver wants three parts (exact after padding).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Shell 1.2+', conditions: [{ type: 'app_version', operator: 'version_gte', targetValue: '1.2' }] }],
      },
      {
        id: 'pos_firmware_sync',
        description: 'In-store POS sync for firmware 2.1.0.450+. Four-part build version: StatSig compares all four parts; LaunchDarkly semver never matches a four-part string.',
        owner: P.marco,
        tags: ['platform'],
        rules: [{ name: 'Firmware 2.1.0.450+', conditions: [{ type: 'custom_field', field: 'firmware_version', operator: 'version_gte', targetValue: '2.1.0.450' }] }],
      },
      {
        id: 'eu_cookie_banner',
        description: 'Cookie consent banner in the EU (country derived from IP). Tagged “★ Core”, which LaunchDarkly tags cannot spell.',
        owner: P.alice,
        tags: ['platform', '★ Core'],
        type: 'PERMANENT',
        rules: [{ name: 'EU', conditions: [{ type: 'country', operator: 'any', targetValue: ['DE', 'FR', 'ES', 'IT', 'NL', 'IE'] }] }],
      },
      {
        id: 'bot_detection_challenge',
        description: 'Show a challenge to user agents that look like bots.',
        owner: P.sam,
        tags: ['platform'],
        rules: [{ name: 'Bot UAs', conditions: [{ type: 'user_agent', operator: 'str_contains_any', targetValue: ['bot', 'crawler', 'spider'] }] }],
      },
      // --- Time ---------------------------------------------------------------------------------
      {
        id: 'holiday_sale_2025',
        description: 'Holiday sale window. Entirely in the past: resolves statically.',
        owner: P.marco,
        tags: ['growth'],
        rules: [
          {
            name: 'Sale window',
            conditions: [
              { type: 'time', operator: 'after', targetValue: PAST_START },
              { type: 'time', operator: 'before', targetValue: PAST_END },
            ],
          },
        ],
      },
      {
        id: 'black_friday_2027',
        description: 'Black Friday pricing; starts in the future → scheduled change or decision.',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'From Black Friday', conditions: [{ type: 'time', operator: 'after', targetValue: FUTURE_START }] }],
      },
      // --- Environment scoping ----------------------------------------------------------------
      {
        id: 'staff_debug_tools',
        description: 'Debug tools in non-production tiers only (environment_tier condition).',
        owner: P.sam,
        tags: ['platform'],
        rules: [{ name: 'Dev & staging', conditions: [{ type: 'environment_tier', operator: 'any', targetValue: ['development', 'staging'] }] }],
      },
      {
        id: 'qa_debug_panel',
        description: 'Debug panel enabled only in the custom qa environment (no LaunchDarkly match).',
        owner: P.sam,
        tags: ['platform'],
        rules: [{ name: 'QA everyone', environments: ['qa'], conditions: [{ type: 'public' }] }],
      },
      {
        id: 'perf_monitoring_v2',
        description: 'Per-environment rules: full in staging, 10% in production.',
        owner: P.sam,
        tags: ['platform'],
        rules: [
          { name: 'Staging all', environments: ['staging'], conditions: [{ type: 'public' }] },
          { name: 'Prod 10%', environments: ['production'], passPercentage: 10, conditions: [{ type: 'public' }] },
        ],
      },
      // --- Custom unit types / segments --------------------------------------------------------
      {
        id: 'b2b_bulk_ordering',
        description: 'Bulk ordering for specific B2B accounts (companyID unit type).',
        owner: P.bob,
        idType: 'companyID',
        tags: ['checkout'],
        rules: [{ name: 'Pilot accounts', conditions: [{ type: 'unit_id', customID: 'companyID', operator: 'any', targetValue: ['acct_1001', 'acct_1002', 'acct_1003'] }] }],
      },
      {
        id: 'enterprise_sso',
        description: 'SSO login for enterprise accounts (companyID segment).',
        owner: P.alice,
        idType: 'companyID',
        tags: ['platform'],
        rules: [{ name: 'Enterprise accounts', conditions: [{ type: 'passes_segment', targetValue: 'enterprise_accounts' }] }],
      },
      {
        id: 'block_fraudulent_checkout',
        description: 'Allow checkout unless on the fraud blocklist (20k ID list → big segment).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [{ name: 'Not on blocklist', conditions: [{ type: 'fails_segment', targetValue: 'fraud_blocklist' }] }],
      },
      {
        id: 'anon_homepage_variant',
        description: 'Homepage variant for anonymous visitors, bucketed by stableID (LaunchDarkly “device” context kind).',
        owner: P.marco,
        idType: 'stableID',
        tags: ['growth'],
        rules: [{ name: 'Half of devices', passPercentage: 50, conditions: [{ type: 'public' }] }],
      },
      {
        id: 'winback_offer',
        description: 'Win-back offer for the churn_risk segment, whose rule samples 10% of matching users.',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'At risk', conditions: [{ type: 'passes_segment', targetValue: 'churn_risk' }] }],
      },
      {
        id: 'labs_menu',
        description: 'Labs menu for the staff_or_beta segment, which references a gate (inlined into the LaunchDarkly segment).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Labs', conditions: [{ type: 'passes_segment', targetValue: 'staff_or_beta' }] }],
      },
      {
        id: 'early_adopter_badge',
        description: 'Badge for the early_adopters segment, which references a gate with a partial rollout (the segment cannot migrate, so this gate is blocked).',
        owner: P.bob,
        tags: ['growth'],
        rules: [{ name: 'Early adopters', conditions: [{ type: 'passes_segment', targetValue: 'early_adopters' }] }],
      },
      {
        id: 'referral_bonus',
        description: 'Bonus for referral partners. References a segment that is not in this project (deleted, or never exported).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Partners', conditions: [{ type: 'passes_segment', targetValue: 'referral_partners' }] }],
      },
      {
        id: 'vip_early_access',
        description: 'Early access for VIP customers (small ID list).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'VIPs', conditions: [{ type: 'passes_segment', targetValue: 'vip_customers' }] }],
      },
      {
        id: 'wholesale_portal',
        description: 'Wholesale portal for partner accounts (2.5k-ID list; hashed in the config spec).',
        owner: P.bob,
        tags: ['checkout'],
        rules: [{ name: 'Partners', conditions: [{ type: 'passes_segment', targetValue: 'wholesale_partners' }] }],
      },
      // --- Numeric, date, regex, null, array operators ---------------------------------------
      {
        id: 'gift_card_upsell',
        description: 'Numeric comparisons on custom fields.',
        owner: P.marco,
        tags: ['growth'],
        rules: [
          { name: 'Low balance', conditions: [{ type: 'custom_field', field: 'gift_card_balance', operator: 'gt', targetValue: 0 }, { type: 'custom_field', field: 'gift_card_balance', operator: 'lte', targetValue: 25 }] },
          { name: 'Gold tier', conditions: [{ type: 'custom_field', field: 'loyalty_points', operator: 'gte', targetValue: 5000 }, { type: 'custom_field', field: 'loyalty_points', operator: 'lt', targetValue: 20000 }] },
        ],
      },
      {
        id: 'loyalty_tier_perks',
        description: 'Perks for loyalty tiers 2 and 3. Numeric target values: StatSig compares them as strings, LaunchDarkly `in` compares typed values.',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Tier 2+', conditions: [{ type: 'custom_field', field: 'loyalty_tier', operator: 'any', targetValue: [2, 3] }] }],
      },
      {
        id: 'legacy_partner_allowlist',
        description: 'Legacy allowlist on the deprecated encoded_any operator (hashed values). Current StatSig SDKs and LaunchDarkly have no equivalent.',
        owner: P.former,
        tags: ['platform'],
        rules: [{ name: 'Encoded partners', conditions: [{ type: 'custom_field', field: 'partner_code', operator: 'encoded_any', targetValue: ['Z3ZhQ2xpZW50', 'c2VydmljZTE='] }] }],
      },
      {
        id: 'new_customer_onboarding',
        description: 'Date comparisons on signup date (after / on).',
        owner: P.marco,
        tags: ['growth'],
        rules: [
          { name: 'Signed up after launch', conditions: [{ type: 'custom_field', field: 'signup_date', operator: 'after', targetValue: LAUNCH_DAY }] },
          { name: 'Launch-day cohort', conditions: [{ type: 'custom_field', field: 'signup_date', operator: 'on', targetValue: LAUNCH_DAY }] },
        ],
      },
      {
        id: 'sku_preview',
        description: 'Regex on SKU. Rule 2 uses a lookbehind (not portable across SDK regex engines). Both rules carry the same name, which StatSig allows and LaunchDarkly does not (edge case 4.16).',
        owner: P.priya,
        tags: ['search'],
        rules: [
          { name: 'SKU regex', conditions: [{ type: 'custom_field', field: 'sku', operator: 'str_matches', targetValue: '^ACME-[0-9]{4}$' }] },
          { name: 'SKU regex', conditions: [{ type: 'custom_field', field: 'sku', operator: 'str_matches', targetValue: '(?<=ACME-)9[0-9]{3}' }] },
        ],
      },
      {
        id: 'missing_email_prompt',
        description: 'Prompt guests with no email to sign in (is_null).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'No email', conditions: [{ type: 'email', operator: 'is_null' }] }],
      },
      {
        id: 'sms_notifications',
        description: 'SMS opt-in for users with a phone number (is_not_null).',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Has phone', conditions: [{ type: 'custom_field', field: 'phone', operator: 'is_not_null' }] }],
      },
      {
        id: 'wishlist_sharing',
        description: 'Array operators: contains any / contains none.',
        owner: P.priya,
        tags: ['search'],
        rules: [
          {
            name: 'Fashion or home, not kids',
            conditions: [
              { type: 'custom_field', field: 'interests', operator: 'array_contains_any', targetValue: ['fashion', 'home'] },
              { type: 'custom_field', field: 'interests', operator: 'array_contains_none', targetValue: ['kids'] },
            ],
          },
        ],
      },
      {
        id: 'bundle_recommendations',
        description: 'Array operators: contains all / not contains all.',
        owner: P.priya,
        tags: ['search'],
        rules: [
          { name: 'Gamers', conditions: [{ type: 'custom_field', field: 'interests', operator: 'array_contains_all', targetValue: ['gaming', 'electronics'] }] },
          { name: 'Not full-house', conditions: [{ type: 'custom_field', field: 'interests', operator: 'not_array_contains_all', targetValue: ['fashion', 'home', 'garden'] }] },
        ],
      },
      {
        id: 'clearance_category_badge',
        description: 'Clearance badge for category IDs 12 and 48. Numeric array targets: StatSig matches only numbers in the array; LaunchDarkly `in` is typed too, but apps often send IDs as strings.',
        owner: P.priya,
        tags: ['search'],
        rules: [{ name: 'Clearance categories', conditions: [{ type: 'custom_field', field: 'category_ids', operator: 'array_contains_any', targetValue: [12, 48] }] }],
      },
      // --- MANUAL condition types --------------------------------------------------------------
      {
        id: 'storefront_url_banner',
        description: 'Banner on specific URLs (url condition: no LaunchDarkly equivalent).',
        owner: P.marco,
        tags: ['growth'],
        targetApps: ['storefront-client-only'],
        rules: [{ name: 'Sale pages', conditions: [{ type: 'url', operator: 'str_contains_any', targetValue: ['/sale', '/deals'] }] }],
      },
      {
        id: 'storefront_app_only',
        description: 'Only for the storefront web target app (target_app condition).',
        owner: P.sam,
        tags: ['platform'],
        targetApps: ['storefront-web'],
        rules: [{ name: 'Storefront', conditions: [{ type: 'target_app', operator: 'any', targetValue: ['storefront-web'] }] }],
      },
      // --- Lifecycle: disabled, archived, stale ----------------------------------------------
      {
        id: 'old_cart_drawer',
        description: 'Old cart drawer. Disabled.',
        owner: P.former,
        tags: ['checkout'],
        isEnabled: false,
        status: 'Disabled',
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
        checksPerHour: 0,
      },
      {
        id: 'legacy_wishlist',
        description: 'Replaced by wishlist_sharing. Archived.',
        owner: P.former,
        tags: ['search'],
        status: 'Archived',
        isEnabled: false,
        archivedDaysAgo: 45,
        archiveReason: 'Replaced by wishlist_sharing',
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
        checksPerHour: 0,
      },
      {
        id: 'stale_promo_ribbon',
        description: 'Fully launched months ago; StatSig marks it stale (all true). Hard-code instead of migrating.',
        owner: P.marco,
        tags: ['growth'],
        status: 'Launched',
        type: 'STALE',
        typeReason: 'STALE_ALL_TRUE',
        modifiedDaysAgo: 210,
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
      },
      {
        id: 'payments_v3_scaffold',
        description: 'Created for a future launch; no rules yet (STALE_NO_RULES).',
        owner: P.sam,
        tags: ['platform'],
        type: 'STALE',
        typeReason: 'STALE_NO_RULES',
        checksPerHour: 0,
        rules: [],
      },
      {
        id: 'Holiday Banner 2026',
        description: 'Name with spaces and capitals: legal in StatSig, but LaunchDarkly keys allow only letters, digits, “.”, “_” and “-”.',
        owner: P.marco,
        tags: ['growth'],
        rules: [{ name: 'Everyone', conditions: [{ type: 'public' }] }],
      },
      {
        id: 'stale_reviews_widget',
        description: 'Nobody checks this gate any more.',
        owner: P.former,
        tags: ['search'],
        type: 'STALE',
        typeReason: 'STALE_PROBABLY_DEAD_CHECK',
        modifiedDaysAgo: 400,
        checksPerHour: 0,
        rules: [{ name: 'Staff', conditions: [STAFF_EMAIL] }],
      },
      {
        id: 'account_plan_tier_targeting',
        description: 'Plan-tier rollout written one rule per plan. The 0% rules fail users the default already fails (edge case 4.15): Enterprise is trailing, Starter and Student exclude before Pro.',
        owner: P.marco,
        tags: ['platform'],
        team: 'Platform',
        rules: [
          { name: 'Starter plan', passPercentage: 0, conditions: [{ type: 'custom_field', field: 'plan', operator: 'any_case_sensitive', targetValue: ['starter'] }] },
          { name: 'Student plan', passPercentage: 0, conditions: [{ type: 'custom_field', field: 'plan', operator: 'any_case_sensitive', targetValue: ['student'] }] },
          { name: 'Pro plan', conditions: [{ type: 'custom_field', field: 'plan', operator: 'any_case_sensitive', targetValue: ['pro'] }] },
          { name: 'Org plan', conditions: [{ type: 'custom_field', field: 'plan', operator: 'any_case_sensitive', targetValue: ['org'] }] },
          { name: 'Enterprise plan', passPercentage: 0, conditions: [{ type: 'custom_field', field: 'plan', operator: 'any_case_sensitive', targetValue: ['enterprise'] }] },
        ],
        checksPerHour: 3_200,
      },
    ],
    configs: [
      {
        id: 'checkout_config',
        name: 'Checkout tunables',
        description: 'Checkout tunables, schema-validated.',
        owner: P.bob,
        tags: ['checkout'],
        defaultValue: { max_items: 50, express_enabled: false, payment_providers: ['card'] },
        schema: {
          type: 'object',
          properties: { max_items: { type: 'number' }, express_enabled: { type: 'boolean' }, payment_providers: { type: 'array', items: { type: 'string' } } },
          required: ['max_items'],
        },
        rules: [
          { name: 'Staff', conditions: [STAFF_EMAIL], returnValue: { max_items: 500, express_enabled: true, payment_providers: ['card', 'paypal', 'apple_pay'] } },
          { name: 'US', conditions: [{ type: 'country', operator: 'any', targetValue: ['US'] }], returnValue: { max_items: 100, express_enabled: true, payment_providers: ['card', 'paypal'] } },
        ],
      },
      {
        id: 'homepage_hero',
        description: 'Homepage hero banner with three creative variants.',
        owner: P.marco,
        tags: ['growth'],
        defaultValue: { headline: 'Welcome to Acme', image: 'hero-default.jpg' },
        rules: [
          {
            name: 'Everyone (variants)',
            conditions: [{ type: 'public' }],
            returnValue: { headline: 'Welcome to Acme', image: 'hero-default.jpg' },
            variants: [
              { name: 'Autumn', passPercentage: 50, returnValue: { headline: 'Fall into savings', image: 'hero-autumn.jpg' } },
              { name: 'Minimal', passPercentage: 30, returnValue: { headline: 'Acme.', image: 'hero-minimal.jpg' } },
              { name: 'Video', passPercentage: 20, returnValue: { headline: 'See it in action', image: 'hero-video.mp4' } },
            ],
          },
        ],
      },
      {
        id: 'shipping_thresholds',
        description: 'Free-shipping thresholds by country. Gains a new value in snapshot 2.',
        owner: P.bob,
        tags: ['checkout'],
        defaultValue: { free_shipping_min: 50, currency: 'USD' },
        rules: [
          { name: 'UK', conditions: [{ type: 'country', operator: 'any', targetValue: ['GB'] }], returnValue: { free_shipping_min: 40, currency: 'GBP' } },
          { name: 'Canada', conditions: [{ type: 'country', operator: 'any', targetValue: ['CA'] }], returnValue: { free_shipping_min: 75, currency: 'CAD' } },
        ],
      },
      {
        id: 'search_ranking_weights',
        description: 'Ranking weights; staging gets an experimental mix.',
        owner: P.priya,
        tags: ['search'],
        defaultValue: { text: 0.6, popularity: 0.3, recency: 0.1 },
        rules: [{ name: 'Staging mix', environments: ['staging'], conditions: [{ type: 'public' }], returnValue: { text: 0.4, popularity: 0.4, recency: 0.2 } }],
      },
      {
        id: 'b2b_order_limits',
        description: 'Per-account order limits (companyID).',
        owner: P.bob,
        idType: 'companyID',
        tags: ['checkout'],
        defaultValue: { max_order_value: 10000 },
        rules: [{ name: 'Enterprise accounts', conditions: [{ type: 'passes_segment', targetValue: 'enterprise_accounts' }], returnValue: { max_order_value: 250000 } }],
      },
      {
        id: 'api_rate_limits',
        description: 'Storefront API rate limits; 50% rollout of the new limits.',
        owner: P.sam,
        tags: ['platform'],
        defaultValue: { rps: 50 },
        rules: [{ name: 'New limits (50%)', passPercentage: 50, conditions: [{ type: 'public' }], returnValue: { rps: 80 } }],
      },
      {
        id: 'maintenance_mode',
        description: 'Maintenance page copy. Same name as the maintenance_mode gate: StatSig namespaces gates and configs separately, LaunchDarkly keys are one namespace.',
        owner: P.sam,
        tags: ['platform'],
        defaultValue: { message: 'We will be back shortly.', eta_minutes: 30 },
        rules: [],
      },
      {
        id: 'loyalty_checkout_perks',
        description: 'Checkout perks by account age: a numeric custom_field condition (gte) and a rule after a 25% rollout, which the first matching rule still ends (10.4).',
        owner: P.marco,
        tags: ['checkout', 'growth'],
        defaultValue: { free_gift_wrap: false, priority_support: false },
        rules: [
          { name: 'Accounts older than 30 days', conditions: [{ type: 'custom_field', field: 'account_age_days', operator: 'gte', targetValue: 30 }], passPercentage: 25, returnValue: { free_gift_wrap: true, priority_support: false } },
          { name: 'Gold tier', conditions: [{ type: 'custom_field', field: 'tier', operator: 'any', targetValue: ['gold'] }], returnValue: { free_gift_wrap: true, priority_support: true } },
        ],
      },
      {
        id: 'legacy_pricing_rules',
        description: 'Disabled config whose only rule returns the default value (nothing to add as a variation).',
        owner: P.former,
        tags: ['checkout'],
        isEnabled: false,
        defaultValue: { rounding: 'nearest', currency_display: 'symbol' },
        rules: [{ name: 'Same as default', conditions: [STAFF_EMAIL], returnValue: { rounding: 'nearest', currency_display: 'symbol' } }],
      },
    ],
    segments: [
      {
        id: 'beta_testers',
        type: 'rule_based',
        description: 'Customers who opted in to beta features.',
        owner: P.marco,
        rules: [
          { name: 'Opted in', conditions: [{ type: 'custom_field', field: 'beta_opt_in', operator: 'any', targetValue: ['true'] }] },
          { name: 'Staff', conditions: [STAFF_EMAIL] },
        ],
      },
      {
        id: 'enterprise_accounts',
        type: 'rule_based',
        idType: 'companyID',
        description: 'B2B accounts on the enterprise plan.',
        owner: P.bob,
        rules: [{ name: 'Enterprise plan', conditions: [{ type: 'custom_field', field: 'account_plan', operator: 'any', targetValue: ['enterprise'] }] }],
      },
      {
        id: 'churn_risk',
        type: 'rule_based',
        description: 'Customers at risk of churning; a 10% sample (segment rules have pass percentages too).',
        owner: P.marco,
        rules: [{ name: 'Inactive 90 days (10%)', passPercentage: 10, conditions: [{ type: 'custom_field', field: 'days_since_order', operator: 'gte', targetValue: 90 }] }],
      },
      {
        id: 'legacy_partners',
        type: 'rule_based',
        description: 'Disabled segment: nobody matches it.',
        owner: P.former,
        isEnabled: false,
        rules: [{ name: 'Legacy plan', conditions: [{ type: 'custom_field', field: 'account_plan', operator: 'any', targetValue: ['legacy'] }] }],
      },
      {
        id: 'staff_or_beta',
        type: 'rule_based',
        description: 'Staff (via the employees_only gate) or beta opt-ins. A gate reference inside a segment must inline: LaunchDarkly segments have no prerequisites.',
        owner: P.marco,
        rules: [
          { name: 'Staff', conditions: [{ type: 'passes_gate', targetValue: 'employees_only' }] },
          { name: 'Opted in', conditions: [{ type: 'custom_field', field: 'beta_opt_in', operator: 'any', targetValue: ['true'] }] },
        ],
      },
      {
        id: 'early_adopters',
        type: 'rule_based',
        description: 'Users in the new checkout rollout. References a gate with a partial rollout, which cannot be inlined into a LaunchDarkly segment.',
        owner: P.bob,
        rules: [{ name: 'New checkout', conditions: [{ type: 'passes_gate', targetValue: 'new_checkout_flow' }] }],
      },
      {
        id: 'beta_or_vip',
        type: 'rule_based',
        description: 'Beta opt-ins or VIP customers. A segment whose rules match other segments: LaunchDarkly wants those segments in the environment first (KNOWN-EDGE-CASES 9.15).',
        owner: P.marco,
        rules: [
          { name: 'Beta', conditions: [{ type: 'passes_segment', targetValue: 'beta_testers' }] },
          { name: 'VIP', conditions: [{ type: 'passes_segment', targetValue: 'vip_customers' }] },
        ],
      },
      {
        id: 'beta_waitlist',
        type: 'id_list',
        description: 'Waitlist for the next beta; currently empty.',
        owner: P.marco,
        idList: { pattern: 'wait-{n}', count: 0, pad: 3 },
      },
      {
        id: 'vip_customers',
        type: 'id_list',
        description: 'Hand-picked VIP customers.',
        owner: P.marco,
        idList: { pattern: 'vip-{n}', count: 25, pad: 3 },
      },
      {
        id: 'wholesale_partners',
        type: 'id_list',
        description: 'Wholesale partner logins. Large enough to be hashed in the config spec.',
        owner: P.bob,
        idList: { pattern: 'partner-{n}', count: 2500, pad: 5 },
      },
      {
        id: 'fraud_blocklist',
        type: 'id_list',
        description: 'Users blocked by the fraud team. 20k IDs → LaunchDarkly big segment.',
        owner: P.sam,
        idList: { pattern: 'fraud-user-{n}', count: 20000, pad: 6 },
      },
    ],
    experiments: [
      {
        id: 'checkout_button_color',
        description: 'Green vs blue Place Order button.',
        hypothesis: 'A green button increases checkout conversion.',
        owner: P.bob,
        tags: ['checkout'],
        status: 'setup',
        allocation: 100,
        layerID: 'checkout_button_color_layer',
        groups: [
          { name: 'Control', size: 50, parameterValues: { color: 'blue' } },
          { name: 'Green', size: 50, parameterValues: { color: 'green' } },
        ],
        primaryMetrics: [{ name: 'checkout_conversion', type: 'ratio' }],
      },
      {
        id: 'search_ranking_v3',
        description: 'New ranking model, US only via a targeting gate.',
        hypothesis: 'Model v3 increases add-to-cart from search.',
        owner: P.priya,
        tags: ['search'],
        status: 'active',
        allocation: 50,
        targetingGateID: 'checkout_targeting_gate',
        groups: [
          { name: 'Control', size: 50, parameterValues: { model: 'v2' } },
          { name: 'Model v3', size: 50, parameterValues: { model: 'v3' } },
        ],
        primaryMetrics: [{ name: 'purchase_count', type: 'event_count_custom' }],
        secondaryMetrics: [{ name: 'revenue', type: 'sum' }],
        startedDaysAgo: 9,
      },
      {
        id: 'homepage_layout_test',
        description: 'Grid vs list layout on the homepage. Shipped Grid.',
        hypothesis: 'Grid layout increases product clicks.',
        owner: P.marco,
        tags: ['growth'],
        status: 'decision_made',
        allocation: 100,
        launchedGroup: 'Grid',
        groups: [
          { name: 'Control', size: 50, parameterValues: { layout: 'list', columns: 1 } },
          { name: 'Grid', size: 50, parameterValues: { layout: 'grid', columns: 4 } },
        ],
        primaryMetrics: [{ name: 'checkout_conversion', type: 'ratio' }],
        startedDaysAgo: 60,
        endedDaysAgo: 20,
        decisionReason: 'Grid won on conversion (+3.1%).',
      },
      {
        id: 'free_shipping_banner',
        description: 'Free shipping banner copy test. Abandoned.',
        hypothesis: 'A banner increases AOV.',
        owner: P.marco,
        tags: ['growth'],
        status: 'abandoned',
        allocation: 100,
        groups: [
          { name: 'Control', size: 50, parameterValues: { show_banner: false } },
          { name: 'Banner', size: 50, parameterValues: { show_banner: true } },
        ],
        startedDaysAgo: 40,
        endedDaysAgo: 35,
        decisionReason: 'Instrumentation bug.',
      },
      {
        id: 'checkout_cta_copy',
        description: 'CTA copy test in the checkout layer.',
        hypothesis: 'Urgent copy increases conversion.',
        owner: P.bob,
        tags: ['checkout'],
        status: 'active',
        allocation: 40,
        layerID: 'checkout_layer',
        groups: [
          { name: 'Control', size: 50, parameterValues: { cta_text: 'Place order' } },
          { name: 'Urgent', size: 50, parameterValues: { cta_text: 'Complete purchase now' } },
        ],
        primaryMetrics: [{ name: 'checkout_conversion', type: 'ratio' }],
        startedDaysAgo: 5,
      },
      {
        id: 'checkout_trust_badges',
        description: 'Trust badges test in the checkout layer.',
        hypothesis: 'Badges reduce cart abandonment.',
        owner: P.bob,
        tags: ['checkout'],
        status: 'setup',
        allocation: 30,
        layerID: 'checkout_layer',
        groups: [
          { name: 'Control', size: 50, parameterValues: { show_badges: false } },
          { name: 'Badges', size: 50, parameterValues: { show_badges: true } },
        ],
      },
      {
        id: 'old_banner_test',
        description: 'Banner test from last year. Archived.',
        hypothesis: 'A sticky banner increases newsletter signups.',
        owner: P.former,
        tags: ['growth'],
        status: 'archived',
        allocation: 100,
        groups: [
          { name: 'Control', size: 50, parameterValues: { sticky: false } },
          { name: 'Sticky', size: 50, parameterValues: { sticky: true } },
        ],
        startedDaysAgo: 400,
        endedDaysAgo: 380,
      },
      {
        id: 'b2b_discount_tiers',
        description: 'Tiered discounts for B2B accounts, randomized by companyID.',
        hypothesis: 'Tiered discounts increase reorder rate.',
        owner: P.bob,
        idType: 'companyID',
        tags: ['checkout'],
        status: 'setup',
        allocation: 100,
        groups: [
          { name: 'Control', size: 50, parameterValues: { discount_pct: 0 } },
          { name: 'Tiered', size: 50, parameterValues: { discount_pct: 5 } },
        ],
        primaryMetrics: [{ name: 'revenue', type: 'sum' }],
      },
    ],
    layers: [
      {
        id: 'checkout_layer',
        description: 'Mutually exclusive checkout experiments sharing CTA parameters.',
        owner: P.bob,
        parameters: [
          { name: 'cta_text', type: 'string', defaultValue: 'Place order' },
          { name: 'show_badges', type: 'boolean', defaultValue: false },
        ],
        experimentIds: ['checkout_cta_copy', 'checkout_trust_badges'],
      },
      {
        id: 'checkout_button_color_layer',
        description: 'Implicit layer created for checkout_button_color.',
        owner: P.bob,
        isImplicitLayer: true,
        parameters: [{ name: 'color', type: 'string', defaultValue: 'blue' }],
        experimentIds: ['checkout_button_color'],
      },
    ],
    holdouts: [
      { id: 'global_holdout', description: 'Global 2% holdout for measuring cumulative impact.', owner: P.alice, passPercentage: 2, isGlobal: true },
      { id: 'checkout_holdout', description: 'Holdout for checkout gates.', owner: P.bob, passPercentage: 5, gateIDs: ['new_checkout_flow'] },
    ],
    autotunes: [
      {
        // 11.8: running in StatSig → autotune_running decision (wait or pre-stage); 11.9: 33/33/33 sums to 99.
        id: 'promo_banner_autotune',
        description: 'Bandit over promo banner copy (running: wait for a winner, or pre-stage).',
        owner: P.marco,
        successEvent: 'promo_click',
        isStarted: true,
        variants: [
          { name: 'Ten off', json: { copy: '10% off today' } },
          { name: 'Free ship', json: { copy: 'Free shipping on everything' } },
          { name: 'BOGO', json: { copy: 'Buy one get one' } },
        ],
      },
      {
        // 11.8: not started → JSON flag (off) + metric + drafted bandit.
        id: 'hero_image_autotune',
        description: 'Not started yet: homepage hero image candidates (drafted as a LaunchDarkly bandit).',
        owner: P.marco,
        successEvent: 'hero_click',
        isStarted: false,
        tags: ['homepage'],
        variants: [
          { name: 'Lifestyle', json: { image: 'hero-lifestyle.jpg' }, size: 50 },
          { name: 'Product', json: { image: 'hero-product.jpg' }, size: 50 },
        ],
      },
      {
        // 11.10: concluded → the flag serves the winner at 100%, no bandit.
        id: 'pricing_page_autotune',
        description: 'Concluded: StatSig picked “Annual first” (the flag serves the winner at 100%).',
        owner: P.dana,
        successEvent: 'plan_selected',
        isStarted: true,
        winner: 'Annual first',
        variants: [
          { name: 'Monthly first', json: { order: ['monthly', 'annual'] } },
          { name: 'Annual first', json: { order: ['annual', 'monthly'] } },
        ],
      },
      {
        // 11.11: no success event → missing_metric decision (flag only, or skip).
        id: 'cart_upsell_autotune',
        description: 'No success event configured: nothing for a bandit to optimize.',
        owner: P.bob,
        isStarted: false,
        variants: [
          { name: 'Accessories', json: { upsell: 'accessories' } },
          { name: 'Warranty', json: { upsell: 'warranty' } },
        ],
      },
      {
        // 11.12: two variants with identical JSON → duplicate_variant_value (merge or skip).
        id: 'free_shipping_copy_autotune',
        description: 'Two variants return the same JSON (LaunchDarkly variations must be distinct).',
        owner: P.marco,
        successEvent: 'checkout_start',
        isStarted: false,
        variants: [
          { name: 'Short', json: { copy: 'Free shipping' } },
          { name: 'Short again', json: { copy: 'Free shipping' } },
          { name: 'Long', json: { copy: 'Free shipping on every order' } },
        ],
      },
      {
        // 11.13: companyID autotune → bandit randomized by the “company” context kind (randomization unit).
        id: 'b2b_pricing_autotune',
        description: 'Randomized by companyID: the LaunchDarkly bandit needs “company” as a randomization unit.',
        owner: P.dana,
        successEvent: 'quote_requested',
        isStarted: false,
        idType: 'companyID',
        variants: [
          { name: 'Volume tiers', json: { pricing: 'tiers' } },
          { name: 'Flat rate', json: { pricing: 'flat' } },
        ],
      },
    ],
    metrics: [
      { name: 'purchase_count', type: 'event_count_custom', description: 'Count of purchase events.', owner: P.marco, events: ['purchase'] },
      { name: 'revenue', type: 'sum', description: 'Sum of purchase value.', owner: P.marco, events: ['purchase'] },
      { name: 'avg_order_value', type: 'mean', description: 'Mean purchase value.', owner: P.marco, events: ['purchase'] },
      { name: 'checkout_conversion', type: 'ratio', description: 'Purchases / checkout starts.', owner: P.bob, events: ['purchase', 'checkout_start'] },
      { name: 'checkout_funnel', type: 'funnel', description: 'View cart → checkout → purchase.', owner: P.bob, funnel: ['view_cart', 'checkout_start', 'purchase'] },
      {
        name: 'engagement_score',
        type: 'composite',
        description: 'Composite of clicks and purchases (no LaunchDarkly equivalent).',
        owner: P.marco,
        components: [{ name: 'purchase_count', type: 'event_count_custom' }, { name: 'promo_clicks', type: 'event_count_custom' }],
      },
      { name: 'promo_clicks', type: 'event_count_custom', description: 'Promo banner clicks.', owner: P.marco, events: ['promo_click'] },
    ],
    metricSources: [],
    paramStores: [
      {
        name: 'checkout_params',
        description: 'Checkout parameters for the storefront.',
        owner: P.bob,
        parameters: [
          { ref_type: 'static', name: 'support_phone', param_type: 'string', value: '+1-800-555-0100' },
          { ref_type: 'gate', name: 'express_pay_enabled', gate_name: 'checkout_express_pay', param_type: 'boolean', pass_value: true, fail_value: false },
          { ref_type: 'experiment', name: 'cta_text', param_type: 'string', experiment_name: 'checkout_cta_copy', param_name: 'cta_text' },
          { ref_type: 'dynamic_config', name: 'max_items', param_type: 'number', config_name: 'checkout_config', param_name: 'max_items' },
        ],
      },
    ],
    gateOverrides: [
      {
        gate: 'new_checkout_flow',
        passingUserIDs: ['user-qa-1', 'user-qa-2'],
        failingUserIDs: ['user-vip-complainer'],
        // user-vip-complainer fails everywhere but passes in staging: a conflict LD can't hold.
        environmentOverrides: [{ environment: 'staging', unitID: 'userID', passingIDs: ['user-staging-tester', 'user-vip-complainer'], failingIDs: [] }],
      },
      // Custom-ID overrides on a userID gate: the Console API doesn't say which unit type.
      { gate: 'search_v2', passingCustomIDs: ['acct_3001'] },
      {
        gate: 'b2b_bulk_ordering',
        passingCustomIDs: ['acct_2001'],
        environmentOverrides: [{ environment: 'production', unitID: 'companyID', passingIDs: ['acct_9999'], failingIDs: ['acct_1003'] }],
      },
    ],
    experimentOverrides: [
      { experiment: 'search_ranking_v3', userIDOverrides: [{ groupName: 'Model v3', ids: ['user-search-qa'] }] },
    ],
    // Prompts / AI Configs (edge case 1.12): the Console API lists the shell only; versions are not readable.
    prompts: [
      { id: 'support_reply_assistant', description: 'Drafts first replies to support tickets from the order history.', owner: P.priya, team: 'Search', tags: ['search', '★ Core'], version: 4, targetApps: ['storefront-api'] },
      // Owned by someone who left Acme (maintainer_unknown), in a holdout.
      { id: 'product_description_writer', description: 'Generates product descriptions for new catalog items.', owner: P.former, team: 'Growth', tags: ['growth'], version: 2, holdoutIDs: ['checkout_holdout'] },
    ],
    // Topline alerts: no LD equivalent, listed at cut over.
    alerts: [
      { id: 'alert_purchase_drop', name: 'Purchases down 20%', alertType: 'pct_change', metrics: ['purchase_count'], message: 'Purchase count dropped more than 20% hour over hour.', condition: 'less', threshold: -20, windowMs: 3_600_000, owner: P.bob, team: 'Checkout', tags: ['checkout'], subscribers: [P.bob.email, P.alice.email] },
      { id: 'alert_search_errors', name: 'Search errors above 50/h', alertType: 'threshold', metrics: ['search_error_count'], message: 'Search error count above 50 in an hour.', condition: 'greater', threshold: 50, windowMs: 3_600_000, owner: P.priya, team: 'Search' },
    ],
  };
}
