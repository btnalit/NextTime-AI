import { describe, expect, it } from 'vitest';
import {
  RELEVANT_FACTS_MAX_CHARS,
  VOCABULARY_MAX_CHARS,
  renderRelevantFacts,
  renderVocabulary,
} from './vocabulary.js';

/** `get_task`'s `ontologyVocabulary` as the kernel sends it (relevant entries first). */
function vocabulary(
  objectTypes: readonly [string, readonly string[] | null, boolean][],
  linkTypes: readonly [string, string, string, boolean][],
  omitted: { objectTypes?: number; linkTypes?: number } = {},
) {
  return {
    objectTypes: objectTypes.map(([name, identityKey, relevant]) => ({
      name,
      identityKey,
      relevant,
    })),
    linkTypes: linkTypes.map(([name, domain, range, relevant]) => ({
      name,
      domain,
      range,
      relevant,
    })),
    omittedObjectTypes: omitted.objectTypes ?? 0,
    omittedLinkTypes: omitted.linkTypes ?? 0,
  };
}

describe('renderVocabulary (legacy 968)', () => {
  it('lists each ObjectType with its identity key and each signature on a line, under a lead that says what a Fact is', () => {
    const text = renderVocabulary(
      vocabulary(
        [
          ['Container', ['composeProjectId', 'serviceName'], true],
          ['Host', ['hostname'], true],
          ['Note', null, false],
        ],
        [
          ['runs_on', 'Container', 'Host', true],
          ['mentions', 'Note', '*', false],
        ],
      ),
    );
    expect(text).toBe(
      [
        '### Ontology vocabulary',
        'Each `factsToAssert` entry is a Link: its `linkType` must be one of the LinkTypes below, ' +
          'from an Object of its source type to an Object of its target type, or the platform ' +
          'refuses the entry. Name an Object by `objectId`, or by `objectType` with `identity` ' +
          'holding the properties of its identity key. Do not make up a LinkType: a conclusion ' +
          'these cannot express goes in `findings`, with what backs it in `evidence`.',
        'ObjectTypes (identity key):',
        '- Container (composeProjectId, serviceName)',
        '- Host (hostname)',
        '- Note',
        'LinkTypes (source -> target, * is any type):',
        '- runs_on: Container -> Host',
        '- mentions: Note -> *',
      ].join('\n'),
    );
  });

  it('says to leave factsToAssert empty when nothing can be written', () => {
    expect(renderVocabulary(vocabulary([], []))).toBe(
      '### Ontology vocabulary\n' +
        'This workspace’s ontology declares no LinkType a Worker can write a Fact with: leave ' +
        '`factsToAssert` empty and put your conclusions in `findings`, with what backs them in ' +
        '`evidence`.',
    );
  });

  it('is no section when get_task gave none (a kernel before 968, or no published ontology)', () => {
    expect(renderVocabulary(undefined)).toBeUndefined();
    expect(renderVocabulary(null)).toBeUndefined();
    expect(renderVocabulary('runs_on')).toBeUndefined();
  });

  it('skips a malformed entry and keeps the rest', () => {
    const text = renderVocabulary({
      objectTypes: [
        { name: 'Host', identityKey: ['hostname', 3], relevant: true },
        { name: '' },
        7,
      ],
      linkTypes: [{ name: 'runs_on', domain: 'Container' }, null],
      omittedObjectTypes: 'x',
    });
    expect(text).toContain('- Host (hostname)');
    expect(text).not.toContain('runs_on');
    expect(text).not.toContain('more not listed');
  });

  const large = () => {
    const objectTypes: [string, readonly string[] | null, boolean][] = [];
    const linkTypes: [string, string, string, boolean][] = [];
    for (let i = 0; i < 60; i += 1) {
      objectTypes.push([`Relevant${i}`, ['tenantId', 'resourceName'], true]);
    }
    for (let i = 0; i < 100; i += 1) objectTypes.push([`Other${i}`, ['id'], false]);
    for (let i = 0; i < 200; i += 1) {
      linkTypes.push([`link_${i % 50}`, `Other${i}`, `Other${i + 1}`, false]);
    }
    return vocabulary(objectTypes, linkTypes, { objectTypes: 5, linkTypes: 9 });
  };

  it(`never goes over ${VOCABULARY_MAX_CHARS} characters: full lines while they fit, then names, then a count`, () => {
    const text = renderVocabulary(large()) ?? '';
    expect(text.length).toBeLessThanOrEqual(VOCABULARY_MAX_CHARS);
    const lines = text.split('\n');
    // The relevant ObjectTypes come first and get full lines.
    expect(lines).toContain('- Relevant0 (tenantId, resourceName)');
    const named = lines.find((line) => line.startsWith('Also declared (names only): '));
    expect(named).toBeDefined();
    const count = lines.at(-1) ?? '';
    expect(count).toMatch(/^… and \d+ more not listed\.$/);
    // Every entry is in exactly one place: a full line, a name, or the count (with what the
    // kernel left out).
    const fullObjectLines = lines.filter((line) => /^- (Relevant|Other)\d+ \(/.test(line)).length;
    const fullLinkLines = lines.filter((line) => /^- link_\d+: /.test(line)).length;
    const names = (named ?? '').replace('Also declared (names only): ', '').split(', ');
    const objectNames = names.filter((name) => /^(Relevant|Other)\d+$/.test(name)).length;
    const linkNames = new Set(names.filter((name) => name.startsWith('link_')));
    const linkSignaturesNamed = large().linkTypes.filter(
      (link, index) => linkNames.has(link.name) && index >= fullLinkLines,
    ).length;
    const counted = Number(count.match(/\d+/)?.[0]);
    expect(fullObjectLines + objectNames + fullLinkLines + linkSignaturesNamed + counted).toBe(
      160 + 200 + 5 + 9,
    );
  });

  it('a budget too small for any line still names what fits and counts the rest', () => {
    const text =
      renderVocabulary(
        vocabulary(
          [
            ['Host', ['hostname'], true],
            ['Container', null, false],
          ],
          [['runs_on', 'Container', 'Host', true]],
        ),
        560,
      ) ?? '';
    expect(text.length).toBeLessThanOrEqual(560);
    expect(text).not.toContain('- Host');
    // Still relevant first: the relevant ObjectType, the relevant signature, then the rest.
    expect(text).toContain('Also declared (names only): Host, runs_on, Container');
  });

  it('gives the same text for the same vocabulary, so the prompt up to it stays cached', () => {
    expect(renderVocabulary(large())).toBe(renderVocabulary(large()));
  });
});

describe('renderRelevantFacts (legacy 968)', () => {
  it('is no section without Objects, one line per Object otherwise', () => {
    expect(renderRelevantFacts([])).toBeUndefined();
    expect(renderRelevantFacts([{ id: 'obj-1' }, { id: 'obj-2' }])).toBe(
      '### Relevant facts\n- {"id":"obj-1"}\n- {"id":"obj-2"}',
    );
  });

  it(`never goes over ${RELEVANT_FACTS_MAX_CHARS} characters; an Object that does not fit is counted and the ones after it still tried`, () => {
    const facts = [
      { id: 'small-1' },
      { id: 'huge', properties: { text: 'x'.repeat(RELEVANT_FACTS_MAX_CHARS) } },
      { id: 'small-2' },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `obj-${i}`,
        properties: { n: 'y'.repeat(80) },
      })),
    ];
    const text = renderRelevantFacts(facts) ?? '';
    expect(text.length).toBeLessThanOrEqual(RELEVANT_FACTS_MAX_CHARS);
    expect(text).toContain('{"id":"small-1"}');
    expect(text).toContain('{"id":"small-2"}');
    expect(text).not.toContain('"huge"');
    const shown = text.split('\n').filter((line) => line.startsWith('- {')).length;
    expect(text.split('\n').at(-1)).toBe(`- … and ${facts.length - shown} more not shown`);
  });
});
