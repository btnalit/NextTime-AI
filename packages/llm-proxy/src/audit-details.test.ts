import { LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { fitAuditDetails, fitModelIds, storableDetails } from './audit-details.js';

const LIMIT = LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS;
const jsonLength = (value: unknown) => JSON.stringify(value).length;

/** A `provider_created`-shaped row around `models`. */
const createdRow = (models: string[]) => ({
  api: 'openai-completions',
  upstreamBaseUrl: 'https://acme.example.invalid',
  apiKeyEnv: 'ACME_API_KEY',
  models,
  enabled: true,
  modelsJsonError: null,
});

/** Characters left for the model ids' JSON (quotes and commas included) beside the rest of the
 *  row and a `modelsOmitted` of `count`. */
const roomBeside = (count: number) =>
  LIMIT - jsonLength({ ...createdRow([]), modelsOmitted: count });

describe('fitModelIds (legacy 151)', () => {
  it('returns a row that fits unchanged, however many ids it names', () => {
    const ordinary = createdRow(['a', 'b', 'c']);
    expect(fitModelIds(ordinary)).toBe(ordinary);
    // #501's case: 100 ids of about 30 characters is about 3.3 KB — every id stays.
    const hundred = createdRow(
      Array.from(
        { length: 100 },
        (_, i) => `vendor/model-${String(i).padStart(3, '0')}-instruct-v2`,
      ),
    );
    expect(jsonLength(hundred)).toBeGreaterThan(3000);
    expect(fitModelIds(hundred)).toBe(hundred);
  });

  it('a row exactly at the limit is sent whole; one character more names fewer ids', () => {
    const pad = LIMIT - jsonLength(createdRow(['a', '']));
    const atLimit = createdRow(['a', 'x'.repeat(pad)]);
    expect(jsonLength(atLimit)).toBe(LIMIT);
    expect(fitModelIds(atLimit)).toBe(atLimit);
    const over = createdRow(['a', 'x'.repeat(pad + 1)]);
    expect(fitModelIds(over)).toEqual({ ...over, models: ['a'], modelsOmitted: 1 });
  });

  it('an id that exactly fills the room beside the count is kept', () => {
    // {...rest, "models":["…"], "modelsOmitted":2} at exactly the limit.
    const fills = 'f'.repeat(roomBeside(2) - 2);
    const row = createdRow([fills, 'n'.repeat(20)]);
    expect(jsonLength(row)).toBeGreaterThan(LIMIT);
    expect(fitModelIds(row)).toEqual({ ...row, models: [fills], modelsOmitted: 1 });
    expect(jsonLength(fitModelIds(row))).toBe(LIMIT);
    const longer = createdRow([`${fills}f`, 'n'.repeat(20)]);
    expect(fitModelIds(longer)).toEqual({ ...longer, models: [], modelsOmitted: 2 });
  });

  it('names the first ids that fit beside the rest of the row, whatever its size', () => {
    for (const idLength of [1, 9, 30, 77, 200]) {
      for (const baseLength of [30, 600, 1024]) {
        const ids = Array.from({ length: 200 }, (_, i) =>
          `${String(i).padStart(3, '0')}${'m'.repeat(idLength)}`.slice(0, Math.max(idLength, 3)),
        );
        const row = {
          ...createdRow(ids),
          upstreamBaseUrl: `https://acme.example.invalid/${'p'.repeat(baseLength - 29)}`,
        };
        if (jsonLength(row) <= LIMIT) continue;
        const fitted = fitModelIds(row) as { models: string[]; modelsOmitted: number };
        const kept = fitted.models.length;
        expect(fitted.models).toEqual(ids.slice(0, kept));
        expect(fitted.modelsOmitted).toBe(200 - kept);
        expect(jsonLength(fitted)).toBeLessThanOrEqual(LIMIT);
        // The next id would not have fit beside the largest count.
        expect(
          jsonLength({ ...row, models: ids.slice(0, kept + 1), modelsOmitted: 200 }),
        ).toBeGreaterThan(LIMIT);
      }
    }
  });

  it('stops at the first id that does not fit, even if a later one would', () => {
    // Six characters left after the first id: not enough for the second, enough for the third.
    const first = 'a'.repeat(roomBeside(3) - 2 - 6);
    const row = createdRow([first, 'b'.repeat(20), 'c']);
    expect(jsonLength(row)).toBeGreaterThan(LIMIT);
    expect(fitModelIds(row)).toEqual({ ...row, models: [first], modelsOmitted: 2 });
  });

  it('leaves room for every digit of the count and every comma', () => {
    // After `a`, the next id would need exactly one character more than is left beside a
    // three-digit count: reserving a one-digit count, or no comma, would take it and run over.
    const b = 'b'.repeat(10);
    const a = 'a'.repeat(roomBeside(150) - JSON.stringify(b).length - 2);
    const row = createdRow([a, b, ...Array.from({ length: 148 }, () => 'z')]);
    const fitted = fitModelIds(row);
    expect(fitted).toEqual({ ...row, models: [a], modelsOmitted: 149 });
    expect(jsonLength({ ...row, models: [a, b], modelsOmitted: 148 })).toBe(LIMIT + 1);
  });

  it('a row over the limit without a model list is left to fitAuditDetails', () => {
    const row = { error: 'e'.repeat(LIMIT) };
    expect(fitModelIds(row)).toBe(row);
  });

  it('counts what JSON escapes', () => {
    const id = '"'.repeat(150); // 302 characters as JSON
    const fitted = fitModelIds(createdRow(Array.from({ length: 20 }, () => id))) as {
      models: string[];
    };
    expect(jsonLength(fitted)).toBeLessThanOrEqual(LIMIT);
    expect(fitted.models).toHaveLength(12);
  });
});

describe('fitAuditDetails (legacy 151)', () => {
  it('returns a row that fits unchanged', () => {
    const details = { model: 'm', completion: 'ok', count: 3 };
    expect(fitAuditDetails(details)).toBe(details);
    const atLimit = { pad: 'p'.repeat(LIMIT - '{"pad":""}'.length) };
    expect(jsonLength(atLimit)).toBe(LIMIT);
    expect(fitAuditDetails(atLimit)).toBe(atLimit);
  });

  it('drops the largest field first and keeps the rest — a base URL survives a long error', () => {
    const url = `https://acme.example.invalid/${'a'.repeat(990)}`;
    const details = {
      upstreamBaseUrl: url,
      modelsJsonError: '\u0001'.repeat(600), // 3602 characters as JSON
      enabled: true,
    };
    const fitted = fitAuditDetails(details);
    expect(fitted).toEqual({
      upstreamBaseUrl: url,
      enabled: true,
      detailsOmitted: ['modelsJsonError'],
    });
  });

  it('drops fields one at a time, largest first, until the row fits', () => {
    const details = {
      small: 's',
      mid: 'm'.repeat(1500),
      big: 'b'.repeat(2600),
      large: { from: 'l'.repeat(2000), to: 'l'.repeat(1000) },
    };
    expect(fitAuditDetails(details)).toEqual({
      small: 's',
      mid: 'm'.repeat(1500),
      detailsOmitted: ['large', 'big'],
    });
  });

  it('stops as soon as the row is exactly at the limit', () => {
    const omittedTail = ',"detailsOmitted":["big"]';
    const keep = 'k'.repeat(LIMIT - '{"keep":""}'.length - omittedTail.length);
    const fitted = fitAuditDetails({ keep, big: 'b'.repeat(LIMIT) });
    expect(fitted).toEqual({ keep, detailsOmitted: ['big'] });
    expect(jsonLength(fitted)).toBe(LIMIT);
  });

  it('a pre-cap base URL in a move is dropped whole and named', () => {
    const details = {
      changed: ['upstream_base_url'],
      enabled: true,
      upstreamBaseUrl: {
        from: `https://old.example.invalid/${'a'.repeat(5000)}`,
        to: 'https://new.example.invalid',
      },
      secretCleared: true,
    };
    const fitted = fitAuditDetails(details);
    expect(fitted).toEqual({
      changed: ['upstream_base_url'],
      enabled: true,
      secretCleared: true,
      detailsOmitted: ['upstreamBaseUrl'],
    });
    expect(jsonLength(fitted)).toBeLessThanOrEqual(LIMIT);
  });

  it('a row whose field names alone are over the limit is left with the names', () => {
    // Not one of this proxy's rows (at most eight fields); pinned so the last step stays defined.
    const details = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`field-${String(i).padStart(9, '0')}`, 'v']),
    );
    expect(fitAuditDetails(details)).toEqual({ detailsOmitted: Object.keys(details) });
  });
});

