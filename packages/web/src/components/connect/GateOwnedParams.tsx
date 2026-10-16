import type {
  GateOwnedParamDraftWire,
  GateOwnedParamWire,
  PublishManifestResultWire,
} from '@nexttime/shared';
import { operationKey } from '../../lib/governance.js';
import { type Translate, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';

/**
 * components/connect/GateOwnedParams (console G4, legacy 219): what a reader sees about an
 * Operation the gate's manifest declares with a param only the gate sets (legacy J) — a header that
 * says who is calling or where the call goes, a credential in the query string, a cookie, or a query
 * parameter the call address already fixes. The gate refuses that param on every call, so the
 * kernel never publishes such a definition: a bulk publish (`enable_gate_instance`,
 * `publish_manifest`) leaves it a draft and reports it in `gateOwnedParamDrafts`, and the catalog row
 * carries `gateOwnedParams`. One wording for every place that says so.
 *
 * Only the gate's maintainer can fix it, by dropping the params from the gate's manifest. What
 * follows depends on the gate: for a platform gate the workspace's 「与门公告对齐」 then rewrites
 * the held draft to the new announcement (`refresh_operation_governance`); a gate the workspace
 * connected itself has no in-place re-sync yet, so it has to be connected again.
 */

const LOCATION_LABEL: Readonly<Record<GateOwnedParamWire['location'], { zh: string; en: string }>> =
  {
    header: { zh: '请求头', en: 'header' },
    query: { zh: '查询参数里的凭据', en: 'credential in the query' },
    cookie: { zh: 'cookie', en: 'cookie' },
    binding: { zh: '调用地址已固定的查询参数', en: 'query parameter the call address fixes' },
  };

/** 「Authorization（请求头）、access_token（查询参数里的凭据）」 */
export function gateOwnedParamsText(params: readonly GateOwnedParamWire[], t: Translate): string {
  return params
    .map((entry) => {
      const label = LOCATION_LABEL[entry.location];
      return t(`${entry.param}（${label.zh}）`, `${entry.param} (${label.en})`);
    })
    .join(t('、', ', '));
}

/** Which next step applies: a platform gate re-syncs through align, a self-connected one does not.
 *  `align-here`: the same as `align`, said next to the one-draft rewrite button itself (the
 *  catalog), so the reader is not sent to another page for it (UX acceptance of #567 P3). */
export type GateOwnedParamsFix = 'align' | 'align-here' | 'reconnect' | 'either';

/** The sentence after "the gate's maintainer drops them from its manifest". */
export function gateOwnedParamsNextStep(fix: GateOwnedParamsFix, t: Translate): string {
  if (fix === 'align') {
    return t(
      '要门的维护者从门的清单里去掉这些参数；去掉之后，到「系统与授权」打开这个系统，点「与门公告对齐」按新清单重写草稿，再到能力目录发布。',
      'The gate’s maintainer has to drop these params from the gate’s manifest; then open this system under Systems & access, use “Align with the gate’s announcement” to rewrite the draft, and publish it in the catalog.',
    );
  }
  if (fix === 'align-here') {
    return t(
      '要门的维护者从门的清单里去掉这些参数；改好并由平台采用之后，点下面的「按门的最新清单重写」，再发布。',
      'The gate’s maintainer has to drop these params from the gate’s manifest; once that is done and adopted by the platform, use “Rewrite from the gate’s latest manifest” below, then publish.',
    );
  }
  if (fix === 'reconnect') {
    return t(
      '要门的维护者从门的清单里去掉这些参数；这是工作区自己接入的系统，控制台还不能就地同步它的清单，改好之后需要重新接入。',
      'The gate’s maintainer has to drop these params from the gate’s manifest. This system was connected by the workspace itself and its manifest cannot be re-synced in place yet, so connect it again once the manifest is fixed.',
    );
  }
  return t(
    '要门的维护者从门的清单里去掉这些参数。平台提供的系统，去掉之后到「系统与授权」点「与门公告对齐」重写这份草稿再发布；工作区自己接入的系统，改好清单后需要重新接入。',
    'The gate’s maintainer has to drop these params from the gate’s manifest. For a platform-provided system, then use “Align with the gate’s announcement” under Systems & access to rewrite this draft and publish it; a system the workspace connected itself has to be connected again once the manifest is fixed.',
  );
}

/**
 * One announced entry the bulk publish will hold back (UX acceptance of #567 P3) — marked in the
 * table that first lists it (the launcher's announced Operations, the instance drawer's manifest
 * in effect), not only in the enable preview.
 */
export function GateOwnedParamsMark({
  params,
  testId,
}: {
  readonly params: readonly GateOwnedParamWire[] | undefined;
  readonly testId?: string;
}) {
  const t = useT();
  if (!params || params.length === 0) return null;
  return (
    <span className="stack-s" data-testid={testId}>
      <span>
        <span className="chip chip-s chip-warn">{t('发布不了', 'Cannot be published')}</span>
      </span>
      <span className="text-3 text-small">
        {t(
          `声明了只能由门自己设置的参数：${gateOwnedParamsText(params, t)}`,
          `Declares params only the gate sets: ${gateOwnedParamsText(params, t)}`,
        )}
      </span>
    </span>
  );
}

/**
 * The bulk-publish result's held-back drafts — rendered after `enable_gate_instance` and
 * `publish_manifest`. Each name links to its draft in the catalog. Renders nothing when there are
 * none (an older kernel's result without the field reads the same).
 */
export function HeldDraftsNotice({
  drafts,
  gatekeeperId,
  fix,
  testId,
}: {
  readonly drafts: readonly GateOwnedParamDraftWire[] | undefined;
  readonly gatekeeperId: string;
  readonly fix: GateOwnedParamsFix;
  readonly testId?: string;
}) {
  const t = useT();
  if (!drafts || drafts.length === 0) return null;
  return (
    <Notice tone="warn" testId={testId}>
      <span className="stack-s">
        <span>
          {t(
            `${drafts.length} 个 Operation 没有发布，还是草稿：它们声明了只能由门自己设置的参数，门会拒绝带这些参数的每一次调用。`,
            `${drafts.length} operation(s) were not published and stay drafts: they declare params only the gate sets, and the gate refuses every call that passes one.`,
          )}
        </span>
        <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {drafts.map((draft) => (
            <li key={draft.name} data-testid={testId ? `${testId}-item` : undefined}>
              <RouteLink
                href={hrefs.catalog('operations', operationKey({ gatekeeperId, name: draft.name }))}
              >
                <span className="mono">{draft.name}</span>
              </RouteLink>
              {t('：', ': ')}
              {gateOwnedParamsText(draft.params, t)}
            </li>
          ))}
        </ul>
        <span className="text-3">{gateOwnedParamsNextStep(fix, t)}</span>
      </span>
    </Notice>
  );
}

/**
 * `publish_manifest`'s whole result (console G4): what it published, the gate's drafts it held back
 * for a gate-owned param, and the drafts it never sweeps up — an agent's or a member's proposal
 * (`skippedDraftOperationNames`), which an owner publishes one by one in the catalog after reading
 * it. Before this the system card showed nothing at all, so a click that published nothing looked
 * like a click that published everything.
 */
export function ManifestPublishResultNotice({
  result,
  fix,
  testId,
}: {
  readonly result: PublishManifestResultWire;
  readonly fix: GateOwnedParamsFix;
  readonly testId?: string;
}) {
  const t = useT();
  const skipped = result.skippedDraftOperationNames ?? [];
  return (
    <span className="stack-s" data-testid={testId}>
      <Notice testId={testId ? `${testId}-published` : undefined}>
        {t(
          `已发布 ${result.publishedOperationNames.length} 个 Operation。`,
          `Published ${result.publishedOperationNames.length} operation(s).`,
        )}
      </Notice>
      <HeldDraftsNotice
        drafts={result.gateOwnedParamDrafts}
        gatekeeperId={result.gatekeeperId}
        fix={fix}
        testId={testId ? `${testId}-held` : undefined}
      />
      {skipped.length > 0 ? (
        <Notice testId={testId ? `${testId}-proposals` : undefined}>
          <span className="stack-s">
            <span>
              {t(
                `${skipped.length} 份草稿是 agent 或成员提出的，不随清单一起发布：到能力目录逐个核对后再发布。`,
                `${skipped.length} draft(s) were proposed by an agent or a member and are not published with the manifest — check each in the catalog and publish it there.`,
              )}
            </span>
            <span className="row-wrap">
              {skipped.map((name) => (
                <RouteLink
                  key={name}
                  href={hrefs.catalog(
                    'operations',
                    operationKey({ gatekeeperId: result.gatekeeperId, name }),
                  )}
                >
                  <span className="mono">{name}</span>
                </RouteLink>
              ))}
            </span>
          </span>
        </Notice>
      ) : null}
    </span>
  );
}
