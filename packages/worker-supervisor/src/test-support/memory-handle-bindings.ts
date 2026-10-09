import type { HandleBinding } from '@nexttime/shared';
import type { HandleBindingStore } from '../handle-bindings.js';

/** An in-memory `HandleBindingStore` for tests that don't look at the file itself
 *  (handle-bindings.test.ts covers that). `failBind` makes every `bind` throw, like an unwritable
 *  volume. */
export function memoryHandleBindings(options: { failBind?: boolean } = {}): HandleBindingStore {
  const bindings = new Map<string, HandleBinding>();
  return {
    bind(ip, binding) {
      if (options.failBind) throw new Error('EACCES: permission denied');
      bindings.set(ip, { ...binding, boundAt: new Date(0).toISOString() });
    },
    // Same compare-and-delete as the file store (handle-bindings.ts `unbind`).
    unbind(ip, containerId) {
      const current = bindings.get(ip);
      if (!current) return false;
      if (current.containerId !== undefined && current.containerId !== containerId) return false;
      return bindings.delete(ip);
    },
    async retainLive(isLive) {
      const dropped: string[] = [];
      for (const [ip, binding] of [...bindings]) {
        if (!(await isLive(ip, binding))) {
          bindings.delete(ip);
          dropped.push(ip);
        }
      }
      return dropped;
    },
    snapshot() {
      return new Map(bindings);
    },
  };
}
