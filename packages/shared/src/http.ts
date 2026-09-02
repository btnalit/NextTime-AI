/**
 * HTTP capability-route convention (S1.6, decided for S1.3 to implement the kernel side against):
 * every capability in the registry (capabilities.ts) is projected onto exactly one HTTP route,
 * `POST /api/cap/<capability_name>`, with a JSON body of the capability's params. The handle
 * channel authenticates with `Authorization: Bearer <CAPABILITY_HANDLE>`; the human channel uses
 * `X-API-Key` (§9.5) and is out of scope for this helper. Response envelope (both channels):
 * `{ok:true, result}` or `{ok:false, error:{code,message}}`.
 *
 * This is the single source of truth for the path shape, so the kernel (S1.3), the platform
 * extension (S1.6), and any future client agree by construction instead of by convention.
 */
export function capabilityRoute(name: string): string {
  return `/api/cap/${name}`;
}
