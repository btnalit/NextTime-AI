import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KernelClient } from '../kernel-client.js';
import { type FakeKernel, startFakeKernel } from '../test-support/fake-kernel.js';
import {
  ADMIN_TOOL_CAPABILITY_NAMES,
  PROPOSAL_TARGETS_CUSTOM_TYPE,
  registerAdminMode,
  renderProposalTargets,
} from './admin.js';

/**
 * admin mode (S11 AA4c-2) against a minimal `ExtensionAPI` stub, as entry.test.ts does for entry
 * mode: what it registers, what it calls at the start of a Turn, and what it never calls.
 */

// biome-ignore lint/suspicious/noExplicitAny: event/handler shapes vary per pi.on() overload.
type Handler = (...args: any[]) => any;

function createFakePi() {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler>();
  const active: string[] = ['read', 'bash'];
  const api = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: ToolDefinition) => {
      if (!tools.has(tool.name)) active.push(tool.name);
      tools.set(tool.name, tool);
    }),
    getActiveTools: vi.fn(() => [...active]),
    getAllTools: vi.fn(() =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    ),
    setActiveTools: vi.fn((names: string[]) => {
      active.splice(0, active.length, ...new Set(names));
    }),
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;
  return { api, tools, handlers, active };
}

const OBSERVE_OP = {
  gatekeeperId: 'gk-1',
  gateName: 'routeros',
  name: 'list_interfaces',
  operation: {
    name: 'list_interfaces',
    mode: 'observe',
    description: 'List interfaces',
    params_schema: { type: 'object', properties: {} },
  },
};

const EXECUTE_OP = {
  ...OBSERVE_OP,
  name: 'reboot',
  operation: { ...OBSERVE_OP.operation, name: 'reboot', mode: 'execute' },
};

describe('registerAdminMode', () => {
  let kernel: FakeKernel;
  let fake: ReturnType<typeof createFakePi>;
  let kernelClient: KernelClient;

  beforeEach(async () => {
    kernel = await startFakeKernel();
    fake = createFakePi();
    kernelClient = new KernelClient({ kernelUrl: kernel.url });
    kernel.setHandler('list_allowed_operations', () => ({
      ok: true,
      result: { items: [OBSERVE_OP, EXECUTE_OP] },
    }));
    kernel.setHandler('agent_list_proposal_targets', () => ({
      ok: true,
      result: { targetWorkspaceIds: ['ws-target-1', 'ws-target-2'] },
    }));
    registerAdminMode(fake.api, { kernelClient });
  });

  afterEach(async () => {
    await kernel.close();
  });

  it('registers exactly its static tools, none of the entry agent’s own', () => {
    expect([...fake.tools.keys()]).toEqual([...ADMIN_TOOL_CAPABILITY_NAMES]);
    for (const name of [
      'get_entry_context',
      'report_turn',
      'invoke_worker',
      'record_decision',
      'request_connection',
      'propose_goal',
      'observe_operation',
      'request_action',
    ]) {
      expect(fake.tools.has(name)).toBe(false);
    }
    expect([...fake.handlers.keys()].sort()).toEqual([
      'before_agent_start',
      'input',
      'session_start',
    ]);
  });

  it('projects the observe-class gate tools only, and calls them through observe_operation', async () => {
    await fake.handlers.get('session_start')?.({}, {});
    const gateTools = [...fake.tools.keys()].filter((name) => name.includes('list_interfaces'));
    expect(gateTools).toHaveLength(1);
    expect([...fake.tools.keys()].some((name) => name.includes('reboot'))).toBe(false);

    kernel.setHandler('observe_operation', () => ({ ok: true, result: { interfaces: [] } }));
    const tool = fake.tools.get(gateTools[0] as string);
    await tool?.execute('call-1', {}, undefined, undefined, undefined as never);
    expect(kernel.requests.at(-1)).toMatchObject({
      capability: 'observe_operation',
      params: { gatekeeperId: 'gk-1', operation: 'list_interfaces', params: {} },
    });
  });

  it('strips the Turn marker, and puts the proposal targets ahead of the run under that Turn’s id', async () => {
    const transformed = fake.handlers.get('input')?.({
      text: '<!--nexttime:turn_id=turn-0042-->\nlook at the gates',
    });
    expect(transformed).toEqual({ action: 'transform', text: 'look at the gates' });

    const result = await fake.handlers.get('before_agent_start')?.({}, {});
    expect(result).toEqual({
      message: {
        customType: PROPOSAL_TARGETS_CUSTOM_TYPE,
        content: renderProposalTargets({ targetWorkspaceIds: ['ws-target-1', 'ws-target-2'] }),
        display: false,
      },
    });
    expect(result.message.content).toContain('- ws-target-1\n- ws-target-2');

    const targetsCall = kernel.requests.find(
      (request) => request.capability === 'agent_list_proposal_targets',
    );
    expect(targetsCall).toMatchObject({ params: {}, correlationId: 'turn-0042' });
    // Neither entry-mode call, ever.
    expect(kernel.requests.map((request) => request.capability)).not.toContain('get_entry_context');
  });

  it('says the targets could not be read when the read fails, and lists none', async () => {
    kernel.setHandler('agent_list_proposal_targets', () => ({
      ok: false,
      error: { code: 'internal', message: 'boom' },
    }));
    const result = await fake.handlers.get('before_agent_start')?.({}, {});
    expect(result.message.content).toBe(renderProposalTargets(undefined));
    expect(result.message.content).toContain('could not be read');
    expect(result.message.content).toContain('`agent_list_proposal_targets`');
  });

  it('says plainly when no workspace is chosen', () => {
    const text = renderProposalTargets({ targetWorkspaceIds: [] });
    expect(text).toContain('has not chosen any workspace');
    expect(text).not.toContain('- ');
  });

  it('passes a tool’s refusal through as the tool error, code included', async () => {
    kernel.setHandler('propose_admin_proposal', () => ({
      ok: false,
      error: {
        code: 'admin_proposal_target_not_chosen',
        message: 'your administrator has not chosen that workspace',
      },
    }));
    const tool = fake.tools.get('propose_admin_proposal');
    await expect(
      tool?.execute('call-1', { segments: [] }, undefined, undefined, undefined as never),
    ).rejects.toThrow(
      'admin_proposal_target_not_chosen: your administrator has not chosen that workspace',
    );
  });
});
