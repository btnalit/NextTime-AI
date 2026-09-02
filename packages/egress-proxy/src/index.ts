import { fileURLToPath } from 'node:url';

/**
 * @nexttime/egress-proxy — forwarding proxy on the control/workers networks: allows public
 * egress, denies RFC1918/link-local/internal service names, and records per-domain byte counts
 * (design doc §7.9). Placeholder for the R1 repo skeleton; real behavior lands in S2.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/egress-proxy ${VERSION}: not implemented yet`);
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main();
}
