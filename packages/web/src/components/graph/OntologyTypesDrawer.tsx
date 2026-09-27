import type { OntologyTypeWire } from '@nexttime/shared';
import { type FormEvent, useMemo, useState } from 'react';
import { useCapability, useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { EmptyState } from '../kit/empty-state.js';
import { ErrorBanner } from '../kit/error-banner.js';
import { KeyValue, type KeyValueItem } from '../kit/key-value.js';
import { List, ListRow } from '../kit/list-row.js';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '../kit/sheet.js';
import { SkeletonRows } from '../kit/skeleton.js';
import { StatusChip } from '../kit/status-chip.js';
import { Tabs } from '../kit/tabs.js';

export interface OntologyTypesDrawerProps {
  readonly http: CapabilityCaller;
  /** Open state — the graph page drives this from `?types=1` (`lib/graph-route.ts`) so the drawer
   *  is a deep link, not only a click-to-open overlay. */
  readonly open: boolean;
  /** The type focused in the detail view, or `undefined` for the list view — the graph page drives
   *  this from `?typeName=`. */
  readonly selectedTypeName: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectType: (typeName: string | undefined) => void;
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
 * components/graph/OntologyTypesDrawer (收尾波次 C5, coverage gap G1 half — `get_type`/`list_types`
 * console gap): a read-only browser over the workspace's currently-visible ontology (every
 * published ObjectType/LinkType/ActionType, `list_types`; `get_type` re-fetches the canonical
 * definition once a row is opened, the same "list row is a summary, detail re-reads" convention
 * `ProvenanceDrawer`/`ApprovalDetail` already follow). Two views inside one `kit/sheet`: a
 * searchable, kind-filterable list, and a selected type's detail — `onSelectType`/`selectedTypeName`
 * switch between them, driven by the graph page's own hash query so both are deep-linkable.
 *
 * Also covers `validate` (a LinkType's own "校验一个候选关系" tool below its signatures,
 * `LinkValidateTool`) — its real semantics is checking one candidate `{linkType, sourceType,
 * targetType}` against every visible signature's domain/range (I2), not dry-running a proposed
 * ontology *change* (the coverage doc's gap #1 description conflated the two); a LinkType's own
 * detail view is exactly where a person already has `linkType` fixed and wants to try a pair.
 *
 * Deliberately does **not** cover `propose_ontology_change`/`publish_ontology_version` (the other
 * half of G1, "提案审阅" in the dispatch) — there is no kernel capability that lists or reads a
 * pending `ontology_versions` draft row (id/version/status/proposedBy) by any filter; `get_type`/
 * `list_types` return the merged *current-state* type view (no `id`/`version`/`proposedBy` fields
 * at all), scoped to published rows plus only the caller's own drafts, and neither `propose_
 * ontology_change` nor `publish_ontology_version` has a matching read sibling the way `list_skills`/
 * `list_worker_definitions` do for their own draft/publish lifecycle. Building a "review queue" here
 * would mean inventing a kernel capability from inside a console PR — out of scope; see this wave's
 * final report for the exact gap.
 */
export function OntologyTypesDrawer({
  http,
  open,
  selectedTypeName,
  onOpenChange,
  onSelectType,
}: OntologyTypesDrawerProps) {
  const t = useT();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="wide" data-testid="graph-types-drawer">
        <SheetHeader className="flex-row items-center justify-between">
          <SheetTitle>{t('本体类型', 'Ontology types')}</SheetTitle>
          {/* A read-only browser has no Cancel of its own, and a wide sheet can leave no overlay to
           *  tap on a phone — so an explicit close, not only Esc / outside click. */}
          <SheetClose asChild>
            <Button variant="ghost" size="s" data-testid="graph-types-close">
              {t('关闭', 'Close')}
            </Button>
          </SheetClose>
        </SheetHeader>
        {open ? (
          selectedTypeName === undefined ? (
            <TypesListView http={http} onSelect={onSelectType} />
          ) : (
            <TypeDetailView
              http={http}
              typeName={selectedTypeName}
              onBack={() => onSelectType(undefined)}
            />
          )
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
