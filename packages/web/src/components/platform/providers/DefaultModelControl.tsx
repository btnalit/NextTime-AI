import type { PlatformSettingsWire } from '@nexttime/shared';
import { useState } from 'react';
import {
  invalidateCapability,
  useCapability,
  useCapabilityList,
} from '../../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../../lib/clients.js';
import type { ModelRow } from '../../../lib/governance.js';
import { useT } from '../../../lib/i18n.js';
import { Card } from '../../ui/Card.js';
import { ErrorBanner } from '../../ui/ErrorBanner.js';
import { Field, Select } from '../../ui/Field.js';
import { Notice } from '../../ui/Notice.js';
import { SkeletonRows } from '../../ui/Skeleton.js';

export interface DefaultModelControlProps {
  readonly http: CapabilityCaller;
}

/** The select's "clear it" choice — `model: null` on the wire (pi's own default), which a
 *  `<select>` cannot carry as a value. */
const PI_DEFAULT = '__pi_default__';

/**
 * components/platform/providers/DefaultModelControl: 平台默认入口模型 Platform default entry
 * model (design §6.2; S7-E E5) — `set_platform_default_model`, validated against
 * `list_platform_models` (the same catalog `list_runtime_images`'s sibling pages read from,
 * never a free-text box: `PlatformSettingsPage` used to have one and pointed here after the
 * generic `update_platform_settings` patch stopped accepting `defaultEntryModel`, see that page's
 * own hint). Mounted on 模型与供应商 (`PlatformModelsPage`) rather than 平台设置 because the
 * catalog this select validates against lives in the same place the providers themselves are
 * managed — picking a model here can never name one the page's own provider table does not show.
 *
 * Uses `useCapability`/`useCapabilityList` (kernel capabilities) rather than `PlatformModelsPage`'s
 * own `LlmAdminClient` — `get_platform_settings` and `list_platform_models` are both
 * `scope:'platform'` capabilities, not llm-proxy admin endpoints, so this control goes through the
 * normal `http` prop like every other governance page.
 */
export function DefaultModelControl({ http }: DefaultModelControlProps) {
  const t = useT();
  const settings = useCapability<PlatformSettingsWire>(http, 'get_platform_settings');
  const models = useCapabilityList<ModelRow>(http, 'list_platform_models');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleChange(value: string): Promise<void> {
    const model = value === PI_DEFAULT ? null : value;
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const next = await http.call<PlatformSettingsWire>('set_platform_default_model', { model });
      invalidateCapability(http, 'get_platform_settings');
      settings.mutate(() => next);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const catalog = models.state.status === 'ready' ? models.state.data.items : [];

  return (
    <Card title={t('平台默认入口模型', 'Platform default entry model')}>
      <div className="stack-s">
        <p className="text-3 text-small">
          {t(
            "新工作区（未显式指定入口模型时）与新用户的 AgentProfile 取它；留空 = 用 pi 自己的默认值。 New workspaces (when no explicit entry model is given) and new users' AgentProfiles take this; empty =",
            "pi's own default.",
          )}
        </p>
        {settings.state.status === 'loading' ? (
          <SkeletonRows
            count={1}
            label="Loading the default model"
            testId="platform-default-model-loading"
          />
        ) : settings.state.status === 'error' ? (
          <ErrorBanner
            error={settings.state.error}
            title="Could not load the platform settings"
            onRetry={() => void settings.reload()}
            testId="platform-default-model-load-error"
          />
        ) : (
          <Field id="platform-default-model" label={t('默认入口模型', 'Default model')}>
            <Select
              id="platform-default-model"
              value={settings.state.data.defaultEntryModel ?? PI_DEFAULT}
              onChange={(event) => void handleChange(event.target.value)}
              disabled={submitting}
              data-testid="platform-default-model-select"
            >
              <option value={PI_DEFAULT}>{t('pi 自己的默认值', "pi's own default")}</option>
              {catalog.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {saved ? (
          <Notice testId="platform-default-model-saved">{t('已保存', 'Saved')}</Notice>
        ) : null}
        {error !== null ? (
          <ErrorBanner
            error={error}
            title={t('无法保存默认入口模型', 'Could not save the default entry model')}
            testId="platform-default-model-error"
          />
        ) : null}
      </div>
    </Card>
  );
}
