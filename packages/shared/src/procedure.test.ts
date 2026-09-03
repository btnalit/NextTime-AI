import { describe, expect, it } from 'vitest';
import { ProcedureStepSchema, ProposeProcedureContentSchema } from './procedure.js';

describe('ProcedureStepSchema', () => {
  it('accepts an operation step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'operation',
      gatekeeperId: 'gk-1',
      operationName: 'container.restart',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a worker step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'worker',
      definitionId: 'def-1',
      version: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an approval step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'approval',
      description: 'Finance must approve the expense claim.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a verify step', () => {
    const result = ProcedureStepSchema.safeParse({
      kind: 'verify',
      description: 'Confirm the stock level changed.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(ProcedureStepSchema.safeParse({ kind: 'bogus' }).success).toBe(false);
  });

  it('rejects an approval/verify step with no description', () => {
    expect(ProcedureStepSchema.safeParse({ kind: 'approval' }).success).toBe(false);
    expect(ProcedureStepSchema.safeParse({ kind: 'verify' }).success).toBe(false);
  });

  it('rejects a worker step with a non-positive version', () => {
    expect(
      ProcedureStepSchema.safeParse({ kind: 'worker', definitionId: 'd', version: 0 }).success,
    ).toBe(false);
  });

  it('rejects an operation step with unknown extra fields (strict)', () => {
    expect(
      ProcedureStepSchema.safeParse({
        kind: 'operation',
        gatekeeperId: 'gk-1',
        operationName: 'op',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('ProposeProcedureContentSchema', () => {
  it('accepts a minimal procedure with an empty steps array (propose is permissive)', () => {
    const result = ProposeProcedureContentSchema.safeParse({
      name: 'restart-and-verify',
      description: 'Restart a container and confirm it came back up.',
      steps: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a full multi-step procedure', () => {
    const result = ProposeProcedureContentSchema.safeParse({
      name: 'restart-and-verify',
      description: 'Restart a container and confirm it came back up.',
      steps: [
        { kind: 'operation', gatekeeperId: 'gk-1', operationName: 'container.restart' },
        { kind: 'verify', description: 'Container status is running.' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing field', () => {
    expect(ProposeProcedureContentSchema.safeParse({ name: 'x', description: 'y' }).success).toBe(
      false,
    );
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(
      ProposeProcedureContentSchema.safeParse({
        name: 'x',
        description: 'y',
        steps: [],
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
