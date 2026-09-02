/**
 * @nexttime/web — library-shaped entry kept for parity with every other package's uniform
 * contract (VERSION + main()). The real app entry Vite builds is `index.html` -> `src/main.tsx`
 * (design doc §7.6, S1.8: login, chat list, chat page, `lib/ws-client.ts`); Vite never loads this
 * file, since a static-site bundler's entry point is a script tag, not a package's `main`/
 * `exports` field.
 */
export const VERSION = '0.1.0';

export function main(): void {
  console.log(`@nexttime/web ${VERSION}`);
}