/** True when `JSON.stringify` had to escape U+0000 or an unpaired surrogate — what Postgres `jsonb`
 *  refuses. A paired surrogate is written as itself, never escaped. */
const hasUnstorableEscape = (value: unknown) =>
  /\\u0000|\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(value));

describe('storableDetails (legacy 825)', () => {
  it('returns a row with nothing to replace unchanged, other control characters and emoji included', () => {
    const details = {
      model: 'model-😀',
      error: 'tab\there, \u0001 and \u001f are stored as they are',
      results: [{ model: 'a', completion: 'ok' }],
      upstreamBaseUrl: { from: 'https://old.example.invalid', to: 'https://new.example.invalid' },
      enabled: true,
      modelsJsonError: null,
    };
    expect(storableDetails(details)).toBe(details);
  });

  it('replaces U+0000 and unpaired surrogates with U+FFFD and names the fields', () => {
    const details = {
      model: 'nul\u0000id',
      // `String(err).slice(0, 200)` can end on the first half of a pair.
      modelsJsonError: `${'e'.repeat(199)}😀`.slice(0, 200),
      lowFirst: 'x\udc00y',
      twoHigh: '\ud800\ud800😀',
      enabled: true,
    };
    const stored = storableDetails(details);
    expect(stored).toEqual({
      model: 'nul\ufffdid',
      modelsJsonError: `${'e'.repeat(199)}\ufffd`,
      lowFirst: 'x\ufffdy',
      twoHigh: '\ufffd\ufffd😀',
      enabled: true,
      detailsReplaced: ['model', 'modelsJsonError', 'lowFirst', 'twoHigh'],
    });
    expect(hasUnstorableEscape(details)).toBe(true);
    expect(hasUnstorableEscape(stored)).toBe(false);
  });

  it('reaches text at any depth, keys included, and leaves the untouched parts as they were', () => {
    const to = { url: 'https://new.example.invalid' };
    const details = {
      upstreamBaseUrl: { from: 'https://old.example.invalid/\u0000', to },
      results: [
        { model: 'ok', completion: 'ok' },
        { model: 'lone\ud83d', completion: 'error' },
      ],
      nested: { 'k\u0000ey': 1 },
      untouched: ['a', 'b'],
    };
    const stored = storableDetails(details) as typeof details & { detailsReplaced: string[] };
    expect(stored.upstreamBaseUrl).toEqual({ from: 'https://old.example.invalid/\ufffd', to });
    expect(stored.upstreamBaseUrl.to).toBe(to);
    expect(stored.results).toEqual([
      { model: 'ok', completion: 'ok' },
      { model: 'lone\ufffd', completion: 'error' },
    ]);
    expect(stored.results[0]).toBe(details.results[0]);
    expect(stored.nested).toEqual({ 'k\ufffdey': 1 });
    expect(stored.untouched).toBe(details.untouched);
    expect(stored.detailsReplaced).toEqual(['upstreamBaseUrl', 'results', 'nested']);
    expect(hasUnstorableEscape(stored)).toBe(false);
  });

  it('a field whose name needs replacing is named as stored', () => {
    expect(storableDetails({ 'bad\u0000name': 'v' })).toEqual({
      'bad\ufffdname': 'v',
      detailsReplaced: ['bad\ufffdname'],
    });
  });
});
