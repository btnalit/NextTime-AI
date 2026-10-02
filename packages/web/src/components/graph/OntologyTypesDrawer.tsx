import type { OntologyTypeWire, OntologyVersionListItemWire } from '@nexttime/shared';
import { type FormEvent, useMemo, useState } from 'react';
import {
  type CapabilityListResult,
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../hooks/useCapability.js';
import { usePermissions } from '../../hooks/usePermissions.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { isForbiddenError } from '../../lib/errors.js';
import { formatDateTime, formatRelative, shortId } from '../../lib/format.js';
import { type OntologyProposalDiffEntry, ontologyProposalDiff } from '../../lib/graph-view.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { Confirm } from '../kit/confirm.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { List, ListRow } from '../kit/list-row.js';
import { RefChip } from '../kit/ref-chip.js';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { Tabs } from '../kit/tabs.js';

type OntologyDrawerTab = 'types' | 'proposals';

export interface OntologyTypesDrawerProps {
  readonly http: CapabilityCaller;
  /** Open state — the graph page drives this from `?types=1` (`lib/graph-route.ts`) so the drawer
   *  is a deep link, not only a click-to-open overlay. */
  readonly open: boolean;
  /** Which of the drawer's two top-level tabs is showing — the graph page drives this from
   *  `?ontologyTab=`. */
  readonly activeTab: OntologyDrawerTab;
  readonly onTabChange: (tab: OntologyDrawerTab) => void;
  /** The type focused in the 「类型 Types」 tab's detail view, or `undefined` for its list view —
   *  the graph page drives this from `?typeName=`. */
  readonly selectedTypeName: string | undefined;
  /** The draft focused in the 「提案 Proposals」 tab's detail view (both fields together, or both
   *  `undefined` for its list view) — the graph page drives this from `?proposalId=&proposalVersion=`. */
  readonly selectedProposal: { readonly id: string; readonly version: number } | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectType: (typeName: string | undefined) => void;
  readonly onSelectProposal: (
    proposal: { readonly id: string; readonly version: number } | undefined,
  ) => void;
}

type KindFilter = 'all' | OntologyTypeWire['kind'];

function kindLabel(kind: OntologyTypeWire['kind'], t: Translate): string {
  if (kind === 'object') return t('对象', 'Object');
  if (kind === 'link') return t('关系', 'Link');
  return t('动作', 'Action');
}

/** One line summarising a row for the list — the description for object/action, the first
 *  domain→range signature (plus a "+N" count) for a link, which has no description of its own at
 *  the type level (only per-signature, `wire/ontology.ts`'s own doc comment on why one name may
 *  carry more than one signature). */
function rowSummary(row: OntologyTypeWire): string {
  if (row.kind === 'link') {
    const [first, ...rest] = row.signatures;
    if (!first) return '';
    const base = `${first.domain} → ${first.range}`;
    return rest.length > 0 ? `${base} (+${rest.length})` : base;
  }
  return row.description;
}

/**
 * components/graph/OntologyTypesDrawer (收尾波次 C5, coverage gap G1 — `get_type`/`list_types`/
 * `validate`/`propose_ontology_change`/`publish_ontology_version` console gap): two top-level tabs
 * inside one `kit/sheet`.
 *
 * 「类型 Types」 (closing wave C5, part 1): a read-only browser over the workspace's currently-
 * visible ontology (every published ObjectType/LinkType/ActionType, `list_types`; `get_type`
 * re-fetches the canonical definition once a row is opened, the same "list row is a summary,
 * detail re-reads" convention `ProvenanceDrawer`/`ApprovalDetail` already follow) — searchable,
 * kind-filterable list plus a selected type's detail, `onSelectType`/`selectedTypeName` switching
 * between them. Also covers `validate` (a LinkType's own "校验一个候选关系" tool below its
 * signatures, `LinkValidateTool`) — its real semantics is checking one candidate `{linkType,
 * sourceType, targetType}` against every visible signature's domain/range (I2), not dry-running a
 * proposed ontology *change*; a LinkType's own detail view is exactly where a person already has
 * `linkType` fixed and wants to try a pair.
 *
 * 「提案 Proposals」 (closing wave C5b, part 2): lists the caller-visible `ontology_versions` draft
 * rows (`list_ontology_versions` — part 1's own module doc comment explains why that capability did
 * not exist yet), each opening onto a detail view that diffs the draft's own definition against the
 * currently-visible types (`ontologyProposalDiff`, `lib/graph-view.ts`) and offers `发布 Publish`
 * (`publish_ontology_version`) behind an `irreversible`-tier confirm — that capability is a one-way
 * `draft -> published` transition (I12: the definition becomes immutable the moment it publishes,
 * and no unpublish/deprecate exists for an OntologyVersion), so this is not a `medium`-tier
 * one-click action like `publish_skill`/`publish_worker_definition`.
 *
 * Both tabs, and the Proposals detail, are driven by the graph page's own hash query
 * (`?ontologyTab=&proposalId=&proposalVersion=` alongside `?types=&typeName=`) so every view is
 * deep-linkable, the same convention part 1 already established for `typeName`.
 */
export function OntologyTypesDrawer({
  http,
  open,
  activeTab,
  onTabChange,
  selectedTypeName,
  selectedProposal,
  onOpenChange,
  onSelectType,
  onSelectProposal,
}: OntologyTypesDrawerProps) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="wide" data-testid="graph-types-drawer">
        <SheetHeader className="flex-row items-center justify-between">
          <SheetTitle>{t('本体', 'Ontology')}</SheetTitle>
          {/* A read-only browser has no Cancel of its own, and a wide sheet can leave no overlay to
           *  tap on a phone — so an explicit close, not only Esc / outside click. */}
          <SheetClose asChild>
            <Button variant="ghost" size="s" data-testid="graph-types-close">
              {t('关闭', 'Close')}
            </Button>
          </SheetClose>
        </SheetHeader>
        {open ? (
          <div className="stack">
            <Tabs<OntologyDrawerTab>
              ariaLabel={t('本体标签页', 'Ontology tabs')}
              value={activeTab}
              onChange={onTabChange}
              options={[
                { value: 'types', label: t('类型', 'Types'), testId: 'graph-ontology-tab-types' },
                {
                  value: 'proposals',
                  label: t('提案', 'Proposals'),
                  testId: 'graph-ontology-tab-proposals',
                },
              ]}
            />
            {activeTab === 'types' ? (
              selectedTypeName === undefined ? (
                <TypesListView http={http} onSelect={onSelectType} />
              ) : (
                <TypeDetailView
                  http={http}
                  typeName={selectedTypeName}
                  onBack={() => onSelectType(undefined)}
                />
              )
            ) : selectedProposal === undefined ? (
              <ProposalsListView http={http} onSelect={onSelectProposal} />
            ) : (
              <ProposalDetailView
                http={http}
                proposalId={selectedProposal.id}
                proposalVersion={selectedProposal.version}
                onBack={() => onSelectProposal(undefined)}
              />
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface TypesListViewProps {
  readonly http: CapabilityCaller;
  readonly onSelect: (typeName: string) => void;
}

function TypesListView({ http, onSelect }: TypesListViewProps) {
  const t = useT();
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const types = useCapabilityList<OntologyTypeWire>(http, 'list_types', {});
  const rows = types.state.status === 'ready' ? types.state.data.items : undefined;

  const counts = useMemo(() => {
    const next: Record<KindFilter, number> = { all: 0, object: 0, link: 0, action: 0 };
    for (const row of rows ?? []) {
      next.all += 1;
      next[row.kind] += 1;
    }
    return next;
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return undefined;
    const needle = query.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (kind === 'all' || row.kind === kind) &&
        (needle === '' || row.name.toLowerCase().includes(needle)),
    );
  }, [rows, kind, query]);

  return (
    <div className="stack" data-testid="graph-types-list-view">
      <div className="field">
        <label className="field-label" htmlFor="graph-types-search">
          {t('搜索类型', 'Search types')}
        </label>
        <input
          id="graph-types-search"
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('按名称筛选', 'Filter by name')}
          data-testid="graph-types-search"
        />
      </div>
      <Tabs<KindFilter>
        ariaLabel={t('类型种类', 'Type kind')}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'all', label: t('全部', 'All'), count: counts.all },
          { value: 'object', label: t('对象', 'Object'), count: counts.object },
          { value: 'link', label: t('关系', 'Link'), count: counts.link },
          { value: 'action', label: t('动作', 'Action'), count: counts.action },
        ]}
      />
      {types.state.status === 'loading' ? (
        <SkeletonRows count={4} label="Loading types" testId="graph-types-loading" />
      ) : types.state.status === 'error' ? (
        <ErrorBanner
          error={types.state.error}
          title={t('无法加载类型', 'Could not load types')}
          onRetry={() => void types.reload()}
          testId="graph-types-error"
        />
      ) : (filtered ?? []).length === 0 ? (
        <EmptyState
          title={t('没有匹配的类型', 'No matching types')}
          body={t('换一个关键字或种类。', 'Try another name or kind.')}
          testId="graph-types-empty"
        />
      ) : (
        <List ariaLabel={t('本体类型', 'Ontology types')} testId="graph-types-list">
          {(filtered ?? []).map((row) => (
            <ListRow
              key={`${row.kind}:${row.name}`}
              testId="graph-type-row"
              onSelect={() => onSelect(row.name)}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="mono">{row.name}</span>
                <span className="chip chip-neutral chip-s">{kindLabel(row.kind, t)}</span>
              </span>
              <span className="text-3 truncate">{rowSummary(row)}</span>
            </ListRow>
          ))}
        </List>
      )}
    </div>
  );
}

