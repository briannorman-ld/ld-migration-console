/**
 * Config-spec (download_config_specs) file intake (PLAN §4.2 "Parsing").
 * Accepts JSON, gzip, or brotli (where the runtime can decode it); detects v1 vs v2; rejects
 * forms that can't be migrated with an explanation of what to fetch instead.
 */

export type SpecVersion = 1 | 2;

export interface ParsedSpec {
  version: SpecVersion;
  json: Record<string, unknown>;
  /** Hints that the key that produced this file was scoped (partial file). */
  partialHints: string[];
  /** The file was wrapped (e.g. a data-adapter value holding a JSON string). */
  unwrapped?: 'data_adapter_string';
}

export class SpecRejectedError extends Error {
  constructor(
    readonly reason: 'protobuf' | 'client_initialize_response' | 'no_updates' | 'not_a_spec' | 'unsupported_compression' | 'invalid_json' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'SpecRejectedError';
  }
}

export const FETCH_INSTRUCTIONS =
  'Fetch the full spec as JSON with no query parameters: ' +
  'curl -o spec.json "https://api.statsigcdn.com/v2/download_config_specs/<CLIENT_KEY>.json" ' +
  '(use a client key with only the "Allow Download Config Specs" scope, covering all environments and target apps).';

/**
 * Upper bound on a spec, compressed or not (256 MiB). Real specs run to tens of MB at most; the
 * bound stops a mis-picked file or a gzip bomb from exhausting the worker, and is well under the
 * engine's maximum string length that JSON.parse would hit anyway.
 */
export const MAX_SPEC_BYTES = 256 * 1024 * 1024;

/**
 * Top-level DCS fields that carry the project's client SDK keys (`sdk_keys_to_app_ids` maps
 * plaintext keys to target apps; the hashed variant is its SHA form). They play no part in a
 * migration and must not reach IndexedDB in the clear (CLAUDE.md: tokens never persisted
 * unencrypted), so `classifySpec` deletes them before the spec leaves the parser. The store
 * refuses an upload that still has them (`packages/store`).
 */
export const SPEC_SECRET_FIELDS = ['sdk_keys_to_app_ids', 'hashed_sdk_keys_to_app_ids'] as const;

function tooLarge(what: string): SpecRejectedError {
  return new SpecRejectedError('too_large', `${what} is larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB, which is bigger than any config spec. Check that this is the download_config_specs file.`);
}

export async function parseSpecBytes(bytes: Uint8Array, filename = ''): Promise<ParsedSpec> {
  if (bytes.byteLength > MAX_SPEC_BYTES) throw tooLarge('The file');
  const lower = filename.toLowerCase();
  if (/\.pb(\.br|\.gz)?$/.test(lower)) {
    throw new SpecRejectedError('protobuf', `This looks like the protobuf form of the config spec, which can't be read. ${FETCH_INSTRUCTIONS}`);
  }
  let data = bytes;
  if (isGzip(data)) {
    data = await decompress(data, 'gzip');
  } else if (lower.endsWith('.br')) {
    data = await decompress(data, 'brotli');
  }
  const text = new TextDecoder().decode(data).replace(/^﻿/, '');
  if (!/^\s*[[{"]/.test(text)) {
    throw new SpecRejectedError('protobuf', `The file isn't JSON (it may be protobuf or a compressed format we can't read here). ${FETCH_INSTRUCTIONS}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SpecRejectedError('invalid_json', `The file isn't valid JSON: ${(e as Error).message}`);
  }
  return classifySpec(parsed);
}

export function classifySpec(parsed: unknown): ParsedSpec {
  let unwrapped: ParsedSpec['unwrapped'];
  // SDK data adapters (Redis, Edge Config) store the spec as a JSON string.
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
      unwrapped = 'data_adapter_string';
    } catch {
      throw new SpecRejectedError('not_a_spec', 'The file contains a string that is not a config spec.');
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpecRejectedError('not_a_spec', 'The file is not a StatSig config spec object.');
  }
  const json = parsed as Record<string, unknown>;
  if ('hash_used' in json || 'evaluated_keys' in json || ('generator' in json && 'user' in json)) {
    throw new SpecRejectedError(
      'client_initialize_response',
      `This is a client initialize response (getClientInitializeResponse). It is hashed and evaluated for a single user, so it contains no rules. ${FETCH_INSTRUCTIONS}`,
    );
  }
  const hasSections = 'feature_gates' in json || 'dynamic_configs' in json || 'layer_configs' in json;
  if (!hasSections) {
    if (json.has_updates === false) {
      throw new SpecRejectedError('no_updates', `This response says "has_updates: false": it was fetched with sinceTime or a checksum. ${FETCH_INSTRUCTIONS}`);
    }
    throw new SpecRejectedError('not_a_spec', 'The file has no feature_gates, dynamic_configs or layer_configs; it is not a config spec.');
  }
  const isV2 = json.response_format === 'dcs-v2' || (json.feature_gates !== undefined && !Array.isArray(json.feature_gates));
  const partialHints: string[] = [];
  if (typeof json.app_id === 'string' && json.app_id) {
    partialHints.push(`The key is scoped to target app "${json.app_id}": entities for other target apps may be missing.`);
  }
  if (json.is_delta === true || json.deltas_full_response === false) {
    partialHints.push('This looks like a delta response; fetch without sinceTime/checksum/accept_deltas for the full spec.');
  }
  for (const k of SPEC_SECRET_FIELDS) delete json[k];
  return { version: isV2 ? 2 : 1, json, partialHints, ...(unwrapped ? { unwrapped } : {}) };
}

function isGzip(b: Uint8Array): boolean {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}

async function decompress(bytes: Uint8Array, format: 'gzip' | 'brotli'): Promise<Uint8Array> {
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream(format as CompressionFormat);
  } catch {
    // TODO(M1 follow-up): bundle a WASM brotli decoder (PLAN §3.2) for browsers without native brotli.
    throw new SpecRejectedError('unsupported_compression', `This browser can't decompress ${format}. Decompress the file first (e.g. \`brotli -d spec.json.br\`) and upload the JSON.`);
  }
  // Read in chunks so the decompressed size is bounded before it is all in memory.
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(ds).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_SPEC_BYTES) {
      await reader.cancel();
      throw tooLarge('The decompressed file');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
