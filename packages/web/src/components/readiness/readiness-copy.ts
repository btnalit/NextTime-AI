import {
  type ExecutionReadinessMissingWire,
  type GateUnreachableReason,
  type Role,
  getCapability,
  roleMayUseCapability,
} from '@nexttime/shared';
import type { Translate } from '../../lib/i18n.js';
import { type CatalogTab, hrefs } from '../../lib/router.js';

/**
 * components/readiness/readiness-copy: the one place `ExecutionReadinessMissingWire.code` (and,
 * for `no_grant`, its `gateId`) turns into console copy — used by `ExecutionReadinessCard` (J1's
 * "开始使用" card, mounted on both 对话 and, since console redesign P3-5, 能力目录) and, for the
 * per-gate reasons, `systems/SystemAccessCard`, so they never drift on wording or on which page a
 * code sends the reader to. (J1's original hint bar, `ExecutionPrerequisiteBar`, was unmounted by
 * P3-5 and deleted with leftover 98.)
 * `missing.code` itself is never rendered — every caller goes through `missingCauseText` /
 * `missingLinkHref` / `missingLinkLabel` below (ui-audit S14 "内部术语外泄").
 *
 * `gateNames` resolves a `no_grant` item's optional `gateId` to a human name — callers build it
 * from the *same* `execution_readiness` response's own `gates[]` (each already carries `name`),
 * never a separate `resolve_refs` round trip: the one read already has everything this component
 * needs.
 */
export type GateNameLookup = ReadonlyMap<string, string>;

const CATALOG_WORKERS_TAB: CatalogTab = 'workers';

/**
 * Console audit P1-4 / P1-5: who is reading a fix, so a fix link is offered only to someone the
 * kernel would let make it, and never points at the page the reader is already on.
 */
export interface ReadinessReader {
  /** The reader's workspace role once `get_workspace` said it; `null` while unknown — the link is
   *  then shown, and the page it opens says itself what this role cannot do. */
  readonly role: Role | null;
  /** `get_agent_policy.memberCanEditProfile` once read; `null` (or absent) while unknown — read
   *  like an unknown role: the link is shown and 我的智能体 says itself it is read-only. */
  readonly memberCanEditProfile?: boolean | null;
  /** The page the card sits on (`hrefs.*`): a fix link to it would only reload the same page. */
  readonly currentHref?: string;
}

/**
 * What makes a fix (#541 review R1): the registry capability that changes it, so whether the
 * reader gets a link is the kernel's own predicate (`roleMayUseCapability`, shared `roles.ts`)
 * rather than a hand-kept role table; `platform` for what only a platform administrator changes;
 * `member_self` for another member's own 我的智能体 setting, which no page of the reader's reaches
 * (review R2); `explained` for a state whose destination itself says whose step it is (a
 * definition mismatch: the system's drawer names the platform adoption or the workspace revision
 * still owed — #538), which any reader may open.
 */
type Fix =
  | { readonly kind: 'capability'; readonly name: FixCapability }
  | { readonly kind: 'platform' }
  | { readonly kind: 'member_self' }
  | { readonly kind: 'explained' };

type FixCapability =
  | 'request_connection'
  | 'grant_capability'
  | 'set_agent_policy'
  | 'publish_worker_definition'
  | 'publish_operation'
  | 'set_agent_profile';

const PLATFORM_FIX: Fix = { kind: 'platform' };
const MEMBER_SELF_FIX: Fix = { kind: 'member_self' };
const EXPLAINED_FIX: Fix = { kind: 'explained' };

function capabilityFix(name: FixCapability): Fix {
  return { kind: 'capability', name };
}

/** Whether `reader` may make `fix` — exactly what the kernel would authorize: the role predicate
 *  for the capability, plus `set_agent_profile`'s own rule (an owner edits anyone's profile; a
 *  member only their own, and only when the policy's `memberCanEditProfile` allows it). The reader
 *  fixing their own readiness is always editing their own profile. */
function readerCanFix(fix: Fix, reader: ReadinessReader | undefined): boolean {
  if (fix.kind === 'explained') return true;
  if (fix.kind !== 'capability') return false;
  const role = reader?.role ?? null;
  if (role === null) return true;
  if (!roleMayUseCapability(role, getCapability(fix.name))) return false;
  if (fix.name === 'set_agent_profile' && role !== 'owner') {
    return reader?.memberCanEditProfile !== false;
  }
  return true;
}

function linkFor(
  href: string | undefined,
  fix: Fix,
  reader: ReadinessReader | undefined,
): string | undefined {
  if (href === undefined || !readerCanFix(fix, reader)) return undefined;
  return href === reader?.currentHref ? undefined : href;
}

