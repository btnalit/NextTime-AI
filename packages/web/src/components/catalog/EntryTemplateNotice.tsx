import type {
  EntryTemplateField,
  EntryTemplateStatusWire,
  EntryTemplateUpgradeWire,
  WorkerDefinitionWire,
} from '@nexttime/shared';
import { useEffect, useRef, useState } from 'react';
import type { Resource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import { actionHint, actionLabel } from '../../lib/capability-labels.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import {
  type TextDiffLine,
  capabilityChanges,
  entryCapabilitiesOf,
  entryPromptOf,
  lineDiff,
} from '../../lib/entry-template.js';
import { describeError } from '../../lib/errors.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { Button } from '../kit/button.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { SkeletonRows } from '../kit/skeleton.js';

/**
 * components/catalog/EntryTemplateNotice (legacy 145): on the catalog's entry definition, whether
 * the version the entry agent runs with has the prompt and capabilities of the entry template
 * this platform release ships (`get_entry_template_status`). When it does not: what differs, the
 * difference itself (the capabilities first, by what each does, then the prompt line by line) so
 * whoever adopts it sees what it replaces, and 「按平台模板生成新版本草稿」
 * (`propose_entry_template_upgrade`) — a draft only; the owner publishes it like any other entry
 * version, and nothing changes until then. On an entry draft, `EntryDraftChanges` says what
 * publishing it changes against the version in use.
 */

export type EntryTemplateStatusResource = Resource<EntryTemplateStatusWire | null>;

function fieldsText(differs: readonly EntryTemplateField[], t: Translate): string {
  return differs
    .map((field) =>
      field === 'systemPrompt' ? t('系统提示词', 'system prompt') : t('能力', 'capabilities'),
    )
    .join(t('、', ', '));
}

/** The status, when it is about `definitionId@version` and something differs. */
function outdated(
  status: EntryTemplateStatusResource,
  ref?: { readonly id: string; readonly version: number },
): EntryTemplateStatusWire | null {
  if (status.state.status !== 'ready' || status.state.data === null) return null;
  const data = status.state.data;
  if (data.current === null || data.differs.length === 0) return null;
  if (ref && (data.current.definitionId !== ref.id || data.current.version !== ref.version)) {
    return null;
  }
  return data;
}

/** The list's line under the entry definition: only when the template differs. */
export function EntryTemplateSummary({
  status,
  onOpen,
}: {
  readonly status: EntryTemplateStatusResource;
  /** Opens the entry version the status compares (`id@version`), where the full notice is. */
  readonly onOpen: (ref: { readonly id: string; readonly version: number }) => void;
}) {
  const t = useT();
  const data = outdated(status);
  if (!data?.current) return null;
  const current = data.current;
  return (
    <Notice tone="warn" testId="entry-template-summary">
      <p>
        {t(
          `当前生效的入口定义 v${current.version} 的${fieldsText(data.differs, t)}与这个平台版本自带的入口模板不同。`,
          `The ${fieldsText(data.differs, t)} of v${current.version}, the entry definition in use, differ from the entry template this platform release ships.`,
        )}
      </p>
      <Button
        variant="ghost"
        size="s"
        onClick={() => onOpen({ id: current.definitionId, version: current.version })}
        data-testid="entry-template-summary-open"
      >
        {t('查看差异', 'See the difference')}
      </Button>
    </Notice>
  );
}

