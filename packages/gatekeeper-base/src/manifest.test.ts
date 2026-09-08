import { describe, expect, it } from 'vitest';
import { parseManifestJson } from './manifest.js';

const validOperation = {
  name: 'stock.get',
  binding: { kind: 'http', method: 'GET', path: '/stock' },
  params_schema: {},
  mode: 'observe',
  blast_radius: 'low',
  reversibility: false,
  auto_approvable: true,
  await_decision: false,
  reads: [],
  writes: [],
};

describe('parseManifestJson (review lane 5, P3 batch)', () => {
  it('parses a valid manifest array', () => {
    const operations = parseManifestJson(JSON.stringify([validOperation]), 'test.json');
    expect(operations).toHaveLength(1);
    expect(operations[0]?.name).toBe('stock.get');
  });

  it('throws a clear error for invalid JSON', () => {
    expect(() => parseManifestJson('{not json', 'test.json')).toThrow(/not valid JSON/);
  });

  it('throws when the top level is not an array', () => {
    expect(() => parseManifestJson(JSON.stringify(validOperation), 'test.json')).toThrow(
      /must be a JSON array/,
    );
  });

  it('throws, naming the entry index and name, when an entry fails OperationSchema validation', () => {
    const broken = { ...validOperation, mode: 'not-a-real-mode' };
    expect(() => parseManifestJson(JSON.stringify([validOperation, broken]), 'test.json')).toThrow(
      /entry 1 \(name: stock\.get\)/,
    );
  });

  it('throws for an entry missing required fields entirely', () => {
    expect(() => parseManifestJson(JSON.stringify([{ name: 'x' }]), 'test.json')).toThrow(
      /entry 0/,
    );
  });
});
