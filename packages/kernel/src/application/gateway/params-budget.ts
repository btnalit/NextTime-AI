/**
 * Legacy (#707 P2, GHSA-mrhx-c7xc-m3w5): Zod reports one issue per failing element of a collection
 * it has no size limit for — an array without `.max()` (zod 4.6.6+ stops at a failed `.max()`
 * before looking at elements) or a record with typed values. A 1 MiB call body of ~520,000 wrong
 * elements made ~520,000 issues: about 170 MB of heap and half a second per call. The budget below
 * counts a call's JSON values before Zod sees them and refuses the call past it, so no call can make
 * more issues than that.
 *
 * 128 Ki values: a real call body averaging 8 bytes or more per value reaches the 1 MiB body limit
 * (`/api/cap/*`, `/mcp`, the WS frame limit) before it reaches the budget, so the budget refuses
 * nothing a body could carry today; it caps an attack at about a quarter of the old cost.
 */
export const MAX_PARAMS_VALUES = 128 * 1024;

/** `true` when `value` holds more than `limit` JSON values (every array element and object member,
 *  at any depth, plus the value itself). Stops counting as soon as it passes the limit. */
export function exceedsValueBudget(value: unknown, limit: number = MAX_PARAMS_VALUES): boolean {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    count += 1;
    if (count > limit) return true;
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (next !== null && typeof next === 'object') {
      for (const member of Object.values(next)) pending.push(member);
    }
  }
  return false;
}
