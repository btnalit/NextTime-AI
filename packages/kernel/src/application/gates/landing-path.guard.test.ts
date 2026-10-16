import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * application/gates/landing-path.guard.test (pure, no DB): P0b's one landing path is a rule about
 * the code, not only about the two capabilities — no production module but `landing.ts` registers
 * a Gatekeeper or writes its origin record. Before it, `create_connection`, `enable_gate_instance`
 * and the `register-gatekeeper` CLI each did; the CLI wrote a Gatekeeper with no origin and no
 * audit row (STATUS leftover 123 L1-14), and nothing stopped a fourth way from appearing. A new
 * way in must go through `landGatekeeper` — or change this list in review.
 *
 * The writers are matched by name, so the origin tables are matched by statement too (#620 review
 * P3-2): an `insert into` / `update` / `delete from` / `merge into` / `truncate` on
 * `workspace_gate_links` or `workspace_self_connections` written anywhere but the module that owns
 * the table would be a way around both the landing and the platform's view of a Gatekeeper.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Each writer, and the files allowed to call it: where it is defined, and the landing. */
const ALLOWED_CALLERS: Readonly<Record<string, readonly string[]>> = {
  registerGatekeeper: ['governance/gatekeepers/registry.ts', 'application/gates/landing.ts'],
  registerGatekeeperObject: [
    'substrate/ontology/meta-objects.ts',
    'governance/gatekeepers/registry.ts',
  ],
  insertGateLink: ['application/gates/store.ts', 'application/gates/landing.ts'],
  insertSelfConnection: ['application/gates/self-connections.ts', 'application/gates/landing.ts'],
  deleteSelfConnection: ['application/gates/self-connections.ts', 'application/gates/landing.ts'],
};

/** Each origin table, and the files allowed to write it: the module that owns it. Its platform
 *  side (suspend / resume) and the raw-secret scrub's address rewrite are in
 *  `self-connections.ts` too. The workspace purge deletes every workspace table by name from the
 *  catalog (`"${table}"`), never this spelling. */
const TABLE_WRITERS: Readonly<Record<string, readonly string[]>> = {
  workspace_gate_links: ['application/gates/store.ts'],
  workspace_self_connections: ['application/gates/self-connections.ts'],
};

function productionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return productionFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

describe('P0b: the one landing path', () => {
  const files = productionFiles(SRC).map((full) => ({
    relative: path.relative(SRC, full).split(path.sep).join('/'),
    text: readFileSync(full, 'utf8'),
  }));

  it.each(Object.entries(ALLOWED_CALLERS))(
    '%s is called only where it is defined and by the landing',
    (writer, allowed) => {
      const call = new RegExp(`\\b${writer}\\s*\\(`);
      const callers = files.filter((file) => call.test(file.text)).map((file) => file.relative);
      expect(callers.sort()).toEqual([...allowed].sort());
    },
  );

  it.each(Object.entries(TABLE_WRITERS))(
    '%s is written only by the module that owns it',
    (table, allowed) => {
      const write = new RegExp(
        `\\b(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate(\\s+table)?)\\s+(only\\s+)?"?${table}\\b`,
        'i',
      );
      const writers = files.filter((file) => write.test(file.text)).map((file) => file.relative);
      expect(writers.sort()).toEqual([...allowed].sort());
    },
  );

  it('the scan sees the kernel source (a moved directory would pass the rule vacuously)', () => {
    expect(files.some((file) => file.relative === 'application/gates/landing.ts')).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });
});
