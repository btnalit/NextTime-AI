import type { ResultMapping } from '@nexttime/shared';
import jmespath from 'jmespath';
import type { ObservedFactCandidate } from './protocol.js';

/**
 * Applies an Operation's `result_mapping` (JMESPath, design doc §5.1.4/§7.5) to a raw response,
 * producing `observed` fact candidates `{objectType, identity, properties}` — the kernel writes
 * these as `observed` Facts (`request_action`'s observe path, `governance/gatekeepers`).
 *
 * `jmes_path` is evaluated against the whole response first; its result may be a single object or
 * an array (one candidate is produced per array element, or one for a single object). For each
 * matched item: `identity` is built from `identity_keys` (each key read off the item by the same
 * name), and `properties` is either every `attributes`-declared key (each value itself a JMESPath
 * expression evaluated relative to the item) when `attributes` is given, or the item's own plain
 * fields otherwise.
 */
export function applyResultMapping(
  response: unknown,
  mapping: ResultMapping,
): ObservedFactCandidate[] {
  const matched: unknown = jmespath.search(response, mapping.jmes_path);
  const items = toItemArray(matched);

  return items
    .filter((item): item is Record<string, unknown> => isPlainObject(item))
    .map((item) => ({
      objectType: mapping.object_type,
      identity: pickIdentity(item, mapping.identity_keys),
      properties: mapping.attributes ? mapAttributes(item, mapping.attributes) : { ...item },
    }));
}

function toItemArray(matched: unknown): unknown[] {
  if (matched === undefined || matched === null) return [];
  return Array.isArray(matched) ? matched : [matched];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickIdentity(
  item: Record<string, unknown>,
  identityKeys: readonly string[],
): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const key of identityKeys) {
    identity[key] = item[key];
  }
  return identity;
}

function mapAttributes(
  item: Record<string, unknown>,
  attributes: Record<string, string>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [outputKey, expression] of Object.entries(attributes)) {
    properties[outputKey] = jmespath.search(item, expression);
  }
  return properties;
}
