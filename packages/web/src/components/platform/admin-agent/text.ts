import type { Translate } from '../../../lib/i18n.js';

/**
 * components/platform/admin-agent/text: what 平台 · 管理员智能体 (S11 AA4c-3) says in more than one
 * place. The targets are one choice per person and trial workspace (the AA4c plan D1), shared by
 * every admin agent chat of theirs there; the coordinator asked (2026-11-02) that the console say
 * so plainly wherever targets are read or changed.
 */
export function sharedTargetsText(t: Translate): string {
  return t(
    '这个试验工作区里你的所有管理员对话共用这一组目标：从哪个对话过来改，都会作用到这个试验工作区下你的所有管理员对话。已经提出的管理员提案不跟着变；去掉一个目标后，之前向它提的工作区部分暂时不能应用，重新加回就照原样可以应用。',
    'Every admin agent chat of yours in this trial workspace shares these targets: changing them, from whichever chat you came, applies to all of your admin agent chats in this trial workspace. Admin proposals already made keep theirs; once a target is removed, the workspace part proposed to it cannot be applied until you add it back, and then applies as it was.',
  );
}
