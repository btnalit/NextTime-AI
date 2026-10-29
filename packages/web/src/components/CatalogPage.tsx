import type {
  EntryTemplateStatusWire,
  GateOwnedParamWire,
  SkillDetailWire,
} from '@nexttime/shared';
import { visibleText } from '@nexttime/shared';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { invalidateCapability, useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useResource } from '../hooks/useResource.js';
import { useRoleCan } from '../hooks/useRoleCan.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import { actionLabel } from '../lib/capability-labels.js';
import { opsRunnerTemplateForm, workerItemId } from '../lib/catalog.js';
import type { CapabilityCaller } from '../lib/clients.js';
import {
  type PublishCredentialReview,
  reviewFieldNames,
  usePublishCredentialReview,
} from '../lib/credential-review.js';
import { entryCapabilitiesOf, entryPromptOf } from '../lib/entry-template.js';
import {
  errorToastText,
  isDraftChangedError,
  isForbiddenError,
  isVersionChangedError,
} from '../lib/errors.js';
import {
  actionKindRaw,
  actionKindTagText,
  actionKindTagToastText,
  formatRelative,
  prettyJsonVisible,
  shortId,
} from '../lib/format.js';
import {
  type CapabilityNameRow,
  type OperationCatalogRow,
  type OperationStatsRow,
  type ProcedureRow,
  type SkillRow,
  absentAnswersText,
  operationKey,
  operationStatsKey,
  revisionDraftKey,
} from '../lib/governance.js';
import { HttpError } from '../lib/http-client.js';
import { type Translate, useT } from '../lib/i18n.js';
import { operationFieldLabel, workerDefinitionKindLabel } from '../lib/labels.js';
import { breadcrumbFor } from '../lib/nav.js';
import { procedureTemplateProblemText } from '../lib/procedure-template.js';
import {
  type ProposerOnlyAction,
  proposerOnlyText,
  provenNotDraftReviewer,
  provenNotProposer,
} from '../lib/publish-authority.js';
import { type WorkspaceRole, isProvenMember } from '../lib/role.js';
import type { CatalogTab } from '../lib/router.js';
import { hrefs } from '../lib/router.js';
import { labelText, statusChipStyle } from '../lib/status-tone.js';
import {
  type WorkerDefinitionSummary,
  definitionName,
  inUseEntryVersion,
  publishedFamilyHeads,
  sameNameDefinitionIds,
  unnamedDefinitionLabel,
} from '../lib/tasks.js';
import { nameOf, useGatekeeperDirectory } from './approvals/useDirectoryNames.js';
import {
  AbsentAnswersReviewSlot,
  type AbsentAnswersReviewState,
  AbsentAnswersReviewedLine,
  useAbsentAnswersReview,
} from './catalog/AbsentAnswersReview.js';
import { DraftExpiryNote, type EditorState } from './catalog/CatalogShared.js';
import { ChangesTab } from './catalog/ChangesTab.js';
import { DiscardReasonField } from './catalog/DiscardReasonField.js';
import {
  EntryDraftChanges,
  EntryTemplateNotice,
  EntryTemplateSummary,
} from './catalog/EntryTemplateNotice.js';
import { GateOwnedParamsNotice } from './catalog/GateOwnedParamsNotice.js';
import { MarkdownPreview } from './catalog/MarkdownPreview.js';
import { PackOrigin } from './catalog/PackOrigin.js';
import { PacksTab } from './catalog/PacksTab.js';
import { ProcedureEditorHost } from './catalog/ProcedureEditorHost.js';
import { ProcedureTemplateView } from './catalog/ProcedureTemplateView.js';
import { SkillEditor } from './catalog/SkillEditor.js';
import { WorkerEditorHost } from './catalog/WorkerEditorHost.js';
import { gateOwnedParamsText } from './connect/GateOwnedParams.js';
import {
  GovernanceChangeList,
  type OperationClassificationWire,
  firstPublishConsequence,
  firstPublishNeedsConfirm,
  governanceConsequences,
  governanceFieldChanges,
  governanceFieldsText,
  isLoosening,
} from './connect/GovernanceChange.js';
import { Button } from './kit/button.js';
import { Confirm } from './kit/confirm.js';
import { CredentialReview } from './kit/credential-review.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './kit/dialog.js';
import { EmptyState } from './kit/empty-state.js';
import { ErrorBanner } from './kit/error-banner.js';
import { Field, describedBy } from './kit/field.js';
import { KeyValue, type KeyValueItem } from './kit/key-value.js';
import { List, ListRow } from './kit/list-row.js';
import { MasterDetail, nothingToPick } from './kit/master-detail.js';
import { Notice } from './kit/notice.js';
import { PageHeader } from './kit/page-header.js';
import { RedactedNote, showsRedaction } from './kit/redacted-note.js';
import { RefChip } from './kit/ref-chip.js';
import { SameNameId } from './kit/same-name-id.js';
import { SkeletonRows } from './kit/skeleton.js';
import { StatusChip } from './kit/status-chip.js';
import { Tabs } from './kit/tabs.js';
import { Textarea } from './kit/textarea.js';
import { ExecutionReadinessCard } from './readiness/ExecutionReadinessCard.js';
import {
  announceReadinessChange,
  useExecutionReadiness,
} from './readiness/useExecutionReadiness.js';
// `useToast` stays on `components/ui/Toast` — `App.tsx` mounts that provider (not `kit/toast`'s
// own, separate context), so `kit/toast`'s hook would make this page's publish/deprecate/discard
// toasts a silent no-op (same reason `ApprovalQueuePage.tsx`/`TasksPage.tsx` keep it).
import { useToast } from './ui/Toast.js';

export interface CatalogPageProps {
  readonly http: CapabilityCaller;
  readonly tab: CatalogTab;
  readonly onTabChange: (tab: CatalogTab) => void;
  /** The item selected within the active tab (`#/govern/catalog/<tab>/<itemId>`) — an existing
   *  row's own stable key (`operationKey`/`id`/`id@version`), or the sentinel `'new'` while an
   *  editor (new draft / copy-as-new-draft / template / new version) is open in the pane. No item
   *  route exists for Operations (drafts arrive from a connected system's manifest, never a
   *  console "propose"). 能力包 (`packs`, S11 P1-C): a pack's name. 安装历史 (`changes`, S11
   *  P1-B): an install record's id. */
  readonly itemId?: string;
  readonly onSelectItem: (itemId: string | null) => void;
  /** `session.user?.platformRole === 'admin'` (the 能力包 tab's link to 平台 · 集成). */
  readonly platformAdmin?: boolean;
}

/** S8 W1-A10 (i18n remainder): `Operation`/`Skill`/`Worker` stay English proper nouns even in zh
 *  copy (the page's own description above does the same); `Procedure` reads 流程, the zh term the
 *  rest of the console uses (legacy 355: capability names, audit resource types, task detail,
 *  purge counts; `lib/nav.ts`'s catalog nav group). S11 P1-C: a pack reads 能力包 (it replaces the
 *  模块 tab: a module is a pack with one ontology part). */
const TAB_LABEL: Readonly<Record<CatalogTab, { readonly zh: string; readonly en: string }>> = {
  operations: { zh: 'Operation', en: 'Operations' },
  skills: { zh: 'Skill', en: 'Skills' },
  procedures: { zh: '流程', en: 'Procedures' },
  workers: { zh: 'Worker', en: 'Workers' },
  packs: { zh: '能力包', en: 'Packs' },
  // S11 P1-B: each pack install or upgrade, and its rollback (`catalog/ChangesTab`).
  changes: { zh: '安装历史', en: 'Install history' },
};

/** The sentinel item segment while any editor (new / copy / template / new version) is open in
 *  the detail pane — see the module doc comment on `CatalogPageProps.itemId`. Not a real id: no
 *  row is ever selected while it is current. */
const NEW_ITEM_ID = 'new';

/**
 * components/CatalogPage: 能力目录 Catalog (`/govern/catalog`, S3.11 "目录" group — `minRole:
 * 'member'`, open to everyone). Six tabs over the platform's publishable content: Operations
 * (`list_operations`), Skills/Procedures (`list_skills`/`list_procedures`), Workers
 * (`list_worker_definitions`), 能力包 (`list_packs`, `PacksTab`, S11 P1-C) and 安装历史
 * (`list_change_segments`, `ChangesTab`, S11 P1-B). Publish/deprecate stay the two-step `propose → publish` capabilities already in the
 * registry (docs/wire-contract-conventions.md: "UI 不得提供'直接改分类'的捷径") — never a shortcut,
 * each write still `channel: 'human'`-gated on its own (no fixed `minRole`, so a 403 denies only
 * that one capability — `hooks/usePermissions.tsx`).
 *
 * Console redesign P3-5 (V2/V7/V8/V9, following P3-4's own `kit/master-detail`): Operations,
 * Skills, Procedures and Workers are each a list pane (`kit/list-row`, plain text — no nested
 * interactive element) plus a detail pane/`kit/sheet`, selection driven only by the URL
 * (`#/govern/catalog/<tab>/<itemId>`, `lib/router.ts`) — no auto-select, and an empty list with
 * nothing selected collapses to the single list pane (`MasterDetail`'s own `detail === null`
 * rule). A row's own actions (Publish / Deprecate / Edit description / Edit as new draft /
 * Discard) move from the row itself into the detail pane — the row shows only its name and a
 * short meta line now, same capability calls and confirm tiers as before, just relocated. Opening
 * an editor (新建草稿 / 编辑为新草稿 / 从模板创建 / 编辑新版本) selects the `NEW_ITEM_ID` sentinel so
 * it, too, shows in the pane/sheet rather than a `ui/Drawer`; the editor's own payload (which row
 * it copies, if any) cannot live in the URL, so it stays local `useState` exactly as before — the
 * URL only ever needs to know "an editor is open", never which one.
 *
 * V2 readiness: swaps the old `ExecutionPrerequisiteBar` (a bordered block enumerating every
 * missing prerequisite) for the same `ExecutionReadinessCard` the 对话 page already renders
 * (console redesign P3-3) — one quiet, neutral summary line ("我的智能体能用 n/m 个系统") with the
 * missing-item detail behind a disclosure, instead of a second, differently-shaped readiness
 * block. No new readiness computation: same `useExecutionReadiness` read model, same component.
 */
export function CatalogPage({
  http,
  tab,
  onTabChange,
  itemId,
  onSelectItem,
  platformAdmin = false,
}: CatalogPageProps) {
  const t = useT();
  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('catalog')}
        title={t('能力目录', 'Catalog')}
        description={t(
          '工作区里已发布的 Operation、Skill、流程与 Worker 定义，以及你自己的草稿。',
          'Published Operations, Skills, Procedures and Worker definitions across the workspace, plus your own drafts.',
        )}
      />
      <ExecutionReadinessCard http={http} currentHref={hrefs.catalog(tab)} />
      <div className="page-toolbar">
        <Tabs<CatalogTab>
          ariaLabel="Catalog section"
          value={tab}
          onChange={onTabChange}
          options={(Object.keys(TAB_LABEL) as CatalogTab[]).map((value) => ({
            value,
            label: t(TAB_LABEL[value].zh, TAB_LABEL[value].en),
          }))}
        />
      </div>
      {tab === 'operations' ? (
        <OperationsTab http={http} itemId={itemId} onSelectItem={onSelectItem} />
      ) : tab === 'skills' ? (
        <SkillsTab http={http} itemId={itemId} onSelectItem={onSelectItem} />
      ) : tab === 'procedures' ? (
        <ProceduresTab http={http} itemId={itemId} onSelectItem={onSelectItem} />
      ) : tab === 'workers' ? (
        <WorkersTab http={http} itemId={itemId} onSelectItem={onSelectItem} />
      ) : tab === 'packs' ? (
        <PacksTab
          http={http}
          itemId={itemId}
          onSelectItem={onSelectItem}
          platformAdmin={platformAdmin}
        />
      ) : (
        <ChangesTab http={http} itemId={itemId} onSelectItem={onSelectItem} />
      )}
    </div>
  );
}

interface CatalogTabProps {
  readonly http: CapabilityCaller;
  readonly itemId: string | undefined;
  readonly onSelectItem: (itemId: string | null) => void;
}

function DegradedList({
  status,
  error,
  reload,
  capabilityLabel,
}: {
  readonly status: 'loading' | 'error';
  readonly error?: unknown;
  readonly reload: () => void;
  readonly capabilityLabel: string;
}) {
  const t = useT();
  if (status === 'loading') {
    return <SkeletonRows count={4} label={`Loading ${capabilityLabel}`} />;
  }
  return (
    <ErrorBanner
      error={error}
      title={t(`无法加载 ${capabilityLabel}`, `Could not load ${capabilityLabel}`)}
      onRetry={reload}
      testId="catalog-error"
    />
  );
}

/** The per-tab toolbar: the one primary action of the page ("新建草稿", §5.9 principle 1) plus
 *  the refresh — hidden entirely when the session has learned it may not propose. */
function DraftToolbar({
  canPropose,
  onNewDraft,
  onRefresh,
  refreshing,
  testId,
  extra,
}: {
  readonly canPropose: boolean;
  readonly onNewDraft: () => void;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly testId: string;
  /** An extra action grouped right after "New draft" — the Workers tab's own "从模板创建
   *  （ops-runner）" (J7/CW1). `undefined` for every other tab, unchanged layout. */
  readonly extra?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="page-toolbar">
      {canPropose || extra ? (
        <div className="row-wrap">
          {canPropose ? (
            <Button variant="primary" onClick={onNewDraft} data-testid={testId}>
              {t('新建草稿', 'New draft')}
            </Button>
          ) : null}
          {extra}
        </div>
      ) : null}
      <Button
        variant="ghost"
        aria-busy={refreshing || undefined}
        disabled={refreshing}
        onClick={onRefresh}
      >
        {t('刷新', 'Refresh')}
      </Button>
    </div>
  );
}

/** S8 W1-A7 (audit S13 "目录「弃用」是普通文字按钮" — no confirm at all): the one 弃用 Deprecate
 *  button every tab below shares — a `kit/confirm` `medium` popover anchored to the button itself
 *  (deprecating a published Operation/Skill/Procedure/Worker stops agents from reaching it, at
 *  least medium per the dispatch). `target`/`impact` are the one piece of data each tab already
 *  has about what deprecating this row affects; a tab with nothing more specific than "this row"
 *  passes `impact` as `undefined` rather than inventing a count it does not have. */
function DeprecateConfirm({
  busy,
  target,
  impact,
  onConfirm,
  testId,
}: {
  readonly busy: boolean;
  readonly target: string;
  readonly impact?: readonly string[];
  readonly onConfirm: () => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('弃用', 'Deprecate')}
        </Button>
      }
      title={t(`弃用 ${target}`, `Deprecate ${target}`)}
      description={t(
        '弃用后 Agent 不能再使用它；已发生的调用与审计不受影响，随时可以重新发布恢复。',
        'Once deprecated, agents can no longer reach it; past calls and the audit trail are unaffected, and republishing brings it back at any time.',
      )}
      target={target}
      impact={impact}
      confirmLabel={t('弃用', 'Deprecate')}
      danger
      onConfirm={onConfirm}
      testId={testId}
    />
  );
}

/** R-19 (decision D-17): Publish for a draft that changes the published version's mode / blast
 *  radius / auto-approvable — a `medium` confirm listing old → new from the kernel's own
 *  `governanceChange`, danger-styled with what it means when the kernel's direction loosens. A
 *  draft with no such change (a new Operation, or one whose classification is unchanged) keeps the
 *  plain one-click Publish. */
