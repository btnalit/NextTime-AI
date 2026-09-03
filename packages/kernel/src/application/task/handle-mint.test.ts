import { describe, expect, it } from 'vitest';
import { WORKER_CEILING_CAPABILITIES } from '../../governance/capability/index.js';
import { EMPTY_CAPABILITY_SCOPE, computeChildHandleScope } from './handle-mint.js';
import { InvokeWorkerAttenuationError, InvokeWorkerValidationError } from './types.js';

/**
 * application/task/handle-mint.test: pure, no-DB unit tests for `computeChildHandleScope` — the
 * literal mechanism behind docs/development-tasks.md S2.7's acceptance criterion "入口 Handle 请求
 * 含 execute 的子 Handle 被拒" (see handle-mint.ts's own module doc comment for the full rule).
 */

describe('computeChildHandleScope', () => {
  it('narrows to the intersection of declared capabilities and the worker ceiling (drops an unregistered name)', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: ['get_object', 'not_a_real_capability'],
      declaredGates: [],
    });
    // S2.9: list_allowed_operations/report_task_result are force-unioned in unconditionally (see
    // handle-mint.ts's own doc comment) — with `unconstrained` authority every non-execute-class
    // name passes through, so both appear here alongside the explicitly declared `get_object`.
    expect(scope.capabilities).toEqual([
      'get_object',
      'list_allowed_operations',
      'report_task_result',
    ]);
  });

  it('entry Handle (no execute-class capability in scope) requesting an execute-class capability is rejected — S2.7 acceptance', () => {
    const entryLikeScope = {
      capabilities: ['get_object', 'traverse', 'invoke_worker'], // never <gate>.<op>:execute
      resources: {},
    };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: entryLikeScope,
        declaredCapabilities: ['get_object', '<gate>.<op>:execute'],
        declaredGates: [],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('request_action is also treated as execute-class and rejected the same way', () => {
    const entryLikeScope = { capabilities: ['get_object'], resources: {} };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: entryLikeScope,
        declaredCapabilities: ['request_action'],
        declaredGates: [],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('a non-execute-class capability the parent lacks is silently dropped, not rejected', () => {
    const parentScope = { capabilities: ['get_object'], resources: {} };
    const scope = computeChildHandleScope({
      parentAuthority: parentScope,
      declaredCapabilities: ['get_object', 'propose_skill'], // propose_skill not held by parent
      declaredGates: [],
    });
    expect(scope.capabilities).toEqual(['get_object']);
  });

  it('a Worker Handle that already holds the execute-class capability can pass it to a child', () => {
    const workerScope = {
      capabilities: ['get_object', '<gate>.<op>:execute'],
      resources: { gatekeeper: ['gk-1'] },
    };
    const scope = computeChildHandleScope({
      parentAuthority: workerScope,
      declaredCapabilities: ['get_object', '<gate>.<op>:execute'],
      declaredGates: ['gk-1'],
    });
    expect(scope.capabilities).toContain('<gate>.<op>:execute');
    expect(scope.resources.gatekeeper).toEqual(['gk-1']);
  });

  it('requesting a gate not covered by the parent scope is rejected when execute-class capabilities are involved', () => {
    const workerScope = {
      capabilities: ['<gate>.<op>:execute'],
      resources: { gatekeeper: ['gk-1'] },
    };
    expect(() =>
      computeChildHandleScope({
        parentAuthority: workerScope,
        declaredCapabilities: ['<gate>.<op>:execute'],
        declaredGates: ['gk-1', 'gk-2'],
        requestedGates: ['gk-2'],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('requesting a gate the WorkerDefinition itself never declared is a validation error, not attenuation', () => {
    expect(() =>
      computeChildHandleScope({
        parentAuthority: 'unconstrained',
        declaredCapabilities: ['get_object'],
        declaredGates: ['gk-1'],
        requestedGates: ['gk-not-declared'],
      }),
    ).toThrow(InvokeWorkerValidationError);
  });

  it('unconstrained (human/owner root call) skips the subset check entirely, including for execute-class capabilities', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: ['get_object', '<gate>.<op>:execute'],
      declaredGates: ['gk-1'],
    });
    expect(scope.capabilities).toContain('<gate>.<op>:execute');
    expect(scope.resources.gatekeeper).toEqual(['gk-1']);
  });

  it('an empty scope (non-owner human, or a caller with nothing) rejects any execute-class need', () => {
    expect(() =>
      computeChildHandleScope({
        parentAuthority: EMPTY_CAPABILITY_SCOPE,
        declaredCapabilities: ['<gate>.<op>:execute'],
        declaredGates: ['gk-1'],
      }),
    ).toThrow(InvokeWorkerAttenuationError);
  });

  it('defaults requestedGates to every declared gate when omitted', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: ['get_object'],
      declaredGates: ['gk-1', 'gk-2'],
    });
    expect(scope.resources.gatekeeper).toEqual(['gk-1', 'gk-2']);
  });

  it('never returns a capability outside WORKER_CEILING_CAPABILITIES', () => {
    const scope = computeChildHandleScope({
      parentAuthority: 'unconstrained',
      declaredCapabilities: [...WORKER_CEILING_CAPABILITIES, 'grant_capability'], // human-only, must be filtered
      declaredGates: [],
    });
    expect(scope.capabilities).not.toContain('grant_capability');
    for (const capability of scope.capabilities) {
      expect(WORKER_CEILING_CAPABILITIES).toContain(capability);
    }
  });
});
