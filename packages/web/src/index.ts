/**
 * @nexttime/web — library-shaped entry kept for parity with every other package's uniform
 * contract (VERSION + main()). The actual app entry Vite builds is src/main.tsx (design doc
 * §7.6); this file is not bundled into the SPA.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/web ${VERSION}: not implemented yet`);
}
