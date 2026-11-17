import type { Translate } from './i18n.js';

/** §5.9 / §5.6: 选类型 → 连接与凭证 → 能力与策略 → 握手验证 — the 「接入一个系统」 launcher's steps
 *  (`components/ui/Launcher`). */
export const LAUNCHER_STEPS = [
  { key: 'kind', zh: '选类型', en: 'Type' },
  { key: 'connection', zh: '连接与凭证', en: 'Connection & credentials' },
  { key: 'policy', zh: '能力与策略', en: 'Capabilities & policy' },
  { key: 'handshake', zh: '握手验证', en: 'Handshake' },
] as const;

/** The steps on one line, in the interface's language — the 「接入一个系统」 drawer's subtitle
 *  (legacy 805: it was written in Chinese only). */
export function launcherStepsText(t: Translate): string {
  return LAUNCHER_STEPS.map((step) => t(step.zh, step.en)).join(' → ');
}