function PublishGovernanceConfirm({
  row,
  change,
  busy,
  blocked,
  onConfirm,
  testId,
}: {
  readonly row: OperationCatalogRow;
  readonly change: NonNullable<OperationCatalogRow['governanceChange']>;
  readonly busy: boolean;
  /** An open credential question (`CredentialReview`) is unanswered. */
  readonly blocked: boolean;
  readonly onConfirm: () => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const item = { name: row.name, ...change };
  const consequences = governanceConsequences(item, t, false);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        // ux-lint-allow-disabled: the 「已核对凭据」 checkbox (CredentialReview) right above says why.
        <Button
          variant="primary"
          size="s"
          disabled={busy || blocked}
          aria-busy={busy || undefined}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('发布', 'Publish')}
        </Button>
      }
      title={t('发布这个 Operation', 'Publish this operation')}
      description={t(
        '这个草稿改了当前生效版本的治理字段——它们决定这个 Operation 要不要人工审批、要不要授权、调用方等不等审批结果。发布后替换当前版本。',
        'This draft changes governance fields of the version in effect — they decide whether this operation needs a person’s approval and a grant, and whether the caller waits for the decision. Publishing replaces the current version.',
      )}
      target={actionKindTagText(row.name)}
      confirmLabel={t('发布', 'Publish')}
      danger={isLoosening(change.direction)}
      onConfirm={onConfirm}
      testId={testId}
    >
      {/* Legacy 404 (UX acceptance of #653): the change being confirmed comes first, ahead of
       *  what loosening it means — on a short window it used to sit under the fold. */}
      <GovernanceChangeList items={[item]} single />
      {consequences.length > 0 ? (
        <Notice tone="warn" testId={`${testId}-loosens`}>
          <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
            {consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </Confirm>
  );
}

/** Legacy 349 (UX acceptance of #612): an Operation's first version that writes or is high
 *  impact is confirmed before it is published — there is no version in effect to compare with, so
 *  the confirm says what publishing lets happen instead. */
function PublishFirstVersionConfirm({
  row,
  fields,
  busy,
  blocked,
  onConfirm,
  testId,
}: {
  readonly row: OperationCatalogRow;
  readonly fields: OperationClassificationWire;
  readonly busy: boolean;
  /** An open credential question (`CredentialReview`) is unanswered. */
  readonly blocked: boolean;
  readonly onConfirm: () => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        // ux-lint-allow-disabled: the 「已核对凭据」 checkbox (CredentialReview) right above says why.
        <Button
          variant="primary"
          size="s"
          disabled={busy || blocked}
          aria-busy={busy || undefined}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('发布', 'Publish')}
        </Button>
      }
      title={t('发布这个 Operation', 'Publish this operation')}
      description={t(
        `这是它第一次发布，分类为「${governanceFieldsText(fields, t)}」。发布后它马上可以被调用；分类决定要不要授权、要不要人工审批，发布前请核对。`,
        `This is its first published version, classified “${governanceFieldsText(fields, t)}”. It can be called as soon as it is published; the classification decides whether it needs a grant and a person's approval — check it before publishing.`,
      )}
      target={actionKindTagText(row.name)}
      impact={[firstPublishConsequence(null, fields, t)]}
      confirmLabel={t('发布', 'Publish')}
      onConfirm={onConfirm}
      testId={testId}
    />
  );
}

/** The fields a first-publish confirm reads — `null` when the row does not carry all three (an
 *  older kernel), so it falls back to the plain button rather than guessing. */
function governanceFieldsOf(row: OperationCatalogRow): OperationClassificationWire | null {
  if (row.mode === undefined || row.blastRadius === undefined || row.autoApprovable === undefined) {
    return null;
  }
  return {
    mode: row.mode as OperationClassificationWire['mode'],
    blastRadius: row.blastRadius as OperationClassificationWire['blastRadius'],
    autoApprovable: row.autoApprovable,
  };
}

/** The credential question in front of a draft's Publish (decision 2026-10-09 "二次确认") — open
 *  only after the kernel refused a publish of this draft (lib/credential-review.ts). */
function PublishCredentialSlot({
  review,
  busy,
  fieldNames,
}: {
  readonly review: PublishCredentialReview;
  readonly busy: boolean;
  readonly fieldNames?: Readonly<Record<string, string>>;
}) {
  return (
    <CredentialReview
      count={review.count}
      paths={review.paths}
      fieldNames={fieldNames}
      subject="publish"
      checked={review.checked}
      onChange={review.setChecked}
      disabled={busy}
    />
  );
}

/** UX acceptance of #722 (P2-1): the problems the kernel refused publishing a Procedure for, as a
 *  template (`publish_procedure`'s 400 `invalid_params`, `details.problems`), or `null` for any
 *  other failure. */
function procedureTemplateProblemsOf(err: unknown): readonly string[] | null {
  if (!(err instanceof HttpError) || err.code !== 'invalid_params') return null;
  const problems = err.details?.problems;
  if (!Array.isArray(problems) || problems.length === 0) return null;
  return problems.filter((problem): problem is string => typeof problem === 'string');
}

/** UX acceptance of #722 (P2-1): why publishing this draft was refused — the plan it makes does not
 *  pass — next to Publish, where the person is, focused when it appears; each problem as
 *  `lib/procedure-template` words it. The fix is a new draft (a draft's content never changes). */
function PublishTemplateProblems({ problems }: { readonly problems: readonly string[] }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus again on each new refusal.
  useEffect(() => {
    ref.current?.focus();
  }, [problems]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="field-error stack-s"
      data-testid="procedure-publish-problems"
    >
      <strong>
        {t(
          '这个流程生成不了目标的计划，所以没有发布。',
          'This Procedure does not make a goal plan that passes, so it was not published.',
        )}
      </strong>
      <span>
        {t(
          '请「编辑为新草稿」，在 JSON 视图里改下面这些位置，再发布新的草稿：',
          'Use “Edit as new draft”, fix these places in the JSON view, then publish the new draft:',
        )}
      </span>
      <ul className="stack-s">
        {problems.map((problem) => (
          <li key={problem}>{procedureTemplateProblemText(problem, t)}</li>
        ))}
      </ul>
    </div>
  );
}

/** A catalog row's selection key: `operationKey`, except a draft that revises a published version
 *  (it carries `governanceChange`) — both rows share the identity, and the draft must stay
 *  selectable on its own to be published from here (R-19) — and a retired (`deprecated`) version,
 *  which shares it with the version that replaced it (UX acceptance of #538: the two rows had one
 *  React key), so it is keyed by its version. */
/** Operation names that more than one gate declares. */
function operationNamesOnSeveralGates(rows: readonly OperationCatalogRow[]): ReadonlySet<string> {
  const gates = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = gates.get(row.name) ?? new Set<string>();
    seen.add(row.gatekeeperId);
    gates.set(row.name, seen);
  }
  return new Set([...gates].filter(([, seen]) => seen.size > 1).map(([name]) => name));
}

/** UX acceptance of #571 P3-2: the identities listed more than once (a published version beside
 *  the deprecated ones it replaced, a revision draft beside its published version) — their rows
 *  say the version, which is what tells them apart. */
function identitiesListedTwice(rows: readonly OperationCatalogRow[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const identity = operationKey(row);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([identity]) => identity));
}

function catalogOperationKey(row: OperationCatalogRow): string {
  if (row.status === 'draft' && row.governanceChange) return revisionDraftKey(row);
  if (row.status === 'deprecated' && row.version !== undefined) {
    return `${operationKey(row)}@v${row.version}`;
  }
  return operationKey(row);
}

/** One param of a revision, as `+warehouse（query，可选）` reads it. Where it goes is named only
 *  when the definition says (`x-in`): without it the gate's kind decides (query for an HTTP GET,
 *  the body otherwise), which this row cannot tell. */
function paramLine(
  sign: string,
  param: { readonly name: string; readonly in?: string; readonly required: boolean },
  t: Translate,
): string {
  // Review of #593: a param name is the gate's (or a proposer's) own text — shown visibly.
  const where = param.in !== undefined ? visibleText(param.in) : undefined;
  const zh = [where, param.required ? '必填' : '可选'].filter(Boolean).join('，');
  const en = [where, param.required ? 'required' : 'optional'].filter(Boolean).join(', ');
  const name = visibleText(param.name);
  return t(`参数：${sign}${name}（${zh}）`, `Param: ${sign}${name} (${en})`);
}

/**
 * Legacy K (UX acceptance of #538): what publishing this revision draft changes against the version
 * in effect — governance fields (`governanceChange`) and the definition the gate runs
 * (`definitionChange`: changed fields, params added / removed / changed). Publishing approves a new
 * definition, so it is shown before the button, never only after.
 */
