import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';

/**
 * Legacy 303: a LinkType end that would name an ObjectType no ontology in the workspace declares —
 * a rollback preview's `linkEnds` (`OntologyLinkEndWire`), or the `details.undeclared` /
 * `details.orphaned` of a 409 `ontology_link_endpoint_undeclared`. Said the same way on both, so
 * the person reads which ontology's which link type points at what (UX acceptance of #1141).
 */

/** The part of a link end these texts read. `ontologyId` is null in a refusal for a family the
 *  refused publish would have created. */
export interface OntologyLinkEndShown {
  readonly ontologyId: string | null;
  readonly family: string | null;
  readonly linkType: string;
  readonly end: 'domain' | 'range';
  readonly objectType: string;
}

/** "本体 ops-assets 的关系类型 served_by 的 range 是 Host": whose link type it is — left out when
 *  it is `ownOntologyId`'s, the ontology the sentence is already about; "another ontology" when
 *  no ChangePlan record names it — which end, and the type it names. */
export function ontologyLinkEndText(
  end: OntologyLinkEndShown,
  t: Translate,
  ownOntologyId?: string | null,
): string {
  const own = ownOntologyId !== undefined && end.ontologyId === ownOntologyId;
  const zhOwner = own ? '' : end.family !== null ? `本体 ${end.family} 的` : '另一个本体的';
  const enOwner = own
    ? ''
    : end.family !== null
      ? `ontology ${end.family}’s `
      : 'another ontology’s ';
  return t(
    `${zhOwner}关系类型 ${end.linkType} 的 ${end.end} 是 ${end.objectType}`,
    `${enOwner}link type ${end.linkType}: ${end.end} is ${end.objectType}`,
  );
}

/** Several ends in one run of text. */
export function ontologyLinkEndsText(
  ends: readonly OntologyLinkEndShown[],
  t: Translate,
  ownOntologyId?: string | null,
): string {
  return ends.map((end) => ontologyLinkEndText(end, t, ownOntologyId)).join(t('；', '; '));
}

function linkEndOf(value: unknown): OntologyLinkEndShown | null {
  if (typeof value !== 'object' || value === null) return null;
  const { ontologyId, family, linkType, end, objectType } = value as Record<string, unknown>;
  if (ontologyId !== null && typeof ontologyId !== 'string') return null;
  if (typeof linkType !== 'string' || typeof objectType !== 'string') return null;
  if (end !== 'domain' && end !== 'range') return null;
  return {
    ontologyId,
    family: typeof family === 'string' ? family : null,
    linkType,
    end,
    objectType,
  };
}

function linkEndsOf(value: unknown): OntologyLinkEndShown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const end = linkEndOf(item);
    return end ? [end] : [];
  });
}

/** The ends a 409 `ontology_link_endpoint_undeclared` names: `undeclared` — the refused version's
 *  own link types pointing at a type nobody declares; `orphaned` — other ontologies' link types
 *  pointing at a type the refused version would take away. Null when `err` is not that refusal or
 *  names none. */
export function ontologyLinkEndpointRefusalOf(err: unknown): {
  readonly undeclared: readonly OntologyLinkEndShown[];
  readonly orphaned: readonly OntologyLinkEndShown[];
} | null {
  if (!(err instanceof HttpError) || err.code !== 'ontology_link_endpoint_undeclared') return null;
  const undeclared = linkEndsOf(err.details?.undeclared);
  const orphaned = linkEndsOf(err.details?.orphaned);
  return undeclared.length > 0 || orphaned.length > 0 ? { undeclared, orphaned } : null;
}

/** A 409 `ontology_link_endpoint_undeclared` said with the ends it names, wherever no surface says
 *  it its own way (publishing an ontology draft, installing a module, an admin proposal): the
 *  refused version's own ends first, then other ontologies' ends it would leave pointing at
 *  nothing. Null when `err` is not that refusal or names no end — `platform-errors.ts` then says
 *  it in general. */
export function ontologyLinkEndpointMessage(err: unknown, t: Translate): string | null {
  const refusal = ontologyLinkEndpointRefusalOf(err);
  if (!refusal) return null;
  const { undeclared, orphaned } = refusal;
  const own = undeclared[0]?.ontologyId;
  const zh: string[] = [];
  const en: string[] = [];
  if (undeclared.length > 0) {
    zh.push(
      `这个版本里有关系类型指向工作区里没有任何已发布本体声明的对象类型：${ontologyLinkEndsText(undeclared, t, own)}。`,
    );
    en.push(
      `A link type in this version points at an object type no published ontology in the workspace declares: ${ontologyLinkEndsText(undeclared, t, own)}.`,
    );
  }
  if (orphaned.length > 0) {
    zh.push(
      `这个版本去掉了别的本体的关系类型还在用的对象类型：${ontologyLinkEndsText(orphaned, t)}。`,
    );
    en.push(
      `This version drops an object type another ontology’s link type still uses: ${ontologyLinkEndsText(orphaned, t)}.`,
    );
  }
  zh.push('本次没有发布任何内容。改正关系类型或补上对象类型；是别的本体在用的，先改那个本体。');
  en.push(
    'Nothing was published. Correct the link type or declare the object type; if another ontology uses it, change that ontology first.',
  );
  return t(zh.join(''), en.join(' '));
}

