import { fileURLToPath } from 'node:url';

/**
 * @nexttime/gatekeeper-base — gatekeeper protocol, transport kinds, manifest model, credential
 * resolution, idempotent apply storage (design doc §7.5). Placeholder for the R1 repo skeleton;
 * real behavior lands in S2.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/gatekeeper-base ${VERSION}: not implemented yet`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
