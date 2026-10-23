import type { PackComponentStateWire, PackWire } from '@nexttime/shared';
import { useCapabilityList } from '../../hooks/useCapability.js';
import type { CapabilityCaller } from '../../lib/clients.js';
import { useT } from '../../lib/i18n.js';
import { hrefs } from '../../lib/router.js';
import { RouteLink } from '../kit/route-link.js';

/** A published Skill (its family's head), or one version of a WorkerDefinition. */
export type PackOriginTarget =
  | { readonly kind: 'skill'; readonly skillId: string }
  | { readonly kind: 'worker'; readonly definitionId: string; readonly version: number };

function matches(component: PackComponentStateWire, target: PackOriginTarget): boolean {
  if (component.status === 'not_installed') return false;
  return target.kind === 'skill'
    ? component.kind === 'skill' && component.skillId === target.skillId
    : component.kind === 'worker' &&
        component.definitionId === target.definitionId &&
        component.headVersion === target.version;
}

/**
 * components/catalog/PackOrigin (STATUS leftover 418): on a Skill's or a Worker version's detail,
 * the pack that installed it — 「来自能力包 ops-base v3」, linking to the pack — read from the same
 * `list_packs` the 能力包 tab reads (cached, one call). A Skill is matched by its family (the
 * pack's state is its published head's); a Worker by its family and its published head version, so
 * an older version of it says nothing. A component that matches no version of the pack says it was
 * changed outside the pack. Nothing while loading, on an error, or for anything no pack installed.
 */
export function PackOrigin({
  http,
  target,
  testId,
}: {
  readonly http: CapabilityCaller;
  readonly target: PackOriginTarget;
  readonly testId: string;
}) {
  const t = useT();
  const packs = useCapabilityList<PackWire>(http, 'list_packs', {});
  if (packs.state.status !== 'ready') return null;
  for (const pack of packs.state.data.items) {
    const component = pack.components.find((candidate) => matches(candidate, target));
    if (!component) continue;
    const link = (
      <RouteLink href={hrefs.catalog('packs', pack.name)} testId={`${testId}-link`}>
        {pack.name}
      </RouteLink>
    );
    return (
      <span className="row-wrap text-3 text-small" data-testid={testId}>
        <span>{t('来自能力包', 'From pack')}</span>
        {link}
        <span>
          {component.installedVersion !== null
            ? `v${component.installedVersion}`
            : t(
                '（内容已在能力包之外改过，对不上它的任何一个版本）',
                '(changed outside the pack; it matches none of its versions)',
              )}
        </span>
      </span>
    );
  }
  return null;
}