/** Legacy 705: an end a 409 `ontology_link_endpoint_outside_requires` names — a link type of a
 *  pack being installed whose end names an object type that the workspace does declare, but in
 *  an ontology family outside what the pack may build on (the platform's own ontology, the pack's
 *  own families, the families of the packs it requires). `family` is the family that declares
 *  the type (null when it has no name); `pack`, the pack that family comes from, when one does. */
export interface OntologyLinkEndOutsideRequires {
  readonly linkType: string;
  readonly end: 'domain' | 'range';
  readonly objectType: string;
  readonly family: string | null;
  readonly pack: string | null;
}

function outsideEndOf(value: unknown): OntologyLinkEndOutsideRequires | null {
  if (typeof value !== 'object' || value === null) return null;
  const { linkType, end, objectType, family, pack } = value as Record<string, unknown>;
  if (typeof linkType !== 'string' || typeof objectType !== 'string') return null;
  if (end !== 'domain' && end !== 'range') return null;
  return {
    linkType,
    end,
    objectType,
    family: typeof family === 'string' ? family : null,
    pack: typeof pack === 'string' ? pack : null,
  };
}

/** The ends a 409 `ontology_link_endpoint_outside_requires` names (`details.ends`). Null when
 *  `err` is not that refusal or names none. */
export function ontologyLinkEndpointOutsideRequiresOf(
  err: unknown,
): readonly OntologyLinkEndOutsideRequires[] | null {
  if (!(err instanceof HttpError) || err.code !== 'ontology_link_endpoint_outside_requires') {
    return null;
  }
  const raw = err.details?.ends;
  const ends = Array.isArray(raw)
    ? raw.flatMap((item) => {
        const end = outsideEndOf(item);
        return end ? [end] : [];
      })
    : [];
  return ends.length > 0 ? ends : null;
}

/** "关系类型 ticket_on_host 的 range 是 Host，由能力包 ops-hosts 的本体 ops-hosts 声明": the end,
 *  and where the type it names is declared — the pack whose family it is, when one is. */
export function ontologyLinkEndOutsideRequiresText(
  end: OntologyLinkEndOutsideRequires,
  t: Translate,
): string {
  const zhWhere =
    end.family === null
      ? '由另一个本体声明'
      : end.pack !== null
        ? `由能力包 ${end.pack} 的本体 ${end.family} 声明`
        : `由本体 ${end.family} 声明（它不是从能力包装上的）`;
  const enWhere =
    end.family === null
      ? 'declared by another ontology'
      : end.pack !== null
        ? `declared by ontology ${end.family} of pack ${end.pack}`
        : `declared by ontology ${end.family} (not installed from a pack)`;
  return t(
    `关系类型 ${end.linkType} 的 ${end.end} 是 ${end.objectType}，${zhWhere}`,
    `link type ${end.linkType}: ${end.end} is ${end.objectType}, ${enWhere}`,
  );
}

/** The packs the refused ends point at, by name, each once; the ones whose family no pack has
 *  are left out. */
export function packsOutsideRequires(
  ends: readonly OntologyLinkEndOutsideRequires[],
): readonly string[] {
  return [...new Set(ends.flatMap((end) => (end.pack === null ? [] : [end.pack])))];
}

/** A 409 `ontology_link_endpoint_outside_requires` said with the ends it names, wherever no
 *  surface says it its own way (installing a module, confirming a pack install). Null when `err`
 *  is not that refusal or names no end — `platform-errors.ts` then says it in general. */
export function ontologyLinkEndpointOutsideRequiresMessage(
  err: unknown,
  t: Translate,
): string | null {
  const ends = ontologyLinkEndpointOutsideRequiresOf(err);
  if (!ends) return null;
  const shown = ends.map((end) => ontologyLinkEndOutsideRequiresText(end, t)).join(t('；', '; '));
  const packs = packsOutsideRequires(ends);
  const zhFix =
    packs.length > 0
      ? `要在这个能力包的 requires.packs 里加上 ${packs.join('、')}`
      : '要让这个能力包依赖声明这些类型的能力包，或改掉这些关系类型';
  const enFix =
    packs.length > 0
      ? `its requires.packs needs ${packs.join(', ')}`
      : 'it needs to require a pack that declares these types, or to change these link types';
  return t(
    `这个能力包的关系类型连到了它没有声明依赖的本体里的对象类型：${shown}。能力包只能连到平台自带的本体、它自己的本体和它依赖的能力包的本体，所以本次没有安装任何内容。这要改能力包本身（${zhFix}），请平台管理员处理。`,
    `A link type of this pack ends on an object type of an ontology it does not declare it builds on: ${shown}. A pack may only link to the platform’s own ontology, its own ontologies and those of the packs it requires, so nothing was installed. The pack itself needs changing (${enFix}); ask a platform administrator.`,
  );
}
