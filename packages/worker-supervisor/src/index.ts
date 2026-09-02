import { fileURLToPath } from 'node:url';

/**
 * @nexttime/worker-supervisor — docker-socket supervisor for entry and Worker containers
 * (design doc §7.3). Placeholder for the R1 repo skeleton; real behavior lands in S1/S2.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/worker-supervisor ${VERSION}: not implemented yet`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
