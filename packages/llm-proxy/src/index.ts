import { fileURLToPath } from 'node:url';

/**
 * @nexttime/llm-proxy — per-provider passthrough proxy; verifies kernel-issued Handle
 * signatures locally, injects real provider keys, whitelists models, reports usage back to the
 * kernel (design doc §7.7). Placeholder for the R1 repo skeleton; real behavior lands starting
 * with S1's model calls.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/llm-proxy ${VERSION}: not implemented yet`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
