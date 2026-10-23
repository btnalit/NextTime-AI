import type { OperationGovernanceFieldsWire } from '@nexttime/shared';

/** An Operation's governance fields as the kernel sends them (`OperationGovernanceFieldsWire`),
 *  shared by the governance confirms' tests: the classification given, every other field at the
 *  value an Operation that declares nothing more has (STATUS leftover 344). */
export function governanceFields(
  fields: Pick<OperationGovernanceFieldsWire, 'mode' | 'blastRadius' | 'autoApprovable'> &
    Partial<OperationGovernanceFieldsWire>,
): OperationGovernanceFieldsWire {
  return {
    awaitDecision: false,
    reads: [],
    writes: [],
    readOnlyHint: null,
    destructiveHint: null,
    idempotentHint: null,
    ...fields,
  };
}
