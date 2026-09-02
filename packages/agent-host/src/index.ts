import { fileURLToPath } from 'node:url';

/**
 * @nexttime/agent-host — event bridge for the per-user resident entry agent container
 * (design doc §7.2). Placeholder for the R1 repo skeleton; real behavior lands in S1/S2.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/agent-host ${VERSION}: not implemented yet`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
