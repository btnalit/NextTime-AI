import { describe, expect, it } from 'vitest';
import { EvaluationContentWithheldError } from './errors.js';
import {
  SEAL_SPAN_CHARS,
  SealSpanIndex,
  canariesIn,
  normalizeSealText,
  sealStrings,
} from './span-index.js';

/**
 * application/eval-seal/span-index.test: the pure half of the evaluation seal (S10 E3-1c) — what
 * normalizing does and does not fold, when a run of holdout text counts as copied (a whole
 * {@link SEAL_SPAN_CHARS}-character window, anywhere in a longer string), and that the index and
 * the refusal hold none of the text.
 */

const HOLDOUT =
  'Drain the zephyr-quokka pool on rack nine before rotating its relay keys, then confirm.';

function indexOf(...texts: string[]): SealSpanIndex {
  const index = new SealSpanIndex();
  for (const text of texts) index.add(text);
  return index;
}

describe('normalizeSealText', () => {
  it('folds width, case and whitespace runs, and trims', () => {
    expect(normalizeSealText('  ＤＲＡＩＮ\tthe\n\n  Pool  ')).toBe('drain the pool');
  });

  it('leaves wording, punctuation and order alone', () => {
    expect(normalizeSealText('Pool, drain the.')).toBe('pool, drain the.');
  });
});

describe('sealStrings', () => {
  it('collects every string leaf and object key, nested', () => {
    expect(sealStrings({ a: ['x', { 'key two': 'y' }], n: 3, nil: null, ok: true }).sort()).toEqual(
      ['a', 'key two', 'n', 'nil', 'ok', 'x', 'y'].sort(),
    );
  });

  it('reads a bare string as itself', () => {
    expect(sealStrings('just this')).toEqual(['just this']);
  });
});

describe('canariesIn', () => {
  it('finds a canary anywhere in normalized text', () => {
    const canary = `NTEVAL-${'ab12'.repeat(8)}`;
    expect(canariesIn(normalizeSealText(`see ${canary}, then stop`))).toEqual([
      canary.toLowerCase(),
    ]);
  });

  it('finds none in text without one', () => {
    expect(canariesIn('nteval- is not a canary on its own')).toEqual([]);
  });
});

describe('SealSpanIndex', () => {
  it('holds a verbatim run of a whole window, wherever it sits in a longer text', () => {
    const index = indexOf(HOLDOUT);
    const run = HOLDOUT.slice(10, 10 + SEAL_SPAN_CHARS);
    expect(index.holdsWindowOf(normalizeSealText(`a log line says: ${run} — and goes on`))).toBe(
      true,
    );
  });

  it('holds it re-cased, re-spaced and in full-width forms', () => {
    const index = indexOf(HOLDOUT);
    const disguised = 'DRAIN  the\nZEPHYR-QUOKKA pool  on rack ｎｉｎｅ before ROTATING';
    expect(index.holdsWindowOf(normalizeSealText(disguised))).toBe(true);
  });

  it('does not hold a run one character shorter than a window', () => {
    const index = indexOf(HOLDOUT);
    const run = normalizeSealText(HOLDOUT).slice(0, SEAL_SPAN_CHARS - 1);
    expect(index.holdsWindowOf(`${run}`)).toBe(false);
    expect(index.holdsWindowOf(`${run} and something else entirely different`)).toBe(false);
  });

  it('does not hold text that merely shares words', () => {
    const index = indexOf(HOLDOUT);
    expect(
      index.holdsWindowOf(
        normalizeSealText('Rotate the relay keys on rack nine, then drain the pool and confirm.'),
      ),
    ).toBe(false);
  });

  it('holds nothing from a text shorter than a window', () => {
    const index = indexOf('short holdout title');
    expect(index.size).toBe(0);
    expect(index.holdsWindowOf(normalizeSealText(`${'short holdout title'.repeat(4)}`))).toBe(
      false,
    );
  });

  it('keeps one key per distinct window and no text', () => {
    const index = indexOf(HOLDOUT);
    expect(index.size).toBe(normalizeSealText(HOLDOUT).length - SEAL_SPAN_CHARS + 1);
    // Nothing enumerable, nothing a serializer or inspector shows of the text.
    expect(Object.keys(index)).toEqual([]);
    expect(JSON.stringify(index)).toBe('{}');
    expect(JSON.stringify(index)).not.toContain('zephyr');
  });

  it('matches across texts of many characters (surrogate pairs and CJK included)', () => {
    const mixed =
      '把 zephyr-quokka 池子排空之后再轮换中继密钥，最后确认一下 🙂 状态是否恢复正常了吗';
    const index = indexOf(mixed);
    expect(index.holdsWindowOf(normalizeSealText(`前缀 ${mixed} 后缀`))).toBe(true);
    expect(index.holdsWindowOf(normalizeSealText(mixed.slice(0, SEAL_SPAN_CHARS - 1)))).toBe(false);
  });
});

describe('EvaluationContentWithheldError', () => {
  it('says where it was stopped and nothing of what', () => {
    for (const err of [
      new EvaluationContentWithheldError('capability_result'),
      new EvaluationContentWithheldError('capability_result', false),
      new EvaluationContentWithheldError('capability_error'),
      new EvaluationContentWithheldError('worker_start'),
      new EvaluationContentWithheldError('entry_turn'),
    ]) {
      expect(err.code).toBe('evaluation_content_withheld');
      expect(err.message).toMatch(/reserved for evaluation/);
      expect(Object.keys(err).sort()).toEqual(['code', 'name', 'recorded', 'rolledBack', 'where']);
    }
    expect(new EvaluationContentWithheldError('capability_result').message).toMatch(/rolled back/);
    expect(new EvaluationContentWithheldError('capability_result', false).message).toMatch(
      /took effect/,
    );
  });
});
