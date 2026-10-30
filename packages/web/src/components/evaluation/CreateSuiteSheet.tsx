import type { EvalSuiteWire } from '@nexttime/shared';
import { useState } from 'react';
import { useRoleCan } from '../../hooks/useRoleCan.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { describeError } from '../../lib/errors.js';
import type { WorkerChoice } from '../../lib/evaluation.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Button } from '../kit/button.js';
import { GuardedCancelButton } from '../kit/discard-guard.js';
import { Field, describedBy } from '../kit/field.js';
import { InlineError } from '../kit/inline-error.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { Select } from '../kit/select.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../kit/sheet.js';
import { StillNeeded } from '../kit/still-needed.js';
import { Textarea } from '../kit/textarea.js';

export interface CreateSuiteSheetProps {
  readonly http: CapabilityCaller;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The published worker-kind definitions a suite can pin (`lib/evaluation` `workerChoices`);
   *  `undefined` while they load. */
  readonly workers: readonly WorkerChoice[] | undefined;
  readonly onCreated: (suite: EvalSuiteWire) => void;
}

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;

/**
 * components/evaluation/CreateSuiteSheet (S10 E3-1a): 新建用例集 — a name, an optional description,
 * and the Worker version it pins, picked from the published worker-kind definitions (never a typed
 * id). A name another suite of the workspace already has (case ignored) is refused on the name
 * field (409 `eval_suite_name_taken`); text that looks like a credential or still holds the mask
 * is refused as everywhere else (400 `credentials_in_text` / `redacted_text_submitted`).
 */
export function CreateSuiteSheet({
  http,
  open,
  onOpenChange,
  workers,
  onCreated,
}: CreateSuiteSheetProps) {
  const t = useT();
  const can = useRoleCan(http);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [version, setVersion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const worker = workers?.find((choice) => choice.id === workerId);
  const trimmedName = name.trim();
  const nameTaken = error !== null && describeError(error).code === 'eval_suite_name_taken';
  const missing = [
    trimmedName === '' ? t('填写名字', 'enter a name') : null,
    worker === undefined ? t('选择 Worker', 'choose a Worker') : null,
    worker !== undefined && version === '' ? t('选择版本', 'choose a version') : null,
  ].filter((item): item is string => item !== null);

  function reset(): void {
    setName('');
    setDescription('');
    setWorkerId('');
    setVersion('');
    setError(null);
  }

  function close(): void {
    reset();
    onOpenChange(false);
  }

  async function submit(): Promise<void> {
    if (worker === undefined || missing.length > 0 || can('create_eval_suite') === false) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmedDescription = description.trim();
      const suite = await http.call<EvalSuiteWire>('create_eval_suite', {
        name: trimmedName,
        ...(trimmedDescription !== '' ? { description: trimmedDescription } : {}),
        workerDefinitionId: worker.id,
        workerDefinitionVersion: Number(version),
      });
      reset();
      onCreated(suite);
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => !submitting && (next ? onOpenChange(true) : close())}
    >
      <SheetContent data-testid="eval-suite-create" data-discard-guard>
        <SheetHeader>
          <SheetTitle>{t('新建用例集', 'New evaluation suite')}</SheetTitle>
          <SheetDescription>
            {t(
              '用例集钉住一个已发布的 Worker 版本。新建后再把它要用的门冻结成夹具门；用例集的内容只给人看，智能体读不到。',
              'A suite pins a published Worker version. Freeze the gates it uses as fixture gates once it exists; a suite is shown to people only, never to an agent.',
            )}
          </SheetDescription>
        </SheetHeader>

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            id="eval-suite-name"
            label={t('名字', 'Name')}
            required
            hint={
              nameTaken
                ? undefined
                : t('工作区里唯一，不区分大小写。', 'Unique in the workspace, case ignored.')
            }
            error={
              nameTaken
                ? t(
                    '工作区里已经有同名的用例集，换一个名字。',
                    'The workspace already has a suite by this name; choose another.',
                  )
                : null
            }
          >
            <input
              id="eval-suite-name"
              className="input"
              value={name}
              maxLength={NAME_MAX}
              onChange={(event) => {
                setName(event.target.value);
                if (nameTaken) setError(null);
              }}
              disabled={submitting}
              aria-invalid={nameTaken || undefined}
              aria-describedby={describedBy('eval-suite-name', !nameTaken, nameTaken)}
              data-testid="eval-suite-create-name"
            />
          </Field>

          <Field
            id="eval-suite-description"
            label={t('说明', 'Description')}
            hint={t('可选：这组用例要验证什么。', 'Optional: what these cases check.')}
          >
            <Textarea
              id="eval-suite-description"
              aria-label={t('说明', 'Description')}
              value={description}
              maxLength={DESCRIPTION_MAX}
              minRows={3}
              onChange={(event) => setDescription(event.target.value)}
              disabled={submitting}
              data-testid="eval-suite-create-description"
            />
          </Field>

          {workers !== undefined && workers.length === 0 ? (
            <Notice tone="warn" testId="eval-suite-create-no-workers">
              {t(
                '工作区里还没有已发布的 Worker，用例集没有可钉住的版本。',
                'The workspace has no published Worker yet, so there is no version to pin.',
              )}{' '}
              <RouteLink href={hrefs.catalog('workers')}>
                {t('到能力目录发布一个', 'Publish one in the catalog')}
              </RouteLink>
            </Notice>
          ) : (
            <div className="row-wrap" style={{ alignItems: 'flex-start' }}>
              <Field id="eval-suite-worker" label={t('Worker', 'Worker')} required>
                <Select
                  id="eval-suite-worker"
                  aria-label={t('Worker', 'Worker')}
                  value={workerId}
                  disabled={submitting || workers === undefined}
                  onChange={(event) => {
                    const next = workers?.find((choice) => choice.id === event.target.value);
                    setWorkerId(event.target.value);
                    // The newest published version is the usual pick.
                    setVersion(next?.versions[0] !== undefined ? String(next.versions[0]) : '');
                  }}
                  data-testid="eval-suite-create-worker"
                >
                  <option value="">
                    {workers === undefined
                      ? t('加载中…', 'Loading…')
                      : t('选择 Worker', 'Choose a Worker')}
                  </option>
                  {(workers ?? []).map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="eval-suite-version" label={t('版本', 'Version')} required>
                <Select
                  id="eval-suite-version"
                  aria-label={t('版本', 'Version')}
                  value={version}
                  disabled={submitting || worker === undefined}
                  onChange={(event) => setVersion(event.target.value)}
                  data-testid="eval-suite-create-version"
                >
                  {worker === undefined ? <option value="">—</option> : null}
                  {(worker?.versions ?? []).map((v, index) => (
                    <option key={v} value={String(v)}>
                      {index === 0 ? t(`v${v}（最新）`, `v${v} (latest)`) : `v${v}`}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          {error !== null && !nameTaken ? (
            <InlineError error={error} testId="eval-suite-create-error" />
          ) : null}
        </form>

        <SheetFooter>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={missing.length > 0 || submitting}
            aria-busy={submitting || undefined}
            data-testid="eval-suite-create-submit"
          >
            {t('新建', 'Create')}
          </Button>
          <GuardedCancelButton variant="ghost" onCancel={close} disabled={submitting}>
            {t('取消', 'Cancel')}
          </GuardedCancelButton>
          <StillNeeded items={missing} hidden={submitting} testId="eval-suite-create-missing" />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
