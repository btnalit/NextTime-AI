import { useState } from 'react';
import type { CapabilityCaller } from '../../lib/clients.js';
import { actionKindTagText } from '../../lib/format.js';
import {
  type OperationChoice,
  confirmsAbsence,
  useGateOperations,
} from '../../lib/gate-operations.js';
import type { GatekeeperListRow } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { transportKindLabel } from '../../lib/labels.js';
import { hrefs } from '../../lib/router.js';
import { sameNameIds, withSameNameId } from '../../lib/same-name.js';
import { BLAST_RADIUS_TONES } from '../../lib/status-tone.js';
import { Button } from '../kit/button.js';
import { Combobox } from '../kit/combobox.js';
import { Field } from '../kit/field.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';
import { Select } from '../kit/select.js';

/** The note beside an Operation in the picker: its declared blast radius. */
function operationSecondary(choice: OperationChoice, t: Translate): string | undefined {
  if (choice.blastRadius === null) return undefined;
  const label = BLAST_RADIUS_TONES[choice.blastRadius].label;
  return typeof label === 'string' ? label : t(label.zh, label.en);
}

/**
 * A gate + one of its Operations — an `operation` step's (console-ux-2), and since legacy 453 the
 * gate a `verify` step's check observes: the Operation is chosen from the picked
 * gate's published Operations (`lib/gate-operations.ts`) instead of typed, so a typo can no longer
 * save a step that fails at publish. "手动输入" stays as a fallback — and is what renders while the
 * gate directory is unavailable (typed gate id), the list fails to load or is empty, or a
 * prefilled name is not on the list (a copied step whose Operation has since changed).
 */
