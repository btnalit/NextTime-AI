import { AUDIT_ACTING_THROUGH_VALUES, type AuditActingThrough } from '@nexttime/shared';
import type { Translate } from './i18n.js';
import { ownEntry } from './own.js';

/**
 * lib/acting-through (legacy 666): what an audit row's act came through (`actingThrough`, #1028 —
 * `audit_records.acting_through`): the person themself, one of the agents or Handles acting in
 * their name, or the platform's own background work. The actor stays the person answerable for
 * it; this says how it reached the platform. Both audit pages show it on every row and filter by
 * it (`audit_query{filter.actingThrough}`, `platform_audit_query{actingThrough}`), from this one
 * table, so the two never word the same value two ways.
 */

interface BilingualLabel {
  readonly zh: string;
  readonly en: string;
  /** The English name inside a sentence ("Via admin agent"), where it is not the same as `en`
   *  (UX P3-1 on #1038): a common noun goes lower-case there, a proper one (Worker, MCP) does not. */
  readonly enInline?: string;
}

const ACTING_THROUGH_LABELS: Readonly<Record<AuditActingThrough, BilingualLabel>> = {
  person: { zh: '本人', en: 'In person' },
  admin_agent_session: { zh: '管理员智能体', en: 'Admin agent', enInline: 'admin agent' },
  entry_agent: { zh: '入口智能体', en: 'Entry agent', enInline: 'entry agent' },
  worker_handle: { zh: 'Worker', en: 'Worker' },
  service_handle: { zh: '服务账号', en: 'Service account', enInline: 'service account' },
  member_handle: {
    zh: '成员的 MCP 会话',
    en: 'Member’s MCP session',
    enInline: 'member’s MCP session',
  },
  system: {
    zh: '平台后台任务',
    en: 'Platform background work',
    enInline: 'platform background work',
  },
};

/** Every value, in the order the filter offers them: the person first, the platform last. */
export const ACTING_THROUGH_OPTIONS: readonly AuditActingThrough[] = AUDIT_ACTING_THROUGH_VALUES;

export function isActingThrough(value: string): value is AuditActingThrough {
  return ownEntry(ACTING_THROUGH_LABELS, value) !== undefined;
}

/** Under the 经由 filter while it narrows the list: which rows it can show. Rows from before the
 *  platform recorded it carry none and match no value — except 管理员智能体, which also keeps
 *  the older rows whose payload names the admin agent (the kernel's rule, `queryAudit`). */
export function actingThroughFilterNote(value: string, t: Translate): string {
  return value === 'admin_agent_session'
    ? t(
        '只列出记录了「经由」的行，以及更早的、负载里标明由管理员智能体代为的行。',
        'Only rows that record what they came through, and older rows whose payload names the admin agent.',
      )
    : t(
        '只列出记录了「经由」的行；早于平台开始记录的行不在其中。',
        'Only rows that record what they came through; rows from before the platform recorded it are not listed.',
      );
}

/** What a row's chip says: 「经由 …」, and in English "In person", "Via …" with the channel as it
 *  reads inside a sentence, or "Not recorded" (UX P3-1 on #1035 and #1038). `name` (legacy 666,
 *  the wire's `actingName`): the Worker or service account the act came through, after the
 *  channel. */
export function actingThroughChipText(
  value: string | null | undefined,
  name: string | null | undefined,
  t: Translate,
): string {
  const suffix = name ? ` · ${name}` : '';
  const zh = `经由 ${actingThroughLabel(value, (zhText) => zhText)}${suffix}`;
  if (value === null || value === undefined) return t(zh, 'Not recorded');
  if (value === 'person') return t(zh, `In person${suffix}`);
  const entry = ownEntry(ACTING_THROUGH_LABELS, value);
  return t(zh, `Via ${entry ? (entry.enInline ?? entry.en) : value}${suffix}`);
}

/** A value's name; `null` (a row from before it was recorded, or written outside any call) is
 *  「未记录」, and an unknown value stays visible as itself. */
export function actingThroughLabel(value: string | null | undefined, t: Translate): string {
  if (value === null || value === undefined) return t('未记录', 'Not recorded');
  const entry = ownEntry(ACTING_THROUGH_LABELS, value);
  return entry ? t(entry.zh, entry.en) : value;
}
