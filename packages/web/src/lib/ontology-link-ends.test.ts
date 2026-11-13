import { describe, expect, it } from 'vitest';
import { presentError } from './errors.js';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import {
  ontologyLinkEndText,
  ontologyLinkEndpointMessage,
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
