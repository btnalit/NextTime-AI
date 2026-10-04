import type { SkillDetailWire } from '@nexttime/shared';
import { type ReactNode, useId, useState } from 'react';
import { invalidateCapability, useCapability, useCapabilityList } from '../hooks/useCapability.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useWorkspaceIdentity } from '../hooks/useWorkspaceIdentity.js';
import { opsRunnerTemplateForm } from '../lib/catalog.js';
import type { CapabilityCaller } from '../lib/clients.js';
import { describeError, isForbiddenError } from '../lib/errors.js';
import { formatRelative, prettyJson, shortId } from '../lib/format.js';
import {
  type CapabilityNameRow,
  type OperationCatalogRow,
  type OperationStatsRow,
  type ProcedureRow,
  type SkillRow,
  operationKey,
  operationStatsKey,
} from '../lib/governance.js';
import { type Translate, useT } from '../lib/i18n.js';
import { workerDefinitionKindLabel } from '../lib/labels.js';
import { breadcrumbFor } from '../lib/nav.js';
import { type WorkspaceRole, isProvenMember } from '../lib/role.js';
import type { CatalogTab } from '../lib/router.js';
import { hrefs } from '../lib/router.js';
import { labelText, statusChipStyle } from '../lib/status-tone.js';
import { type WorkerDefinitionSummary, definitionName } from '../lib/tasks.js';
import { nameOf, useGatekeeperNames } from './approvals/useDirectoryNames.js';
import { DraftExpiryNote, type EditorState } from './catalog/CatalogShared.js';
import { MarkdownPreview } from './catalog/MarkdownPreview.js';
import { ModulesTab } from './catalog/ModulesTab.js';
import { ProcedureEditorHost } from './catalog/ProcedureEditorHost.js';
import { SkillEditor } from './catalog/SkillEditor.js';
import { WorkerEditorHost } from './catalog/WorkerEditorHost.js';
import {
  GovernanceChangeList,
  governanceChangeSummary,
  governanceConsequences,
  isLoosening,
} from './connect/GovernanceChange.js';
import { Button } from './kit/button.js';
import { Confirm } from './kit/confirm.js';
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
import { MasterDetail } from './kit/master-detail.js';
import { Notice } from './kit/notice.js';
import { PageHeader } from './kit/page-header.js';
import { RefChip } from './kit/ref-chip.js';
import { SkeletonRows } from './kit/skeleton.js';
import { StatusChip } from './kit/status-chip.js';
import { Tabs } from './kit/tabs.js';
import { Textarea } from './kit/textarea.js';
import { ExecutionReadinessCard } from './readiness/ExecutionReadinessCard.js';
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
   *  console "propose") or Modules (no per-row detail concept — see `ModulesTab`'s own doc
   *  comment on why it stays outside this master-detail shell). */
  readonly itemId?: string;
  readonly onSelectItem: (itemId: string | null) => void;
}

/** S8 W1-A10 (i18n remainder): `Operation`/`Skill`/`Procedure`/`Worker` stay English proper nouns
 *  even in zh copy (the page's own description above does the same); `Module` has an established
 *  zh term ("模块", `lib/nav.ts`'s catalog nav group). */
const TAB_LABEL: Readonly<Record<CatalogTab, { readonly zh: string; readonly en: string }>> = {
  operations: { zh: 'Operation', en: 'Operations' },
  skills: { zh: 'Skill', en: 'Skills' },
  procedures: { zh: 'Procedure', en: 'Procedures' },
  workers: { zh: 'Worker', en: 'Workers' },
  modules: { zh: '模块', en: 'Modules' },
};

/** The sentinel item segment while any editor (new / copy / template / new version) is open in
 *  the detail pane — see the module doc comment on `CatalogPageProps.itemId`. Not a real id: no
 *  row is ever selected while it is current. */
const NEW_ITEM_ID = 'new';