/** What a reader who cannot make the fix themselves does instead — ask whoever can. */
function askFor(fix: Fix, reader: ReadinessReader, t: Translate): string | undefined {
  if (fix.kind === 'platform' || fix.kind === 'explained') return undefined;
  if (fix.kind === 'member_self') {
    return t('要这位成员自己重新勾选。', 'That member has to tick it again themselves.');
  }
  if (readerCanFix(fix, reader)) return undefined;
  if (
    fix.name === 'set_agent_profile' &&
    reader.role !== null &&
    roleMayUseCapability(reader.role, getCapability(fix.name))
  ) {
    return t(
      '工作区策略不允许成员自己改「我的智能体」，请联系工作区所有者。',
      'The workspace policy does not let members edit My Agent themselves; ask a workspace owner.',
    );
  }
  return getCapability(fix.name)?.minRole === 'builder'
    ? t(
        '这一步要构建者或工作区所有者来做，请联系他们。',
        'A builder or a workspace owner has to do this; ask one of them.',
      )
    : t(
        '这一步要工作区所有者来做，请联系他们。',
        'A workspace owner has to do this; ask one of them.',
      );
}

function missingFix(code: ExecutionReadinessMissingWire['code']): Fix {
  switch (code) {
    case 'no_enabled_gate':
      return capabilityFix('request_connection');
    case 'no_grant':
      return capabilityFix('grant_capability');
    case 'excluded_by_policy':
      return capabilityFix('set_agent_policy');
    case 'no_published_worker':
    case 'no_worker_gate':
      return capabilityFix('publish_worker_definition');
    case 'excluded_by_profile':
      return capabilityFix('set_agent_profile');
    case 'disabled_by_platform':
      return PLATFORM_FIX;
    case 'definition_mismatch':
      return EXPLAINED_FIX;
  }
}

/** Whose entry agent a gate reason is about: the reader's own (`me`) or another member's row on
 *  系统与授权's 「谁能用」 (`them`). */
export type ReasonSubject = 'me' | 'them';

function gateReasonFix(reason: GateUnreachableReason, about: ReasonSubject): Fix {
  switch (reason) {
    case 'excluded_by_profile':
      return about === 'me' ? capabilityFix('set_agent_profile') : MEMBER_SELF_FIX;
    case 'not_granted':
      return capabilityFix('grant_capability');
    case 'excluded_by_policy':
      return capabilityFix('set_agent_policy');
    case 'no_published_operation':
      return capabilityFix('publish_operation');
    case 'no_worker':
      return capabilityFix('publish_worker_definition');
    case 'disabled_by_platform':
      return PLATFORM_FIX;
    case 'definition_mismatch':
      return EXPLAINED_FIX;
  }
}

/** For a reader who cannot fix `item` themselves: who to ask. `undefined` when they can (the link
 *  says where) or when nobody in the workspace can (`disabled_by_platform`'s own text says so). */
export function missingAsk(
  item: ExecutionReadinessMissingWire,
  reader: ReadinessReader,
  t: Translate,
): string | undefined {
  return askFor(missingFix(item.code), reader, t);
}

/** `missingAsk` for one gate's `reason`. */
export function gateReasonAsk(
  reason: GateUnreachableReason,
  reader: ReadinessReader,
  t: Translate,
  about: ReasonSubject = 'me',
): string | undefined {
  return askFor(gateReasonFix(reason, about), reader, t);
}