interface TypeDetailViewProps {
  readonly http: CapabilityCaller;
  readonly typeName: string;
  readonly onBack: () => void;
}

function TypeDetailView({ http, typeName, onBack }: TypeDetailViewProps) {
  const t = useT();
  const detail = useCapability<OntologyTypeWire | null>(http, 'get_type', { typeName });
  return (
    <div className="stack" data-testid="graph-type-detail-view">
      <Button variant="ghost" size="s" onClick={onBack} data-testid="graph-type-back">
        {t('← 返回列表', '← Back to list')}
      </Button>
      {detail.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading type" testId="graph-type-detail-loading" />
      ) : detail.state.status === 'error' ? (
        <ErrorBanner
          error={detail.state.error}
          title={t('无法加载该类型', 'Could not load this type')}
          onRetry={() => void detail.reload()}
          testId="graph-type-detail-error"
        />
      ) : detail.state.data === null ? (
        <EmptyState
          title={t('未找到该类型', 'Type not found')}
          body={t(
            '它可能已被移除，或名称已变化。',
            'It may have been removed, or its name has changed.',
          )}
          testId="graph-type-detail-missing"
        />
      ) : (
        <TypeDetailBody http={http} type={detail.state.data} t={t} />
      )}
    </div>
  );
}

function TypeDetailBody({
  http,
  type,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly type: OntologyTypeWire;
  readonly t: Translate;
}) {
  return (
    <div className="stack" data-testid="graph-type-detail-body">
      <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <span className="mono" style={{ fontWeight: 600 }}>
          {type.name}
        </span>
        <span className="chip chip-neutral chip-s">{kindLabel(type.kind, t)}</span>
      </span>

      {type.kind === 'object' ? (
        <KeyValue
          testId="graph-type-detail-fields"
          items={[
            { key: 'description', label: t('说明', 'Description'), value: type.description },
            {
              key: 'identityKey',
              label: t('身份键', 'Identity key'),
              value:
                type.identityKey && type.identityKey.length > 0
                  ? type.identityKey.join(', ')
                  : t('未声明', 'Not declared'),
              mono: Boolean(type.identityKey && type.identityKey.length > 0),
            },
          ]}
        />
      ) : null}

      {type.kind === 'link' ? (
        <div className="stack-s" data-testid="graph-type-detail-signatures">
          <h3 className="text-12 font-semibold uppercase tracking-wider text-text-3">
            {t('domain → range 签名', 'Domain → range signatures')}
          </h3>
          {type.signatures.map((signature) => (
            <div key={`${signature.domain}->${signature.range}`} className="stack-s">
              <span className="mono">
                {signature.domain} → {signature.range}
              </span>
              {signature.description !== '' ? (
                <span className="text-3">{signature.description}</span>
              ) : null}
            </div>
          ))}
          <LinkValidateTool http={http} linkType={type.name} t={t} />
        </div>
      ) : null}

      {type.kind === 'action' ? (
        <>
          <KeyValue
            testId="graph-type-detail-fields"
            items={[
              { key: 'description', label: t('说明', 'Description'), value: type.description },
            ]}
          />
          <div className="row-wrap">
            <StatusChip machine="operationMode" status={type.mode} size="s" />
            <StatusChip machine="blastRadius" status={type.blastRadius} size="s" />
            {type.autoApprovable !== undefined ? (
              <StatusChip machine="autoApprovable" status={String(type.autoApprovable)} size="s" />
            ) : null}
          </div>
          <KeyValue
            testId="graph-type-detail-flags"
            items={(
              [
                type.reversibility !== undefined
                  ? {
                      key: 'reversibility',
                      label: t('可撤回', 'Reversible'),
                      value: type.reversibility ? t('是', 'Yes') : t('否', 'No'),
                    }
                  : null,
                type.awaitDecision !== undefined
                  ? {
                      key: 'awaitDecision',
                      label: t('阻塞等待决定', 'Await decision'),
                      value: type.awaitDecision ? t('是', 'Yes') : t('否', 'No'),
                    }
                  : null,
                type.requesterCanApprove !== undefined
                  ? {
                      key: 'requesterCanApprove',
                      label: t('提出者可自行批准', 'Requester can approve'),
                      value: type.requesterCanApprove ? t('是', 'Yes') : t('否', 'No'),
                    }
                  : null,
              ] as readonly (KeyValueItem | null)[]
            ).filter((item): item is KeyValueItem => item !== null)}
          />
        </>
      ) : null}
    </div>
  );
}