/**
 * components/CatalogPage: 能力目录 Catalog (`/govern/catalog`, S3.11 "目录" group — `minRole:
 * 'member'`, open to everyone). Five tabs over the platform's publishable content: Operations
 * (`list_operations`), Skills/Procedures (`list_skills`/`list_procedures`), Workers
 * (`list_worker_definitions`), Modules (`list_workspace_modules`, `ModulesTab` — see its own doc
 * comment). Publish/deprecate stay the two-step `propose → publish` capabilities already in the
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
export function CatalogPage({ http, tab, onTabChange, itemId, onSelectItem }: CatalogPageProps) {
  const t = useT();
  return (
    <div className="page">
      <PageHeader
        breadcrumb={breadcrumbFor('catalog')}
        title={t('能力目录', 'Catalog')}
        description={t(
          '工作区里已发布的 Operation、Skill、Procedure 与 Worker 定义，以及你自己的草稿。',
          'Published Operations, Skills, Procedures and Worker definitions across the workspace, plus your own drafts.',
        )}
      />
      <ExecutionReadinessCard http={http} />
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
      ) : (
        // Modules has no per-row detail concept (a plain table, install/upgrade acts in place) —
        // left outside the master-detail shell rather than force-fit into `detail={null}`, which
        // would nest `ModulesTab`'s own `DashboardCard` inside the `.md-pane` card for no reason.
        <ModulesTab http={http} />
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
  onConfirm,
  testId,
}: {
  readonly row: OperationCatalogRow;
  readonly change: NonNullable<OperationCatalogRow['governanceChange']>;
  readonly busy: boolean;
  readonly onConfirm: () => Promise<void>;
  readonly testId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const item = { name: row.name, ...change };
  const consequences = governanceConsequences(item, t);
  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <Button
          variant="primary"
          size="s"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={() => setOpen(true)}
          data-testid={`${testId}-trigger`}
        >
          {t('发布', 'Publish')}
        </Button>
      }
      title={t(`发布 ${row.name}`, `Publish ${row.name}`)}
      description={t(
        '这个草稿改变了当前生效版本的分类——分类决定它要不要人工审批、要不要授权。发布后替换当前版本。',
        'This draft changes the classification of the version in effect — the classification decides whether it needs a person’s approval and a grant. Publishing replaces the current version.',
      )}
      target={row.name}
      impact={[governanceChangeSummary(item, t)]}
      confirmLabel={t('发布', 'Publish')}
      danger={isLoosening(change.direction)}
      onConfirm={onConfirm}
      testId={testId}
    >
      {consequences.length > 0 ? (
        <Notice tone="warn" testId={`${testId}-loosens`}>
          <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
            {consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <GovernanceChangeList items={[item]} />
    </Confirm>
  );
}

/** A catalog row's selection key: `operationKey`, except a draft that revises a published version
 *  (it carries `governanceChange`) — both rows share the identity, and the draft must stay
 *  selectable on its own to be published from here (R-19). */