/** The detail's notice, on the published entry version `row`. */
export function EntryTemplateNotice({
  http,
  status,
  row,
  onProposed,
}: {
  readonly http: CapabilityCaller;
  readonly status: EntryTemplateStatusResource;
  readonly row: Pick<WorkerDefinitionWire, 'id' | 'version' | 'definition'>;
  /** The draft the call returned (`created: false`: the caller's own identical one). */
  readonly onProposed: (upgrade: EntryTemplateUpgradeWire) => void;
}) {
  const t = useT();
  const can = useRoleCan(http);
  const canPropose = can('propose_entry_template_upgrade') !== false;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (status.state.status === 'loading') return <SkeletonRows count={1} />;
  if (status.state.status === 'error') {
    return <InlineError error={status.state.error} testId="entry-template-error" />;
  }
  const data = status.state.data;
  if (data === null || data.current === null) return null;
  if (data.current.definitionId !== row.id || data.current.version !== row.version) return null;
  if (data.differs.length === 0) {
    return (
      <p className="text-3 text-small" data-testid="entry-template-current">
        {t(
          '与这个平台版本自带的入口模板一致。',
          'Matches the entry template this platform release ships.',
        )}
      </p>
    );
  }
  const current = data.current;

  async function propose(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const upgrade = await http.call<EntryTemplateUpgradeWire>('propose_entry_template_upgrade', {
        templateDigest: data?.template.digest,
        basedOn: { definitionId: current.definitionId, version: current.version },
      });
      onProposed(upgrade);
    } catch (err) {
      setError(err);
      const code = describeError(err).code;
      // What was compared moved: read it again, so the notice shows what is there now.
      if (code === 'entry_template_changed' || code === 'entry_template_current') {
        void status.reload();
      }
    } finally {
      setBusy(false);
    }
  }

  const changes = capabilityChanges(
    entryCapabilitiesOf(row.definition),
    data.template.capabilities,
  );

  return (
    <div className="stack-s" data-testid="entry-template-notice">
      <Notice tone="warn">
        <p>
          <strong>
            {t('与平台自带的入口模板不同', 'Differs from the platform’s entry template')}
          </strong>
        </p>
        <p>
          {t(
            `当前生效的 v${current.version} 与这个平台版本自带的入口模板不同：${fieldsText(data.differs, t)}。平台升级会带来新模板，但已有工作区的入口定义不会跟着变；在这里改过入口定义也会显示不同。按模板生成新版本草稿不会改变正在用的入口 agent，草稿由所有者发布后才生效。`,
            `v${current.version}, the one in use, differs from the entry template this release ships: ${fieldsText(data.differs, t)}. A platform upgrade brings a new template but leaves an existing workspace’s entry definition as it is, and edits made here also show as a difference. A draft from the template changes nothing the entry agent runs with; it takes effect once the owner publishes it.`,
          )}
        </p>
        <p>
          {t(
            `如果在这里改过${fieldsText(data.differs, t)}，新草稿会用平台模板替换这些改动；发布前可以在草稿里再改。`,
            `If you edited the ${fieldsText(data.differs, t)} here, the draft replaces those edits with the template; you can edit the draft again before publishing it.`,
          )}
        </p>
      </Notice>
      {data.differs.includes('capabilities') ? (
        <div className="stack-s" data-testid="entry-template-capability-diff">
          <span className="section-title">{t('能力的变化', 'Capability changes')}</span>
          <p className="text-small text-3">
            {t(
              `按模板生成的草稿发布后，入口 agent 能做的事与 v${current.version} 相比：`,
              `Once a draft from the template is published, what the entry agent may do, against v${current.version}:`,
            )}
          </p>
          <CapabilityChangeList added={changes.added} removed={changes.removed} />
        </div>
      ) : null}
      {data.differs.includes('systemPrompt') ? (
        <details className="disclosure" data-testid="entry-template-diff">
          <summary>{t('查看系统提示词差异', 'See the system prompt’s difference')}</summary>
          <div className="disclosure-body stack-s">
            <span className="text-small text-3">
              {t(
                `− 是 v${current.version} 里有、模板里没有的行，+ 是模板新加的行`,
                `− lines are in v${current.version} and not in the template, + lines are the template’s new ones`,
              )}
            </span>
            <TextDiff
              lines={lineDiff(entryPromptOf(row.definition), data.template.systemPrompt)}
              testId="entry-template-prompt-diff"
            />
          </div>
        </details>
      ) : null}
      {canPropose ? (
        <div className="row-wrap">
          <Button
            variant="primary"
            size="s"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void propose()}
            data-testid="entry-template-propose"
          >
            {t('按平台模板生成新版本草稿', 'Propose a new version from the template')}
          </Button>
        </div>
      ) : (
        <p className="text-3 text-small" data-testid="entry-template-propose-role">
          {t(
            '生成草稿需要构建者或所有者；请他们在这里生成，再由所有者发布。',
            'Proposing the draft needs a builder or the owner; ask one of them to do it here, then the owner publishes it.',
          )}
        </p>
      )}
      <InlineError error={error} testId="entry-template-propose-error" />
    </div>
  );
}

/**
 * A line-by-line comparison. Legacy 471: a run of unchanged lines folded away opens in place, so
 * the context around a change can be read without leaving the comparison. Legacy 479: the button
 * goes away as the lines open, so focus moves to the first line it opened, not back to the page.
 */