export function OperationStepFields({
  http,
  prefix,
  gatekeeperId,
  operationName,
  testPrefix = 'procedure-step',
  gateLabel,
  gatekeepers,
  busy,
  gateError,
  operationError,
  absence = false,
  onChange,
}: {
  readonly http: CapabilityCaller;
  readonly prefix: string;
  readonly gatekeeperId: string;
  readonly operationName: string;
  /** Where the test ids start (`procedure-step-operation`, …). */
  readonly testPrefix?: string;
  readonly gateLabel?: string;
  readonly gatekeepers?: readonly GatekeeperListRow[];
  readonly busy: boolean;
  readonly gateError: string | null;
  readonly operationError: string | null;
  /** S11 「门确认不存在」 B: an absence check's Operation — only the gate's Operations that declare
   *  which answers mean "does not exist", confirmed when published ({@link confirmsAbsence}), are
   *  offered. */
  readonly absence?: boolean;
  readonly onChange: (patch: {
    readonly gatekeeperId?: string;
    readonly operationName?: string;
  }) => void;
}) {
  const t = useT();
  const [manualChosen, setManualChosen] = useState(false);
  const hasDirectory = gatekeepers !== undefined && gatekeepers.length > 0;
  const gateSame = sameNameIds(
    gatekeepers,
    (row) => row.id,
    (row) => row.name,
  );
  const gate = gatekeepers?.find((row) => row.id === gatekeeperId);
  // Only a gate from the directory is queried — a half-typed id would be a 400 per keystroke.
  const operations = useGateOperations(
    http,
    gate ? { gatekeeperId: gate.id } : null,
    absence ? confirmsAbsence : undefined,
  );
  const choices: readonly OperationChoice[] =
    operations.state.status === 'ready' ? operations.state.choices : [];
  const name = operationName.trim();
  const listUnavailable =
    operations.state.status === 'error' ||
    (operations.state.status === 'ready' && choices.length === 0);
  const notOnList =
    operations.state.status === 'ready' &&
    name !== '' &&
    !choices.some((choice) => choice.name === name);
  const manual = !hasDirectory || manualChosen || listUnavailable || notOnList;

  return (
    <div className="stack-s">
      <div className="row-wrap">
        <Field
          id={`${prefix}-gatekeeper`}
          label={gateLabel ?? t('门', 'Gate')}
          required
          error={gateError}
        >
          {hasDirectory ? (
            <Select
              id={`${prefix}-gatekeeper`}
              aria-label={gateLabel ?? t('门', 'Gate')}
              value={gatekeeperId}
              onChange={(event) =>
                // A name picked from the previous gate's list may not exist on the new one; a
                // typed name is the person's own and stays.
                onChange({
                  gatekeeperId: event.target.value,
                  ...(manual ? {} : { operationName: '' }),
                })
              }
              disabled={busy}
            >
              <option value="">{t('选择一个门…', 'Choose a gate…')}</option>
              {gatekeepers.map((row) => (
                <option key={row.id} value={row.id}>
                  {withSameNameId(row.name, row.id, gateSame)} · {transportKindLabel(row.kind, t)}
                </option>
              ))}
            </Select>
          ) : (
            <input
              className="input input-mono"
              id={`${prefix}-gatekeeper`}
              value={gatekeeperId}
              onChange={(event) => onChange({ gatekeeperId: event.target.value })}
              onBlur={() => onChange({ gatekeeperId: gatekeeperId.trim() })}
              disabled={busy}
            />
          )}
        </Field>
        <Field
          id={`${prefix}-operation`}
          label={t('Operation 名', 'Operation')}
          required
          error={operationError}
          hint={
            manual
              ? t(
                  '手动输入：与门发布的 Operation 名完全一致（区分大小写）。',
                  'Manual entry: the Operation name exactly as the gate publishes it (case-sensitive).',
                )
              : undefined
          }
        >
          {manual ? (
            <input
              className="input input-mono"
              id={`${prefix}-operation`}
              value={operationName}
              onChange={(event) => onChange({ operationName: event.target.value })}
              onBlur={() => onChange({ operationName: operationName.trim() })}
              disabled={busy}
              aria-invalid={!!operationError || notOnList || undefined}
              data-testid={`${testPrefix}-operation-input`}
            />
          ) : (
            // console-ux-3: a gate imported from OpenAPI can publish hundreds of Operations —
            // searchable instead of a native select.
            <Combobox
              id={`${prefix}-operation`}
              options={choices.map((choice) => ({
                value: choice.name,
                label: actionKindTagText(choice.name),
                secondary: operationSecondary(choice, t),
              }))}
              value={operationName}
              onChange={(operationName) => onChange({ operationName })}
              loading={operations.state.status === 'loading'}
              disabled={busy || operations.state.status === 'idle'}
              invalid={!!operationError}
              mono
              placeholder={
                operations.state.status === 'idle'
                  ? t('先选择门', 'Choose a gate first')
                  : operations.state.status === 'loading'
                    ? t('正在加载 Operation…', 'Loading Operations…')
                    : t('输入以搜索 Operation…', 'Type to search Operations…')
              }
              testId={`${testPrefix}-operation`}
            />
          )}
        </Field>
      </div>
      {operations.state.status === 'error' ? (
        <Notice tone="warn" testId={`${testPrefix}-operations-error`}>
          {t(
            '无法加载这个门的 Operation 列表，已切换为手动输入。',
            'Could not load this gate’s Operations — switched to manual entry.',
          )}{' '}
          <Button variant="ghost" size="s" onClick={operations.reload}>
            {t('重试', 'Retry')}
          </Button>
        </Notice>
      ) : null}
      {gate && operations.state.status === 'ready' && choices.length === 0 ? (
        absence ? (
          <span className="text-3 text-small" data-testid={`${testPrefix}-operations-empty`}>
            {t(
              `门「${gate.name}」上没有能确认“不存在”的 Operation：要用的 Operation 得声明哪些回答表示要查的东西不存在，并在发布时有人确认过门用的凭据看得到要查的东西。`,
              `Gate “${gate.name}” has no Operation that can confirm something is not there: the Operation must declare which answers mean the thing looked up does not exist, and someone must have confirmed at publish that the gate’s credentials can see what it looks up.`,
            )}{' '}
            <RouteLink href={hrefs.catalog('operations')}>
              {t('到能力目录声明并确认', 'Declare and confirm it in the catalog')}
            </RouteLink>
          </span>
        ) : (
          <span className="text-3 text-small" data-testid={`${testPrefix}-operations-empty`}>
            {t(
              `门「${gate.name}」还没有已发布的 Operation，请手动输入名称。`,
              `Gate “${gate.name}” has no published Operation yet — type the name manually.`,
            )}
          </span>
        )
      ) : null}
      {gate && notOnList && (absence || choices.length > 0) ? (
        <Notice tone="warn" testId={`${testPrefix}-unknown-operation`}>
          {absence
            ? t(
                `门「${gate.name}」上的「${actionKindTagText(name)}」没有发布、没有声明哪些回答表示不存在，或者发布时没人确认过；发布这个流程时会失败。`,
                `On gate “${gate.name}”, “${actionKindTagText(name)}” is not published, declares no answer that means "not there", or nobody confirmed it at publish; publishing this Procedure would fail.`,
              )
            : t(
                `门「${gate.name}」上没有已发布的「${actionKindTagText(name)}」；发布这个流程时会失败。请从列表选择，或检查拼写。`,
                `Gate “${gate.name}” publishes no “${actionKindTagText(name)}”; publishing this Procedure would fail. Choose from the list or check the spelling.`,
              )}
        </Notice>
      ) : null}
      {gate && choices.length > 0 ? (
        <div>
          <Button
            variant="ghost"
            size="s"
            disabled={busy}
            onClick={() => {
              if (manual) {
                setManualChosen(false);
                if (notOnList) onChange({ operationName: '' });
              } else {
                setManualChosen(true);
              }
            }}
            data-testid={`${testPrefix}-operation-mode`}
          >
            {manual ? t('从列表选择', 'Choose from the list') : t('手动输入', 'Type it manually')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
