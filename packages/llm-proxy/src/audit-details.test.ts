import { LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import { fitAuditDetails, fitModelIds } from './audit-details.js';

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
