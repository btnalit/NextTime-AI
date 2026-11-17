import { LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FIELD_MAX_CHARS,
  AUDIT_MODEL_IDS_MAX_CHARS,
  auditedModelIds,
  fitAuditDetails,
} from './audit-details.js';

const jsonLength = (value: unknown) => JSON.stringify(value).length;

describe('auditedModelIds (legacy 151)', () => {
  it('keeps every id of an ordinary list', () => {
    expect(auditedModelIds(['a', 'b', 'c'])).toEqual({ ids: ['a', 'b', 'c'], omitted: 0 });
    expect(auditedModelIds([])).toEqual({ ids: [], omitted: 0 });
  });

  it('keeps the ids that fit AUDIT_MODEL_IDS_MAX_CHARS as JSON, in order, and counts the rest', () => {
    const ids = Array.from(
      { length: 200 },
      (_, i) => `${String(i).padStart(3, '0')}${'m'.repeat(197)}`,
    );
    const { ids: kept, omitted } = auditedModelIds(ids);
    expect(kept).toEqual(ids.slice(0, kept.length));
    expect(kept.length + omitted).toBe(200);
    expect(jsonLength(kept)).toBeLessThanOrEqual(AUDIT_MODEL_IDS_MAX_CHARS);
    // The next id would not have fit.
    expect(jsonLength(ids.slice(0, kept.length + 1))).toBeGreaterThan(AUDIT_MODEL_IDS_MAX_CHARS);
  });

  it('a list exactly at the budget is kept whole; one character more drops the last id', () => {
    // ["…","…"]: 2 brackets + 2 × (id + 2 quotes) + 1 comma.
    const idLength = (AUDIT_MODEL_IDS_MAX_CHARS - 2 - 1) / 2 - 2;
    const exact = ['x'.repeat(Math.floor(idLength)), 'y'.repeat(Math.ceil(idLength))];
    expect(jsonLength(exact)).toBe(AUDIT_MODEL_IDS_MAX_CHARS);
    expect(auditedModelIds(exact)).toEqual({ ids: exact, omitted: 0 });
    const over = [exact[0] as string, `${exact[1]}z`];
    expect(auditedModelIds(over)).toEqual({ ids: [exact[0]], omitted: 1 });
  });

  it('counts what JSON escapes', () => {
    const id = '"'.repeat(150); // 302 characters as JSON
    const { ids: kept } = auditedModelIds(Array.from({ length: 10 }, () => id));
    expect(jsonLength(kept)).toBeLessThanOrEqual(AUDIT_MODEL_IDS_MAX_CHARS);
    expect(kept).toHaveLength(6);
  });
});

describe('fitAuditDetails (legacy 151)', () => {
  it('returns a row that fits unchanged', () => {
    const details = { model: 'm', completion: 'ok', count: 3 };
    expect(fitAuditDetails(details)).toBe(details);
    const atLimit = { pad: 'p'.repeat(LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS - '{"pad":""}'.length) };
    expect(jsonLength(atLimit)).toBe(LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS);
    expect(fitAuditDetails(atLimit)).toBe(atLimit);
  });

  it('a row over the limit keeps its small fields and names the ones it dropped', () => {
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
    expect(jsonLength(fitted)).toBeLessThanOrEqual(LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS);
  });

  it('keeps a field of exactly AUDIT_FIELD_MAX_CHARS as JSON and drops one a character longer', () => {
    const at = 'k'.repeat(AUDIT_FIELD_MAX_CHARS - 2);
    const fitted = fitAuditDetails({ at, over: `${at}k`, pad: 'p'.repeat(5000) });
    expect(fitted).toEqual({ at, detailsOmitted: ['over', 'pad'] });
  });

  it('a row whose small fields alone are still over the limit only names its fields', () => {
    const details = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field${i}`, 'v'.repeat(AUDIT_FIELD_MAX_CHARS - 2)]),
    );
    const fitted = fitAuditDetails(details);
    expect(fitted).toEqual({ detailsOmitted: Object.keys(details) });
    expect(jsonLength(fitted)).toBeLessThanOrEqual(LLM_ADMIN_AUDIT_DETAILS_MAX_CHARS);
  });
});
