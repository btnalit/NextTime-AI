import { describe, expect, it } from 'vitest';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { stepReferenceRefusalOf, stepReferenceText } from './step-reference.js';

const zh: Translate = (text) => text;
const refused = (message: string, details?: Record<string, unknown>) =>
  new HttpError('capability_error', message, 'invalid_step_reference', details);

describe('legacy 493: invalid_step_reference read as which step and why', () => {
  it('an Operation not published, its quoted name read back', () => {
    const refusal = stepReferenceRefusalOf(
      refused(
        'Procedure step 1 does not resolve: Operation "orders.\\"lookup\\"" on Gatekeeper 0f6d7b8e-1111-4222-8333-944445555666 is not published (or does not exist)',
      ),
    );
    expect(refusal).toEqual({
      stepIndex: 1,
      reason: 'operation_not_published',
      operationName: 'orders."lookup"',
    });
    expect(refusal && stepReferenceText(refusal, zh)).toMatch(
      /^第 2 步（Operation「orders\."lookup"」）：这个 Operation 没有发布/,
    );
  });

  it('a Worker version not published, and an entry definition', () => {
    expect(
      stepReferenceRefusalOf(
        refused(
          'Procedure step 0 does not resolve: WorkerDefinition 0f6d7b8e-1111-4222-8333-944445555666@3 is not published: WorkerDefinition is deprecated',
        ),
      ),
    ).toEqual({ stepIndex: 0, reason: 'worker_not_published', version: 3 });
    const entry = stepReferenceRefusalOf(
      refused(
        'Procedure step 2 does not resolve: WorkerDefinition 0f6d7b8e-1111-4222-8333-944445555666@1 is entry-kind: a step runs only a worker-kind WorkerDefinition',
      ),
    );
    expect(entry).toEqual({ stepIndex: 2, reason: 'not_worker_kind', version: 1 });
    expect(entry && stepReferenceText(entry, zh)).toMatch(/^第 3 步（Worker 定义）：这是入口定义/);
  });

  it('a Procedure with no step, and a reason it does not know', () => {
    const empty = stepReferenceRefusalOf(
      refused(
        'Procedure step -1 does not resolve: a Procedure must have at least one step to publish',
      ),
    );
    expect(empty).toEqual({ stepIndex: null, reason: 'no_steps' });
    expect(empty && stepReferenceText(empty, zh)).toBe('流程至少要有一步才能发布。');
    expect(
      stepReferenceRefusalOf(
        refused('Procedure step 4 does not resolve: WorkerDefinition x@1 has no graph projection'),
      ),
    ).toEqual({ stepIndex: 4, reason: 'unresolved' });
  });

  it('reads details.stepIndex first, and is null for any other error', () => {
    expect(
      stepReferenceRefusalOf(refused('Procedure step 9 does not resolve: ?', { stepIndex: 1 }))
        ?.stepIndex,
    ).toBe(1);
    expect(
      stepReferenceRefusalOf(new HttpError('capability_error', 'nope', 'invalid_params')),
    ).toBeNull();
    expect(stepReferenceRefusalOf(new Error('x'))).toBeNull();
  });
});
