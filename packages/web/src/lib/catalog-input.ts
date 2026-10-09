import { SKILL_NAME_MAX_LENGTH } from '@nexttime/shared';
import { joinList, splitList } from './catalog.js';

/**
 * lib/catalog-input: client-side normalization for the catalog editors' free-text fields — the
 * console normalizes what a person typed into the shape the platform accepts instead of refusing
 * it (maintainer request, console-ux-2). Pure, no React; the editors call these as the person
 * types / on blur / right before submit. Server-side validation is unchanged.
 */

// -------------------------------------------------------------------------------------------
// Skill name — the publish-time rule (`PublishedSkillNameSchema`, packages/shared/src/skill.ts:
// 1–64 lowercase letters / digits, single hyphens, none leading or trailing). `propose_skill`
// accepts any non-empty name, so without this a draft saved fine and only `publish_skill` failed.
// -------------------------------------------------------------------------------------------

/**
 * The name as the person types it, rewritten toward the publish rule: lowercased, accents
 * dropped, every run of anything else (spaces, `_`, `.`, CJK…) collapsed to one `-`, no leading
 * `-`, at most 64 chars. A single trailing `-` is kept so typing "restart-" → "restart-web"
 * works; `finalizeSkillName` drops it.
 */
export function slugifySkillNameDraft(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SKILL_NAME_MAX_LENGTH);
}

/** The name to submit: `slugifySkillNameDraft` without a trailing `-`. `''` when nothing usable
 *  is left (e.g. a name written only in Chinese) — the caller says what a valid name looks like. */
export function finalizeSkillName(raw: string): string {
  return slugifySkillNameDraft(raw).replace(/-+$/, '');
}

// -------------------------------------------------------------------------------------------
// Egress deny list — `egressDeny` entries reach the egress proxy verbatim as a source's `deny`
// list, matched by `@nexttime/shared`'s `matchesSuffix` (net-address.ts): the request's hostname
// equals the entry, or ends with `.` + entry, case-insensitive. So only a bare host matches:
// a pasted URL ("https://x.example/path"), a port ("x.example:443") or a leading "*." / "."
// never matches anything — and "x.example" already covers every subdomain.
// -------------------------------------------------------------------------------------------

/** One deny entry reduced to the host the proxy compares against (see above); `''` when nothing
 *  is left. */
export function egressDenyHost(entry: string): string {
  let host = entry.trim();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  host = host.split(/[/?#]/, 1)[0] ?? '';
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    host = close > 0 ? host.slice(1, close) : host.slice(1);
  } else if ((host.match(/:/g) ?? []).length === 1) {
    host = host.replace(/:\d*$/, '');
  }
  host = host.replace(/^(\*?\.)+/, '').replace(/\.+$/, '');
  return host.toLowerCase();
}

export interface EgressDenyNormalization {
  /** The normalized list, one host per line (duplicates and blanks dropped). */
  readonly text: string;
  /** Entries that were rewritten (`to === ''`: dropped as unusable). */
  readonly changes: readonly { readonly from: string; readonly to: string }[];
}

/** The whole textarea (comma / newline separated, `splitList`) normalized entry by entry. */
export function normalizeEgressDenyText(text: string): EgressDenyNormalization {
  const hosts: string[] = [];
  const changes: { from: string; to: string }[] = [];
  for (const entry of splitList(text)) {
    const host = egressDenyHost(entry);
    if (host !== entry) changes.push({ from: entry, to: host });
    if (host !== '' && !hosts.includes(host)) hosts.push(host);
  }
  return { text: joinList(hosts), changes };
}