/** One line explaining *why* this item is missing — never the raw `code`, never a bare id. */
export function missingCauseText(
  item: ExecutionReadinessMissingWire,
  gateNames: GateNameLookup,
  t: Translate,
): string {
  switch (item.code) {
    case 'no_enabled_gate':
      return t(
        '入口 agent 还没有任何可以作用的系统，先在系统接入启用一个门。',
        'Your entry agent has no system to act on yet — enable a gate under Systems first.',
      );
    case 'no_grant': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      if (name) {
        return t(
          `门「${name}」还没有授权给你的入口 agent。`,
          `Your entry agent has not been granted the “${name}” gate yet.`,
        );
      }
      // Audit P1-4: reads need no grant, so "no grant at all" next to a 可直接调用 chip read as a
      // contradiction — it is the write operations that are not granted.
      return t(
        '你的入口 agent 还没有任何门的写操作授权（只读操作不需要授权，可以直接用）。',
        'Your entry agent has no write grant on any gate yet (read operations need no grant and work already).',
      );
    }
    case 'no_published_worker':
      return t(
        '入口 agent 委派任务时找不到可用的 Worker，先发布一个 Worker 定义（可从 ops-runner 模板开始）。',
        'Your entry agent finds no Worker to delegate to — publish a Worker definition first (the ops-runner template is a quick start).',
      );
    case 'no_worker_gate':
      return t(
        '委派出去的 Worker 碰不到任何系统：在 Worker 定义里勾选已授权的门，再发布新版本。',
        'A delegated Worker reaches no system: tick a granted gate in the Worker definition, then publish a new version.',
      );
    case 'excluded_by_profile': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      return name
        ? t(
            `门「${name}」在「我的智能体」里被取消了勾选，入口 agent 用不了它。`,
            `The “${name}” gate is unticked on My Agent, so your entry agent cannot use it.`,
          )
        : t(
            '有系统或 Worker 在「我的智能体」里被取消了勾选。',
            'A system or Worker is unticked on My Agent.',
          );
    }
    case 'excluded_by_policy': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      return name
        ? t(
            `门「${name}」已经授权给你，但工作区策略的门上限没有包含它。`,
            `The “${name}” gate is granted to you, but the workspace policy’s gate limit leaves it out.`,
          )
        : t(
            '工作区策略的门上限把一个已授权的系统排除在外。',
            'The workspace policy’s gate limit leaves a granted system out.',
          );
    }
    case 'disabled_by_platform': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      return name
        ? t(
            `门「${name}」的操作被平台管理员在「平台 · 集成」停用了，这不是工作区能修复的。`,
            `Operations on the “${name}” gate were disabled by a platform administrator under Platform · Integrations — a workspace cannot fix this.`,
          )
        : t(
            '一个系统的操作被平台管理员停用了，这不是工作区能修复的。',
            'A system’s operations were disabled by a platform administrator — a workspace cannot fix this.',
          );
    }
    case 'definition_mismatch': {
      const name = item.gateId ? gateNames.get(item.gateId) : undefined;
      return name
        ? t(
            `门「${name}」运行的定义和已发布的不一样，对其中的操作调用正被拒绝。`,
            `The “${name}” gate runs another definition than the published one, so calls to some of its operations are refused.`,
          )
        : t(
            '有系统运行的定义和已发布的不一样，对它的调用正被拒绝。',
            'A system runs another definition than the published one, so calls to it are refused.',
          );
    }
  }
}

/** Where "去修复" sends the reader for this missing item — `undefined` when there is nowhere a
 *  member or workspace owner can usefully go (`disabled_by_platform`: the only page that acts on it,
 *  平台 · 集成, refuses anyone who is not a platform admin outright — `routes.tsx`'s own
 *  `requireAdmin` — so this is text-only rather than a link most readers cannot open). */
export function missingLinkHref(
  item: ExecutionReadinessMissingWire,
  reader?: ReadinessReader,
): string | undefined {
  return linkFor(missingDestination(item), missingFix(item.code), reader);
}

function missingDestination(item: ExecutionReadinessMissingWire): string | undefined {
  switch (item.code) {
    case 'no_enabled_gate':
      return hrefs.systems();
    case 'no_grant':
      return hrefs.access();
    case 'no_published_worker':
    case 'no_worker_gate':
      return hrefs.catalog(CATALOG_WORKERS_TAB);
    case 'excluded_by_profile':
      return hrefs.agent();
    case 'excluded_by_policy':
      return hrefs.models();
    case 'disabled_by_platform':
      return undefined;
    // The system's own drawer says which Operations and whose step it is.
    case 'definition_mismatch':
      return item.gateId ? hrefs.gatekeeper(item.gateId) : hrefs.systems();
  }
}

/** The link's own label — names the destination page, never the internal code. `undefined` exactly
 *  when `missingLinkHref` is (`disabled_by_platform` — see that function's own doc comment). */
export function missingLinkLabel(
  item: ExecutionReadinessMissingWire,
  t: Translate,
): string | undefined {
  switch (item.code) {
    case 'no_enabled_gate':
      return t('去系统与授权', 'Go to Systems & access');
    case 'no_grant':
      return t('去系统与授权', 'Go to Systems & access');
    case 'no_published_worker':
    case 'no_worker_gate':
      return t('去能力目录', 'Go to Catalog');
    case 'excluded_by_profile':
      return t('去我的智能体', 'Go to My Agent');
    case 'excluded_by_policy':
      return t('去模型与配额', 'Go to Models & Quotas');
    case 'disabled_by_platform':
      return undefined;
    case 'definition_mismatch':
      return t('看下一步', 'See what to do');
  }
}

