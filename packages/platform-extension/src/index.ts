import { fileURLToPath } from 'node:url';

/**
 * @nexttime/platform-extension — the single shared pi extension, driven by NEXTTIME_MODE
 * (entry/worker/interactive — design doc §7.4). Placeholder for the R1 repo skeleton; real
 * behavior lands in S1/S2.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/platform-extension ${VERSION}: not implemented yet`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
