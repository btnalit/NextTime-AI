import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_ACTING_CONTEXT,
  currentActingContext,
  runWithActingContext,
  runWithStandingActingContext,
} from './acting-context.js';

/**
 * substrate/audit/acting-context (batch D3, migration core 0054): the context `writeAudit` takes
 * `acting_through` / `acting_session_id` from — open for exactly the call that set it — and the
 * rule that only dispatch, the background services and the approval drainer set one.
 */

const KERNEL_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('acting context (unit)', () => {
  it('is absent outside every context', () => {
    expect(currentActingContext()).toBeUndefined();
  });

  it('holds what the call set, refined part-way through, for everything the call awaits', async () => {
    await runWithActingContext(undefined, async (acting) => {
      expect(currentActingContext()).toBeUndefined();
      acting.set({ actingThrough: 'entry_agent', actingSessionId: 'session-1' });
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentActingContext()).toEqual({
        actingThrough: 'entry_agent',
        actingSessionId: 'session-1',
      });
    });
    expect(currentActingContext()).toBeUndefined();
  });

  it('closes when the call settles: work it left running reads nothing, on success and on failure', async () => {
    const seen: unknown[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leftBehind: Promise<void>[] = [];
    for (const fails of [false, true]) {
      await runWithActingContext({ actingThrough: 'person' }, async () => {
        leftBehind.push(
          released.then(() => {
            seen.push(currentActingContext());
          }),
        );
        if (fails) throw new Error('refused');
      }).catch(() => undefined);
    }
    release();
    await Promise.all(leftBehind);
    expect(seen).toEqual([undefined, undefined]);
  });

  it('a nested call has its own context, and the outer one is back when it returns', async () => {
    await runWithActingContext({ actingThrough: 'person' }, async () => {
      await runWithActingContext(SYSTEM_ACTING_CONTEXT, async () => {
        expect(currentActingContext()).toEqual({ actingThrough: 'system' });
      });
      expect(currentActingContext()).toEqual({ actingThrough: 'person' });
    });
  });

  it('a standing context stays open for the timers started in it', async () => {
    const seen = await runWithStandingActingContext(
      SYSTEM_ACTING_CONTEXT,
      () =>
        new Promise<unknown>((resolve) => {
          setTimeout(() => resolve(currentActingContext()), 1);
        }),
    );
    expect(seen).toEqual({ actingThrough: 'system' });
  });
});

describe('who sets an acting context (guard)', () => {
  /** The only non-test kernel files that may open one (acting-context.ts's own doc comment). */
  const ALLOWED = new Set([
    'substrate/audit/acting-context.ts',
    'substrate/audit/index.ts',
    'application/gateway/dispatch.ts',
    'governance/approval/drainer.ts',
    'index.ts',
  ]);

  it('no handler opens one: only dispatch, the background services and the approval drainer', () => {
    const files = execFileSync('git', ['ls-files', '*.ts'], { cwd: KERNEL_SRC, encoding: 'utf8' })
      .split('\n')
      .filter((file) => file !== '' && !file.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter(
      (file) =>
        !ALLOWED.has(file) &&
        /\brunWith(Standing)?ActingContext\b/.test(
          readFileSync(path.join(KERNEL_SRC, file), 'utf8'),
        ),
    );
    expect(offenders).toEqual([]);
  });
});
