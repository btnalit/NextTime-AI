import type { ObjectWire } from '@nexttime/shared';
import type { ReactNode } from 'react';
import { formatDateTime, formatRelative, prettyJson, redactSensitive } from '../../lib/format.js';
import { objectDisplayName } from '../../lib/graph-view.js';
import { DataRow } from '../ui/DataList.js';
import { Icon } from '../ui/Icon.js';
import { RefChip } from '../ui/RefChip.js';
import { FreshnessChip } from './FreshnessChip.js';
import { useGraphObjects } from './GraphObjectsContext.js';

export interface ObjectCardProps {
  readonly object: ObjectWire;
  /** The ObjectType's declared identity keys (`list_types`), for the display name. */
  readonly identityKeys?: readonly string[];
  /** The instant freshness is judged against (ms). */
  readonly asOf: number;
  readonly testId?: string;
}

/** The search-result row (`ObjectSearch`): type · name · RefChip · freshness · last observed.
 *  Enter / Space / click focuses the Object (`DataRow`'s own keyboard path); the name is also a
 *  real link to the deep-linkable `?objectId=` hash. */
export function ObjectRow({
  object,
  identityKeys,
  asOf,
  onOpen,
  selected,
  testId,
}: ObjectCardProps & { readonly onOpen: (objectId: string) => void; readonly selected?: boolean }) {
  const { hrefFor } = useGraphObjects();
  const name = objectDisplayName(object, identityKeys);
  return (
    <DataRow
      leading={<span className="tag graph-type-tag">{object.objectType}</span>}
      title={
        <RefChip kind="object" id={object.id} name={name} href={hrefFor(object.id)} size="s" />
      }
      meta={
        <>
          <FreshnessChip input={{ lastObservedAt: object.lastObservedAt }} asOf={asOf} size="s" />
          <span className="meta-sep" title={formatDateTime(object.lastObservedAt)}>
            {object.lastObservedAt
              ? `观测 Observed ${formatRelative(object.lastObservedAt, asOf)}`
              : `更新 Updated ${formatRelative(object.updatedAt, asOf)}`}
          </span>
        </>
      }
      onSelect={() => onOpen(object.id)}
      selected={selected}
      testId={testId}
    />
  );
}

/**
 * components/graph/ObjectCard: the focused Object's header block on the graph page — type, name
 * (or the grey bare-id chip when the identity has nothing readable, §5.9 principle 3), freshness
 * from `lastObservedAt` (S5.2: an Object never expires, its clock only stops advancing), and the
 * identity key + current properties behind a disclosure (redacted like every params dump in the
 * console). `actions` is the header's right side (Refresh, As-of).
 */
export function ObjectCard({
  object,
  identityKeys,
  asOf,
  actions,
  testId,
}: ObjectCardProps & { readonly actions?: ReactNode }) {
  const name = objectDisplayName(object, identityKeys);
  const identityEntries = object.identityKey ? Object.entries(object.identityKey) : [];
  return (
    <section className="card graph-object-card" data-testid={testId} data-object-id={object.id}>
      <header className="graph-object-head">
        <div className="stack-s grow">
          <div className="row-wrap">
            <span className="tag graph-type-tag">{object.objectType}</span>
            <FreshnessChip
              input={{ lastObservedAt: object.lastObservedAt }}
              asOf={asOf}
              testId="graph-object-freshness"
            />
          </div>
          <h2 className="graph-object-title">
            {name ?? <span className="text-3">（无名称 unnamed）</span>}
          </h2>
          <RefChip kind="object" id={object.id} name={name} size="s" />
        </div>
        {actions !== undefined ? <div className="row-wrap">{actions}</div> : null}
      </header>
      <dl className="definition-list">
        <dt>最近观测 Last observed</dt>
        <dd>
          {object.lastObservedAt ? (
            <time title={formatDateTime(object.lastObservedAt)}>
              {formatRelative(object.lastObservedAt, asOf)}
            </time>
          ) : (
            <span className="text-3">无 Never</span>
          )}
        </dd>
        <dt>更新 Updated</dt>
        <dd>
          <time title={formatDateTime(object.updatedAt)}>
            {formatRelative(object.updatedAt, asOf)}
          </time>
        </dd>
        {identityEntries.length > 0 ? (
          <>
            <dt>身份 Identity</dt>
            <dd className="graph-identity">
              {identityEntries.map(([key, value]) => (
                <span key={key} className="graph-identity-pair">
                  <span className="text-3">{key}</span>
                  <span className="mono truncate" title={String(value)}>
                    {String(value)}
                  </span>
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      <details className="disclosure" data-testid="graph-object-properties">
        <summary>
          <Icon name="chevron-right" size="s" className="icon-chevron" />
          属性 Properties ({Object.keys(object.properties).length})
        </summary>
        <div className="disclosure-body">
          <pre className="code-block pre-wrap">
            {prettyJson(redactSensitive(object.properties))}
          </pre>
        </div>
      </details>
    </section>
  );
}