function catalogOperationKey(row: OperationCatalogRow): string {
  return row.status === 'draft' && row.governanceChange
    ? `${operationKey(row)}@draft`
    : operationKey(row);
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
  onConfirm,
  testId,
}: {
  readonly busy: boolean;
  readonly target: string;
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
          {t('丢弃', 'Discard')}
        </Button>
      }
      title={t(`丢弃 ${target}`, `Discard ${target}`)}
      description={t(
        '草稿将被删除，无法恢复。',
        'This draft will be permanently deleted and cannot be recovered.',
      )}
      target={target}
      confirmLabel={t('丢弃', 'Discard')}
      danger
      onConfirm={onConfirm}
      testId={testId}
    />
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
  row,
  usage,
  gatekeeperNames,
  canPublish,
  canDeprecate,
  canEditDescription,
  busy,
  onPublish,
  onDeprecate,
  onEditDescription,
}: {
  readonly row: OperationCatalogRow;
  readonly usage: OperationStatsRow | undefined;
  readonly gatekeeperNames: ReadonlyMap<string, string>;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  readonly canEditDescription: boolean;
  readonly busy: boolean;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onEditDescription: () => void;
}) {
  const t = useT();
  const key = catalogOperationKey(row);
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
          row.description
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
  items.push({
    key: 'usage',
    label: t('用量', 'Usage'),
    value: (
      <span
        data-testid="catalog-row-usage"
        title={
          usage
            ? `${usage.calls} calls, ${usage.approved} approved, ${usage.rejected} rejected in the trailing window`
            : 'No usage data for this Operation (get_operation_stats unavailable, or no calls in the window)'
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
          <strong className="catalog-detail-title mono truncate">{row.name}</strong>
        </div>
      </header>
      <KeyValue items={items} />
      <div className="row-wrap">
        {canPublish &&
        row.status === 'draft' &&
        row.governanceChange &&
        row.governanceChange.direction !== 'neutral' ? (
          <PublishGovernanceConfirm
            row={row}
            change={row.governanceChange}
            busy={busy}
            onConfirm={onPublish}
            testId={`operation-publish-confirm-${key}`}
          />
        ) : canPublish && row.status === 'draft' ? (
          <Button
            variant="primary"
            size="s"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void onPublish()}
          >
            {t('发布', 'Publish')}
          </Button>
        ) : canDeprecate && row.status === 'published' ? (
          <DeprecateConfirm
            busy={busy}
            target={row.name}
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
 * Offered only where it can succeed: the owner; a builder on a row they proposed. A caller proven
 * below the builder floor (a known member / operator / auditor, or an inferred member) is never
 * offered it. Unknown either side (role or proposer not loaded, an older kernel) keeps the action,
 * as `isOwnDraftOrUnknown` does — the kernel refuses it anyway.
 */
function mayEditOperationDescription(
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
  const toast = useToast();
  const operations = useCapabilityList<OperationCatalogRow>(http, 'list_operations');
  // Own capability call, own degrade path — a `get_operation_stats` failure (not deployed yet, a
  // transient error, whatever) never blocks the Operations list itself; a row simply renders "—"
  // for its usage columns when no matching stats entry comes back (see `statsFor` below).
  const stats = useCapabilityList<OperationStatsRow>(http, 'get_operation_stats');
  const gatekeeperNames = useGatekeeperNames(http);
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

  const rows = operations.state.status === 'ready' ? operations.state.data.items : [];
  const selected = itemId ? rows.find((row) => catalogOperationKey(row) === itemId) : undefined;

  function refresh(): void {
    invalidateCapability(http, 'list_operations');
    void operations.reload();
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
      await http.call(action, { gatekeeperId: row.gatekeeperId, name: row.name });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_operation' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        title: `Could not update ${row.name}`,
        description: describeError(err).message,
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
        description: editingRow.name,
      });
      setEditingRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('update_operation_description');
      setDescriptionError(err);
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
          return (
            <ListRow
              key={key}
              testId="catalog-row"
              selected={key === itemId}
              onSelect={() => onSelectItem(key)}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="row-wrap">
                  <StatusChip machine="publishable" status={row.status} size="s" />
                  <span className="mono truncate">{row.name}</span>
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

  const detailContent = selected ? (
    <OperationDetailView
      row={selected}
      usage={statsFor(selected)}
      gatekeeperNames={gatekeeperNames}
      canPublish={!permissions.isDenied('publish_operation')}
      canDeprecate={!permissions.isDenied('deprecate_operation')}
      canEditDescription={
        !permissions.isDenied('update_operation_description') &&
        mayEditOperationDescription(selected, role, principalId)
      }
      busy={busy === catalogOperationKey(selected)}
      onPublish={() => act(selected, 'publish_operation')}
      onDeprecate={() => act(selected, 'deprecate_operation')}
      onEditDescription={() => openDescriptionEditor(selected)}
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
        detail={
          operations.state.status === 'ready' && rows.length === 0 && itemId === undefined
            ? null
            : detailContent
        }
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
            <DialogDescription className="mono">{editingRow?.name}</DialogDescription>
          </DialogHeader>
          <Field
            id={descriptionFieldId}
            label={t('描述', 'Description')}
            hint={t(
              '说明这个 Operation 做什么——会用于自然语言检索与在目录 / 审批卡片里展示。',
              "What this Operation does — used for natural-language search and shown wherever it's listed.",
            )}
            error={descriptionError !== null ? describeError(descriptionError).message : undefined}
          >
            <Textarea
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

function SkillDetailView({
  http,
  row,
  canPropose,
  canPublish,
  canDeprecate,
  canDiscard,
  busy,
  onEditAsDraft,
  onPublish,
  onDeprecate,
  onDiscard,
}: {
  readonly http: CapabilityCaller;
  readonly row: SkillRow;
  readonly canPropose: boolean;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  readonly canDiscard: boolean;
  readonly busy: boolean;
  readonly onEditAsDraft: () => void;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: () => Promise<void>;
}) {
  const t = useT();
  // Best-effort read of the current version's full body — degrades to "—" on error/while loading
  // rather than blocking the rest of the detail (same convention `get_operation_stats` uses on the
  // Operations tab above). `get_skill` already exists and is already called from this same file
  // for the copy-prefill flow (`SkillEditor.tsx`); this is a second, read-only call site of it.
  const skillDetail = useCapability<SkillDetailWire | null>(http, 'get_skill', { skillId: row.id });
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
          <strong className="catalog-detail-title truncate">{row.name}</strong>
          <span className="text-3 text-small">v{row.version}</span>
        </div>
        <PublishableStepper status={row.status} testId="skill-detail-stepper" />
      </header>

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

      <div className="row-wrap">
        {canPropose ? (
          <Button
            variant="ghost"
            size="s"
            onClick={onEditAsDraft}
            data-testid="catalog-edit-as-draft"
          >
            {t('编辑为新草稿', 'Edit as new draft')}
          </Button>
        ) : null}
        {canPublish && row.status === 'draft' ? (
          <Button
            variant="primary"
            size="s"
            disabled={busy}
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
        ) : null}
        {canDiscard && row.status === 'draft' ? (
          <DiscardDraftConfirm
            busy={busy}
            target={row.name}
            onConfirm={onDiscard}
            testId={`skill-discard-confirm-${row.id}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function SkillsTab({ http, itemId, onSelectItem }: CatalogTabProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const skills = useCapabilityList<SkillRow>(http, 'list_skills');
  const { principalId } = useWorkspaceIdentity(http);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<SkillRow>>(null);

  const rows = skills.state.status === 'ready' ? skills.state.data.items : [];
  const selected = itemId ? rows.find((row) => row.id === itemId) : undefined;
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
    onSelectItem(id);
  }

  function closeEditor(): void {
    setEditor(null);
    onSelectItem(null);
  }

  async function act(row: SkillRow, action: 'publish_skill' | 'deprecate_skill') {
    setBusy(row.id);
    try {
      await http.call(action, { skillId: row.id });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_skill' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        title: `Could not update ${row.name}`,
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  // S8 W3 K2 (leftover 82): `discard_draft{kind, id, version}` — a different params shape from
  // `act` above (`{skillId}` alone), so it is its own function rather than a third `action` value.
  async function discardSkillDraft(row: SkillRow): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', { kind: 'skill', id: row.id, version: row.version });
      toast.push({ tone: 'ok', title: `${row.name} ${t('已丢弃', 'discarded')}` });
      selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = !permissions.isDenied('propose_skill');
  const canPublish = !permissions.isDenied('publish_skill');
  const canDeprecate = !permissions.isDenied('deprecate_skill');
  const canDiscard = !permissions.isDenied('discard_draft');

  const editorPane = editor ? (
    <div className="stack">
      <h2 className="catalog-detail-title">
        {editor.kind === 'copy'
          ? t('编辑为新草稿', 'Edit as new draft')
          : t('新建 Skill 草稿', 'New Skill draft')}
      </h2>
      <p className="text-3 text-small">
        {t('SKILL.md：frontmatter 字段 + Markdown 正文', 'frontmatter fields + Markdown body')}
      </p>
      <SkillEditor
        key={editor.kind === 'copy' ? editor.row.id : 'new'}
        http={http}
        copyOf={editor.kind === 'copy' ? editor.row : undefined}
        onProposed={() => void skills.reload()}
        onDone={() => {
          closeEditor();
          refresh();
        }}
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
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="truncate">{row.name}</span>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">
                  v{row.version} · {row.description}
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
  ) : selected ? (
    <SkillDetailView
      http={http}
      row={selected}
      canPropose={canPropose}
      canPublish={canPublish}
      canDeprecate={canDeprecate}
      canDiscard={canDiscard && isOwnDraftOrUnknown(selected, principalId)}
      busy={busy === selected.id}
      onEditAsDraft={() => openEditor({ kind: 'copy', row: selected })}
      onPublish={() => act(selected, 'publish_skill')}
      onDeprecate={() => act(selected, 'deprecate_skill')}
      onDiscard={() => discardSkillDraft(selected)}
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
        skills.state.status === 'ready' && rows.length === 0 && itemId === undefined
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
  canDiscard,
  busy,
  onEditAsDraft,
  onPublish,
  onDeprecate,
  onDiscard,
}: {
  readonly http: CapabilityCaller;
  readonly row: ProcedureRow;
  readonly canPropose: boolean;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  readonly canDiscard: boolean;
  readonly busy: boolean;
  readonly onEditAsDraft: () => void;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: () => Promise<void>;
}) {
  const t = useT();
  return (
    <div className="stack" data-testid="procedure-detail" data-procedure-id={row.id}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="publishable" status={row.status} size="s" />
          <strong className="catalog-detail-title truncate">{row.name}</strong>
          <span className="text-3 text-small">v{row.version}</span>
          {row.steps ? (
            <span className="tag">
              {row.steps.length} {t('步', 'steps')}
            </span>
          ) : null}
        </div>
        <PublishableStepper status={row.status} testId="procedure-detail-stepper" />
      </header>

      <KeyValue
        items={[
          { key: 'description', label: t('描述', 'Description'), value: row.description },
          ...(row.proposedBy
            ? [proposerItem(http, row.proposedBy, t, 'procedure-detail-proposer')]
            : []),
        ]}
      />

      <div className="stack-s">
        <span className="section-title">{t('步骤', 'Steps')}</span>
        <pre className="code-block" data-testid="procedure-detail-steps">
          {prettyJson(row.steps ?? [])}
        </pre>
      </div>

      <div className="row-wrap">
        {canPropose ? (
          <Button
            variant="ghost"
            size="s"
            onClick={onEditAsDraft}
            data-testid="catalog-edit-as-draft"
          >
            {t('编辑为新草稿', 'Edit as new draft')}
          </Button>
        ) : null}
        {canPublish && row.status === 'draft' ? (
          <Button
            variant="primary"
            size="s"
            disabled={busy}
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
        ) : null}
        {canDiscard && row.status === 'draft' ? (
          <DiscardDraftConfirm
            busy={busy}
            target={row.name}
            onConfirm={onDiscard}
            testId={`procedure-discard-confirm-${row.id}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function ProceduresTab({ http, itemId, onSelectItem }: CatalogTabProps) {
  const t = useT();
  const permissions = usePermissions();
  const toast = useToast();
  const procedures = useCapabilityList<ProcedureRow>(http, 'list_procedures');
  const { principalId } = useWorkspaceIdentity(http);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState<ProcedureRow>>(null);

  const rows = procedures.state.status === 'ready' ? procedures.state.data.items : [];
  const selected = itemId ? rows.find((row) => row.id === itemId) : undefined;
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
    onSelectItem(id);
  }

  function closeEditor(): void {
    setEditor(null);
    onSelectItem(null);
  }

  async function act(row: ProcedureRow, action: 'publish_procedure' | 'deprecate_procedure') {
    setBusy(row.id);
    try {
      await http.call(action, { procedureId: row.id });
      toast.push({
        tone: 'ok',
        title: `${row.name} ${action === 'publish_procedure' ? t('已发布', 'published') : t('已弃用', 'deprecated')}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied(action);
      // C14: carry the kernel's own text — the generic title alone dropped the actual reason.
      toast.push({
        tone: 'danger',
        title: `Could not update ${row.name}`,
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  // S8 W3 K2 (leftover 82): `discard_draft{kind, id, version}` — a different params shape from
  // `act` above (`{procedureId}` alone), so it is its own function rather than a third `action`.
  async function discardProcedureDraft(row: ProcedureRow): Promise<void> {
    setBusy(row.id);
    try {
      await http.call('discard_draft', { kind: 'procedure', id: row.id, version: row.version });
      toast.push({ tone: 'ok', title: `${row.name} ${t('已丢弃', 'discarded')}` });
      selectRow(null);
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('discard_draft');
      toast.push({
        tone: 'danger',
        title: t('无法丢弃该草稿', 'Could not discard this draft'),
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = !permissions.isDenied('propose_procedure');
  const canPublish = !permissions.isDenied('publish_procedure');
  const canDeprecate = !permissions.isDenied('deprecate_procedure');
  const canDiscard = !permissions.isDenied('discard_draft');

  const editorPane = editor ? (
    <div className="stack">
      <h2 className="catalog-detail-title">
        {editor.kind === 'copy'
          ? t('编辑为新草稿', 'Edit as new draft')
          : t('新建 Procedure 草稿', 'New Procedure draft')}
      </h2>
      <p className="text-3 text-small">
        {t('名称、描述与有序步骤', 'name, description and ordered steps')}
      </p>
      <ProcedureEditorHost
        key={editor.kind === 'copy' ? editor.row.id : 'new'}
        http={http}
        copyOf={editor.kind === 'copy' ? editor.row : undefined}
        onProposed={() => void procedures.reload()}
        onDone={() => {
          closeEditor();
          refresh();
        }}
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
            title={t('还没有 Procedure', 'No Procedures yet')}
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
                <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="row-wrap">
                    <span className="truncate">{row.name}</span>
                    {row.steps ? (
                      <span className="tag">
                        {row.steps.length} {t('步', 'steps')}
                      </span>
                    ) : null}
                  </span>
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">
                  v{row.version} · {row.description}
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
              '已达到单次读取上限，继续点“加载更多”查看其余 Procedure。',
              'Reached the per-page limit — keep loading more to see the rest.',
            )}
          </p>
        ) : null}
        {procedures.loadMoreError !== null ? (
          <ErrorBanner
            error={procedures.loadMoreError}
            title={t('无法加载更多 Procedure', 'Could not load more procedures')}
            testId="procedures-load-more-error"
          />
        ) : null}
      </div>
    );

  const detailContent = showEditor ? (
    editorPane
  ) : selected ? (
    <ProcedureDetailView
      http={http}
      row={selected}
      canPropose={canPropose}
      canPublish={canPublish}
      canDeprecate={canDeprecate}
      canDiscard={canDiscard && isOwnDraftOrUnknown(selected, principalId)}
      busy={busy === selected.id}
      onEditAsDraft={() => openEditor({ kind: 'copy', row: selected })}
      onPublish={() => act(selected, 'publish_procedure')}
      onDeprecate={() => act(selected, 'deprecate_procedure')}
      onDiscard={() => discardProcedureDraft(selected)}
    />
  ) : (
    <SelectionPlaceholder
      itemId={itemId}
      ready={procedures.state.status === 'ready'}
      emptyTitle={t(
        '选择左侧一个 Procedure，查看步骤',
        'Select a Procedure on the left to see its steps',
      )}
    />
  );

  return (
    <MasterDetail
      list={list}
      detail={
        procedures.state.status === 'ready' && rows.length === 0 && itemId === undefined
          ? null
          : detailContent
      }
      open={itemId !== undefined}
      onClose={closeEditor}
      sheetTitle={t('Procedure 详情', 'Procedure detail')}
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
  return `${row.id}@${row.version}`;
}

/** A Worker definition's display name: its own name, else 「未命名 · <short id>」. Rows are one
 *  `<button>` now, so the pre-P3-5 `RefChip` fallback (greyed short id) is gone — and a raw UUID
 *  in a title is exactly what the copy guard rejects (an unnamed entry definition tripped it). */
function workerLabel(row: WorkerDefinitionSummary, t: Translate): string {
  return (
    definitionName([row], row.id, row.version) ?? `${t('未命名', 'Unnamed')} · ${shortId(row.id)}`
  );
}

/** Workers tab local editor state — a superset of the shared `EditorState<Row>` used by the
 *  Skills/Procedures tabs above: adds `'template'` for J7/CW1 "从模板创建（ops-runner）", which
 *  prefills a brand-new draft rather than starting blank or copying a published row. */
type WorkerEditorState =
  | { readonly kind: 'new' }
  | { readonly kind: 'copy'; readonly row: WorkerDefinitionSummary }
  | { readonly kind: 'template' }
  | null;

function WorkerDetailView({
  row,
  isMyDraft,
  canPropose,
  canPublish,
  canDeprecate,
  canDiscard,
  busy,
  onEditAsNewVersion,
  onPublish,
  onDeprecate,
  onDiscard,
}: {
  readonly row: WorkerDefinitionSummary;
  readonly isMyDraft: boolean;
  readonly canPropose: boolean;
  readonly canPublish: boolean;
  readonly canDeprecate: boolean;
  readonly canDiscard: boolean;
  readonly busy: boolean;
  readonly onEditAsNewVersion: () => void;
  readonly onPublish: () => Promise<void>;
  readonly onDeprecate: () => Promise<void>;
  readonly onDiscard: () => Promise<void>;
}) {
  const t = useT();
  const name = workerLabel(row, t);
  return (
    <div className="stack" data-testid="worker-detail" data-worker-key={workerKey(row)}>
      <header className="stack-s">
        <div className="row-wrap">
          <StatusChip machine="publishable" status={row.status} size="s" />
          <strong className="catalog-detail-title truncate">{name}</strong>
          <span className="text-3 text-small">v{row.version}</span>
          <span className="tag">{workerDefinitionKindLabel(row.kind, t)}</span>
        </div>
        <PublishableStepper status={row.status} testId="worker-detail-stepper" />
      </header>

      {typeof row.definition.description === 'string' ? (
        <KeyValue
          items={[
            {
              key: 'description',
              label: t('描述', 'Description'),
              value: row.definition.description,
            },
          ]}
        />
      ) : null}

      <div className="stack-s">
        <span className="section-title">{t('定义', 'Definition')}</span>
        <pre className="code-block" data-testid="worker-detail-definition">
          {prettyJson(row.definition)}
        </pre>
      </div>

      <div className="row-wrap">
        {isMyDraft ? (
          <>
            {canPublish ? (
              <Button
                variant="primary"
                size="s"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void onPublish()}
                data-testid="worker-draft-publish"
              >
                {t('发布', 'Publish')}
              </Button>
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
  const toast = useToast();
  const workers = useCapabilityList<WorkerDefinitionSummary>(http, 'list_worker_definitions', {});
  // S8 W2-U2b (audit R6): a dedicated own-drafts read — `includeOwnDrafts` is additive (published
  // rows come back too, S8 W2-U2b) — only the caller's own draft rows are this section's concern.
  const myDrafts = useCapabilityList<WorkerDefinitionSummary>(
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
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<WorkerEditorState>(null);

  function refresh(): void {
    invalidateCapability(http, 'list_worker_definitions');
    void workers.reload();
    void myDrafts.reload();
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
      await http.call('publish_worker_definition', { definitionId: row.id, version: row.version });
      toast.push({
        tone: 'ok',
        title: `${workerLabel(row, t)} ${t('已发布', 'published')}`,
      });
      refresh();
    } catch (err) {
      if (isForbiddenError(err)) permissions.markDenied('publish_worker_definition');
      toast.push({
        tone: 'danger',
        title: t('无法发布该草稿', 'Could not publish this draft'),
        description: describeError(err).message,
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
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  // S8 W3 K2 (leftover 82): discards one of the caller's own draft WorkerDefinition versions —
  // same catch-and-toast convention every other write in this tab already uses (never re-throws
  // into `Confirm`'s own inline error state, matching `deprecate`/`publishDraft` above).
  async function discardWorkerDraft(row: WorkerDefinitionSummary): Promise<void> {
    setBusy(workerKey(row));
    try {
      await http.call('discard_draft', {
        kind: 'worker_definition',
        id: row.id,
        version: row.version,
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
        description: describeError(err).message,
      });
    } finally {
      setBusy(null);
    }
  }

  const canPropose = !permissions.isDenied('propose_worker_definition');
  const canPublish = !permissions.isDenied('publish_worker_definition');
  const canDiscard = !permissions.isDenied('discard_draft');
  const canDeprecate = !permissions.isDenied('deprecate_worker_definition');

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
      <p className="text-3 text-small">kind + definition（systemPrompt、model、capabilities…）</p>
      <WorkerEditorHost
        key={editor.kind === 'copy' ? `${editor.row.id}@${editor.row.version}` : editor.kind}
        http={http}
        newVersionOf={editor.kind === 'copy' ? editor.row : undefined}
        initialForm={
          editor.kind === 'template' && capabilityNames.state.status === 'ready'
            ? opsRunnerTemplateForm(capabilityNames.state.data.items)
            : undefined
        }
        capabilityNames={
          capabilityNames.state.status === 'ready' ? capabilityNames.state.data.items : undefined
        }
        onProposed={() => {
          void workers.reload();
          void myDrafts.reload();
        }}
        onDone={() => {
          closeEditor();
          refresh();
        }}
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
  const selected = itemId ? allRows.find((row) => workerKey(row) === itemId) : undefined;

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
                <span className="truncate text-3">v{row.version}</span>
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
                  <StatusChip machine="publishable" status={row.status} size="s" />
                </span>
                <span className="truncate text-3">v{row.version}</span>
              </ListRow>
            ))}
          </List>
        )}
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
                <span className="truncate text-3">v{row.version}</span>
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
      row={selected}
      isMyDraft={selected.status === 'draft'}
      canPropose={canPropose}
      canPublish={canPublish}
      canDeprecate={canDeprecate}
      canDiscard={canDiscard}
      busy={busy === workerKey(selected)}
      onEditAsNewVersion={() => openEditor({ kind: 'copy', row: selected })}
      onPublish={() => publishDraft(selected)}
      onDeprecate={() => deprecate(selected)}
      onDiscard={() => discardWorkerDraft(selected)}
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
