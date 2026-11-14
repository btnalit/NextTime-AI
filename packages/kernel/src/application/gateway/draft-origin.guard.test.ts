import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_CHANNEL_VALUES,
  CAPABILITY_REGISTRY,
  PRINCIPAL_KIND_VALUES,
} from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { operationOriginOf } from '../../governance/gatekeepers/index.js';
import type { CapabilityHandlerContext } from './capability-handler.js';
import { callerKindOf, draftOriginOf } from './draft-viewer.js';
import { CAPABILITY_HANDLERS } from './handlers.js';

/**
 * application/gateway/draft-origin.guard.test (pure, no DB) — S11 AA3a (legacy 293): a draft's
 * `origin` says which channel wrote it, and `platform` means the kernel wrote it with no caller at
 * all. So nothing a caller sends, over the human channel or through a Handle, may come out as
 * `platform`; only the kernel's own templates write it. Three rules hold that:
 *
 *  1. The gateway derives a draft's origin from the channel and the calling Principal's kind
 *     alone (`draftOriginOf`): `human` only for a person over the human channel, and nothing
 *     gives `platform`.
 *  2. No capability takes an `origin` param: every dispatchable capability's `paramsSchema`
 *     refuses the key (dispatch.ts parses the params before any handler runs), so a caller cannot
 *     name an origin, whatever value it sends.
 *  3. The literal `platform` origin is written in exactly three production files, the kernel
 *     templates that have no caller: a new workspace's entry template, the platform meta ontology,
 *     the goal planner's definition. And no gateway file writes a literal draft origin, so a
 *     capability handler gets one only from `draftOriginOf`.
 *
 *  4. Legacy 616: a write that records the caller's kind beside the Principal it is for
 *     (`propose_operation`'s proposer) takes it from `callerKindOf`, never from the channel alone
 *     (a service's API key is the human channel too), and the origin an Operation draft derives
 *     from that kind (`operationOriginOf`) is always `draftOriginOf`'s.
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

/** A caller kind taken from the channel alone: `channel === 'human' ? 'human' : 'agent'`. */
const KIND_FROM_CHANNEL =
  /channel\s*===\s*(['"`])human\1\s*\?\s*(['"`])human\2\s*:\s*(['"`])agent\3/;

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

  it('draftOriginOf derives human for a person over the human channel, agent otherwise, never platform', () => {
    expect(CAPABILITY_CHANNEL_VALUES.length).toBeGreaterThan(0);
    for (const channel of CAPABILITY_CHANNEL_VALUES) {
      for (const kind of PRINCIPAL_KIND_VALUES) {
        const ctx = {
          channel,
          principalId: 'p',
          principal: { id: 'p', kind, role: 'owner', displayName: null },
        } as CapabilityHandlerContext;
        // A service's API key is the human channel too, and still not a person (review #493 on
        // #914, P3-1).
        expect(draftOriginOf(ctx), `${channel} ${kind}`).toBe(
          channel === 'human' && kind === 'human' ? 'human' : 'agent',
        );
      }
      // No resolved Principal (a Handle never has one): not a person either.
      expect(draftOriginOf({ channel } as CapabilityHandlerContext), channel).toBe('agent');
    }
    expect(draftOriginOf(undefined)).toBe('agent');
  });

  it('legacy 616: the caller kind is the authenticated Principal’s own over the human channel, agent otherwise, and an Operation draft’s origin from it is draftOriginOf’s', () => {
    for (const channel of CAPABILITY_CHANNEL_VALUES) {
      for (const kind of PRINCIPAL_KIND_VALUES) {
        const ctx = {
          channel,
          principalId: 'p',
          principal: { id: 'p', kind, role: 'owner', displayName: null },
        } as CapabilityHandlerContext;
        expect(callerKindOf(ctx), `${channel} ${kind}`).toBe(channel === 'human' ? kind : 'agent');
        expect(operationOriginOf(callerKindOf(ctx)), `${channel} ${kind}`).toBe(draftOriginOf(ctx));
      }
      const bare = { channel } as CapabilityHandlerContext;
      expect(callerKindOf(bare), channel).toBe('agent');
      expect(operationOriginOf(callerKindOf(bare)), channel).toBe(draftOriginOf(bare));
    }
    expect(callerKindOf(undefined)).toBe('agent');
    // The service case the leftover is about: the human channel, and still not a person.
    const service = {
      channel: 'human',
      principalId: 'svc',
      principal: { id: 'svc', kind: 'service', role: 'owner', displayName: 'ci-bot' },
    } as CapabilityHandlerContext;
    expect(callerKindOf(service)).toBe('service');
    expect(operationOriginOf(callerKindOf(service))).toBe('agent');
  });

  it('legacy 616: no gateway file takes a caller kind from the channel alone', () => {
    const fromChannel = files
      .filter((file) => file.relative.startsWith('application/gateway/'))
      .filter((file) => KIND_FROM_CHANNEL.test(file.text))
      .map((file) => file.relative);
    expect(fromChannel).toEqual([]);
    // The pattern matches the form it stands for (a pattern that never matches would pass anything).
    expect(KIND_FROM_CHANNEL.test("const k = ctx?.channel === 'human' ? 'human' : 'agent';")).toBe(
      true,
    );
    const callers = files
      .filter((file) => file.relative.startsWith('application/gateway/'))
      .filter((file) => /\bcallerKindOf\s*\(ctx\)/.test(file.text))
      .map((file) => file.relative);
    // The two writes that record a caller kind, and `draftOriginOf`, defined from it.
    expect(callers.sort()).toEqual([
      'application/gateway/connection-handlers.ts',
      'application/gateway/draft-viewer.ts',
      'application/gateway/operation-manifest-handlers.ts',
    ]);
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