type ValidateResult =
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'done'; readonly valid: boolean; readonly errors?: readonly string[] }
  | { readonly status: 'error'; readonly error: unknown };

interface LinkValidateToolProps {
  readonly http: CapabilityCaller;
  /** Fixed to the LinkType whose detail this renders under — `validate`'s own semantics is
   *  "does {linkType, sourceType, targetType} match a declared signature" (I2), so only the two
   *  ObjectType ends need a field; there is nothing else for the reader to pick. */
  readonly linkType: string;
  readonly t: Translate;
}

/** The `validate` capability's console surface (coverage gap G1's other closeable half — see this
 *  file's module doc comment): try one candidate `sourceType -> targetType` pair against every
 *  signature this LinkType currently declares. Calls `http.call` directly (an on-demand check, not
 *  a page-load read) — the same pattern `FactRow`'s write confirms use for `verify_fact`/etc. */
function LinkValidateTool({ http, linkType, t }: LinkValidateToolProps) {
  const [sourceType, setSourceType] = useState('');
  const [targetType, setTargetType] = useState('');
  const [result, setResult] = useState<ValidateResult>({ status: 'idle' });

  async function run(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setResult({ status: 'checking' });
    try {
      const outcome = await http.call<{ valid: boolean; errors?: readonly string[] }>('validate', {
        link: { linkType, sourceType: sourceType.trim(), targetType: targetType.trim() },
      });
      setResult({ status: 'done', valid: outcome.valid, errors: outcome.errors });
    } catch (error) {
      setResult({ status: 'error', error });
    }
  }

  const canSubmit =
    sourceType.trim() !== '' && targetType.trim() !== '' && result.status !== 'checking';

  return (
    <div className="stack-s" data-testid="graph-type-validate-tool">
      <h3 className="text-12 font-semibold uppercase tracking-wider text-text-3">
        {t('校验一个候选关系', 'Validate a candidate link')}
      </h3>
      <form className="row-wrap" onSubmit={run} data-testid="graph-type-validate-form">
        <div className="field">
          <label className="field-label" htmlFor="graph-type-validate-source">
            {t('来源类型', 'Source type')}
          </label>
          <input
            id="graph-type-validate-source"
            className="input"
            value={sourceType}
            onChange={(event) => setSourceType(event.target.value)}
            placeholder="ObjectType"
            data-testid="graph-type-validate-source"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="graph-type-validate-target">
            {t('目标类型', 'Target type')}
          </label>
          <input
            id="graph-type-validate-target"
            className="input"
            value={targetType}
            onChange={(event) => setTargetType(event.target.value)}
            placeholder="ObjectType"
            data-testid="graph-type-validate-target"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          size="s"
          disabled={!canSubmit}
          data-testid="graph-type-validate-submit"
        >
          {t('校验', 'Validate')}
        </Button>
      </form>
      {result.status === 'done' ? (
        <div data-testid="graph-type-validate-result">
          {result.valid ? (
            <span className="chip chip-ok chip-s">
              {t('符合 domain/range', 'Matches domain/range')}
            </span>
          ) : (
            <>
              <span className="chip chip-danger chip-s">{t('不符合', 'Does not match')}</span>
              {(result.errors ?? []).map((message) => (
                <p key={message} className="text-3">
                  {message}
                </p>
              ))}
            </>
          )}
        </div>
      ) : null}
      {result.status === 'error' ? (
        <ErrorBanner
          error={result.error}
          title={t('校验失败', 'Validation failed')}
          testId="graph-type-validate-error"
        />
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------------
// Proposals tab (closing wave C5b, coverage gap G1 part 2): list every draft visible to the
// caller (`list_ontology_versions` — published + own drafts + I16, this drawer's module doc
// comment) and let a person review one against the currently-visible types, then publish it.
// -------------------------------------------------------------------------------------------

interface ProposalsListViewProps {
  readonly http: CapabilityCaller;
  readonly onSelect: (proposal: { readonly id: string; readonly version: number }) => void;
}

function ProposalsListView({ http, onSelect }: ProposalsListViewProps) {
  const t = useT();
  const proposals = useCapabilityList<OntologyVersionListItemWire>(
    http,
    'list_ontology_versions',
    {},
  );
  const rows = proposals.state.status === 'ready' ? proposals.state.data.items : undefined;
  // `list_ontology_versions` also returns published rows (same visibility rule as
  // `list_worker_definitions`/`list_skills`) — the Proposals tab is a review queue, so only the
  // still-pending drafts are worth a row here; a published row has nothing left to review.
  const drafts = useMemo(() => (rows ?? []).filter((row) => row.status === 'draft'), [rows]);

  return (
    <div className="stack" data-testid="graph-proposals-list-view">
      {proposals.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading proposals" testId="graph-proposals-loading" />
      ) : proposals.state.status === 'error' ? (
        <ErrorBanner
          error={proposals.state.error}
          title={t('无法加载提案', 'Could not load proposals')}
          onRetry={() => void proposals.reload()}
          testId="graph-proposals-error"
        />
      ) : drafts.length === 0 ? (
        <EmptyState
          title={t('还没有待审阅的提案', 'No proposals to review yet')}
          body={t(
            '智能体调用「提议本体修改」后，草稿会出现在这里，等待有人审阅并发布。',
            'Once an agent proposes an ontology change, the draft appears here, awaiting review and publish.',
          )}
          testId="graph-proposals-empty"
        />
      ) : (
        <List ariaLabel={t('本体提案', 'Ontology proposals')} testId="graph-proposals-list">
          {drafts.map((row) => (
            <ListRow
              key={`${row.id}:${row.version}`}
              testId="graph-proposal-row"
              onSelect={() => onSelect({ id: row.id, version: row.version })}
            >
              <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
                {/* Plain text, never a RefChip — kit/list-row is itself a <button>, and RefChip's
                 *  own copy control is a second, nested interactive element (invalid HTML,
                 *  TasksPage.tsx's own `nameOfPrincipal` doc comment: "the full chip belongs in
                 *  the detail, this is the row"). */}
                <span className="text-13 font-medium text-text">
                  {row.proposedBy.displayName ?? shortId(row.proposedBy.id)}
                </span>
                <StatusChip machine="publishable" status={row.status} size="s" />
              </span>
              <span className="text-3">
                v{row.version} · {formatRelative(row.createdAt)}
              </span>
            </ListRow>
          ))}
        </List>
      )}
    </div>
  );
}

interface ProposalDetailViewProps {
  readonly http: CapabilityCaller;
  readonly proposalId: string;
  readonly proposalVersion: number;
  readonly onBack: () => void;
}

function ProposalDetailView({
  http,
  proposalId,
  proposalVersion,
  onBack,
}: ProposalDetailViewProps) {
  const t = useT();
  const proposals = useCapabilityList<OntologyVersionListItemWire>(
    http,
    'list_ontology_versions',
    {},
  );
  const types = useCapabilityList<OntologyTypeWire>(http, 'list_types', {});
  const rows = proposals.state.status === 'ready' ? proposals.state.data.items : undefined;
  const row = rows?.find((item) => item.id === proposalId && item.version === proposalVersion);

  // Publish invalidates and re-fetches both reads the console cares about here — the drafts list
  // (this row moves from draft to published, or disappears if the tab keeps only drafts) and the
  // currently-visible types (the newly-published definition) — same `invalidateCapability` +
  // `reload()` idiom `CatalogPage.tsx`'s own `refresh()` uses after `publish_skill`/etc.
  function handlePublished(): void {
    invalidateCapability(http, 'list_ontology_versions');
    invalidateCapability(http, 'list_types');
    void proposals.reload();
    void types.reload();
    onBack();
  }

  // Discard (leftover 99) deletes the draft row outright — only the drafts list changes; no type
  // becomes visible or disappears, so `list_types` is left alone.
  function handleDiscarded(): void {
    invalidateCapability(http, 'list_ontology_versions');
    void proposals.reload();
    onBack();
  }

  return (
    <div className="stack" data-testid="graph-proposal-detail-view">
      <Button variant="ghost" size="s" onClick={onBack} data-testid="graph-proposal-back">
        {t('← 返回列表', '← Back to list')}
      </Button>
      {proposals.state.status === 'loading' ? (
        <SkeletonRows count={3} label="Loading proposal" testId="graph-proposal-detail-loading" />
      ) : proposals.state.status === 'error' ? (
        <ErrorBanner
          error={proposals.state.error}
          title={t('无法加载该提案', 'Could not load this proposal')}
          onRetry={() => void proposals.reload()}
          testId="graph-proposal-detail-error"
        />
      ) : row === undefined ? (
        <EmptyState
          title={t('未找到该提案', 'Proposal not found')}
          body={t(
            '它可能已被发布，或不再对你可见。',
            'It may already be published, or is no longer visible to you.',
          )}
          testId="graph-proposal-detail-missing"
        />
      ) : (
        <ProposalDetailBody
          http={http}
          row={row}
          types={types}
          onPublished={handlePublished}
          onDiscarded={handleDiscarded}
          t={t}
        />
      )}
    </div>
  );
}

function diffChipClass(change: OntologyProposalDiffEntry['change']): string {
  if (change === 'added') return 'chip-ok';
  if (change === 'removed') return 'chip-danger';
  return 'chip-warn';
}

function diffChangeLabel(change: OntologyProposalDiffEntry['change'], t: Translate): string {
  if (change === 'added') return t('新增', 'Added');
  if (change === 'removed') return t('移除', 'Removed');
  return t('变更', 'Changed');
}

function ProposalDetailBody({
  http,
  row,
  types,
  onPublished,
  onDiscarded,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly row: OntologyVersionListItemWire;
  readonly types: CapabilityListResult<OntologyTypeWire>;
  readonly onPublished: () => void;
  readonly onDiscarded: () => void;
  readonly t: Translate;
}) {
  const currentTypes = types.state.status === 'ready' ? types.state.data.items : undefined;
  const diff = useMemo(
    () => (currentTypes ? ontologyProposalDiff(row.definition, currentTypes) : undefined),
    [row.definition, currentTypes],
  );

  return (
    <div className="stack" data-testid="graph-proposal-detail-body">
      <span className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <RefChip kind="principal" id={row.proposedBy.id} name={row.proposedBy.displayName} />
        <StatusChip machine="publishable" status={row.status} size="s" />
      </span>
      <KeyValue
        testId="graph-proposal-detail-fields"
        items={[
          { key: 'version', label: t('版本', 'Version'), value: `v${row.version}`, mono: true },
          {
            key: 'createdAt',
            label: t('提出时间', 'Proposed at'),
            value: formatDateTime(row.createdAt),
          },
        ]}
      />
      <div className="stack-s" data-testid="graph-proposal-diff">
        <h3 className="text-12 font-semibold uppercase tracking-wider text-text-3">
          {t('与当前已发布类型的差异', 'Diff against currently visible types')}
        </h3>
        {types.state.status === 'loading' ? (
          <SkeletonRows count={2} label="Loading types" testId="graph-proposal-diff-loading" />
        ) : types.state.status === 'error' ? (
          <ErrorBanner
            error={types.state.error}
            title={t('无法加载当前类型', 'Could not load current types')}
            onRetry={() => void types.reload()}
            testId="graph-proposal-diff-error"
          />
        ) : (diff ?? []).length === 0 ? (
          <EmptyState
            title={t('没有可见差异', 'No visible difference')}
            body={t(
              '该提案声明的类型与当前一致。',
              'The types this proposal declares already match what is currently visible.',
            )}
            variant="inline"
            testId="graph-proposal-diff-empty"
          />
        ) : (
          <div className="stack-s">
            {(diff ?? []).map((entry) => (
              <div
                key={`${entry.kind}:${entry.name}`}
                className="row-wrap"
                style={{ justifyContent: 'space-between' }}
                data-testid="graph-proposal-diff-row"
              >
                <span className="row-wrap">
                  <span className={`chip ${diffChipClass(entry.change)} chip-s`}>
                    {diffChangeLabel(entry.change, t)}
                  </span>
                  <span className="mono">{entry.name}</span>
                </span>
                <span className="chip chip-neutral chip-s">{kindLabel(entry.kind, t)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {row.status === 'draft' ? (
        <div className="row-wrap">
          <PublishProposalButton http={http} row={row} onPublished={onPublished} t={t} />
          <DiscardProposalButton http={http} row={row} onDiscarded={onDiscarded} t={t} />
        </div>
      ) : null}
    </div>
  );
}

function PublishProposalButton({
  http,
  row,
  onPublished,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly row: OntologyVersionListItemWire;
  readonly onPublished: () => void;
  readonly t: Translate;
}) {
  const permissions = usePermissions();
  const [open, setOpen] = useState(false);

  // Hidden, not merely disabled, once a 403 has proven this caller cannot publish (same
  // `permissions.isDenied` idiom `SystemsPage.tsx`/`CatalogPage.tsx` already use for `publish_*`
  // buttons) — this only ever fires after a real refusal, not a role guess made ahead of time
  // (`publish_ontology_version` needs `builder` and publishes only the caller's own draft, STATUS
  // leftover 100 — the same drafts this tab lists, so a non-builder simply has none). `&& !open`:
  // never rip the confirm out from under a caller who already opened it — the failed attempt that
  // just set this denial is itself shown inline, in the still-open confirm's own error banner; the
  // entry point disappears on the *next* visit to this proposal, not mid-flow.
  if (permissions.isDenied('publish_ontology_version') && !open) return null;

  return (
    <Confirm
      tier="irreversible"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <Button
          variant="primary"
          size="s"
          onClick={() => setOpen(true)}
          data-testid="graph-proposal-publish"
        >
          {t('发布', 'Publish')}
        </Button>
      }
      title={t('发布本体版本', 'Publish ontology version')}
      description={t(
        '发布后立即对工作区所有成员生效；这个定义此后无法再修改，也没有撤回发布的操作。',
        'Publishing takes effect for every member of the workspace immediately; this definition can never be revised again, and there is no way to unpublish it.',
      )}
      confirmLabel={t('发布', 'Publish')}
      onConfirm={async () => {
        try {
          await http.call('publish_ontology_version', { id: row.id, version: row.version });
        } catch (err) {
          if (isForbiddenError(err)) permissions.markDenied('publish_ontology_version');
          throw err;
        }
        onPublished();
      }}
      testId="graph-proposal-publish-confirm"
    />
  );
}

/** Leftover 99: the proposer discards their own ontology draft (`discard_draft{kind:
 *  'ontology_version'}`) — a `medium` confirm like `CatalogPage.tsx`'s `DiscardDraftConfirm` (a
 *  hard delete of a private, easily re-proposed draft; not the `irreversible` tier publish uses). */
function DiscardProposalButton({
  http,
  row,
  onDiscarded,
  t,
}: {
  readonly http: CapabilityCaller;
  readonly row: OntologyVersionListItemWire;
  readonly onDiscarded: () => void;
  readonly t: Translate;
}) {
  const permissions = usePermissions();
  const [open, setOpen] = useState(false);

  // Same hide-after-a-real-403 idiom (and `&& !open` rule) as `PublishProposalButton` above.
  if (permissions.isDenied('discard_draft') && !open) return null;

  return (
    <Confirm
      tier="medium"
      open={open}
      onOpenChange={setOpen}
      anchor={
        <Button
          variant="ghost"
          size="s"
          onClick={() => setOpen(true)}
          data-testid="graph-proposal-discard"
        >
          {t('丢弃', 'Discard')}
        </Button>
      }
      title={t('丢弃本体提案', 'Discard ontology proposal')}
      description={t(
        '草稿将被删除，无法恢复。',
        'This draft will be permanently deleted and cannot be recovered.',
      )}
      target={`v${row.version}`}
      confirmLabel={t('丢弃', 'Discard')}
      danger
      onConfirm={async () => {
        try {
          await http.call('discard_draft', {
            kind: 'ontology_version',
            id: row.id,
            version: row.version,
          });
        } catch (err) {
          if (isForbiddenError(err)) permissions.markDenied('discard_draft');
          throw err;
        }
        onDiscarded();
      }}
      testId="graph-proposal-discard-confirm"
    />
  );
}
