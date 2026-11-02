import { redactConnectionAddressesIn } from '../../governance/connections/index.js';
import { redactSuspectedSecrets } from '../../governance/redaction/index.js';

/**
 * application/gateway/audit-copy (S11 AA3c-1): the audit copy of what a handler adds to its own
 * AuditRecord (`CapabilityHandlerResult.auditPayload`), on the workspace and the platform paths
 * alike (dispatch.ts) — the same two rules as the copy of the call's params:
 *
 *   - every gate address in it (a `target`, `endpoint` or `manifestSource`, at any depth) as the
 *     connection rule shows it (`redactConnectionAddressesIn`: a user name and password, a query
 *     and a fragment that could carry a credential are cut);
 *   - every value that looks like a secret wherever it is (`redactSuspectedSecrets`, the value
 *     patterns: a JWT, `Bearer …`, `PGPASSWORD=…`, a URL's password, `?token=…`).
 *
 * Not the field-name rule the params copy adds: a handler's payload names its own fields after
 * secrets (`credentialReview.suspectedSecretValues`, a count), and that rule would replace them. A
 * handler still passes the caller's own text through `redactedForAudit` (which adds it); this is
 * the wall behind it, so nothing a handler forgets to redact reaches the audit log as written.
 */
export function auditedHandlerPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (payload === undefined) return {};
  const addresses = redactConnectionAddressesIn(payload);
  return redactSuspectedSecrets(addresses.value).value as Record<string, unknown>;
}