function TextDiff({
  lines,
  testId,
}: {
  readonly lines: readonly TextDiffLine[];
  readonly testId: string;
}) {
  const t = useT();
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const [justOpened, setJustOpened] = useState<number | null>(null);
  const firstOpenedLine = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (justOpened === null) return;
    firstOpenedLine.current?.focus();
  }, [justOpened]);
  return (
    <pre className="code-block pre-wrap text-diff" data-testid={testId}>
      {lines.map((line, index) => {
        if (line.change !== 'gap') {
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
              key={index}
              className="text-diff-line"
              data-change={line.change}
            >
              {line.change === 'added' ? '+ ' : line.change === 'removed' ? '− ' : '  '}
              {line.text}
            </span>
          );
        }
        if (opened.has(index)) {
          return line.lines.map((text, offset) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
              key={`${index}-${offset}`}
              ref={index === justOpened && offset === 0 ? firstOpenedLine : undefined}
              tabIndex={index === justOpened && offset === 0 ? -1 : undefined}
              className="text-diff-line"
              data-change="same"
              data-opened=""
            >
              {'  '}
              {text}
            </span>
          ));
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
          <span key={index} className="text-diff-line" data-change="gap">
            <Button
              variant="ghost"
              size="s"
              onClick={() => {
                setOpened((prev) => new Set(prev).add(index));
                setJustOpened(index);
              }}
              data-testid={`${testId}-open-gap`}
            >
              {t(
                `… ${line.lines.length} 行未变，点开查看 …`,
                `… ${line.lines.length} unchanged lines, open to read …`,
              )}
            </Button>
          </span>
        );
      })}
    </pre>
  );
}

/**
 * UX acceptance of #747 (P2-1): the capabilities a change adds and takes out — what the entry
 * agent may newly do is the part of the change that grants something, so each reads as what it
 * does first, with the registry name a builder recognizes from docs and errors as secondary text,
 * then its one-line description.
 */
function CapabilityChangeList({
  added,
  removed,
}: {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}) {
  const t = useT();
  const group = (names: readonly string[], change: 'added' | 'removed', heading: string) =>
    names.length === 0 ? null : (
      <div className="stack-s" data-testid={`capability-changes-${change}`}>
        <strong className="text-small">{heading}</strong>
        <ul className="capability-change-list">
          {names.map((name) => {
            const label = actionLabel(name, t);
            const hint = actionHint(name, t);
            return (
              <li key={name} data-change={change} data-capability={name}>
                <span className="wrap-anywhere">
                  {change === 'added' ? '+ ' : '− '}
                  {label}
                  {label !== name ? (
                    <>
                      {' '}
                      <span className="mono text-3 text-small">{name}</span>
                    </>
                  ) : null}
                </span>
                {hint !== null ? <span className="text-3 text-small">{hint}</span> : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <div className="stack-s">
      {group(added, 'added', t(`新增 ${added.length} 项能力`, `${added.length} added`))}
      {group(removed, 'removed', t(`去掉 ${removed.length} 项能力`, `${removed.length} taken out`))}
    </div>
  );
}

/**
 * UX acceptance of #747 (P2-1): on an entry draft, next to Publish, what publishing it changes
 * against `inUse` — the entry version the entry agent runs with now (the one
 * `get_entry_template_status` names): the capabilities it adds and takes out, and whether the
 * system prompt differs. Any entry draft, not only one made from the template: publishing one is
 * how the entry agent gains or loses a capability.
 */
export function EntryDraftChanges({
  draft,
  inUse,
}: {
  readonly draft: Pick<WorkerDefinitionWire, 'definition'>;
  readonly inUse: Pick<WorkerDefinitionWire, 'version' | 'definition'>;
}) {
  const t = useT();
  const changes = capabilityChanges(
    entryCapabilitiesOf(inUse.definition),
    entryCapabilitiesOf(draft.definition),
  );
  const capabilitiesDiffer = changes.added.length + changes.removed.length > 0;
  const promptDiffers = entryPromptOf(inUse.definition) !== entryPromptOf(draft.definition);
  return (
    <div className="stack-s" data-testid="entry-draft-changes">
      {/* Not `.section-title`: its uppercase would print the version as “V2”. */}
      <strong className="text-small">
        {t(`与当前生效的 v${inUse.version} 相比`, `Against v${inUse.version}, the version in use`)}
      </strong>
      {capabilitiesDiffer ? (
        <>
          <p className="text-small text-3">
            {t(
              '发布后，入口 agent 能做的事会这样变：',
              'Once published, what the entry agent may do changes like this:',
            )}
          </p>
          <CapabilityChangeList added={changes.added} removed={changes.removed} />
        </>
      ) : (
        <p className="text-small" data-testid="entry-draft-capabilities-same">
          {t('能力相同。', 'Same capabilities.')}
        </p>
      )}
      <p className="text-small" data-testid="entry-draft-prompt-change">
        {promptDiffers
          ? t(
              '系统提示词有改动，见下面的定义。',
              'The system prompt differs; see the definition below.',
            )
          : t('系统提示词相同。', 'Same system prompt.')}
      </p>
    </div>
  );
}
