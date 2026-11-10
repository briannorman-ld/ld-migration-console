import { ownValue, type Condition, type ConditionType, type SnapshotWarning } from '@sslm/canonical';

/** A DCS condition (v1 inline, or v2 after condition_map resolution). */
export interface DcsCondition {
  type: string;
  targetValue?: unknown;
  operator?: string | null;
  field?: string | null;
  additionalValues?: Record<string, unknown> | null;
  idType?: string | null;
  isDeviceBased?: boolean | null;
}

/** `user_field` names → canonical condition types (PLAN §4.2 table). Matched case-insensitively. */
const USER_FIELDS: Record<string, ConditionType> = {
  userid: 'user_id',
  email: 'email',
  ip: 'ip_address',
  locale: 'locale',
  appversion: 'app_version',
  country: 'country',
  useragent: 'user_agent',
  device_model: 'device_model',
  browser_name: 'browser_name',
  browser_version: 'browser_version',
  os_name: 'os_name',
  os_version: 'os_version',
};

const UA_FIELDS: Record<string, ConditionType> = {
  os_name: 'os_name',
  osname: 'os_name',
  os_version: 'os_version',
  osversion: 'os_version',
  browser_name: 'browser_name',
  browsername: 'browser_name',
  browser_version: 'browser_version',
  browserversion: 'browser_version',
};

/** Types emitted as-is by our generator for Console-only types the SDK can't evaluate. */
const PASSTHROUGH: Record<string, ConditionType> = {
  target_app: 'target_app',
  experiment_group: 'experiment_group',
  javascript: 'javascript',
  url: 'url',
  user_bucket: 'user_bucket',
  public: 'public',
};

export interface ConditionContext {
  warn: (w: SnapshotWarning) => void;
  path: string;
}

/** DCS condition → canonical condition. Never drops anything: unknown forms become `unknown`. */
export function normalizeDcsCondition(c: DcsCondition, ctx: ConditionContext): Condition {
  const raw = c;
  const field = c.field ?? null;
  let operator: string | null = c.operator ?? null;
  let targetValue: unknown = c.targetValue ?? null;

  // `eq null` / `neq null` is how specs encode is_null / is_not_null.
  if ((operator === 'eq' || operator === 'neq') && targetValue === null) {
    operator = operator === 'eq' ? 'is_null' : 'is_not_null';
  }
  const base = { operator, targetValue, raw };

  switch (c.type) {
    case 'user_field': {
      const t = ownValue(USER_FIELDS, field?.toLowerCase());
      if (t) return { type: t, ...base };
      return { type: 'custom_field', field, ...base };
    }
    case 'ip_based': {
      if (field?.toLowerCase() === 'country') return { type: 'country', derivedFrom: 'ip', ...base };
      ctx.warn({ code: 'unknown_condition', path: ctx.path, message: `IP-derived field "${field}" has no canonical type; kept for a decision.` });
      return { type: 'unknown', field, derivedFrom: 'ip', ...base };
    }
    case 'ua_based': {
      const t = ownValue(UA_FIELDS, field?.toLowerCase());
      if (t) return { type: t, derivedFrom: 'user_agent', ...base };
      ctx.warn({ code: 'unknown_condition', path: ctx.path, message: `User-agent field "${field}" has no canonical type; kept for a decision.` });
      return { type: 'unknown', field, derivedFrom: 'user_agent', ...base };
    }
    case 'environment_field': {
      if (field?.toLowerCase() === 'tier') return { type: 'environment_tier', ...base };
      ctx.warn({ code: 'unknown_condition', path: ctx.path, message: `Environment field "${field}" is not a tier; kept for a decision.` });
      return { type: 'unknown', field, ...base };
    }
    case 'pass_gate':
    case 'fail_gate': {
      const pass = c.type === 'pass_gate';
      const name = String(targetValue);
      if (name.startsWith('segment:')) {
        return { type: pass ? 'passes_segment' : 'fails_segment', operator: null, targetValue: name.slice('segment:'.length), raw };
      }
      return { type: pass ? 'passes_gate' : 'fails_gate', operator: null, targetValue: name, raw };
    }
    case 'multi_pass_gate':
    case 'multi_fail_gate': {
      // Multi = OR over the listed gates (Node SDK Evaluator).
      const names = Array.isArray(targetValue) ? targetValue.map(String) : [String(targetValue)];
      return { type: c.type === 'multi_pass_gate' ? 'passes_gate' : 'fails_gate', operator: null, targetValue: names, raw };
    }
    case 'current_time':
      return { type: 'time', ...base };
    case 'unit_id': {
      const idType = c.idType ?? (c.additionalValues?.custom_id as string | undefined) ?? 'userID';
      if (idType.toLowerCase() === 'userid' && operator !== 'in_segment_list' && operator !== 'not_in_segment_list') {
        return { type: 'user_id', ...base };
      }
      return { type: 'unit_id', customID: idType, ...base };
    }
    default: {
      const t = ownValue(PASSTHROUGH, c.type);
      if (t) return { type: t, ...(field ? { field } : {}), ...base };
      ctx.warn({ code: 'unknown_condition', path: ctx.path, message: `Unknown condition type "${c.type}"; kept for a decision.` });
      return { type: 'unknown', field, ...base };
    }
  }
}
