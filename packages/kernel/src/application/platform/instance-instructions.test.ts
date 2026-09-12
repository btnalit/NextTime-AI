import { describe, expect, it } from 'vitest';
import {
  INSTANCE_INSTRUCTIONS_MARKER,
  PROMPT_ADDENDUM_MARKER,
  composeSystemPrompt,
} from './instance-instructions.js';

/**
 * application/platform/instance-instructions.test: pure unit coverage of `composeSystemPrompt`
 * (P-A2, docs/platform-admin-design.md §6.6) — the one function both container paths share
 * (`application/host-bridge/agent-host-runtime.ts`'s entry Turn and `application/task/invoke.ts`/
 * `lifecycle.ts`'s Worker spawn), so the ordering it fixes is asserted once, here, rather than
 * twice through a database.
 *
 * The order is the whole point: the WorkerDefinition's own prompt first, the administrator's
 * platform-wide `instanceInstructions` second, the user's `AgentProfile.promptAddendum` last —
 * neither of the two appended sections can precede, and therefore neither can be read as
 * overriding, the platform's own instructions.
 */

const BASE = 'You are the NextTime entry agent.';
const INSTRUCTIONS = 'Never quote internal prices.';
const ADDENDUM = 'Prefer concise answers.';

describe('composeSystemPrompt', () => {
  it('orders the three parts base → platform marker → addendum marker', () => {
    const prompt = composeSystemPrompt({
      base: BASE,
      instanceInstructions: INSTRUCTIONS,
      promptAddendum: ADDENDUM,
    });

    expect(prompt).toBe(
      `${BASE}\n\n${INSTANCE_INSTRUCTIONS_MARKER}\n${INSTRUCTIONS}\n\n${PROMPT_ADDENDUM_MARKER}\n${ADDENDUM}`,
    );
    expect(prompt?.startsWith(BASE)).toBe(true);
    expect(prompt?.indexOf(INSTANCE_INSTRUCTIONS_MARKER)).toBeLessThan(
      prompt?.indexOf(PROMPT_ADDENDUM_MARKER) ?? -1,
    );
  });

  it('trims the instructions before marking them', () => {
    const prompt = composeSystemPrompt({
      base: BASE,
      instanceInstructions: `\n  ${INSTRUCTIONS}  \n`,
    });

    expect(prompt).toBe(`${BASE}\n\n${INSTANCE_INSTRUCTIONS_MARKER}\n${INSTRUCTIONS}`);
  });

  it('treats whitespace-only instructions as absent', () => {
    expect(composeSystemPrompt({ base: BASE, instanceInstructions: '   \n\t ' })).toBe(BASE);
  });

  it('returns undefined when every part is empty', () => {
    // `undefined` (not `''`) is what lets the caller omit the field entirely so the container
    // keeps `entrypoint.sh`'s static default, exactly as before P-A2.
    expect(composeSystemPrompt({ base: undefined })).toBeUndefined();
    expect(
      composeSystemPrompt({ base: '', instanceInstructions: '', promptAddendum: '' }),
    ).toBeUndefined();
    expect(
      composeSystemPrompt({ base: undefined, instanceInstructions: null, promptAddendum: null }),
    ).toBeUndefined();
  });

  it('keeps the base alone when the other two are empty', () => {
    expect(composeSystemPrompt({ base: BASE })).toBe(BASE);
    expect(
      composeSystemPrompt({ base: BASE, instanceInstructions: null, promptAddendum: null }),
    ).toBe(BASE);
  });

  it('still produces a marked section when only one of the two addenda is set', () => {
    expect(composeSystemPrompt({ base: undefined, instanceInstructions: INSTRUCTIONS })).toBe(
      `${INSTANCE_INSTRUCTIONS_MARKER}\n${INSTRUCTIONS}`,
    );
    expect(composeSystemPrompt({ base: undefined, promptAddendum: ADDENDUM })).toBe(
      `${PROMPT_ADDENDUM_MARKER}\n${ADDENDUM}`,
    );
  });
});
