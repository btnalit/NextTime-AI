import type { CredentialDraftWire } from '@nexttime/shared';
import { visibleText } from '@nexttime/shared';
import { namedReviewPath, reviewFieldNames } from '../../lib/credential-review.js';
import { actionKindTagText } from '../../lib/format.js';
import { operationKey } from '../../lib/governance.js';
import { type Translate, sentenceGap, useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { Notice } from '../kit/notice.js';
import { RouteLink } from '../kit/route-link.js';

/**
 * components/connect/CredentialDrafts (legacy 800, kernel legacy 198): a gate's imported Operation
 * whose definition carries values that look like a key, token or password is not published by a
 * bulk publish (`enable_gate_instance`, `publish_manifest`) — nobody there confirms them, and a
 * published definition goes as it is to every agent that uses it. A person publishes each in the
 * catalog with the credential confirmation (decision 2026-10-09 「二次确认」). Real OpenAPI
 * documents often trip it with an example (`Authorization: Bearer <token>` in a description, a
 * password field's `example`), so without this the toast said 「已发布 N 个」 while some stayed
 * drafts in silence. One wording for every place that says so: before enabling (the preview's
 * announced entries) and after a bulk publish (the result's `credentialDrafts`). Each name links to
 * its draft. The kernel's order is gate-owned params, then credentials, then answers that mean "does
 * not exist", so a draft carrying both of the last two is listed here only.
 */

/** Where the person rewrites the draft once the gate's document drops a real secret: a platform
 *  gate aligns with the platform's announcement, a self-connected one re-reads its manifest. */
export type CredentialDraftsFix = 'align' | 'resync' | 'either';

/** 「描述、参数定义.properties.password.example」, at most what the kernel listed. */
function placesText(draft: CredentialDraftWire, t: Translate): string {
  // UX acceptance of #1370 (P3): the stored definition's top-level fields read as words, the same
  // as the catalog's Publish names them.
  const names = reviewFieldNames('operation', t);
  const places = draft.suspectedSecretPaths
    .map((path) => visibleText(namedReviewPath(path, names)))
    .join(t('、', ', '));
  if (places === '') {
    return t(
      `${draft.suspectedSecretValues} 处疑似凭据`,
      `${draft.suspectedSecretValues} suspected credential value(s)`,
    );
  }
  return t(
    `${draft.suspectedSecretValues} 处疑似凭据，在 ${places}`,
    `${draft.suspectedSecretValues} suspected credential value(s), in ${places}`,
  );
}

function rewriteStep(fix: CredentialDraftsFix, t: Translate): string {
  if (fix === 'either') {
    return t(
      '是真实密钥的，不要发布：请门的维护者从门的文档里去掉它。之后到「系统与授权」打开这个系统：平台提供的系统点「与门公告对齐」，工作区自己接入的系统点「重新读取门的清单」，按新清单重写草稿。',
      'If it is a real secret, do not publish: have the gate’s maintainer remove it from the gate’s document. Then open this system under Systems & access — “Align with the gate’s announcement” for a platform-provided system, “Re-read the gate’s manifest” for one the workspace connected itself — to rewrite the draft.',
    );
  }
  return fix === 'align'
    ? t(
        '是真实密钥的，不要发布：请门的维护者从门的文档里去掉它，之后到「系统与授权」打开这个系统，点「与门公告对齐」按新清单重写草稿。',
        'If it is a real secret, do not publish: have the gate’s maintainer remove it from the gate’s document, then open this system under Systems & access and use “Align with the gate’s announcement” to rewrite the draft.',
      )
    : t(
        '是真实密钥的，不要发布：请门的维护者从门的文档里去掉它，之后到「系统与授权」打开这个系统，点「重新读取门的清单」按新清单重写草稿。',
        'If it is a real secret, do not publish: have the gate’s maintainer remove it from the gate’s document, then open this system under Systems & access and use “Re-read the gate’s manifest” to rewrite the draft.',
      );
}

/** After a bulk publish: the drafts it left for a person because they carry suspected credentials.
 *  Renders nothing when there are none (an older kernel's result without the field reads the
 *  same). */
export function CredentialDraftsNotice({
  drafts,
  gatekeeperId,
  fix,
  testId,
}: {
  readonly drafts: readonly CredentialDraftWire[] | undefined;
  readonly gatekeeperId: string;
  readonly fix: CredentialDraftsFix;
  readonly testId?: string;
}) {
  const t = useT();
  if (!drafts || drafts.length === 0) return null;
  return (
    <Notice tone="warn" testId={testId}>
      <span className="stack-s">
        <span>
          {t(
            `${drafts.length} 个 Operation 没有发布，还是草稿：它们的定义里有看起来像密钥、令牌或密码的值，发布后会原样提供给使用它的 agent，要由人核对后发布。`,
            `${drafts.length} operation(s) were not published and stay drafts: their definitions hold values that look like a key, token or password, which publishing gives as they are to every agent that uses them, so a person checks each before publishing.`,
          )}
        </span>
        <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {drafts.map((draft) => (
            <li key={draft.name} data-testid={testId ? `${testId}-item` : undefined}>
              <RouteLink
                href={hrefs.catalog('operations', operationKey({ gatekeeperId, name: draft.name }))}
              >
                <span className="mono">{actionKindTagText(draft.name)}</span>
              </RouteLink>
              {t('：', ': ')}
              {placesText(draft, t)}
            </li>
          ))}
        </ul>
        <span className="text-3">
          {t(
            '控制台不显示这些值：到门的文档（OpenAPI 文档或清单）里看这些位置。常见的是文档里的示例，比如描述里写的 Authorization: Bearer <token>、password 字段的 example：是示例或本来就该带的，打开草稿点「发布」，勾选「已核对凭据」后发布。',
            'The console does not show these values: look at those places in the gate’s document (the OpenAPI document or manifest). Common ones are examples, such as Authorization: Bearer <token> in a description or a password field’s example: if so, or if the definition is meant to carry it, open the draft, use Publish, tick “Credentials reviewed” and publish.',
          )}
          {sentenceGap(t)}
          {rewriteStep(fix, t)}
        </span>
      </span>
    </Notice>
  );
}

/** Before enabling: the announced entries that will be imported as drafts because they carry
 *  suspected credentials (the preview's `suspectedSecretValues`). */
export function CredentialHeldPreview({
  operations,
  testId,
}: {
  readonly operations: readonly { readonly name: string; readonly suspectedSecretValues: number }[];
  readonly testId?: string;
}) {
  const t = useT();
  if (operations.length === 0) return null;
  return (
    <Notice tone="warn" testId={testId}>
      <span className="stack-s">
        <span>
          {t(
            `${operations.length} 个 Operation 只导入为草稿，不会发布：它们的定义里有看起来像密钥、令牌或密码的值。启用后到能力目录逐个核对，确认是示例或本来就该带的，再发布。`,
            `${operations.length} operation(s) will only be imported as drafts, not published: their definitions hold values that look like a key, token or password. After enabling, check each one in the catalog and publish it once you have confirmed they are examples or meant to be there.`,
          )}
        </span>
        <ul className="stack-s" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {operations.map((operation) => (
            <li key={operation.name} data-testid={testId ? `${testId}-item` : undefined}>
              <span className="mono">{actionKindTagText(operation.name)}</span>
              {t('：', ': ')}
              {t(
                `${operation.suspectedSecretValues} 处疑似凭据`,
                `${operation.suspectedSecretValues} suspected credential value(s)`,
              )}
            </li>
          ))}
        </ul>
      </span>
    </Notice>
  );
}