function RevisionDiff({ row }: { readonly row: OperationCatalogRow }) {
  const t = useT();
  const lines: string[] = [];
  if (row.governanceChange) {
    const fields = governanceFieldChanges(
      row.governanceChange.before,
      row.governanceChange.after,
      t,
    );
    for (const field of fields) {
      lines.push(
        t(
          `${field.label}：${field.before} → ${field.after}`,
          `${field.label}: ${field.before} → ${field.after}`,
        ),
      );
    }
  }
  // Governance fields the gate also runs are already on a line of their own above.
  const governanceListed = new Set<string>();
  if (row.governanceChange) {
    const { before, after } = row.governanceChange;
    if (before.mode !== after.mode) governanceListed.add('mode');
    if (before.blastRadius !== after.blastRadius) governanceListed.add('blast_radius');
  }
  const change = row.definitionChange;
  if (change) {
    for (const param of change.paramsAdded) lines.push(paramLine('+', param, t));
    for (const param of change.paramsRemoved) lines.push(paramLine('−', param, t));
    for (const param of change.paramsChanged) lines.push(paramLine('~', param, t));
    for (const field of change.changedFields) {
      // Param changes are listed one by one above; the field itself only when none of them is.
      if (
        field === 'params_schema' &&
        change.paramsAdded.length + change.paramsRemoved.length + change.paramsChanged.length > 0
      ) {
        continue;
      }
      if (governanceListed.has(field)) continue;
      lines.push(
        t(`${operationFieldLabel(field, t)}变了`, `${operationFieldLabel(field, t)} changed`),
      );
    }
  }
  return (
    <div className="stack-s" data-testid="operation-revision-diff">
      <span className="field-label">
        {t('和已发布版本相比', 'Compared with the published version')}
      </span>
      {lines.length === 0 ? (
        <span className="text-3">
          {change
            ? t('和已发布版本没有差异。', 'No difference from the published version.')
            : t(
                '读不出这一版的定义，没法和已发布版本比较。',
                'This version’s definition could not be read, so it cannot be compared.',
              )}
        </span>
      ) : (
        <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {lines.map((line) => (
            <li key={line} className="text-13" data-testid="operation-revision-diff-line">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** S8 W3 K2 (leftover 82): the caller's own private draft's "丢弃" action — a `kit/confirm`
 *  `medium` popover, same tier as `DeprecateConfirm` above (the dispatch's own wording: "kit/confirm
 *  tier medium, consequence '草稿将被删除，无法恢复'"). Unlike Deprecate, this is destructive and
 *  irreversible for the row itself (a hard delete, not a status change) — `danger` styling, but
 *  still `medium` (not `irreversible`/retyped-name) per the dispatch's own call, since a draft is
 *  private to the caller alone and easy to recreate. */
function DiscardDraftConfirm({
  busy,
  target,
  description,
  onConfirm,
  testId,
}: {
  readonly busy: boolean;
  readonly target: string;
  /** What discarding does to this kind of draft — deleted outright by default (`discard_draft`);
   *  an Operation draft is kept and marked instead (legacy 278, `discard_operation_draft`). */
  readonly description?: string;
  /** `reason` is the discarder's optional why (S10 E1 结果归因) — kept with the call's own
   *  AuditRecord, `undefined` when left blank. */
  readonly onConfirm: (reason: string | undefined) => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = `${testId}-reason`;
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason('');
      }}
      anchor={
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('丢弃', 'Discard')}
        </Button>
      }
      title={t(`丢弃 ${target}`, `Discard ${target}`)}
      description={
        description ??
        t(
          '草稿将被删除，无法恢复。',
          'This draft will be permanently deleted and cannot be recovered.',
        )
      }
      target={target}
      confirmLabel={t('丢弃', 'Discard')}
      danger
      onConfirm={() => onConfirm(reason.trim() === '' ? undefined : reason.trim())}
      testId={testId}
    >
      <DiscardReasonField id={reasonId} value={reason} onChange={setReason} />
    </Confirm>
  );
}

/** E2-0b (review #493 on #764, F2): a reviewer's 「拒绝」 on someone else's pending Skill /
 *  Procedure draft (`reject_draft`) — the workspace owner, or the proposer of the family's version
 *  in use, which the draft would supersede. The draft's own proposer discards it instead. Same
 *  `medium` popover and `danger` styling as `DiscardDraftConfirm` (the row is deleted), but the
 *  reason is required: it is what the audit keeps of why the draft was turned down. A refusal
 *  shows in place (`onConfirm` throws), so the reason typed is not lost. */
function RejectDraftConfirm({
  kind,
  busy,
  target,
  inUseVersion,
  onConfirm,
  testId,
}: {
  readonly kind: 'skill' | 'procedure';
  readonly busy: boolean;
  readonly target: string;
  /** The family's version in use, which stays in use; `undefined`: none. */
  readonly inUseVersion: number | undefined;
  readonly onConfirm: (reason: string) => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = `${testId}-reason`;
  const trimmed = reason.trim();
  const noun = kind === 'skill' ? 'Skill' : t('流程', 'Procedure');
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason('');
      }}
      anchor={
        <Button
          variant="ghost"
          size="s"
          disabled={busy}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('拒绝', 'Reject')}
        </Button>
      }
      title={t(`拒绝 ${target}`, `Reject ${target}`)}
      description={t(
        '这份草稿将被删除，无法恢复；拒绝原因记入审计。',
        'This draft will be deleted and cannot be recovered; the reason is kept in the audit trail.',
      )}
      target={target}
      impact={
        inUseVersion !== undefined
          ? [
              t(
                `已发布的 v${inUseVersion} 照常在用，不受影响`,
                `Published v${inUseVersion} stays in use, unchanged`,
              ),
              t(
                `之后可以再为这个${noun}提议下一版本`,
                `The next version of this ${noun} can be proposed again afterwards`,
              ),
            ]
          : [
              t(
                `这个${noun}还没有发布过的版本，拒绝后它会从目录里消失`,
                `This ${noun} has no published version, so it leaves the catalog`,
              ),
            ]
      }
      confirmLabel={t('拒绝', 'Reject')}
      danger
      confirmDisabled={trimmed === ''}
      onConfirm={() => onConfirm(trimmed)}
      errorOverrides={{
        not_proposer: t(
          '只有工作区所有者或在用版本的提议人能拒绝这份草稿；没有在用版本时只有所有者能拒绝。请他们来操作，或请草稿的提议人自己丢弃它。',
          'Only the workspace owner or the proposer of the version in use can reject this draft (with no version in use, only the owner). Ask them, or ask the draft’s proposer to discard it.',
        ),
      }}
      testId={testId}
    >
      <Field
        id={reasonId}
        label={t('拒绝原因', 'Reason')}
        hint={t(
          '必填，记入审计：为什么不采用这份草稿',
          'Required — kept in the audit trail: why this draft is not taken',
        )}
        required
      >
        <Textarea
          id={reasonId}
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          aria-label={t('拒绝原因', 'Reject reason')}
          aria-required
          aria-describedby={describedBy(reasonId, true, false)}
          data-testid={reasonId}
        />
      </Field>
    </Confirm>
  );
}

/** The compact 草稿→已发布→已弃用 lifecycle line (Skill / Procedure / Worker detail headers, spec
 *  V2/V4 "compact lifecycle stepper"). Three stages, not the artboard's literal four ("草稿→提案→
 *  发布→被替代"): `propose_*` inserts a `draft` row directly (I16, verified against
 *  `application/gateway/skill-procedure-handlers.ts` / `application/worker/definitions.ts`) — this
 *  domain has no distinct "proposed" wire status to visualize, and inventing one here would draw a
 *  state the kernel does not have. Built from the existing `publishable` machine
 *  (`lib/status-tone.ts`), not a new one. */
const PUBLISHABLE_STAGES = ['draft', 'published', 'deprecated'] as const;

function PublishableStepper({
  status,
  testId,
}: {
  readonly status: string;
  readonly testId?: string;
}) {
  const t = useT();
  const index = PUBLISHABLE_STAGES.indexOf(status as (typeof PUBLISHABLE_STAGES)[number]);
  return (
    <div className="row-wrap text-3" data-testid={testId} aria-label={t('生命周期', 'Lifecycle')}>
      {PUBLISHABLE_STAGES.map((stage, i) => (
        <span key={stage} className="row-wrap">
          {i > 0 ? <span aria-hidden="true">→</span> : null}
          {i === index ? (
            <strong aria-current="step">
              {labelText(statusChipStyle('publishable', stage), t)}
            </strong>
          ) : (
            <span>{labelText(statusChipStyle('publishable', stage), t)}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/** The detail pane's "nothing usable to show" branches, shared by every tab below: nothing
 *  selected (names the object, V9), a selected id still loading, or a selected id the current
 *  (ready) rows no longer contain (discarded, filtered out, a stale link). */
function SelectionPlaceholder({
  itemId,
  ready,
  emptyTitle,
  emptyBody,
}: {
  readonly itemId: string | undefined;
  readonly ready: boolean;
  readonly emptyTitle: string;
  readonly emptyBody?: string;
}) {
  const t = useT();
  if (itemId === undefined) {
    return <EmptyState title={emptyTitle} body={emptyBody} testId="catalog-detail-empty" />;
  }
  if (!ready) {
    return <SkeletonRows count={2} label="Loading" testId="catalog-detail-loading" />;
  }
  return (
    <EmptyState
      title={t('未找到', 'Not found')}
      body={t(
        '它可能已经被丢弃、重新发布成了新的草稿，或不在当前筛选范围内。',
        'It may have been discarded, re-proposed as a new draft, or fall outside the current filter.',
      )}
      testId="catalog-detail-missing"
    />
  );
}

// -------------------------------------------------------------------------------------------
// Operations
// -------------------------------------------------------------------------------------------

function OperationDetailView({
  http,
  row,
  usage,
  gatekeeperNames,
  canPublish,
  canDeprecate,
  proposerOnly,
  canDiscard,
  canEditDescription,
  busy,
  credentialReview,
  absentReview,
  onPublish,
  onDeprecate,
  onDiscard,
  onEditDescription,
  onRewritten,
  rewrittenFrom,
}: {
  readonly http: CapabilityCaller;
  readonly row: OperationCatalogRow;
  readonly usage: OperationStatsRow | undefined;
  readonly gatekeeperNames: ReadonlyMap<string, string>;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  /** D-24: Publish / Deprecate withheld on this row because the caller is proven not its proposer
   *  (nor the owner) — the reason shown in their place. */
  readonly proposerOnly: ProposerOnlyAction | null;
  /** Legacy 278: this caller may discard this draft (`discard_operation_draft` — its proposer or
   *  the owner, `mayActOnOwnOperation`). */
  readonly canDiscard: boolean;
  readonly canEditDescription: boolean;
  readonly busy: boolean;
  readonly credentialReview: PublishCredentialReview;
  /** S11 「门确认不存在」 B-a: the confirmation a draft declaring answers that mean "does not
   *  exist" needs before it is published. */
  readonly absentReview: AbsentAnswersReviewState;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: (reason: string | undefined) => Promise<void>;
  readonly onEditDescription: () => void;
  /** Console G4: the held draft was rewritten from the gate's latest manifest — reload the list. */
  readonly onRewritten: () => void;
  /** UX acceptance of #567 P3: this draft was just rewritten here — the params it dropped, said
   *  until another row is opened (the draft is not a revision, so no diff block shows it). */
  readonly rewrittenFrom: readonly GateOwnedParamWire[] | null;
}) {
  const t = useT();
  const key = catalogOperationKey(row);
  const firstPublishFields = governanceFieldsOf(row);
  // Console G4 (legacy 219): publishing a definition with a gate-owned param is refused by the
  // kernel (400 gate_owned_params), so the button is not offered as if it would work.
  const gateOwned = row.gateOwnedParams ?? [];
  const heldBack = row.status === 'draft' && gateOwned.length > 0;
  // Legacy 278: the exact version is what the kernel discards, so a row without one (an older
  // kernel) is not offered it.
  const offersDiscard =
    canDiscard &&
    row.status === 'draft' &&
    row.version !== undefined &&
    row.draftDigest !== undefined;
  // Publish waits on both questions: suspected credentials, and the answers meaning "not there".
  const publishBlocked = credentialReview.blocked || absentReview.blocked;
  const items: KeyValueItem[] = [
    {
      key: 'gatekeeper',
      label: t('门', 'Gatekeeper'),
      value: (
        <RefChip
          kind="gatekeeper"
          id={row.gatekeeperId}
          name={nameOf(gatekeeperNames, row.gatekeeperId)}
          href={hrefs.gatekeeper(row.gatekeeperId)}
          size="s"
        />
      ),
    },
    {
      key: 'description',
      label: t('描述', 'Description'),
      value:
        row.description && row.description.trim().length > 0 ? (
          <span className="stack-s">
            <span>{row.description}</span>
            <RedactedNote value={row.description} testId="catalog-detail-description-redacted" />
          </span>
        ) : (
          <span className="text-3">{t('未填写描述', 'No description yet')}</span>
        ),
    },
  ];
  if (row.mode) {
    items.push({
      key: 'mode',
      label: t('模式', 'Mode'),
      value: <StatusChip machine="operationMode" status={row.mode} size="s" />,
    });
  }
  items.push({
    key: 'autoApprovable',
    label: t('自动批准', 'Auto-approvable'),
    value: (
      <StatusChip machine="autoApprovable" status={String(row.autoApprovable ?? false)} size="s" />
    ),
  });
  if (row.blastRadius) {
    items.push({
      key: 'blastRadius',
      label: t('影响范围', 'Blast radius'),
      value: <StatusChip machine="blastRadius" status={row.blastRadius} size="s" />,
    });
  }
  // S11 「门确认不存在」 A: which of the target's answers mean "not there" — the gate then
  // answers the observation as absent, so a reviewer sees it before publishing.
  if (row.absentAnswers) {
    items.push({
      key: 'absentAnswers',
      label: t('表示不存在的回答', 'Means “not there”'),
      value: (
        <span className="stack-s">
          <span data-testid="catalog-detail-absent-answers">
            {absentAnswersText(row.absentAnswers, t)}
          </span>
          {/* S11 「门确认不存在」 B-a: who confirmed it when this version was published. */}
          <AbsentAnswersReviewedLine http={http} row={row} />
        </span>
      ),
    });
  }
  items.push({
    key: 'usage',
    label: t('用量', 'Usage'),
    value: (
      <span
        data-testid="catalog-row-usage"
        title={
          usage
            ? `${usage.calls} calls, ${usage.approved} approved, ${usage.rejected} rejected in the trailing window`
            : 'No usage data for this Operation (stats unavailable, or no calls in the window)'
        }
      >
        {usage
          ? `${usage.calls} 调用 · ${usage.approved} 批准 · ${usage.rejected} 拒绝 · ${formatRelative(usage.lastCalledAt)}`
          : '—'}
      </span>
    ),
  });

  return (
    <div className="stack" data-testid="operation-detail" data-operation-key={key}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="publishable" status={row.status} size="s" />
          <strong
            className="catalog-detail-title mono wrap-anywhere"
            title={actionKindRaw(row.name)}
          >
            {actionKindTagText(row.name)}
          </strong>
        </div>
      </header>
      <KeyValue items={items} />
      {row.status === 'draft' && row.governanceChange ? <RevisionDiff row={row} /> : null}
      {rewrittenFrom !== null && gateOwned.length === 0 ? (
        <Notice testId="operation-rewritten">
          {t(
            `已按门的最新清单重写这份草稿：去掉了只能由门自己设置的参数 ${gateOwnedParamsText(rewrittenFrom, t)}。核对后可以发布。`,
            `Rewritten from the gate’s latest manifest: the params only the gate sets are gone (${gateOwnedParamsText(rewrittenFrom, t)}). Check it, then publish.`,
          )}
        </Notice>
      ) : null}
      {gateOwned.length > 0 && row.status !== 'deprecated' ? (
        <GateOwnedParamsNotice
          http={http}
          gatekeeperId={row.gatekeeperId}
          name={row.name}
          status={row.status}
          params={gateOwned}
          origin={row.origin}
          canDiscard={offersDiscard}
          gateDisplayName={nameOf(gatekeeperNames, row.gatekeeperId) ?? row.gatekeeperId}
          onRewritten={onRewritten}
        />
      ) : null}
      {canPublish && row.status === 'draft' && !heldBack ? (
        <>
          <PublishCredentialSlot review={credentialReview} busy={busy} />
          <AbsentAnswersReviewSlot review={absentReview} busy={busy} />
        </>
      ) : null}
      <div className="row-wrap">
        {heldBack ? null : canPublish &&
          row.status === 'draft' &&
          row.governanceChange &&
          row.governanceChange.direction !== 'neutral' ? (
          <PublishGovernanceConfirm
            row={row}
            change={row.governanceChange}
            busy={busy}
            blocked={publishBlocked}
            onConfirm={onPublish}
            testId={`operation-publish-confirm-${key}`}
          />
        ) : canPublish &&
          row.status === 'draft' &&
          row.governanceChange === undefined &&
          firstPublishFields !== null &&
          firstPublishNeedsConfirm(firstPublishFields) ? (
          <PublishFirstVersionConfirm
            row={row}
            fields={firstPublishFields}
            busy={busy}
            blocked={publishBlocked}
            onConfirm={onPublish}
            testId={`operation-publish-first-confirm-${key}`}
          />
        ) : canPublish && row.status === 'draft' ? (
          <Button
            variant="primary"
            size="s"
            disabled={busy || credentialReview.blocked || absentReview.blocked}
            aria-busy={busy || undefined}
            onClick={() => void onPublish()}
          >
            {t('发布', 'Publish')}
          </Button>
        ) : canDeprecate && row.status === 'published' ? (
          <DeprecateConfirm
            busy={busy}
            target={actionKindTagText(row.name)}
            impact={
              usage
                ? [
                    t(`${usage.calls} 次调用`, `${usage.calls} calls in the trailing window`),
                    t(`${usage.approved} 次批准`, `${usage.approved} approved`),
                  ]
                : undefined
            }
            onConfirm={onDeprecate}
            testId={`operation-deprecate-confirm-${key}`}
          />
        ) : proposerOnly !== null && !heldBack ? (
          <ProposerOnlyHint action={proposerOnly} />
        ) : null}
        {offersDiscard ? (
          <DiscardDraftConfirm
            busy={busy}
            target={
              row.version !== undefined
                ? `${actionKindTagText(row.name)} v${row.version}`
                : actionKindTagText(row.name)
            }
            description={t(
              '这份草稿会移出能力目录，不会被调用。它不会被删除：谁提议的、谁丢弃的、为什么，都留在审计里。之后再导入或提议这个 Operation，会作为新版本出现。',
              'This draft leaves the catalog and is never called. It is not deleted: who proposed it, who discarded it and why stay in the audit log. If this Operation is imported or proposed again, it comes back as a new version.',
            )}
            onConfirm={onDiscard}
            testId={`operation-discard-confirm-${key}`}
          />
        ) : null}
        {canEditDescription ? (
          <Button
            variant="ghost"
            size="s"
            onClick={onEditDescription}
            data-testid={`operation-edit-description-${key}`}
          >
            {t('编辑描述', 'Edit description')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * STATUS leftover 123 (D-24): `update_operation_description` is `minRole: 'builder'`, and only the
 * Operation's proposer or the owner may edit it — its description reaches every agent's tool list.
 * Legacy 278: `discard_operation_draft` takes the same rule on the draft, so it shares this check.
 * Offered only where it can succeed: the owner; a builder on a row they proposed. A caller proven
 * below the builder floor (a known member / operator / auditor, or an inferred member) is never
 * offered it. Unknown either side (role or proposer not loaded, an older kernel) keeps the action,
 * as `isOwnDraftOrUnknown` does — the kernel refuses it anyway.
 */
function mayActOnOwnOperation(
  row: Pick<OperationCatalogRow, 'proposedBy'>,
  role: WorkspaceRole,
  callerPrincipalId: string | null,
): boolean {
  if (role.kind === 'inferred') return !isProvenMember(role);
  if (role.role === 'owner') return true;
  if (role.role !== 'builder') return false;
  return isOwnDraftOrUnknown(row, callerPrincipalId);
}

/** S8 W3-K1 (leftover 81): the bound `update_operation_description`'s own `paramsSchema` enforces
 *  (`packages/shared/src/capabilities.ts`) — mirrored here only so the textarea can stop the owner
 *  before a doomed round trip, not as the source of truth. */
const OPERATION_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * components/CatalogPage OperationsTab: Operations have no console "propose" flow (they arrive
 * from a connected system's published manifest or the onboarding wizard, `CatalogPage`'s own doc
 * comment) — no editor, no `NEW_ITEM_ID` state, `itemId` only ever names an existing row
 * (`operationKey`). Selecting one shows a read-only detail (`OperationDetailView`) with the same
 * Publish / Deprecate / Edit description actions the row used to carry inline.
 */
function OperationsTab({ http, itemId, onSelectItem }: CatalogTabProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const toast = useToast();
  const operations = useCapabilityList<OperationCatalogRow>(http, 'list_operations');
  // Own capability call, own degrade path — a `get_operation_stats` failure (not deployed yet, a
  // transient error, whatever) never blocks the Operations list itself; a row simply renders "—"
  // for its usage columns when no matching stats entry comes back (see `statsFor` below).
  const stats = useCapabilityList<OperationStatsRow>(http, 'get_operation_stats');
  // Review #501 on #571 ②: two gates of one connector can carry the same display name too, so the
  // list's gate label takes #561's same-name short id (the directory's own `same`).
  const gatekeeperDirectory = useGatekeeperDirectory(http);
  const gatekeeperNames = gatekeeperDirectory.names;
  const gateSame = gatekeeperDirectory.same;
  const [rewritten, setRewritten] = useState<{
    readonly key: string;
    readonly params: readonly GateOwnedParamWire[];
  } | null>(null);
  const { role, principalId } = useWorkspaceIdentity(http);
  const [busy, setBusy] = useState<string | null>(null);
  // S8 W3-K1 (leftover 81): the "编辑描述" dialog — one instance shared across rows, controlled by
  // which row (if any) is being edited, same "single shared surface, not one-per-row" convention
  // `GrantGateDrawer`/`Confirm` already use elsewhere in this codebase. Not tied to the URL (an
  // inline overlay on top of whichever row is selected, not a selection of its own).
  const [editingRow, setEditingRow] = useState<OperationCatalogRow | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);
  const [descriptionError, setDescriptionError] = useState<unknown | null>(null);
  const descriptionFieldId = useId();
  const descriptionBoxRef = useRef<HTMLTextAreaElement>(null);

  const rows = operations.state.status === 'ready' ? operations.state.data.items : [];
  // UX acceptance of #567 P3 (#561's same-name class, on Operations): one name on two gates read
  // as two identical rows — those rows name their gate.
  const sharedNames = operationNamesOnSeveralGates(rows);
  const versioned = identitiesListedTwice(rows);

  const selected = itemId ? rows.find((row) => catalogOperationKey(row) === itemId) : undefined;
  // Legacy 174: the question is about one draft's content — keyed by its digest too, so a gate
  // re-import that rewrites the draft in place drops the tick instead of confirming new content.
  const credentialReview = usePublishCredentialReview(
    itemId ? `${itemId}@${selected?.draftDigest ?? ''}` : null,
  );
  // S11 「门确认不存在」 B-a: same keying — a confirmation is for the draft content shown.
  const absentReview = useAbsentAnswersReview(
    itemId ? `${itemId}@${selected?.draftDigest ?? ''}` : null,
    selected,
  );

  function refresh(): void {
    invalidateCapability(http, 'list_operations');
    void operations.reload();
    announceReadinessChange(http);
  }

  function statsFor(row: OperationCatalogRow): OperationStatsRow | undefined {
    if (stats.state.status !== 'ready') return undefined;
    const key = operationStatsKey({ gatekeeperId: row.gatekeeperId, operationName: row.name });
    return stats.state.data.items.find((item) => operationStatsKey(item) === key);
  }

  async function act(
    row: OperationCatalogRow,
    action: 'publish_operation' | 'deprecate_operation',
  ) {
    const key = catalogOperationKey(row);
    setBusy(key);
    try {
      await http.call(action, {
        gatekeeperId: row.gatekeeperId,
        name: row.name,
        ...(action === 'publish_operation' ? credentialReview.params() : {}),
        ...(action === 'publish_operation' ? absentReview.params() : {}),
        // Review #493 on #583: the draft this detail shows, not whatever replaced it since.
        ...(action === 'publish_operation' && row.draftDigest !== undefined
          ? { draftDigest: row.draftDigest }
          : {}),
      });
      const shown = actionKindTagToastText(row.name);
      toast.push({
        tone: 'ok',
        title:
          action === 'publish_operation'
            ? row.version !== undefined
              ? t(`${shown} 已发布 v${row.version}`, `${shown} v${row.version} published`)
              : t(`${shown} 已发布`, `${shown} published`)
            : t(`${shown} 已弃用`, `${shown} deprecated`),
      });
      // A published revision draft is no longer `@draft` (UX acceptance of #538: the detail read
      // 「未找到」 after publishing) — follow it to the version now in effect.
      if (action === 'publish_operation' && key !== operationKey(row) && itemId === key) {
        onSelectItem(operationKey(row));
      }
      refresh();
    } catch (err) {
      // The kernel's credential question — answered next to Publish, not as a failure toast.
      if (action === 'publish_operation' && credentialReview.capture(err)) return;
      // S11 「门确认不存在」 B-a: the kernel's question about declared "not there" answers, likewise.
      if (action === 'publish_operation' && absentReview.capture(err)) return;
      if (isForbiddenError(err)) permissions.markDenied(action);
      // The toast says it was reloaded: show what is there now.
      if (isDraftChangedError(err)) refresh();
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        // UX acceptance of #592 (P3-1): say which action failed.
        title:
          action === 'publish_operation'
            ? t(
                `无法发布 ${actionKindTagToastText(row.name)}`,
                `Could not publish ${actionKindTagToastText(row.name)}`,
              )
            : t(
                `无法弃用 ${actionKindTagToastText(row.name)}`,
                `Could not deprecate ${actionKindTagToastText(row.name)}`,
              ),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  // Legacy 278: `discard_operation_draft{gatekeeperId, name, version, draftDigest}` — the version
  // and content shown. A draft revised in place since (same version) is refused `draft_changed`
  // (review #493 on #583); the catalog then reloads it.
  async function discardOperation(row: OperationCatalogRow, reason?: string): Promise<void> {
    if (row.version === undefined || row.draftDigest === undefined) return;
    setBusy(catalogOperationKey(row));
    try {
      await http.call('discard_operation_draft', {
        gatekeeperId: row.gatekeeperId,
        name: row.name,
        version: row.version,
        draftDigest: row.draftDigest,
        ...(reason !== undefined ? { reason } : {}),
      });
      toast.push({
        tone: 'ok',
        title: t(
          `${actionKindTagToastText(row.name)} v${row.version} 已丢弃`,
          `${actionKindTagToastText(row.name)} v${row.version} discarded`,
        ),
      });
      onSelectItem(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_operation_draft');
      if (isDraftChangedError(err)) refresh();
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  function openDescriptionEditor(row: OperationCatalogRow): void {
    setEditingRow(row);
    setDescriptionDraft(row.description ?? '');
    setDescriptionError(null);
  }

  function closeDescriptionEditor(): void {
    setEditingRow(null);
    setDescriptionError(null);
  }

  async function saveDescription(): Promise<void> {
    if (!editingRow) return;
    setSavingDescription(true);
    setDescriptionError(null);
    try {
      await http.call('update_operation_description', {
        gatekeeperId: editingRow.gatekeeperId,
        name: editingRow.name,
        description: descriptionDraft,
      });
      toast.push({
        tone: 'ok',
        title: t('描述已更新', 'Description updated'),
        description: actionKindTagToastText(editingRow.name),
      });
      setEditingRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('update_operation_description');
      setDescriptionError(err);
      // The Save button was disabled while it ran, which dropped focus to the page: put it back on
      // the box the error is about.
      descriptionBoxRef.current?.focus();
    } finally {
      setSavingDescription(false);
    }
  }

  const list =
    operations.state.status !== 'ready' ? (
      <DegradedList
        status={operations.state.status === 'loading' ? 'loading' : 'error'}
        error={operations.state.status === 'error' ? operations.state.error : undefined}
        reload={() => void operations.reload()}
        capabilityLabel="list_operations"
      />
    ) : rows.length === 0 ? (
      <EmptyState
        title={t('还没有导入任何 Operation', 'No operations imported yet')}
        body={t(
          'Operation 来自已接入系统发布的清单，或接入向导的提议。',
          "Operations come from a connected system's published manifest, or the onboarding wizard's proposals.",
        )}
        testId="catalog-empty"
      />
    ) : (
      <List ariaLabel="Operations" testId="catalog-list">
        {rows.map((row) => {
          const key = catalogOperationKey(row);
          const gateLabel = sharedNames.has(row.name)
            ? (nameOf(gatekeeperNames, row.gatekeeperId) ?? shortId(row.gatekeeperId))
            : null;
          return (
            <ListRow
              key={key}
              testId="catalog-row"
              selected={key === itemId}
              onSelect={() => onSelectItem(key)}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between', minWidth: 0 }}>
                <span className="row-wrap" style={{ minWidth: 0 }}>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                  <span className="mono wrap-anywhere" title={actionKindRaw(row.name)}>
                    {actionKindTagText(row.name)}
                  </span>
                  {versioned.has(operationKey(row)) && row.version !== undefined ? (
                    <span className="text-3 text-small" data-testid={`catalog-row-version-${key}`}>
                      v{row.version}
                    </span>
                  ) : null}
                  {gateLabel !== null ? (
                    <span className="text-3 truncate" data-testid={`catalog-row-gate-${key}`}>
                      {t(`门：${gateLabel}`, `Gate: ${gateLabel}`)}
                      <SameNameId id={row.gatekeeperId} same={gateSame} />
                    </span>
                  ) : null}
                </span>
                {row.mode ? (
                  <StatusChip machine="operationMode" status={row.mode} size="s" />
                ) : null}
              </span>
              <span className="truncate text-3" data-testid={`catalog-row-description-${key}`}>
                {row.description && row.description.trim().length > 0
                  ? row.description
                  : t('未填写描述', 'No description yet')}
              </span>
            </ListRow>
          );
        })}
      </List>
    );

  // D-24: a revision draft's publish also deprecates the version in effect — that row's
  // proposer counts too.
  const selectedLive =
    selected?.status === 'draft'
      ? rows.find(
          (row) => row.status === 'published' && operationKey(row) === operationKey(selected),
        )
      : undefined;
  const proposerOnly = selected
    ? proposerOnlyFor(
        selected,
        role,
        principalId,
        {
          publish: can('publish_operation') !== false,
          deprecate: can('deprecate_operation') !== false,
        },
        selectedLive,
      )
    : null;

  const detailContent = selected ? (
    <OperationDetailView
      http={http}
      row={selected}
      usage={statsFor(selected)}
      gatekeeperNames={gatekeeperNames}
      canPublish={can('publish_operation') !== false && proposerOnly === null}
      canDeprecate={can('deprecate_operation') !== false && proposerOnly === null}
      proposerOnly={proposerOnly}
      canEditDescription={
        can('update_operation_description') !== false &&
        mayActOnOwnOperation(selected, role, principalId)
      }
      canDiscard={
        can('discard_operation_draft') !== false &&
        mayActOnOwnOperation(selected, role, principalId)
      }
      busy={busy === catalogOperationKey(selected)}
      credentialReview={credentialReview}
      absentReview={absentReview}
      onPublish={() => act(selected, 'publish_operation')}
      onDeprecate={() => act(selected, 'deprecate_operation')}
      onDiscard={(reason) => discardOperation(selected, reason)}
      onEditDescription={() => openDescriptionEditor(selected)}
      onRewritten={() => {
        setRewritten({
          key: catalogOperationKey(selected),
          params: selected.gateOwnedParams ?? [],
        });
        void operations.reload();
      }}
      rewrittenFrom={
        rewritten !== null && rewritten.key === catalogOperationKey(selected)
          ? rewritten.params
          : null
      }
    />
  ) : (
    <SelectionPlaceholder
      itemId={itemId}
      ready={operations.state.status === 'ready'}
      emptyTitle={t(
        '选择左侧一个 Operation，查看详情',
        'Select an Operation on the left to see its detail',
      )}
    />
  );

  return (
    <>
      <MasterDetail
        list={list}
        detail={nothingToPick(operations.state.status, rows.length, itemId) ? null : detailContent}
        open={itemId !== undefined}
        onClose={() => onSelectItem(null)}
        sheetTitle={t('Operation 详情', 'Operation detail')}
        detailTestId="catalog-detail"
      />
      <Dialog
        open={editingRow !== null}
        onOpenChange={(open) => {
          if (!open) closeDescriptionEditor();
        }}
      >
        <DialogContent data-testid="operation-description-dialog">
          <DialogHeader>
            <DialogTitle>{t('编辑描述', 'Edit description')}</DialogTitle>
            <DialogDescription className="mono">
              {editingRow ? actionKindTagText(editingRow.name) : null}
            </DialogDescription>
          </DialogHeader>
          {/* Legacy 420: the box opens on the description as every read shows it, so a masked
              value is never filled back in. */}
          {showsRedaction(editingRow?.description) ? (
            <Notice tone="warn" testId="operation-description-redacted">
              {t(
                '当前描述里的 [redacted] 遮住了看起来像密码、令牌或密钥的内容，原文不会填回来。保存前请把这一段重新写成不带凭据的说明；还留着 [redacted] 的描述保存不了。',
                'Each [redacted] in the current description hides something that looked like a password, token or key, and the original is not filled back in. Write that part again without the credential before saving; a description that still holds [redacted] cannot be saved.',
              )}
            </Notice>
          ) : null}
          <Field
            id={descriptionFieldId}
            label={t('描述', 'Description')}
            hint={t(
              '说明这个 Operation 做什么——会用于自然语言检索与在目录 / 审批卡片里展示。',
              "What this Operation does — used for natural-language search and shown wherever it's listed.",
            )}
            error={
              descriptionError !== null
                ? errorToastText(descriptionError, t, {
                    // Legacy 420: said in the field's own terms — every agent reads it.
                    credentials_in_text: t(
                      '描述里看起来带了凭据（token、key 或密码的值，或 Bearer、Authorization、name=value 这类写法），已拒绝，什么也没保存。描述只写这个 Operation 做什么，每个能用它的 agent 都会读到；凭据交给门保管。',
                      'The description looks like it carries a credential (a token, key or password value, or a Bearer, Authorization or name=value form), so it was refused and nothing was saved. Say what this Operation does: every agent that can use it reads this. The credential belongs to the gate.',
                    ),
                    redacted_text_submitted: t(
                      '没有保存：描述里还留着 [redacted]。把这一段重新写成不带凭据的说明再保存。',
                      'Not saved: the description still holds [redacted]. Write that part again without the credential, then save.',
                    ),
                  })
                : undefined
            }
          >
            <Textarea
              ref={descriptionBoxRef}
              id={descriptionFieldId}
              aria-label={t('描述', 'Description')}
              value={descriptionDraft}
              onChange={(event) => setDescriptionDraft(event.target.value)}
              minRows={4}
              maxLength={OPERATION_DESCRIPTION_MAX_LENGTH}
              invalid={descriptionError !== null}
              aria-describedby={describedBy(descriptionFieldId, true, descriptionError !== null)}
              data-testid="operation-description-textarea"
            />
          </Field>
          <DialogFooter>
            {/* ux-lint-allow-disabled: one field — the description box is empty. */}
            <Button
              variant="primary"
              size="s"
              disabled={savingDescription || descriptionDraft.trim().length === 0}
              aria-busy={savingDescription || undefined}
              onClick={() => void saveDescription()}
              data-testid="operation-description-save"
            >
              {t('保存', 'Save')}
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="s" disabled={savingDescription}>
                {t('取消', 'Cancel')}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// -------------------------------------------------------------------------------------------
// Skills
// -------------------------------------------------------------------------------------------

/** "Proposed by" on a Skill / Procedure detail. The owner and builders see every draft (D-26 rule,
 *  kernel application/worker/draft-visibility.ts) — a member's Worker-proposed Skill is reviewed
 *  here — so the detail names whose draft it is; the chip resolves the name itself. */
function proposerItem(
  http: CapabilityCaller,
  proposedBy: string,
  t: Translate,
  testId: string,
): KeyValueItem {
  return {
    key: 'proposedBy',
    label: t('提议者', 'Proposed by'),
    value: <RefChip kind="principal" id={proposedBy} http={http} size="s" testId={testId} />,
  };
}

/** `discard_draft` stays the proposer's own act, so a reviewer looking at someone else's draft is
 *  not offered it. Unknown either side (an older kernel, `get_workspace` not loaded) keeps the
 *  action, as before. */
function isOwnDraftOrUnknown(
  row: { readonly proposedBy?: string },
  callerPrincipalId: string | null,
): boolean {
  return (
    row.proposedBy === undefined ||
    callerPrincipalId === null ||
    row.proposedBy === callerPrincipalId
  );
}

/** E2-0b (review #493 on #764, F2): 「拒绝」 is offered on a pending Skill / Procedure draft
 *  someone else proposed — its own proposer discards it — unless the caller is proven not to be
 *  one of its reviewers (`provenNotDraftReviewer`: the owner, or the proposer of the version in
 *  use). The role floor is `can('reject_draft')`'s. */
function offersReject(
  row: {
    readonly status: string;
    readonly proposedBy?: string;
    readonly inUse?: { readonly proposedBy?: string };
  },
  role: WorkspaceRole,
  callerPrincipalId: string | null,
): boolean {
  if (row.status !== 'draft') return false;
  if (callerPrincipalId !== null && row.proposedBy === callerPrincipalId) return false;
  return !provenNotDraftReviewer(row, role, callerPrincipalId);
}

/**
 * D-24 (kernel `publish-authority.ts`): which of Publish / Deprecate this row withholds because
 * the caller is proven neither its proposer nor the owner (`provenNotProposer`) — the kernel
 * refuses those with 403 `not_proposer`. Only an action the role could otherwise take is
 * withheld (the role floor is `useRoleCan`'s own). `live`: an Operation revision draft's
 * published version, which publishing it also deprecates — the caller needs authority over it too.
 */
function proposerOnlyFor(
  row: { readonly status: string; readonly proposedBy?: string },
  role: WorkspaceRole,
  callerPrincipalId: string | null,
  roleCan: { readonly publish: boolean; readonly deprecate: boolean },
  live?: { readonly proposedBy?: string },
): ProposerOnlyAction | null {
  if (row.status === 'draft' && roleCan.publish) {
    if (provenNotProposer(row, role, callerPrincipalId)) return 'publish';
    if (live !== undefined && provenNotProposer(live, role, callerPrincipalId)) return 'replace';
  }
  if (
    row.status === 'published' &&
    roleCan.deprecate &&
    provenNotProposer(row, role, callerPrincipalId)
  ) {
    return 'deprecate';
  }
  return null;
}

/** Said where Publish / Deprecate would have been (D-24), so the action is not just missing. */
function ProposerOnlyHint({ action }: { readonly action: ProposerOnlyAction }) {
  const t = useT();
  return (
    <span className="text-3 text-small" data-testid="catalog-proposer-only">
      {proposerOnlyText(action, t)}
    </span>
  );
}

/**
 * UX acceptance of #764 (P2-1): a family with a pending draft lists as that draft (the latest
 * version the owner and builders see), so the published version still in use is named beside it:
 * on the draft, which version stays in use until it is published, with a way to open it; on that
 * version (opened from the draft, read-only), the draft waiting beside it, with the way back.
 */
function FamilyVersionNote({
  kind,
  draftVersion,
  inUseVersion,
  showing,
  onOpen,
}: {
  readonly kind: 'skill' | 'procedure';
  readonly draftVersion: number;
  readonly inUseVersion: number;
  /** Which of the two this detail shows. */
  readonly showing: 'draft' | 'inUse';
  readonly onOpen: () => void;
}) {
  const t = useT();
  if (showing === 'draft') {
    return (
      <Notice testId={`${kind}-detail-in-use-note`}>
        <p>
          {kind === 'skill'
            ? t(
                `已发布的 v${inUseVersion} 仍在用：Worker 挂载的是它，这份草稿 v${draftVersion} 发布后才改用新版本。`,
                `Published v${inUseVersion} is still in use: Workers mount it until this draft, v${draftVersion}, is published.`,
              )
            : t(
                `已发布的 v${inUseVersion} 仍在用：从这个流程发起的目标用的是它，这份草稿 v${draftVersion} 发布后才改用新版本。`,
                `Published v${inUseVersion} is still in use: goals made from this Procedure use it until this draft, v${draftVersion}, is published.`,
              )}
        </p>
        <Button
          variant="ghost"
          size="s"
          onClick={onOpen}
          data-testid={`${kind}-detail-open-in-use`}
        >
          {t(`查看在用的 v${inUseVersion}`, `See v${inUseVersion}, the one in use`)}
        </Button>
      </Notice>
    );
  }
  return (
    <Notice testId={`${kind}-detail-pending-draft-note`}>
      <p>
        {kind === 'skill'
          ? t(
              `这是在用的 v${inUseVersion}（只读）。这个 Skill 还有一份待发布的草稿 v${draftVersion}。`,
              `This is v${inUseVersion}, the one in use (read-only). This Skill also has a draft, v${draftVersion}, waiting to be published.`,
            )
          : t(
              `这是在用的 v${inUseVersion}（只读）。这个流程还有一份待发布的草稿 v${draftVersion}。`,
              `This is v${inUseVersion}, the one in use (read-only). This Procedure also has a draft, v${draftVersion}, waiting to be published.`,
            )}
      </p>
      <Button variant="ghost" size="s" onClick={onOpen} data-testid={`${kind}-detail-open-draft`}>
        {t(`回到草稿 v${draftVersion}`, `Back to draft v${draftVersion}`)}
      </Button>
    </Notice>
  );
}

/** UX acceptance of #764 (P2-1): a list row's version line — the draft and the version in use
 *  beside it when there is one. */
function familyVersionLine(
  row: { readonly version: number; readonly inUse?: { readonly version: number } },
  t: Translate,
): ReactNode {
  if (!row.inUse) return `v${row.version}`;
  return (
    <span data-testid="catalog-row-in-use">
      {t(
        `v${row.inUse.version} 已发布（在用）· v${row.version} 草稿待发布`,
        `v${row.inUse.version} published (in use) · v${row.version} draft pending`,
      )}
    </span>
  );
}

function SkillDetailView({
  http,
  row,
  canPropose,
  canPublish,
  canDeprecate,
  proposerOnly,
  canDiscard,
  canReject,
  inUseVersion,
  busy,
  credentialReview,
  versionNote,
  focusTitle,
  onTitleFocused,
  onEditAsNewVersion,
  onSaveAsNew,
  onPublish,
  onDeprecate,
  onDiscard,
  onReject,
}: {
  readonly http: CapabilityCaller;
  readonly row: Omit<SkillRow, 'inUse'>;
  readonly canPropose: boolean;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  /** D-24: as `OperationDetailView`'s. */
  readonly proposerOnly: ProposerOnlyAction | null;
  readonly canDiscard: boolean;
  readonly busy: boolean;
  readonly credentialReview: PublishCredentialReview;
  /** UX acceptance of #764 (P2-1): `FamilyVersionNote`, or nothing. */
  readonly versionNote: ReactNode;
  /** UX acceptance of #764 (P3-1): the detail opened from 「查看那份草稿」 or a version note takes
   *  focus on its title; `onTitleFocused` clears the request. */
  readonly focusTitle: boolean;
  readonly onTitleFocused: () => void;
  /** 「编辑（新版本草稿）」: the next version of this Skill (published rows only). */
  readonly onEditAsNewVersion: () => void;
  /** 「另存为新的 Skill」: a copy proposed as a new Skill. */
  readonly onSaveAsNew: () => void;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: (reason: string | undefined) => Promise<void>;
  /** E2-0b: 「拒绝」 on this pending draft (`offersReject`). */
  readonly canReject: boolean;
  /** On a draft, the family's version in use (`undefined`: none) — what rejecting leaves in use. */
  readonly inUseVersion: number | undefined;
  readonly onReject: (reason: string) => Promise<void>;
}) {
  const t = useT();
  // Best-effort read of the current version's full body — degrades to "—" on error/while loading
  // rather than blocking the rest of the detail (same convention `get_operation_stats` uses on the
  // Operations tab above). `get_skill` already exists and is already called from this same file
  // for the copy-prefill flow (`SkillEditor.tsx`); this is a second, read-only call site of it.
  // UX acceptance of #764 (P2-1): the version this detail shows — the published one in use, opened
  // beside a pending draft, is not the latest.
  const skillDetail = useCapability<SkillDetailWire | null>(http, 'get_skill', {
    skillId: row.id,
    version: row.version,
  });
  const titleRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request moves focus.
  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    onTitleFocused();
  }, [focusTitle]);
  const items: KeyValueItem[] = [
    { key: 'description', label: t('描述', 'Description'), value: row.description },
  ];
  if (row.proposedBy) {
    items.push(proposerItem(http, row.proposedBy, t, 'skill-detail-proposer'));
  }
  const gateKinds = row.applicable?.gateKinds as readonly string[] | undefined;
  const objectTypes = row.applicable?.objectTypes as readonly string[] | undefined;
  if (gateKinds && gateKinds.length > 0) {
    items.push({
      key: 'gateKinds',
      label: t('适用的门类型', 'applicable.gateKinds'),
      value: gateKinds.join(', '),
      mono: true,
    });
  }
  if (objectTypes && objectTypes.length > 0) {
    items.push({
      key: 'objectTypes',
      label: t('适用的对象类型', 'applicable.objectTypes'),
      value: objectTypes.join(', '),
      mono: true,
    });
  }

  return (
    <div className="stack" data-testid="skill-detail" data-skill-id={row.id}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="publishable" status={row.status} size="s" />
          <strong ref={titleRef} tabIndex={-1} className="catalog-detail-title wrap-anywhere">
            {row.name}
          </strong>
          <span className="text-3 text-small">v{row.version}</span>
        </div>
        {row.status === 'published' ? (
          <PackOrigin
            http={http}
            target={{ kind: 'skill', skillId: row.id }}
            testId="skill-detail-pack-origin"
          />
        ) : null}
        <PublishableStepper status={row.status} testId="skill-detail-stepper" />
      </header>

      {versionNote}

      <KeyValue items={items} />

      <div className="stack-s">
        <span className="section-title">{t('正文', 'SKILL.md body')}</span>
        {skillDetail.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading body" testId="skill-detail-body-loading" />
        ) : skillDetail.state.status === 'ready' && skillDetail.state.data ? (
          <MarkdownPreview markdown={skillDetail.state.data.markdown} testId="skill-detail-body" />
        ) : (
          <span className="text-3">—</span>
        )}
      </div>

      {canPublish && row.status === 'draft' ? (
        <PublishCredentialSlot
          review={credentialReview}
          busy={busy}
          fieldNames={reviewFieldNames('skill', t)}
        />
      ) : null}
      <div className="row-wrap">
        {/* S11 W1a E2-0: a published Skill's next version keeps its id and name; a draft is
            published or discarded first (409 draft_pending), so only the copy is offered on one. */}
        {canPropose && row.status === 'published' ? (
          <Button
            variant="ghost"
            size="s"
            onClick={onEditAsNewVersion}
            data-testid="catalog-edit-as-draft"
          >
            {t('编辑（新版本草稿）', 'Edit as new draft version')}
          </Button>
        ) : null}
        {canPropose ? (
          <Button variant="ghost" size="s" onClick={onSaveAsNew} data-testid="catalog-save-as-new">
            {t('另存为新的 Skill', 'Save as a new Skill')}
          </Button>
        ) : null}
        {canPublish && row.status === 'draft' ? (
          <Button
            variant="primary"
            size="s"
            disabled={busy || credentialReview.blocked}
            aria-busy={busy || undefined}
            onClick={() => void onPublish()}
          >
            {t('发布', 'Publish')}
          </Button>
        ) : canDeprecate && row.status === 'published' ? (
          <DeprecateConfirm
            busy={busy}
            target={row.name}
            onConfirm={onDeprecate}
            testId={`skill-deprecate-confirm-${row.id}`}
          />
        ) : proposerOnly !== null ? (
          <ProposerOnlyHint action={proposerOnly} />
        ) : null}
        {canDiscard && row.status === 'draft' ? (
          <DiscardDraftConfirm
            busy={busy}
            target={row.name}
            onConfirm={onDiscard}
            testId={`skill-discard-confirm-${row.id}`}
          />
        ) : null}
        {canReject && row.status === 'draft' ? (
          <RejectDraftConfirm
            kind="skill"
            busy={busy}
            target={`${row.name} v${row.version}`}
            inUseVersion={inUseVersion}
            onConfirm={onReject}
            testId={`skill-reject-confirm-${row.id}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function SkillsTab({ http, itemId, onSelectItem }: CatalogTabProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const toast = useToast();
  const skills = useCapabilityList<SkillRow>(http, 'list_skills');
  const { role, principalId } = useWorkspaceIdentity(http);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<SkillRow>>(null);
  // UX acceptance of #764 (P2-1): the family whose version in use is open instead of its draft.
  const [inUseOf, setInUseOf] = useState<string | null>(null);
  // UX acceptance of #764 (P3-1): the family whose detail title takes focus when it shows.
  const [focusFamily, setFocusFamily] = useState<string | null>(null);

  const rows = skills.state.status === 'ready' ? skills.state.data.items : [];
  const selected = itemId ? rows.find((row) => row.id === itemId) : undefined;
  const shown = selected?.inUse && inUseOf === selected.id ? selected.inUse : selected;
  const credentialReview = usePublishCredentialReview(
    selected ? `${selected.id}@${selected.version}` : null,
  );
  // The editor only ever shows while `itemId` is the `NEW_ITEM_ID` sentinel — a stale `editor`
  // left over from a previous open (e.g. the reader picked a different, real row instead of
  // finishing it) never flashes back in; see `CatalogPage`'s own doc comment.
  const showEditor = editor !== null && itemId === NEW_ITEM_ID;

  function refresh(): void {
    invalidateCapability(http, 'list_skills');
    void skills.reload();
  }

  function openEditor(next: EditorState<SkillRow>): void {
    setEditor(next);
    onSelectItem(NEW_ITEM_ID);
  }

  function selectRow(id: string | null): void {
    setEditor(null);
    setInUseOf(null);
    onSelectItem(id);
  }

  function closeEditor(): void {
    setEditor(null);
    onSelectItem(null);
  }

  /** S11 W1a E2-0: a next version was refused because the family's latest version is still a
   *  draft (409 draft_pending) — reload the list (that draft may be newer than it) and show the
   *  family, whose row is now that draft, with focus on its title (UX acceptance of #764, P3-1). */
  function showFamily(id: string): void {
    setFocusFamily(id);
    selectRow(id);
    refresh();
  }

  /** UX acceptance of #764 (P2-1): between a pending draft and the version in use beside it. */
  function showInUse(id: string, inUse: boolean): void {
    setFocusFamily(id);
    setInUseOf(inUse ? id : null);
  }

  async function act(row: SkillRow, action: 'publish_skill' | 'deprecate_skill') {
    setBusy(row.id);
    try {
      await http.call(action, {
        skillId: row.id,
        ...(action === 'publish_skill' ? credentialReview.params() : {}),
        // Legacy 300: the version this detail shows, not a newer one proposed since — and
        // (review #493 on #764, F1) its content, not another draft proposed under that version.
        ...(action === 'publish_skill'
          ? { version: row.version, draftDigest: row.draftDigest }
          : {}),
      });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_skill' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
      });
      refresh();
    } catch (err) {
      // The kernel's credential question — answered next to Publish, not as a failure toast.
      if (action === 'publish_skill' && credentialReview.capture(err)) return;
      if (isForbiddenError(err)) permissions.markDenied(action);
      // The toast says it was reloaded: show what is there now.
      if (isVersionChangedError(err) || isDraftChangedError(err)) refresh();
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        // UX acceptance of #592 (P3-1): say which action failed.
        title:
          action === 'publish_skill'
            ? t(`无法发布 ${row.name}`, `Could not publish ${row.name}`)
            : t(`无法弃用 ${row.name}`, `Could not deprecate ${row.name}`),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  // S8 W3 K2 (leftover 82): `discard_draft{kind, id, version}` — a different params shape from
  // `act` above (`{skillId}` alone), so it is its own function rather than a third `action` value.
  async function discardSkillDraft(row: SkillRow, reason?: string): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', {
        kind: 'skill',
        id: row.id,
        version: row.version,
        ...(reason !== undefined ? { reason } : {}),
      });
      toast.push({ tone: 'ok', title: `${row.name} ${t('已丢弃', 'discarded')}` });
      selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  // E2-0b (review #493 on #764, F2): `reject_draft{kind, id, version, draftDigest, reason}` — the
  // reviewer's transition. A refusal is thrown, so `RejectDraftConfirm` shows it in place with the
  // reason kept; a draft swapped since it was read (`draft_changed`) is read again instead (the
  // detail is another one then, and the confirm closes with it).
  async function rejectSkillDraft(row: SkillRow, reason: string): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('reject_draft', {
        kind: 'skill',
        id: row.id,
        version: row.version,
        draftDigest: row.draftDigest,
        reason,
      });
      toast.push({
        tone: 'ok',
        title: t(`已拒绝 ${row.name} v${row.version}`, `Rejected ${row.name} v${row.version}`),
      });
      // With a version in use the family's row is that version now; without one it is gone.
      if (row.inUse === undefined) selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('reject_draft');
      if (!isDraftChangedError(err)) throw err;
      refresh();
      toast.push({
        tone: 'danger',
        title: t(`无法拒绝 ${row.name}`, `Could not reject ${row.name}`),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = can('propose_skill') !== false;
  const canPublish = can('publish_skill') !== false;
  const canDeprecate = can('deprecate_skill') !== false;
  const canDiscard = can('discard_draft') !== false;
  const canReject = can('reject_draft') !== false;
  // D-24: Publish / Deprecate on a row another principal proposed is the owner's.
  const selectedProposerOnly = selected
    ? proposerOnlyFor(selected, role, principalId, {
        publish: canPublish,
        deprecate: canDeprecate,
      })
    : null;

  const editorPane = editor ? (
    <div className="stack">
      <h2 className="catalog-detail-title">
        {editor.kind === 'version'
          ? t('提议新版本', 'Propose a new version')
          : editor.kind === 'copy'
            ? t('另存为新的 Skill', 'Save as a new Skill')
            : t('新建 Skill 草稿', 'New Skill draft')}
      </h2>
      <p className="text-3 text-small">
        {t('SKILL.md：frontmatter 字段 + Markdown 正文', 'frontmatter fields + Markdown body')}
      </p>
      <SkillEditor
        key={editor.kind === 'new' ? 'new' : `${editor.kind}:${editor.row.id}`}
        http={http}
        copyOf={editor.kind === 'copy' ? editor.row : undefined}
        nextVersionOf={editor.kind === 'version' ? editor.row : undefined}
        onShowPendingDraft={editor.kind === 'version' ? () => showFamily(editor.row.id) : undefined}
        onProposed={() => void skills.reload()}
        onDone={() => {
          closeEditor();
          refresh();
        }}
        onPublished={refresh}
      />
    </div>
  ) : null;

  const list =
    skills.state.status !== 'ready' ? (
      <DegradedList
        status={skills.state.status === 'loading' ? 'loading' : 'error'}
        error={skills.state.status === 'error' ? skills.state.error : undefined}
        reload={() => void skills.reload()}
        capabilityLabel="list_skills"
      />
    ) : (
      <div className="stack-s">
        <DraftToolbar
          canPropose={canPropose}
          onNewDraft={() => openEditor({ kind: 'new' })}
          onRefresh={refresh}
          refreshing={skills.state.refreshing}
          testId="skills-new-draft"
        />
        <DraftExpiryNote testId="skills-draft-expiry-note" />
        {rows.length === 0 ? (
          <EmptyState
            title={t('还没有 Skill', 'No Skills yet')}
            body={t(
              '用「新建草稿」写第一个 SKILL.md，或让 Worker 在结果里提议。',
              'Write the first SKILL.md with New draft, or let a Worker propose one in its result.',
            )}
            testId="catalog-empty"
          />
        ) : (
          <List ariaLabel="Skills" testId="catalog-list">
            {rows.map((row) => (
              <ListRow
                key={row.id}
                testId="catalog-row"
                selected={row.id === itemId}
                onSelect={() => selectRow(row.id)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between', minWidth: 0 }}>
                  <span className="wrap-anywhere">{row.name}</span>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">
                  {familyVersionLine(row, t)} · {row.description}
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {skills.state.data.nextCursor !== undefined ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <Button
              variant="secondary"
              aria-busy={skills.loadingMore || undefined}
              disabled={skills.loadingMore}
              onClick={() => void skills.loadMore()}
            >
              {t('加载更多', 'Load more')}
            </Button>
          </div>
        ) : null}
        {skills.state.data.truncated === true ? (
          <p className="text-3 text-small" data-testid="skills-truncated">
            {t(
              '已达到单次读取上限，继续点“加载更多”查看其余 Skill。',
              'Reached the per-page limit — keep loading more to see the rest.',
            )}
          </p>
        ) : null}
        {skills.loadMoreError !== null ? (
          <ErrorBanner
            error={skills.loadMoreError}
            title={t('无法加载更多 Skill', 'Could not load more skills')}
            testId="skills-load-more-error"
          />
        ) : null}
      </div>
    );

  const detailContent = showEditor ? (
    editorPane
  ) : selected && shown && shown !== selected ? (
    // UX acceptance of #764 (P2-1): the version in use, opened from its family's draft — read-only;
    // the draft is what is acted on.
    <SkillDetailView
      key={`${shown.id}@${shown.version}`}
      http={http}
      row={shown}
      canPropose={false}
      canPublish={false}
      canDeprecate={false}
      proposerOnly={null}
      canDiscard={false}
      canReject={false}
      inUseVersion={undefined}
      busy={false}
      credentialReview={credentialReview}
      versionNote={
        <FamilyVersionNote
          kind="skill"
          draftVersion={selected.version}
          inUseVersion={shown.version}
          showing="inUse"
          onOpen={() => showInUse(selected.id, false)}
        />
      }
      focusTitle={focusFamily === selected.id}
      onTitleFocused={() => setFocusFamily(null)}
      onEditAsNewVersion={() => undefined}
      onSaveAsNew={() => undefined}
      onPublish={async () => undefined}
      onDeprecate={async () => undefined}
      onDiscard={async () => undefined}
      onReject={async () => undefined}
    />
  ) : selected ? (
    <SkillDetailView
      // Review #493 on #764 (F1): another draft under the same version is another detail — its
      // body (`get_skill`) is read again however the list was reloaded, so Publish binds the
      // content shown.
      key={`${selected.id}@${selected.version}:${selected.draftDigest ?? ''}`}
      http={http}
      row={selected}
      canPropose={canPropose}
      canPublish={canPublish && selectedProposerOnly === null}
      canDeprecate={canDeprecate && selectedProposerOnly === null}
      proposerOnly={selectedProposerOnly}
      canDiscard={canDiscard && isOwnDraftOrUnknown(selected, principalId)}
      canReject={canReject && offersReject(selected, role, principalId)}
      inUseVersion={selected.inUse?.version}
      busy={busy === selected.id}
      credentialReview={credentialReview}
      versionNote={
        selected.inUse ? (
          <FamilyVersionNote
            kind="skill"
            draftVersion={selected.version}
            inUseVersion={selected.inUse.version}
            showing="draft"
            onOpen={() => showInUse(selected.id, true)}
          />
        ) : null
      }
      focusTitle={focusFamily === selected.id}
      onTitleFocused={() => setFocusFamily(null)}
      onEditAsNewVersion={() => openEditor({ kind: 'version', row: selected })}
      onSaveAsNew={() => openEditor({ kind: 'copy', row: selected })}
      onPublish={() => act(selected, 'publish_skill')}
      onDeprecate={() => act(selected, 'deprecate_skill')}
      onDiscard={(reason) => discardSkillDraft(selected, reason)}
      onReject={(reason) => rejectSkillDraft(selected, reason)}
    />
  ) : (
    <SelectionPlaceholder
      itemId={itemId}
      ready={skills.state.status === 'ready'}
      emptyTitle={t(
        '选择左侧一个 Skill，查看与编辑它的 SKILL.md 正文',
        'Select a Skill on the left to view and edit its SKILL.md',
      )}
    />
  );

  return (
    <MasterDetail
      list={list}
      detail={
        !showEditor && nothingToPick(skills.state.status, rows.length, itemId)
          ? null
          : detailContent
      }
      open={itemId !== undefined}
      onClose={closeEditor}
      sheetTitle={t('Skill 详情', 'Skill detail')}
      detailTestId={showEditor ? 'skill-editor-drawer' : 'catalog-detail'}
    />
  );
}

// -------------------------------------------------------------------------------------------
// Procedures
// -------------------------------------------------------------------------------------------

function ProcedureDetailView({
  http,
  row,
  canPropose,
  canPublish,
  canDeprecate,
  proposerOnly,
  canDiscard,
  canReject,
  busy,
  credentialReview,
  publishProblems,
  versionNote,
  inUseVersion,
  focusTitle,
  onTitleFocused,
  onEditAsNewVersion,
  onSaveAsNew,
  onPublish,
  onDeprecate,
  onDiscard,
  onReject,
}: {
  readonly http: CapabilityCaller;
  readonly row: Omit<ProcedureRow, 'inUse'>;
  readonly canPropose: boolean;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  /** D-24: as `OperationDetailView`'s. */
  readonly proposerOnly: ProposerOnlyAction | null;
  readonly canDiscard: boolean;
  readonly busy: boolean;
  readonly credentialReview: PublishCredentialReview;
  /** Why the kernel refused the last publish of this version, as a template (UX acceptance of
   *  #722), or `null`. */
  readonly publishProblems: readonly string[] | null;
  /** As `SkillDetailView`'s. */
  readonly versionNote: ReactNode;
  /** On a draft, the family's version in use (UX acceptance of #764, P3-2: a template problem is
   *  fixed on it, not by copying the draft into a new Procedure). */
  readonly inUseVersion: number | undefined;
  readonly focusTitle: boolean;
  readonly onTitleFocused: () => void;
  /** 「编辑（新版本草稿）」: the next version of this Procedure (published rows only). */
  readonly onEditAsNewVersion: () => void;
  /** 「另存为新的流程」: a copy proposed as a new Procedure. */
  readonly onSaveAsNew: () => void;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: (reason: string | undefined) => Promise<void>;
  /** As `SkillDetailView`'s. */
  readonly canReject: boolean;
  readonly onReject: (reason: string) => Promise<void>;
}) {
  const t = useT();
  const titleRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request moves focus.
  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    onTitleFocused();
  }, [focusTitle]);
  return (
    <div className="stack" data-testid="procedure-detail" data-procedure-id={row.id}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="publishable" status={row.status} size="s" />
          <strong ref={titleRef} tabIndex={-1} className="catalog-detail-title wrap-anywhere">
            {row.name}
          </strong>
          <span className="text-3 text-small">v{row.version}</span>
          {row.steps ? (
            <span className="tag">
              {row.steps.length} {t('步', 'steps')}
            </span>
          ) : null}
        </div>
        <PublishableStepper status={row.status} testId="procedure-detail-stepper" />
      </header>

      {versionNote}

      <KeyValue
        items={[
          { key: 'description', label: t('描述', 'Description'), value: row.description },
          ...(row.proposedBy
            ? [proposerItem(http, row.proposedBy, t, 'procedure-detail-proposer')]
            : []),
        ]}
      />

      {/* S11 GO5d-2: the steps as the goal plan made from them reads them; JSON one click away. */}
      <ProcedureTemplateView
        http={http}
        status={row.status}
        steps={row.steps ?? []}
        parameters={row.parameters}
        inUseVersion={inUseVersion}
      />

      {canPublish && row.status === 'draft' ? (
        <PublishCredentialSlot
          review={credentialReview}
          busy={busy}
          fieldNames={reviewFieldNames('procedure', t)}
        />
      ) : null}
      {publishProblems && row.status === 'draft' ? (
        <PublishTemplateProblems problems={publishProblems} />
      ) : null}
      <div className="row-wrap">
        {/* S11 W1a E2-0: as the Skill detail's — same id, next version; a draft only copies. */}
        {canPropose && row.status === 'published' ? (
          <Button
            variant="ghost"
            size="s"
            onClick={onEditAsNewVersion}
            data-testid="catalog-edit-as-draft"
          >
            {t('编辑（新版本草稿）', 'Edit as new draft version')}
          </Button>
        ) : null}
        {canPropose ? (
          <Button variant="ghost" size="s" onClick={onSaveAsNew} data-testid="catalog-save-as-new">
            {t('另存为新的流程', 'Save as a new Procedure')}
          </Button>
        ) : null}
        {canPublish && row.status === 'draft' ? (
          <Button
            variant="primary"
            size="s"
            disabled={busy || credentialReview.blocked}
            aria-busy={busy || undefined}
            onClick={() => void onPublish()}
          >
            {t('发布', 'Publish')}
          </Button>
        ) : canDeprecate && row.status === 'published' ? (
          <DeprecateConfirm
            busy={busy}
            target={row.name}
            onConfirm={onDeprecate}
            testId={`procedure-deprecate-confirm-${row.id}`}
          />
        ) : proposerOnly !== null ? (
          <ProposerOnlyHint action={proposerOnly} />
        ) : null}
        {canDiscard && row.status === 'draft' ? (
          <DiscardDraftConfirm
            busy={busy}
            target={row.name}
            onConfirm={onDiscard}
            testId={`procedure-discard-confirm-${row.id}`}
          />
        ) : null}
        {canReject && row.status === 'draft' ? (
          <RejectDraftConfirm
            kind="procedure"
            busy={busy}
            target={`${row.name} v${row.version}`}
            inUseVersion={inUseVersion}
            onConfirm={onReject}
            testId={`procedure-reject-confirm-${row.id}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProceduresTab({ http, itemId, onSelectItem }: CatalogTabProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const toast = useToast();
  const procedures = useCapabilityList<ProcedureRow>(http, 'list_procedures');
  const { role, principalId } = useWorkspaceIdentity(http);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<ProcedureRow>>(null);
  // UX acceptance of #764 (P2-1, P3-1): as the Skills tab's.
  const [inUseOf, setInUseOf] = useState<string | null>(null);
  const [focusFamily, setFocusFamily] = useState<string | null>(null);
  // UX acceptance of #722 (P2-1): the last publish refusal as a template, by `id@version`.
  const [publishRefusal, setPublishRefusal] = useState<{
    readonly version: string;
    readonly problems: readonly string[];
  } | null>(null);

  const rows = procedures.state.status === 'ready' ? procedures.state.data.items : [];
  const selected = itemId ? rows.find((row) => row.id === itemId) : undefined;
  const shown = selected?.inUse && inUseOf === selected.id ? selected.inUse : selected;
  const selectedVersion = selected ? `${selected.id}@${selected.version}` : null;
  const credentialReview = usePublishCredentialReview(selectedVersion);
  const publishProblems =
    publishRefusal !== null && publishRefusal.version === selectedVersion
      ? publishRefusal.problems
      : null;
  const showEditor = editor !== null && itemId === NEW_ITEM_ID;

  function refresh(): void {
    invalidateCapability(http, 'list_procedures');
    void procedures.reload();
  }

  function openEditor(next: EditorState<ProcedureRow>): void {
    setEditor(next);
    onSelectItem(NEW_ITEM_ID);
  }

  function selectRow(id: string | null): void {
    setEditor(null);
    setInUseOf(null);
    onSelectItem(id);
  }

  function closeEditor(): void {
    setEditor(null);
    onSelectItem(null);
  }

  /** S11 W1a E2-0: a next version was refused because the family's latest version is still a
   *  draft (409 draft_pending) — reload the list (that draft may be newer than it) and show the
   *  family, whose row is now that draft, with focus on its title (UX acceptance of #764, P3-1). */
  function showFamily(id: string): void {
    setFocusFamily(id);
    selectRow(id);
    refresh();
  }

  /** UX acceptance of #764 (P2-1): between a pending draft and the version in use beside it. */
  function showInUse(id: string, inUse: boolean): void {
    setFocusFamily(id);
    setInUseOf(inUse ? id : null);
  }

  async function act(row: ProcedureRow, action: 'publish_procedure' | 'deprecate_procedure') {
    setBusy(row.id);
    try {
      await http.call(action, {
        procedureId: row.id,
        ...(action === 'publish_procedure' ? credentialReview.params() : {}),
        // Legacy 300: the version this detail shows, not a newer one proposed since — and
        // (review #493 on #764, F1) its content, not another draft proposed under that version.
        ...(action === 'publish_procedure'
          ? { version: row.version, draftDigest: row.draftDigest }
          : {}),
      });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_procedure' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
      });
      setPublishRefusal(null);
      refresh();
    } catch (err) {
      // The kernel's credential question — answered next to Publish, not as a failure toast.
      if (action === 'publish_procedure' && credentialReview.capture(err)) return;
      // The plan it makes does not pass: listed next to Publish too (UX acceptance of #722).
      const problems = action === 'publish_procedure' ? procedureTemplateProblemsOf(err) : null;
      if (problems && problems.length > 0) {
        setPublishRefusal({ version: `${row.id}@${row.version}`, problems });
        return;
      }
      if (isForbiddenError(err)) permissions.markDenied(action);
      // The toast says it was reloaded: show what is there now.
      if (isVersionChangedError(err) || isDraftChangedError(err)) refresh();
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        // UX acceptance of #592 (P3-1): say which action failed.
        title:
          action === 'publish_procedure'
            ? t(`无法发布 ${row.name}`, `Could not publish ${row.name}`)
            : t(`无法弃用 ${row.name}`, `Could not deprecate ${row.name}`),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  // S8 W3 K2 (leftover 82): `discard_draft{kind, id, version}` — a different params shape from
  // `act` above (`{procedureId}` alone), so it is its own function rather than a third `action`.
  async function discardProcedureDraft(row: ProcedureRow, reason?: string): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', {
        kind: 'procedure',
        id: row.id,
        version: row.version,
        ...(reason !== undefined ? { reason } : {}),
      });
      toast.push({ tone: 'ok', title: `${row.name} ${t('已丢弃', 'discarded')}` });
      selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  // E2-0b: as the Skills tab's `rejectSkillDraft`.
  async function rejectProcedureDraft(row: ProcedureRow, reason: string): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('reject_draft', {
        kind: 'procedure',
        id: row.id,
        version: row.version,
        draftDigest: row.draftDigest,
        reason,
      });
      toast.push({
        tone: 'ok',
        title: t(`已拒绝 ${row.name} v${row.version}`, `Rejected ${row.name} v${row.version}`),
      });
      if (row.inUse === undefined) selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('reject_draft');
      if (!isDraftChangedError(err)) throw err;
      refresh();
      toast.push({
        tone: 'danger',
        title: t(`无法拒绝 ${row.name}`, `Could not reject ${row.name}`),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = can('propose_procedure') !== false;
  const canPublish = can('publish_procedure') !== false;
  const canDeprecate = can('deprecate_procedure') !== false;
  const canDiscard = can('discard_draft') !== false;
  const canReject = can('reject_draft') !== false;
  // D-24: Publish / Deprecate on a row another principal proposed is the owner's.
  const selectedProposerOnly = selected
    ? proposerOnlyFor(selected, role, principalId, {
        publish: canPublish,
        deprecate: canDeprecate,
      })
    : null;

  const editorPane = editor ? (
    <div className="stack">
      <h2 className="catalog-detail-title">
        {editor.kind === 'version'
          ? t('提议新版本', 'Propose a new version')
          : editor.kind === 'copy'
            ? t('另存为新的流程', 'Save as a new Procedure')
            : t('新建流程草稿', 'New Procedure draft')}
      </h2>
      <p className="text-3 text-small">
        {t('名称、描述与有序步骤', 'name, description and ordered steps')}
      </p>
      <ProcedureEditorHost
        key={editor.kind === 'new' ? 'new' : `${editor.kind}:${editor.row.id}`}
        http={http}
        copyOf={editor.kind === 'copy' ? editor.row : undefined}
        nextVersionOf={editor.kind === 'version' ? editor.row : undefined}
        onShowPendingDraft={editor.kind === 'version' ? () => showFamily(editor.row.id) : undefined}
        onProposed={() => void procedures.reload()}
        onDone={() => {
          closeEditor();
          refresh();
        }}
        onPublished={refresh}
      />
    </div>
  ) : null;

  const list =
    procedures.state.status !== 'ready' ? (
      <DegradedList
        status={procedures.state.status === 'loading' ? 'loading' : 'error'}
        error={procedures.state.status === 'error' ? procedures.state.error : undefined}
        reload={() => void procedures.reload()}
        capabilityLabel="list_procedures"
      />
    ) : (
      <div className="stack-s">
        <DraftToolbar
          canPropose={canPropose}
          onNewDraft={() => openEditor({ kind: 'new' })}
          onRefresh={refresh}
          refreshing={procedures.state.refreshing}
          testId="procedures-new-draft"
        />
        <DraftExpiryNote testId="procedures-draft-expiry-note" />
        {rows.length === 0 ? (
          <EmptyState
            title={t('还没有流程', 'No Procedures yet')}
            body={t(
              '用「新建草稿」写第一条有序步骤，或让 Worker 从成功的任务里蒸馏。',
              'Write the first one with New draft, or let a Worker distil one from a successful Task.',
            )}
            testId="catalog-empty"
          />
        ) : (
          <List ariaLabel="Procedures" testId="catalog-list">
            {rows.map((row) => (
              <ListRow
                key={row.id}
                testId="catalog-row"
                selected={row.id === itemId}
                onSelect={() => selectRow(row.id)}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between', minWidth: 0 }}>
                  <span className="row-wrap" style={{ minWidth: 0 }}>
                    <span className="wrap-anywhere">{row.name}</span>
                    {row.steps ? (
                      <span className="tag">
                        {row.steps.length} {t('步', 'steps')}
                      </span>
                    ) : null}
                  </span>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">
                  {familyVersionLine(row, t)} · {row.description}
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {procedures.state.data.nextCursor !== undefined ? (
          <div className="row" style={{ justifyContent: 'center' }}>
            <Button
              variant="secondary"
              aria-busy={procedures.loadingMore || undefined}
              disabled={procedures.loadingMore}
              onClick={() => void procedures.loadMore()}
            >
              {t('加载更多', 'Load more')}
            </Button>
          </div>
        ) : null}
        {procedures.state.data.truncated === true ? (
          <p className="text-3 text-small" data-testid="procedures-truncated">
            {t(
              '已达到单次读取上限，继续点“加载更多”查看其余流程。',
              'Reached the per-page limit — keep loading more to see the rest.',
            )}
          </p>
        ) : null}
        {procedures.loadMoreError !== null ? (
          <ErrorBanner
            error={procedures.loadMoreError}
            title={t('无法加载更多流程', 'Could not load more procedures')}
            testId="procedures-load-more-error"
          />
        ) : null}
      </div>
    );

  const detailContent = showEditor ? (
    editorPane
  ) : selected && shown && shown !== selected ? (
    // UX acceptance of #764 (P2-1): as the Skills tab's — the version in use, read-only.
    <ProcedureDetailView
      key={`${shown.id}@${shown.version}`}
      http={http}
      row={shown}
      canPropose={false}
      canPublish={false}
      canDeprecate={false}
      proposerOnly={null}
      canDiscard={false}
      canReject={false}
      busy={false}
      credentialReview={credentialReview}
      publishProblems={null}
      versionNote={
        <FamilyVersionNote
          kind="procedure"
          draftVersion={selected.version}
          inUseVersion={shown.version}
          showing="inUse"
          onOpen={() => showInUse(selected.id, false)}
        />
      }
      inUseVersion={undefined}
      focusTitle={focusFamily === selected.id}
      onTitleFocused={() => setFocusFamily(null)}
      onEditAsNewVersion={() => undefined}
      onSaveAsNew={() => undefined}
      onPublish={async () => undefined}
      onDeprecate={async () => undefined}
      onDiscard={async () => undefined}
      onReject={async () => undefined}
    />
  ) : selected ? (
    <ProcedureDetailView
      key={`${selected.id}@${selected.version}`}
      http={http}
      row={selected}
      canPropose={canPropose}
      canPublish={canPublish && selectedProposerOnly === null}
      canDeprecate={canDeprecate && selectedProposerOnly === null}
      proposerOnly={selectedProposerOnly}
      canDiscard={canDiscard && isOwnDraftOrUnknown(selected, principalId)}
      canReject={canReject && offersReject(selected, role, principalId)}
      busy={busy === selected.id}
      credentialReview={credentialReview}
      publishProblems={publishProblems}
      versionNote={
        selected.inUse ? (
          <FamilyVersionNote
            kind="procedure"
            draftVersion={selected.version}
            inUseVersion={selected.inUse.version}
            showing="draft"
            onOpen={() => showInUse(selected.id, true)}
          />
        ) : null
      }
      inUseVersion={selected.inUse?.version}
      focusTitle={focusFamily === selected.id}
      onTitleFocused={() => setFocusFamily(null)}
      onEditAsNewVersion={() => openEditor({ kind: 'version', row: selected })}
      onSaveAsNew={() => openEditor({ kind: 'copy', row: selected })}
      onPublish={() => act(selected, 'publish_procedure')}
      onDeprecate={() => act(selected, 'deprecate_procedure')}
      onDiscard={(reason) => discardProcedureDraft(selected, reason)}
      onReject={(reason) => rejectProcedureDraft(selected, reason)}
    />
  ) : (
    <SelectionPlaceholder
      itemId={itemId}
      ready={procedures.state.status === 'ready'}
      emptyTitle={t(
        '选择左侧一个流程，查看步骤',
        'Select a Procedure on the left to see its steps',
      )}
    />
  );

  return (
    <MasterDetail
      list={list}
      detail={
        !showEditor && nothingToPick(procedures.state.status, rows.length, itemId)
          ? null
          : detailContent
      }
      open={itemId !== undefined}
      onClose={closeEditor}
      sheetTitle={t('流程详情', 'Procedure detail')}
      detailTestId={showEditor ? 'procedure-editor-drawer' : 'catalog-detail'}
    />
  );
}

// -------------------------------------------------------------------------------------------
// Workers
// -------------------------------------------------------------------------------------------

/** Workers has no dedicated id column of its own family/version pair — same `${id}@${version}`
 *  shape already used as this tab's React `key` before this lane, now doubling as the item's URL
 *  segment. */
function workerKey(row: Pick<WorkerDefinitionSummary, 'id' | 'version'>): string {
  return workerItemId(row);
}

/** A Worker definition's display name: its own name, else what its kind calls an unnamed one
 *  (legacy 472: an entry definition is 「入口 agent」, not 「未命名 · <short id>」). Two unnamed of
 *  one kind are told apart by the short id the list shows beside them (`sameNameDefinitionIds`).
 *  Never a raw UUID in a title — the copy guard rejects one. */
function workerLabel(row: WorkerDefinitionSummary, t: Translate): string {
  return definitionName([row], row.id, row.version) ?? unnamedDefinitionLabel(row.kind, t);
}

/** Workers tab local editor state — a superset of the shared `EditorState<Row>` used by the
 *  Skills/Procedures tabs above: adds `'template'` for J7/CW1 "从模板创建（ops-runner）", which
 *  prefills a brand-new draft rather than starting blank or copying a published row. */
/** A `list_worker_definitions` row as the catalog reads it: `proposedBy` (required on the wire,
 *  `WorkerDefinitionWireSchema`) decides who may publish / deprecate it (D-24). Optional only so
 *  older fixtures still type-check. */
type CatalogWorkerRow = WorkerDefinitionSummary & { readonly proposedBy?: string };

type WorkerEditorState =
  | { readonly kind: 'new' }
  | { readonly kind: 'copy'; readonly row: WorkerDefinitionSummary }
  | { readonly kind: 'template' }
  | null;

/**
 * Legacy 472: what a definition says, field by field, above its JSON — the system prompt (folded),
 * the model, what an entry agent may do and the hosts it may not reach — so a draft (one made from
 * the entry template above all) reads without the JSON.
 */
function definitionItems(row: WorkerDefinitionSummary, t: Translate): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  const prompt = entryPromptOf(row.definition);
  const lines = prompt === '' ? 0 : prompt.split('\n').length;
  items.push({
    key: 'systemPrompt',
    label: t('系统提示词', 'System prompt'),
    value:
      prompt === '' ? (
        <span className="text-3">{t('没有', 'None')}</span>
      ) : (
        <details className="disclosure" data-testid="worker-detail-prompt">
          <summary>{t(`${lines} 行，点开查看`, `${lines} line(s), open to read`)}</summary>
          <pre className="code-block pre-wrap disclosure-body">{prompt}</pre>
        </details>
      ),
  });
  const model = row.definition.model;
  items.push({
    key: 'model',
    label: t('模型', 'Model'),
    value:
      typeof model === 'string' && model !== '' ? (
        <span className="mono">{model}</span>
      ) : (
        <span className="text-3" data-testid="worker-detail-model-default">
          {t('没有指定，使用工作区默认模型', 'Not set: the workspace default model')}
        </span>
      ),
  });
  if (row.kind === 'entry') {
    const capabilities = entryCapabilitiesOf(row.definition);
    items.push({
      key: 'capabilities',
      label: t(`能做的事（${capabilities.length}）`, `What it may do (${capabilities.length})`),
      value:
        capabilities.length === 0 ? (
          <span className="text-3">{t('什么都不能做', 'Nothing')}</span>
        ) : (
          <ul className="stack-s" data-testid="worker-detail-capabilities">
            {capabilities.map((name) => {
              const label = actionLabel(name, t);
              return (
                <li key={name} data-capability={name} className="wrap-anywhere">
                  {label}
                  {label !== name ? (
                    <>
                      {' '}
                      <span className="mono text-3 text-small">{name}</span>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ),
    });
  }
  const egress = Array.isArray(row.definition.egressDeny)
    ? row.definition.egressDeny.filter((host): host is string => typeof host === 'string')
    : [];
  items.push({
    key: 'egressDeny',
    label: t('出网拒绝', 'Egress denied'),
    value:
      egress.length === 0 ? (
        <span className="text-3">
          {t('没有额外拒绝的主机', 'No host denied beyond the platform’s own')}
        </span>
      ) : (
        <span className="row-wrap" data-testid="worker-detail-egress">
          {egress.map((host) => (
            <span key={host} className="mono">
              {host}
            </span>
          ))}
        </span>
      ),
  });
  return items;
}

/**
 * Legacy 481: every published version of a definition stays `published`, so the status chip alone
 * does not say which one matters. On an entry version: whether the entry agent runs with it (the
 * most recently published entry version), and which one it runs with when not. On an earlier
 * version of a Worker with a newer published one: that it is earlier — still invocable by its
 * version — and which one is newest.
 */
function WorkerVersionNote({
  row,
  inUseEntry,
  familyHead,
  onOpen,
}: {
  readonly row: WorkerDefinitionSummary;
  readonly inUseEntry: { readonly definitionId: string; readonly version: number } | null;
  readonly familyHead: number | undefined;
  readonly onOpen: (ref: { readonly id: string; readonly version: number }) => void;
}) {
  const t = useT();
  if (row.status !== 'published') return null;
  if (row.kind === 'entry') {
    if (inUseEntry === null) return null;
    if (inUseEntry.definitionId === row.id && inUseEntry.version === row.version) {
      return (
        <p className="text-small" data-testid="worker-detail-in-use">
          {t(
            '入口 agent 正在用这一版：它是最近发布的入口定义。',
            'The entry agent runs with this version: it is the most recently published entry definition.',
          )}
        </p>
      );
    }
    return (
      <Notice testId="worker-detail-not-in-use">
        <p>
          {t(
            `这一版已发布，但没有生效：入口 agent 用的是最近发布的 v${inUseEntry.version}。`,
            `This version is published but not in use: the entry agent runs with v${inUseEntry.version}, the most recently published one.`,
          )}
        </p>
        <Button
          variant="ghost"
          size="s"
          onClick={() => onOpen({ id: inUseEntry.definitionId, version: inUseEntry.version })}
          data-testid="worker-detail-open-in-use"
        >
          {t(`查看生效中的 v${inUseEntry.version}`, `See v${inUseEntry.version}, the one in use`)}
        </Button>
      </Notice>
    );
  }
  if (familyHead === undefined || familyHead === row.version) return null;
  return (
    <Notice testId="worker-detail-earlier-version">
      <p>
        {t(
          `这个 Worker 有更新的已发布版本 v${familyHead}；这一版仍可按版本号调用。`,
          `This Worker has a newer published version, v${familyHead}; this one can still be invoked by its version.`,
        )}
      </p>
      <Button
        variant="ghost"
        size="s"
        onClick={() => onOpen({ id: row.id, version: familyHead })}
        data-testid="worker-detail-open-latest"
      >
        {t(`查看最新的 v${familyHead}`, `See v${familyHead}, the latest`)}
      </Button>
    </Notice>
  );
}

function WorkerDetailView({
  http,
  row,
  isMyDraft,
  canPropose,
  canPublish,
  canDeprecate,
  proposerOnly,
  canDiscard,
  busy,
  credentialReview,
  entryNotice,
  versionNote,
  focusTitle,
  onTitleFocused,
  onEditAsNewVersion,
  onPublish,
  onDeprecate,
  onDiscard,
}: {
  readonly http: CapabilityCaller;
  readonly row: WorkerDefinitionSummary;
  readonly isMyDraft: boolean;
  readonly canPropose: boolean;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  /** D-24: as `OperationDetailView`'s. */
  readonly proposerOnly: ProposerOnlyAction | null;
  readonly canDiscard: boolean;
  readonly busy: boolean;
  readonly credentialReview: PublishCredentialReview;
  /** Legacy 145: on the entry version in use, how it stands against the platform's template; on
   *  an entry draft, what publishing it changes against the version in use. */
  readonly entryNotice: ReactNode;
  /** Legacy 481: on a published version, whether it is the entry version in use, or an earlier
   *  version of a Worker that has a newer one. */
  readonly versionNote: ReactNode;
  /** UX acceptance of #747 (P3-1): the draft just proposed from the entry template opens with focus
   *  on its title, not left on the page; `onTitleFocused` clears the request. */
  readonly focusTitle: boolean;
  readonly onTitleFocused: () => void;
  readonly onEditAsNewVersion: () => void;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: (reason: string | undefined) => Promise<void>;
}) {
  const t = useT();
  const name = workerLabel(row, t);
  const titleRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new request moves focus.
  useEffect(() => {
    if (!focusTitle) return;
    titleRef.current?.focus();
    onTitleFocused();
  }, [focusTitle]);
  // Legacy 441: the gates a Worker may act on, by name and linked to the gate — not only as ids in
  // the definition below.
  const gatekeeperNames = useGatekeeperDirectory(http).names;
  const gates = Array.isArray(row.definition.gates)
    ? row.definition.gates.filter((id): id is string => typeof id === 'string')
    : [];
  const items: KeyValueItem[] = [];
  if (typeof row.definition.description === 'string') {
    items.push({
      key: 'description',
      label: t('描述', 'Description'),
      value: row.definition.description,
    });
  }
  if (row.kind === 'worker') {
    items.push({
      key: 'gates',
      label: t('可作用的门', 'Gates it acts on'),
      value:
        gates.length === 0 ? (
          <span data-testid="worker-detail-gates-none">
            {t('无：它不能对任何系统动手', 'None: it cannot act on any system')}
          </span>
        ) : (
          <span className="row-wrap" data-testid="worker-detail-gates">
            {gates.map((id) => (
              <RefChip
                key={id}
                kind="gatekeeper"
                id={id}
                name={nameOf(gatekeeperNames, id)}
                href={hrefs.gatekeeper(id)}
                size="s"
              />
            ))}
          </span>
        ),
    });
  }
  items.push(...definitionItems(row, t));
  return (
    <div className="stack" data-testid="worker-detail" data-worker-key={workerKey(row)}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="publishable" status={row.status} size="s" />
          <strong ref={titleRef} tabIndex={-1} className="catalog-detail-title wrap-anywhere">
            {name}
          </strong>
          <span className="text-3 text-small">v{row.version}</span>
          <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
        </div>
        {row.status === 'published' ? (
          <PackOrigin
            http={http}
            target={{ kind: 'worker', definitionId: row.id, version: row.version }}
            testId="worker-detail-pack-origin"
          />
        ) : null}
        <PublishableStepper status={row.status} testId="worker-detail-stepper" />
      </header>

      {versionNote}

      {entryNotice}

      {items.length > 0 ? <KeyValue items={items} /> : null}

      <div className="stack-s">
        <span className="section-title">{t('定义', 'Definition')}</span>
        <pre className="code-block" data-testid="worker-detail-definition">
          {prettyJsonVisible(row.definition)}
        </pre>
      </div>

      {isMyDraft && canPublish ? (
        <PublishCredentialSlot review={credentialReview} busy={busy} />
      ) : null}
      <div className="row-wrap">
        {isMyDraft ? (
          <>
            {canPublish ? (
              <Button
                variant="primary"
                size="s"
                disabled={busy || credentialReview.blocked}
                aria-busy={busy || undefined}
                onClick={() => void onPublish()}
                data-testid="worker-draft-publish"
              >
                {t('发布', 'Publish')}
              </Button>
            ) : proposerOnly !== null ? (
              <ProposerOnlyHint action={proposerOnly} />
            ) : null}
            {canDiscard ? (
              <DiscardDraftConfirm
                busy={busy}
                target={name}
                onConfirm={onDiscard}
                testId={`worker-draft-discard-${workerKey(row)}`}
              />
            ) : null}
          </>
        ) : (
          <>
            {canPropose ? (
              <Button
                variant="ghost"
                size="s"
                onClick={onEditAsNewVersion}
                data-testid="catalog-edit-as-draft"
              >
                {t('编辑（新版本草稿）', 'Edit as new draft version')}
              </Button>
            ) : null}
            {row.kind !== 'entry' && canDeprecate && row.status === 'published' ? (
              <DeprecateConfirm
                busy={busy}
                target={name}
                onConfirm={onDeprecate}
                testId={`worker-deprecate-confirm-${workerKey(row)}`}
              />
            ) : row.kind !== 'entry' && proposerOnly !== null ? (
              <ProposerOnlyHint action={proposerOnly} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function WorkersTab({ http, itemId, onSelectItem }: CatalogTabProps) {
  const t = useT();
  const permissions = usePermissions();
  const can = useRoleCan(http);
  const toast = useToast();
  const { role, principalId } = useWorkspaceIdentity(http);
  // Legacy 145: the platform's entry template against the entry version in use — read only for
  // those who may propose the upgrade draft (builder and up); nobody else is asked.
  const readsEntryTemplate = can('get_entry_template_status') === true;
  const loadEntryTemplate = useCallback(
    () =>
      readsEntryTemplate
        ? http.call<EntryTemplateStatusWire>('get_entry_template_status', {})
        : Promise.resolve(null),
    [http, readsEntryTemplate],
  );
  const entryTemplate = useResource(loadEntryTemplate);
  // `itemId` is the row's `id@version` (`workerKey`), so a new version asks afresh.
  const credentialReview = usePublishCredentialReview(itemId ?? null);
  const workers = useCapabilityList<CatalogWorkerRow>(http, 'list_worker_definitions', {});
  // S8 W2-U2b (audit R6): a dedicated own-drafts read — `includeOwnDrafts` is additive (published
  // rows come back too, S8 W2-U2b) — only the caller's own draft rows are this section's concern.
  const myDrafts = useCapabilityList<CatalogWorkerRow>(
    http,
    'list_worker_definitions',
    { includeOwnDrafts: true },
    { autoLoadAll: true },
  );
  // S8 W3 K2 (leftover 84): lifted up from `WorkerEditorHost` below — the "从模板创建（ops-runner）"
  // button needs this loaded *before* the editor drawer even opens (it must stay disabled until
  // then, so an incomplete list is never submitted as the template's `capabilities`); passed down
  // into `WorkerEditorHost` as a prop instead of that component loading its own second copy.
  const capabilityNames = useCapabilityList<CapabilityNameRow>(http, 'list_capability_names');
  // Audit P1-7: the same readiness read the card above the tabs makes (one cached call) — the
  // gates granted to the reader start ticked in the ops-runner template. Held until the role is
  // known (an auditor never reads it).
  const readiness = useExecutionReadiness(http, {
    enabled: can('execution_readiness') === true,
  });
  const grantedGateIds =
    readiness.state.status === 'ready'
      ? readiness.state.data.gates.filter((gate) => gate.granted).map((gate) => gate.gateId)
      : [];
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<WorkerEditorState>(null);
  // UX acceptance of #747 (P3-1): the row whose detail title takes focus when it shows.
  const [focusKey, setFocusKey] = useState<string | null>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_worker_definitions');
    void workers.reload();
    void myDrafts.reload();
    announceReadinessChange(http);
  }

  function openEditor(next: WorkerEditorState): void {
    setEditor(next);
    onSelectItem(NEW_ITEM_ID);
  }

  function selectRow(id: string | null): void {
    setEditor(null);
    onSelectItem(id);
  }

  function closeEditor(): void {
    setEditor(null);
    onSelectItem(null);
  }

  async function publishDraft(row: WorkerDefinitionSummary): Promise<void> {
    setBusy(workerKey(row));
    try {
      await http.call('publish_worker_definition', {
        definitionId: row.id,
        version: row.version,
        ...credentialReview.params(),
      });
      toast.push({
        tone: 'ok',
        title: `${workerLabel(row, t)} ${t('已发布', 'published')}`,
      });
      refresh();
      if (row.kind === 'entry') void entryTemplate.reload();
    } catch (err) {
      // The kernel's credential question — answered next to Publish, not as a failure toast.
      if (credentialReview.capture(err)) return;
      if (isForbiddenError(err)) permissions.markDenied('publish_worker_definition');
      toast.push({
        tone: 'danger',
        title: t('无法发布该草稿', 'Could not publish this draft'),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  async function deprecate(row: WorkerDefinitionSummary): Promise<void> {
    setBusy(workerKey(row));
    try {
      await http.call('deprecate_worker_definition', {
        definitionId: row.id,
        version: row.version,
      });
      toast.push({
        tone: 'ok',
        title: t(`${workerLabel(row, t)} 已弃用`, `${workerLabel(row, t)} deprecated`),
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('deprecate_worker_definition');
      toast.push({
        tone: 'danger',
        title: t('无法弃用该定义', 'Could not deprecate this definition'),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  // S8 W3 K2 (leftover 82): discards one of the caller's own draft WorkerDefinition versions —
  // same catch-and-toast convention every other write in this tab already uses (never re-throws
  // into `Confirm`'s own inline error state, matching `deprecate`/`publishDraft` above).
  async function discardWorkerDraft(row: WorkerDefinitionSummary, reason?: string): Promise<void> {
    setBusy(workerKey(row));
    try {
      await http.call('discard_draft', {
        kind: 'worker_definition',
        id: row.id,
        version: row.version,
        ...(reason !== undefined ? { reason } : {}),
      });
      toast.push({
        tone: 'ok',
        title: `${workerLabel(row, t)} ${t('已丢弃', 'discarded')}`,
      });
      selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: errorToastText(err, t),
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = can('propose_worker_definition') !== false;
  const canPublish = can('publish_worker_definition') !== false;
  const canDiscard = can('discard_draft') !== false;
  const canDeprecate = can('deprecate_worker_definition') !== false;

  const showEditor = editor !== null && itemId === NEW_ITEM_ID;

  const editorPane = editor ? (
    <div className="stack">
      <h2 className="catalog-detail-title">
        {editor.kind === 'copy'
          ? t('提议新版本', 'Propose a new version')
          : editor.kind === 'template'
            ? t('从模板创建（ops-runner）', 'Create from template (ops-runner)')
            : t('新建 Worker 定义草稿', 'New Worker definition draft')}
      </h2>
      <p className="text-3 text-small">
        {t(
          '类型、提示词、模型和它能用的能力',
          'Kind, prompt, model and the capabilities it may use',
        )}
      </p>
      <WorkerEditorHost
        key={editor.kind === 'copy' ? `${editor.row.id}@${editor.row.version}` : editor.kind}
        http={http}
        newVersionOf={editor.kind === 'copy' ? editor.row : undefined}
        initialForm={
          editor.kind === 'template' && capabilityNames.state.status === 'ready'
            ? opsRunnerTemplateForm(capabilityNames.state.data.items, grantedGateIds)
            : undefined
        }
        capabilityNames={
          capabilityNames.state.status === 'ready' ? capabilityNames.state.data.items : undefined
        }
        onProposed={() => {
          void workers.reload();
          void myDrafts.reload();
          announceReadinessChange(http);
        }}
        onDone={() => {
          closeEditor();
          refresh();
        }}
        onPublished={refresh}
      />
    </div>
  ) : null;

  if (workers.state.status !== 'ready') {
    return (
      <MasterDetail
        list={
          <DegradedList
            status={workers.state.status === 'loading' ? 'loading' : 'error'}
            error={workers.state.status === 'error' ? workers.state.error : undefined}
            reload={() => void workers.reload()}
            capabilityLabel="list_worker_definitions"
          />
        }
        detail={showEditor ? editorPane : null}
        open={itemId !== undefined}
        onClose={closeEditor}
        sheetTitle={t('Worker 详情', 'Worker detail')}
        detailTestId={showEditor ? 'worker-editor-drawer' : 'catalog-detail'}
      />
    );
  }

  const rows = workers.state.data.items;
  const entryRows = rows.filter((row) => row.kind === 'entry');
  const workerRows = rows.filter((row) => row.kind !== 'entry');
  // R6: additive on top of `workers` above (published rows come back from this call too, S8
  // W2-U2b) — only the caller's own draft rows are this section's concern.
  const myDraftRows =
    myDrafts.state.status === 'ready'
      ? myDrafts.state.data.items.filter((row) => row.status === 'draft')
      : [];
  const allRows = [...myDraftRows, ...entryRows, ...workerRows];
  // Same-name definitions (a template instantiated twice) differ only by id: show it on those.
  const sameName = sameNameDefinitionIds(allRows);
  const selected = itemId ? allRows.find((row) => workerKey(row) === itemId) : undefined;
  // UX acceptance of #747 (P2-1): the entry version the entry agent runs with — the one
  // `get_entry_template_status` names — which an entry draft is compared against. Looked up in the
  // rows already read (the own-drafts read brings every published row too); unknown otherwise.
  // Legacy 481: for a reader `get_entry_template_status` is not asked for, the kernel's own rule
  // over the published rows read (the own-drafts read brings every published row, all pages).
  const everyRow = [
    ...rows,
    ...(myDrafts.state.status === 'ready' ? myDrafts.state.data.items : []),
  ];
  const inUseEntryRef =
    entryTemplate.state.status === 'ready' && entryTemplate.state.data !== null
      ? entryTemplate.state.data.current
      : inUseEntryVersion(everyRow);
  const inUseEntry = inUseEntryRef
    ? everyRow.find(
        (row) => row.id === inUseEntryRef.definitionId && row.version === inUseEntryRef.version,
      )
    : undefined;
  const inUseEntryKey = inUseEntryRef
    ? workerKey({ id: inUseEntryRef.definitionId, version: inUseEntryRef.version })
    : null;
  // Legacy 481: Workers with several published versions — each stays invocable by its version.
  const familyHeads = publishedFamilyHeads(everyRow);
  // D-24: Publish / Deprecate on a definition another principal proposed is the owner's — and
  // publishing a new version of a family supersedes its published version, so that version's
  // proposer counts too (legacy 315; kernel `assertFamilyPublishAuthority`: any published version
  // of the same id that someone else proposed).
  const selectedLive =
    selected?.status === 'draft'
      ? allRows.find(
          (row) =>
            row.id === selected.id &&
            row.status === 'published' &&
            provenNotProposer(row, role, principalId),
        )
      : undefined;
  const selectedProposerOnly = selected
    ? proposerOnlyFor(
        selected,
        role,
        principalId,
        {
          publish: canPublish,
          deprecate: canDeprecate && selected.kind !== 'entry',
        },
        selectedLive,
      )
    : null;

  const list = (
    <div className="stack-s">
      <DraftToolbar
        canPropose={canPropose}
        onNewDraft={() => openEditor({ kind: 'new' })}
        onRefresh={refresh}
        refreshing={workers.state.refreshing}
        testId="workers-new-draft"
        extra={
          canPropose ? (
            <Button
              variant="secondary"
              onClick={() => openEditor({ kind: 'template' })}
              disabled={capabilityNames.state.status !== 'ready'}
              title={
                capabilityNames.state.status !== 'ready'
                  ? t('能力清单加载中，请稍候', 'Loading the capability list, please wait')
                  : undefined
              }
              data-testid="workers-template-button"
            >
              {t('从模板创建（ops-runner）', 'Create from template (ops-runner)')}
            </Button>
          ) : null
        }
      />

      {myDraftRows.length > 0 ? (
        <div className="stack-s" data-testid="workers-my-drafts-section">
          <span className="section-title">{t('我的草稿', 'My drafts')}</span>
          <DraftExpiryNote testId="workers-my-drafts-expiry-note" />
          <List ariaLabel="My drafts" testId="workers-my-drafts-list">
            {myDraftRows.map((row) => (
              <ListRow
                key={workerKey(row)}
                testId="workers-my-draft-row"
                selected={workerKey(row) === itemId}
                onSelect={() => selectRow(workerKey(row))}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="row-wrap">
                    <span className="truncate">{workerLabel(row, t)}</span>
                    <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
                  </span>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">
                  v{row.version}
                  {sameName.has(row.id) ? (
                    <>
                      {' · '}
                      <span className="mono" title={row.id} data-volatile="">
                        {shortId(row.id)}
                      </span>
                    </>
                  ) : null}
                </span>
              </ListRow>
            ))}
          </List>
        </div>
      ) : null}

      <div className="stack-s" data-testid="workers-entry-section">
        <span className="section-title">{t('入口定义', 'Entry definition')}</span>
        {entryRows.length === 0 ? (
          <p className="text-3 text-small">
            {t(
              '本工作区还没有已发布的入口定义。',
              'No published entry definition in this workspace yet.',
            )}
          </p>
        ) : (
          <List ariaLabel="Entry definition" testId="workers-entry-list">
            {entryRows.map((row) => (
              <ListRow
                key={workerKey(row)}
                testId="catalog-row"
                selected={workerKey(row) === itemId}
                onSelect={() => selectRow(workerKey(row))}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="row-wrap">
                    <span className="truncate">{workerLabel(row, t)}</span>
                    <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
                  </span>
                  {workerKey(row) === inUseEntryKey ? (
                    <span className="chip chip-ok chip-s" data-testid="worker-in-use">
                      {t('生效中', 'In use')}
                    </span>
                  ) : (
                    <StatusChip machine="publishable" status={row.status} size="s" />
                  )}
                </span>
                <span className="truncate text-3">
                  v{row.version}
                  {inUseEntryKey !== null &&
                  row.status === 'published' &&
                  workerKey(row) !== inUseEntryKey ? (
                    <span data-testid="worker-not-in-use">{t(' · 未生效', ' · not in use')}</span>
                  ) : null}
                  {sameName.has(row.id) ? (
                    <>
                      {' · '}
                      <span className="mono" title={row.id} data-volatile="">
                        {shortId(row.id)}
                      </span>
                    </>
                  ) : null}
                </span>
              </ListRow>
            ))}
          </List>
        )}
        <EntryTemplateSummary status={entryTemplate} onOpen={(ref) => selectRow(workerKey(ref))} />
      </div>

      <div className="stack-s" data-testid="workers-worker-section">
        <span className="section-title">{t('Worker 定义', 'Worker definitions')}</span>
        {workerRows.length === 0 ? (
          <EmptyState
            title={t('还没有 Worker', 'No Workers yet')}
            body={t(
              '入口 agent 委派任务时找不到可用的 Worker——发布至少一个 Worker 定义，委派才能成功。可以用上面的「从模板创建（ops-runner）」快速开始。',
              'The entry agent has nothing to delegate to — publish at least one Worker definition so delegation can succeed. Use “Create from template (ops-runner)” above to get started quickly.',
            )}
            testId="catalog-empty"
          />
        ) : (
          <List ariaLabel="Worker definitions" testId="catalog-list">
            {workerRows.map((row) => (
              <ListRow
                key={workerKey(row)}
                testId="catalog-row"
                selected={workerKey(row) === itemId}
                onSelect={() => selectRow(workerKey(row))}
              >
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="row-wrap">
                    <span className="truncate">{workerLabel(row, t)}</span>
                    <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
                  </span>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">
                  v{row.version}
                  {row.status === 'published' && familyHeads.has(row.id) ? (
                    <span data-testid="worker-family-version">
                      {familyHeads.get(row.id) === row.version
                        ? t(' · 最新版', ' · latest')
                        : t(' · 较早版本', ' · earlier version')}
                    </span>
                  ) : null}
                  {sameName.has(row.id) ? (
                    <>
                      {' · '}
                      <span className="mono" title={row.id} data-volatile="">
                        {shortId(row.id)}
                      </span>
                    </>
                  ) : null}
                </span>
              </ListRow>
            ))}
          </List>
        )}
        {canPropose &&
        workers.state.data.nextCursor === undefined &&
        workerRows.length > 0 &&
        workerRows.length <= 2 ? (
          // S8 W4 (audit L11 "Workers 只有 1-2 行时，下方空白像没做完"): the row's own remedy
          // example — point back at the toolbar's "新建 Worker 定义草稿" / "从模板创建" above,
          // instead of leaving bare canvas below a short list.
          <Notice testId="workers-short-list-hint">
            {t(
              '还可以新建 Worker 定义草稿，或从模板创建（ops-runner）快速开始。',
              'You can start another Worker definition draft, or create one from the ops-runner template.',
            )}
          </Notice>
        ) : null}
      </div>
      {workers.state.data.nextCursor !== undefined ? (
        <div className="row" style={{ justifyContent: 'center' }}>
          <Button
            variant="secondary"
            aria-busy={workers.loadingMore || undefined}
            disabled={workers.loadingMore}
            onClick={() => void workers.loadMore()}
          >
            {t('加载更多', 'Load more')}
          </Button>
        </div>
      ) : null}
      {workers.state.data.truncated === true ? (
        <p className="text-3 text-small" data-testid="workers-truncated">
          {t(
            '已达到单次读取上限，继续点“加载更多”查看其余 Worker 定义。',
            'Reached the per-page limit — keep loading more to see the rest.',
          )}
        </p>
      ) : null}
      {workers.loadMoreError !== null ? (
        <ErrorBanner
          error={workers.loadMoreError}
          title={t('无法加载更多 Worker 定义', 'Could not load more worker definitions')}
          testId="workers-load-more-error"
        />
      ) : null}
    </div>
  );

  const detailContent = showEditor ? (
    editorPane
  ) : selected ? (
    <WorkerDetailView
      http={http}
      row={selected}
      isMyDraft={selected.status === 'draft'}
      canPropose={canPropose}
      canPublish={canPublish && selectedProposerOnly === null}
      canDeprecate={canDeprecate && selectedProposerOnly === null}
      proposerOnly={selectedProposerOnly}
      canDiscard={canDiscard}
      busy={busy === workerKey(selected)}
      credentialReview={credentialReview}
      focusTitle={focusKey === workerKey(selected)}
      onTitleFocused={() => setFocusKey(null)}
      versionNote={
        <WorkerVersionNote
          row={selected}
          inUseEntry={inUseEntryRef}
          familyHead={familyHeads.get(selected.id)}
          onOpen={(ref) => {
            // UX acceptance of #763 (P2-1): the button goes away with the detail it is on; focus
            // moves to the title of the version it opens.
            setFocusKey(workerKey(ref));
            selectRow(workerKey(ref));
          }}
        />
      }
      entryNotice={
        selected.kind === 'entry' && selected.status === 'draft' && inUseEntry ? (
          <EntryDraftChanges draft={selected} inUse={inUseEntry} />
        ) : selected.kind === 'entry' && selected.status === 'published' ? (
          <EntryTemplateNotice
            http={http}
            status={entryTemplate}
            row={selected}
            onProposed={(upgrade) => {
              const version = upgrade.draft.version;
              let title = t(
                `已生成草稿 v${version}，由所有者发布后生效`,
                `Draft v${version} proposed; it takes effect once the owner publishes it`,
              );
              if (!upgrade.created) {
                title = t(
                  `你已经有这份草稿（第 ${version} 版）`,
                  `You already have this draft, v${version}`,
                );
              }
              toast.push({ tone: 'ok', title });
              refresh();
              setFocusKey(workerKey(upgrade.draft));
              selectRow(workerKey(upgrade.draft));
            }}
          />
        ) : null
      }
      onEditAsNewVersion={() => openEditor({ kind: 'copy', row: selected })}
      onPublish={() => publishDraft(selected)}
      onDeprecate={() => deprecate(selected)}
      onDiscard={(reason) => discardWorkerDraft(selected, reason)}
    />
  ) : (
    <SelectionPlaceholder
      itemId={itemId}
      ready={workers.state.status === 'ready'}
      emptyTitle={t(
        '选择左侧一个 Worker，查看定义',
        'Select a Worker on the left to see its definition',
      )}
    />
  );

  return (
    <MasterDetail
      list={list}
      detail={allRows.length === 0 && itemId === undefined ? null : detailContent}
      open={itemId !== undefined}
      onClose={closeEditor}
      sheetTitle={t('Worker 详情', 'Worker detail')}
      detailTestId={showEditor ? 'worker-editor-drawer' : 'catalog-detail'}
    />
  );
}
