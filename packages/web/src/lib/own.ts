/**
 * lib/own: lookups in a plain-object table keyed by text the console does not control — a URL
 * query (`#/govern/audit?resourceType=…`), a kernel error code, a server-supplied count key.
 * `TABLE[key]` on such a key also finds `Object.prototype` members: `__proto__` returns the
 * prototype object, `constructor` returns a function, and rendering either crashes the page.
 * `ownEntry` answers only the table's own keys.
 */
export function ownEntry<V>(
  table: Readonly<Partial<Record<PropertyKey, V>>>,
  key: PropertyKey,
): V | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
