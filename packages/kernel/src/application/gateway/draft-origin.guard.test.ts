import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_CHANNEL_VALUES, CAPABILITY_REGISTRY } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import type { CapabilityHandlerContext } from './capability-handler.js';
import { draftOriginOf } from './draft-viewer.js';
import { CAPABILITY_HANDLERS } from './handlers.js';

/**
 * application/gateway/draft-origin.guard.test (pure, no DB) — S11 AA3a (legacy 293): a draft's
 * `origin` says which channel wrote it, and `platform` means the kernel wrote it with no caller at
 * all. So nothing a caller sends, over the human channel or through a Handle, may come out as
 * `platform`; only the kernel's own templates write it. Three rules hold that:
 *
 *  1. The gateway derives a draft's origin from the channel alone (`draftOriginOf`), and no
 *     channel gives `platform`.
 *  2. No capability takes an `origin` param: every dispatchable capability's `paramsSchema`
 *     refuses the key (dispatch.ts parses the params before any handler runs), so a caller cannot
 *     name an origin, whatever value it sends.
 *  3. The literal `platform` origin is written in exactly three production files, the kernel
 *     templates that have no caller: a new workspace's entry template, the platform meta ontology,
 *     the goal planner's definition. And no gateway file writes a literal draft origin, so a
 *     capability handler gets one only from `draftOriginOf`.
 *
 * A new path that writes `platform` changes rule 3's list in review, with the reason it has no
 * caller.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The kernel's own templates: each writes with no caller, so `platform`. */
const PLATFORM_ORIGIN_WRITERS = [
  'application/task/planning-task.ts', // the goal planner's WorkerDefinition
  'application/workspace/create.ts', // a new workspace's entry template
  'substrate/ontology/loader.ts', // the platform meta ontology (`seedPlatformMetaOntology`)
];

/** Placeholder patterns, never dispatched as themselves (capabilities.ts, the gate group): their
 *  params are a gate Operation's own input, and they have no handler. */
const GATE_PLACEHOLDER_NAMES = new Set(['<gate>.<op>', '<gate>.<op>:execute']);

/** `origin: 'platform'` (any quote) — a draft-origin literal. */
const PLATFORM_ORIGIN = /\borigin\s*:\s*(['"`])platform\1/g;
/** `origin: 'human' | 'agent' | 'platform'` — any draft-origin literal. */
const ANY_DRAFT_ORIGIN = /\borigin\s*:\s*(['"`])(human|agent|platform)\1/;

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

describe('S11 AA3a: no caller can produce a platform draft origin', () => {
  const files = productionFiles(SRC).map((full) => ({
    relative: path.relative(SRC, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));

  it('draftOriginOf derives human or agent from the channel, never platform', () => {
    expect(CAPABILITY_CHANNEL_VALUES.length).toBeGreaterThan(0);
    for (const channel of CAPABILITY_CHANNEL_VALUES) {
      const origin = draftOriginOf({ channel } as CapabilityHandlerContext);
      expect(origin).toBe(channel === 'human' ? 'human' : 'agent');
    }
    expect(draftOriginOf(undefined)).toBe('agent');
  });

  it('every dispatchable capability refuses an origin param', () => {
    const accepting = CAPABILITY_REGISTRY.filter((capability) => {
      const parsed = capability.paramsSchema.safeParse({ origin: 'platform' });
      return (
        parsed.success ||
        !parsed.error.issues.some(
          (issue) =>
            issue.code === 'unrecognized_keys' &&
            (issue as { keys?: readonly string[] }).keys?.includes('origin'),
        )
      );
    }).map((capability) => capability.name);
    expect(accepting.sort()).toEqual([...GATE_PLACEHOLDER_NAMES].sort());
    // The two that take any params are never dispatched: no handler is registered under them.
    for (const name of GATE_PLACEHOLDER_NAMES) expect(CAPABILITY_HANDLERS.has(name)).toBe(false);
    // The registry is the one the dispatcher reads (a vacuous scan would pass anything).
    expect(CAPABILITY_REGISTRY.length).toBeGreaterThan(200);
  });

  it('only the kernel templates write the platform origin, once each', () => {
    const writes = files.flatMap((file) =>
      [...file.text.matchAll(PLATFORM_ORIGIN)].map(() => file.relative),
    );
    expect(writes.sort()).toEqual([...PLATFORM_ORIGIN_WRITERS].sort());
  });

  it('no gateway file writes a literal draft origin: handlers get one only from draftOriginOf', () => {
    const literal = files
      .filter((file) => file.relative.startsWith('application/gateway/'))
      .filter((file) => ANY_DRAFT_ORIGIN.test(file.text))
      .map((file) => file.relative);
    expect(literal).toEqual([]);
    const deriving = files
      .filter((file) => file.relative.startsWith('application/gateway/'))
      .filter((file) => /\bdraftOriginOf\s*\(ctx\)/.test(file.text))
      .map((file) => file.relative);
    // The four propose_* handlers that write drafts (Skill and Procedure share a file).
    expect(deriving.sort()).toEqual([
      'application/gateway/handlers.ts',
      'application/gateway/ontology-handlers.ts',
      'application/gateway/skill-procedure-handlers.ts',
    ]);
  });

  it('the scan sees the kernel source (a moved directory would pass the rule vacuously)', () => {
    expect(files.some((file) => file.relative === 'application/gateway/draft-viewer.ts')).toBe(
      true,
    );
    expect(files.length).toBeGreaterThan(100);
  });
});
