import { createHash } from 'node:crypto';
import { canonicalJson } from '@nexttime/gatekeeper-base';

/** `sha256:<hex>` of `value`'s canonical JSON (keys sorted, `undefined` members dropped — the same
 *  canonical form the Operation digest and `manifestDigest` use). `value` is JSON data. */
export function contentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}
