import { describe, expect, it } from 'vitest';
import { presentError } from './errors.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import {
  ontologyLinkEndOutsideRequiresText,
  ontologyLinkEndText,
  ontologyLinkEndpointMessage,
  ontologyLinkEndpointOutsideRequiresMessage,
  ontologyLinkEndpointOutsideRequiresOf,
  ontologyLinkEndpointRefusalOf,
} from './ontology-link-ends.js';

/** Legacy 303 (UX acceptance of #1141): a link end says whose link type it is, which end, and the
 *  type it names; a 409 `ontology_link_endpoint_undeclared` says each end its details name. */

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

const refusal = (details?: Record<string, unknown>) =>
  new HttpError(
    'capability_error',
    'ontology LinkType ends must name a declared ObjectType or "*"',
    'ontology_link_endpoint_undeclared',
    details,
  );

describe('ontologyLinkEndText', () => {
  const end = {
    ontologyId: 'o-2',
    family: 'uxlink-services',
    linkType: 'served_by',
    end: 'range' as const,
    objectType: 'UxHost',
  };

  it('names the family when the ChangePlan recorded one, "another ontology" when not, nothing for the ontology the sentence is about', () => {
    // Read inside a sentence, as every surface shows it.
    const said = (text: string) => `${text}。`;
    expect(said(ontologyLinkEndText(end, zh))).toBe(
      '本体 uxlink-services 的关系类型 served_by 的 range 是 UxHost。',
    );
    expect(said(ontologyLinkEndText({ ...end, family: null }, zh))).toBe(
      '另一个本体的关系类型 served_by 的 range 是 UxHost。',
    );
    expect(said(ontologyLinkEndText(end, zh, 'o-2'))).toBe(
      '关系类型 served_by 的 range 是 UxHost。',
    );
    expect(ontologyLinkEndText(end, en)).toBe(
      'ontology uxlink-services’s link type served_by: range is UxHost',
    );
  });
});

describe('ontologyLinkEndpointRefusalOf', () => {
  it('reads both lists, keeps a null ontologyId (a family the publish would create), drops malformed ends', () => {
    const read = ontologyLinkEndpointRefusalOf(
      refusal({
        undeclared: [
          { ontologyId: null, linkType: 'feeds', end: 'range', objectType: 'Typo' },
          { ontologyId: 'o-1', linkType: 'feeds', end: 'middle', objectType: 'Typo' },
        ],
        orphaned: 'not a list',
      }),
    );
    expect(read).toEqual({
      undeclared: [
        { ontologyId: null, family: null, linkType: 'feeds', end: 'range', objectType: 'Typo' },
      ],
      orphaned: [],
    });
  });

  it('is null for another code, or when no end can be read', () => {
    expect(ontologyLinkEndpointRefusalOf(refusal())).toBeNull();
    expect(ontologyLinkEndpointRefusalOf(refusal({ undeclared: [], orphaned: [] }))).toBeNull();
    expect(
      ontologyLinkEndpointRefusalOf(new HttpError('capability_error', 'x', 'not_found', {})),
    ).toBeNull();
  });
});

describe('ontologyLinkEndpointMessage', () => {
  it('says the version’s own ends, then the other ontologies’ ends it would orphan, and that nothing was published', () => {
    const err = refusal({
      undeclared: [
        { ontologyId: 'o-1', family: 'mine', linkType: 'feeds', end: 'range', objectType: 'Typo' },
      ],
      orphaned: [
        {
          ontologyId: 'o-2',
          family: 'ops-assets',
          linkType: 'runs_on',
          end: 'domain',
          objectType: 'Host',
        },
      ],
    });
    expect(ontologyLinkEndpointMessage(err, zh)).toBe(
      '这个版本里有关系类型指向工作区里没有任何已发布本体声明的对象类型：关系类型 feeds 的 range 是 Typo。这个版本去掉了别的本体的关系类型还在用的对象类型：本体 ops-assets 的关系类型 runs_on 的 domain 是 Host。本次没有发布任何内容。改正关系类型或补上对象类型；是别的本体在用的，先改那个本体。',
    );
    // presentError reads it ahead of the general sentence.
    expect(presentError(err, zh).message).toContain(
      '本体 ops-assets 的关系类型 runs_on 的 domain 是 Host。',
    );
  });

  it('leaves a refusal without readable details to the general sentence', () => {
    expect(ontologyLinkEndpointMessage(refusal(), zh)).toBeNull();
    expect(presentError(refusal(), zh).message).toContain(
      '「技术细节」里写着是哪个关系类型和对象类型',
    );
  });
});

