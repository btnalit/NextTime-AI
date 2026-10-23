import type {
  EntryTemplateField,
  EntryTemplateStatusWire,
  EntryTemplateUpgradeWire,
  WorkerDefinitionWire,
} from '@nexttime/shared';
import { useState } from 'react';
import type { Resource } from '../../hooks/useResource.js';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { capabilityChanges, lineDiff } from '../../lib/entry-template.js';
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
 * difference itself (the prompt line by line, the capabilities by name) so whoever adopts it sees
 * what it replaces, and 「按平台模板生成新版本草稿」 (`propose_entry_template_upgrade`) — a draft
 * only; the owner publishes it like any other entry version, and nothing changes until then.
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

  const prompt = typeof row.definition.systemPrompt === 'string' ? row.definition.systemPrompt : '';
  const capabilities = Array.isArray(row.definition.capabilities)
    ? row.definition.capabilities.map(String)
    : [];
  const changes = capabilityChanges(capabilities, data.template.capabilities);

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
            '如果改过入口说明，新草稿会用平台模板替换这些改动；发布前可以在草稿里再改。',
            'If the entry prompt was edited here, the draft replaces those edits with the template; you can edit the draft again before publishing it.',
          )}
        </p>
      </Notice>
      <details className="disclosure" data-testid="entry-template-diff">
        <summary>{t('查看差异', 'See the difference')}</summary>
        <div className="disclosure-body">
          {data.differs.includes('systemPrompt') ? (
            <div className="stack-s">
              <span className="text-small text-3">
                {t(
                  `系统提示词：− 是 v${current.version} 里有、模板里没有的行，+ 是模板新加的行`,
                  `System prompt: − lines are in v${current.version} and not in the template, + lines are the template’s new ones`,
                )}
              </span>
              <pre
                className="code-block pre-wrap text-diff"
                data-testid="entry-template-prompt-diff"
              >
                {lineDiff(prompt, data.template.systemPrompt).map((line, index) =>
                  line.change === 'gap' ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
                    <span key={index} className="text-diff-line" data-change="gap">
                      {t(`… ${line.count} 行未变 …`, `… ${line.count} unchanged lines …`)}
                    </span>
                  ) : (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity of their own
                      key={index}
                      className="text-diff-line"
                      data-change={line.change}
                    >
                      {line.change === 'added' ? '+ ' : line.change === 'removed' ? '− ' : '  '}
                      {line.text}
                    </span>
                  ),
                )}
              </pre>
            </div>
          ) : null}
          {data.differs.includes('capabilities') ? (
            <ul className="stack-s text-small" data-testid="entry-template-capability-diff">
              {changes.added.length > 0 ? (
                <li>
                  {t('模板新增的能力：', 'Capabilities the template adds: ')}
                  <span className="mono">{changes.added.join(', ')}</span>
                </li>
              ) : null}
              {changes.removed.length > 0 ? (
                <li>
                  {t('模板去掉的能力：', 'Capabilities the template takes out: ')}
                  <span className="mono">{changes.removed.join(', ')}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      </details>
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