/** Console redesign M2: why one system is not usable by the entry agent (`gates[].reason`) — the
 *  same reason code `find_operations` hands the agent, so both say the same thing. `about` is whose
 *  entry agent: the reader's own (`me`, the default) or another member's row on 系统与授权's
 *  「谁能用」 (`them`), which must not say "you". */
export function gateReasonText(
  reason: GateUnreachableReason | undefined,
  t: Translate,
  about: ReasonSubject = 'me',
): string {
  if (about === 'them') {
    if (reason === 'not_granted') {
      return t(
        '写操作还没有授权给这位成员——需要工作区所有者授权（只读操作不需要授权）。',
        'Its write operations are not granted to this member yet — a workspace owner has to grant them (read operations need no grant).',
      );
    }
    if (reason === 'excluded_by_profile') {
      return t(
        '这位成员在自己的「我的智能体」里取消了勾选。',
        'This member unticked it on their own My Agent page.',
      );
    }
  }
  switch (reason) {
    case 'no_published_operation':
      return t('这个系统还没有已发布的操作。', 'This system has no published operation yet.');
    case 'not_granted':
      return t(
        '写操作还没有授权给你——需要工作区所有者授权（只读操作不需要授权）。',
        'Its write operations are not granted to you yet — a workspace owner has to grant them (read operations need no grant).',
      );
    case 'excluded_by_policy':
      return t(
        '工作区策略的门上限没有包含它。',
        'The workspace policy’s gate limit leaves it out.',
      );
    case 'excluded_by_profile':
      return t('你在「我的智能体」里取消了勾选。', 'You unticked it on My Agent.');
    case 'no_worker':
      return t(
        '没有能调用它的 Worker——需要发布一个挂了这个系统的 Worker。',
        'No Worker can call it — publish a Worker that includes this system.',
      );
    case 'disabled_by_platform':
      return t(
        '平台管理员在「平台 · 集成」停用了这个系统的操作，这不是工作区能修复的。',
        'A platform administrator disabled operations on this system under Platform · Integrations — a workspace cannot fix this.',
      );
    case 'definition_mismatch':
      return t(
        '门运行的定义和已发布的不一样，对它的调用正被拒绝。',
        'The gate runs another definition than the published one, so calls to it are refused.',
      );
    case undefined:
      return t('暂时用不了。', 'Not usable right now.');
  }
}

/** `undefined` for `disabled_by_platform` — see `missingLinkHref`'s own doc comment: 平台 · 集成
 *  refuses anyone who is not a platform admin, so a member or workspace owner reading this has
 *  nowhere useful to click through to. */
export function gateReasonHref(
  reason: GateUnreachableReason,
  reader?: ReadinessReader,
  about: ReasonSubject = 'me',
): string | undefined {
  return linkFor(gateReasonDestination(reason), gateReasonFix(reason, about), reader);
}

function gateReasonDestination(reason: GateUnreachableReason): string | undefined {
  switch (reason) {
    case 'no_published_operation':
      return hrefs.systems();
    case 'not_granted':
      return hrefs.access();
    case 'excluded_by_policy':
      return hrefs.models();
    case 'excluded_by_profile':
      return hrefs.agent();
    case 'no_worker':
      return hrefs.catalog(CATALOG_WORKERS_TAB);
    case 'disabled_by_platform':
      return undefined;
    // Said on the system's own row and drawer (`DefinitionMismatchNotice`), not another page.
    case 'definition_mismatch':
      return undefined;
  }
}

export function gateReasonLink(reason: GateUnreachableReason, t: Translate): string | undefined {
  switch (reason) {
    case 'no_published_operation':
      return t('去系统与授权', 'Go to Systems & access');
    case 'not_granted':
      return t('去系统与授权', 'Go to Systems & access');
    case 'excluded_by_policy':
      return t('去模型与配额', 'Go to Models & Quotas');
    case 'excluded_by_profile':
      return t('去我的智能体', 'Go to My Agent');
    case 'no_worker':
      return t('去能力目录', 'Go to Catalog');
    case 'disabled_by_platform':
    case 'definition_mismatch':
      return undefined;
  }
}

/** A stable React key for one `missing[]` entry — `code` alone collides when the same code
 *  appears without a `gateId` and with one (the handler already dedupes by `code:gateId`,
 *  `execution-readiness-handler.ts`'s own `missingByKey`, so this only needs to mirror that). */
export function missingKey(item: ExecutionReadinessMissingWire): string {
  return `${item.code}:${item.gateId ?? ''}`;
}
