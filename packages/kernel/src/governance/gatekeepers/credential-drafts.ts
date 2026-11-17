import { findSuspectedSecrets } from '../redaction/index.js';

/**
 * governance/gatekeepers/credential-drafts (legacy 198, #532 review O): a gate's imported draft
 * whose definition carries suspected credential values — what `publishOperation` asks the person
 * publishing it to confirm (`assertDraftCredentialsReviewed`, decision 2026-10-09 「二次确认」). A
 * bulk publish (`publish_manifest`, `enable_gate_instance`'s landing) has nobody confirming each
 * definition, and used to publish it unchecked: the check runs only for a call with an actor. As
 * for a gate-owned param or answers that mean "does not exist", the bulk publish now leaves such a
 * draft unpublished and lists it; a person publishes it with `publish_operation` and
 * `credentialsReviewed: true`.
 */
export interface CredentialDraft {
  readonly name: string;
  readonly suspectedSecretValues: number;
  /** Where, as field paths (at most 20) — never a value. */
  readonly suspectedSecretPaths: readonly string[];
}

/** `name`'s entry when `operation` (its stored definition) carries suspected credential values —
 *  the count `publishOperation` checks, values only (a definition declares fields, so a field's
 *  name alone is not one) — else `undefined`. */
export function credentialDraftOf(name: string, operation: unknown): CredentialDraft | undefined {
  const found = findSuspectedSecrets(operation);
  return found.count > 0
    ? { name, suspectedSecretValues: found.count, suspectedSecretPaths: found.paths }
    : undefined;
}

/** The count alone, for a preview of an announced definition that is not stored yet. */
export function suspectedCredentialValuesOf(operation: unknown): number {
  return findSuspectedSecrets(operation).count;
}
