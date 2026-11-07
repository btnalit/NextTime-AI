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
}

const ACTING_THROUGH_LABELS: Readonly<Record<AuditActingThrough, BilingualLabel>> = {
  person: { zh: '本人', en: 'In person' },
  admin_agent_session: { zh: '管理员智能体', en: 'Admin agent' },
  entry_agent: { zh: '入口智能体', en: 'Entry agent' },
  worker_handle: { zh: 'Worker', en: 'Worker' },
  service_handle: { zh: '服务账号', en: 'Service account' },
  member_handle: { zh: '成员的 MCP 会话', en: 'Member’s MCP session' },
  system: { zh: '平台后台任务', en: 'Platform background work' },
};

/** Every value, in the order the filter offers them: the person first, the platform last. */
export const ACTING_THROUGH_OPTIONS: readonly AuditActingThrough[] = AUDIT_ACTING_THROUGH_VALUES;

export function isActingThrough(value: string): value is AuditActingThrough {
  return ownEntry(ACTING_THROUGH_LABELS, value) !== undefined;
}

/** A value's name; `null` (a row from before it was recorded, or written outside any call) is
 *  「未记录」, and an unknown value stays visible as itself. */
export function actingThroughLabel(value: string | null | undefined, t: Translate): string {
  if (value === null || value === undefined) return t('未记录', 'Not recorded');
  const entry = ownEntry(ACTING_THROUGH_LABELS, value);
  return entry ? t(entry.zh, entry.en) : value;
}