/** Legacy 705: a pack's link type ending on an object type of an ontology the pack does not build
 *  on — each end says which ontology declares the type, and which pack that ontology comes from. */
describe('ontology_link_endpoint_outside_requires', () => {
  const outside = (details?: Record<string, unknown>) =>
    new HttpError(
      'capability_error',
      "a pack's LinkType ends name ObjectTypes of the platform-meta ontology, of its own families or of the packs it requires",
      'ontology_link_endpoint_outside_requires',
      details,
    );
  const end = {
    linkType: 'ticket_on_host',
    end: 'range' as const,
    objectType: 'Host',
    family: 'ops-hosts',
    pack: 'ops-hosts-pack',
  };

  it('says where the type is declared: a pack’s ontology, an ontology from no pack, or one with no name', () => {
    expect(ontologyLinkEndOutsideRequiresText(end, zh)).toBe(
      '关系类型 ticket_on_host 的 range 是 Host，由能力包 ops-hosts-pack 的本体 ops-hosts 声明',
    );
    expect(ontologyLinkEndOutsideRequiresText({ ...end, pack: null }, zh)).toBe(
      '关系类型 ticket_on_host 的 range 是 Host，由本体 ops-hosts 声明（它不是从能力包装上的）',
    );
    expect(ontologyLinkEndOutsideRequiresText({ ...end, family: null, pack: null }, zh)).toBe(
      '关系类型 ticket_on_host 的 range 是 Host，由另一个本体声明',
    );
    expect(ontologyLinkEndOutsideRequiresText(end, en)).toBe(
      'link type ticket_on_host: range is Host, declared by ontology ops-hosts of pack ops-hosts-pack',
    );
  });

  it('reads the ends from the details, skipping malformed ones; null for another refusal or none', () => {
    const err = outside({ ends: [end, { linkType: 'x', end: 'middle', objectType: 'Y' }] });
    expect(ontologyLinkEndpointOutsideRequiresOf(err)).toEqual([end]);
    expect(ontologyLinkEndpointOutsideRequiresOf(outside())).toBeNull();
    expect(ontologyLinkEndpointOutsideRequiresOf(outside({ ends: [] }))).toBeNull();
    expect(ontologyLinkEndpointOutsideRequiresOf(refusal({ undeclared: [] }))).toBeNull();
  });

  it('names each end and the pack to require, and presentError reads it ahead of the general sentence', () => {
    const err = outside({
      ends: [end, { ...end, linkType: 'ticket_from_host', end: 'domain' }],
    });
    const message = ontologyLinkEndpointOutsideRequiresMessage(err, zh);
    expect(message).toBe(
      '这个能力包的关系类型连到了它没有声明依赖的本体里的对象类型：关系类型 ticket_on_host 的 range 是 Host，由能力包 ops-hosts-pack 的本体 ops-hosts 声明；关系类型 ticket_from_host 的 domain 是 Host，由能力包 ops-hosts-pack 的本体 ops-hosts 声明。能力包只能连到平台自带的本体、它自己的本体和它依赖的能力包的本体，所以本次没有安装任何内容。这要改能力包本身（要在这个能力包的 requires.packs 里加上 ops-hosts-pack），请平台管理员处理。',
    );
    expect(presentError(err, zh).message).toContain(
      'requires.packs 里加上 ops-hosts-pack），请平台管理员处理',
    );
    // No pack has the family: no pack to name.
    expect(
      ontologyLinkEndpointOutsideRequiresMessage(outside({ ends: [{ ...end, pack: null }] }), zh),
    ).toContain('要让这个能力包依赖声明这些类型的能力包，或改掉这些关系类型');
  });

  it('leaves a refusal without readable details to the general sentence', () => {
    expect(ontologyLinkEndpointOutsideRequiresMessage(outside(), zh)).toBeNull();
    expect(presentError(outside(), zh).message).toContain('在 requires.packs 里加上那个能力包');
  });
});
