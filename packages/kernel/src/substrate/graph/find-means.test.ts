import { describe, expect, it } from 'vitest';
import { MAX_FIND_MEANS_TOKENS, buildFindMeansQuery, tokenizeNeed } from './find-means.js';

/**
 * Unit tests (no database) for `find-means.ts`'s pure halves — `tokenizeNeed` and
 * `buildFindMeansQuery` — docs/development-tasks.md S8 W2-K1 (leftover 71, audit B3): "find_* 用
 * need 做子串 ILIKE，自然语言需求几乎不可能命中". Real end-to-end ranking/matching behaviour against
 * Postgres is covered by `find-means.integration.test.ts` (DB-gated); this file exercises the pure
 * builders directly, same split `queries.test.ts`/`sql-store.test.ts` already establish for the
 * rest of this layer.
 */

describe('tokenizeNeed', () => {
  it('blank need tokenises to no tokens (caller\'s "match everything" case)', () => {
    expect(tokenizeNeed('')).toEqual([]);
    expect(tokenizeNeed('   ')).toEqual([]);
  });

  it('English need: splits on whitespace, lower-cases, drops punctuation', () => {
    expect(tokenizeNeed('Restart the Container!')).toEqual(['restart', 'the', 'container']);
  });

  it('Chinese need: a CJK run becomes the whole run plus every 2-char sliding-window substring', () => {
    expect(tokenizeNeed('重启容器')).toEqual(['重启容器', '重启', '启容', '容器']);
  });

  it('a single CJK character has no shorter substring to add', () => {
    expect(tokenizeNeed('门')).toEqual(['门']);
  });

  it('mixed English/Chinese need: each script run tokenised by its own rule', () => {
    expect(tokenizeNeed('restart 容器')).toEqual(['restart', '容器']);
  });

  it('two separate CJK runs (need has ASCII punctuation between them) tokenise independently', () => {
    // "备份" (2 chars): whole run and its only bigram are identical, so it collapses to one token.
    // "数据库" (3 chars): whole run plus its two bigrams.
    expect(tokenizeNeed('备份,数据库')).toEqual(['备份', '数据库', '数据', '据库']);
  });

  it('duplicate tokens are de-duplicated, first-seen order kept', () => {
    expect(tokenizeNeed('docker docker 容器容器')).toEqual(['docker', '容器容器', '容器', '器容']);
  });

  it('caps the token count at MAX_FIND_MEANS_TOKENS', () => {
    const need = Array.from({ length: MAX_FIND_MEANS_TOKENS + 20 }, (_, i) => `word${i}`).join(' ');
    expect(tokenizeNeed(need)).toHaveLength(MAX_FIND_MEANS_TOKENS);
  });
});

describe('buildFindMeansQuery', () => {
  it('blank need (no tokens): where degrades to true, rank expression to the constant 0', () => {
    const q = buildFindMeansQuery('WorkerDefinition', 'ws1', [], 20);
    expect(q.text).toContain('and true');
    expect(q.text).toContain('order by (0) desc, updated_at desc');
    expect(q.values).toEqual(['ws1', 'WorkerDefinition', false, 20]);
  });

  it('one token: matches name/description, one rank term, one bound ILIKE pattern', () => {
    const q = buildFindMeansQuery('WorkerDefinition', 'ws1', ['docker'], 20);
    expect(q.text).toContain("properties ->> 'name' ilike $3");
    expect(q.text).toContain("properties ->> 'description' ilike $3");
    expect(q.text).toContain('case when');
    expect(q.values).toEqual(['ws1', 'WorkerDefinition', '%docker%', false, 20]);
  });

  it('ranking order: the rank expression sums one case-when term per token (more distinct hits ranks higher)', () => {
    const q = buildFindMeansQuery('Procedure', 'ws1', ['restart', 'container'], 10);
    const rankLine = q.text.split('\n').find((line) => line.includes('order by'));
    expect(rankLine).toBeDefined();
    // Two tokens -> two summed case-when terms in the rank expression.
    expect((rankLine?.match(/case when/g) ?? []).length).toBe(2);
    expect(q.values).toEqual(['ws1', 'Procedure', '%restart%', '%container%', false, 10]);
  });

  it("Operation additionally matches `mode` (kind) and, via a correlated exists, its Gatekeeper's own name", () => {
    const q = buildFindMeansQuery('Operation', 'ws1', ['docker'], 20);
    expect(q.text).toContain("properties ->> 'mode' ilike $3");
    expect(q.text).toContain("gk.object_type = 'Gatekeeper'");
    expect(q.text).toContain("gk.properties ->> 'name' ilike $3");
  });

  it('Operation is published-only; WorkerDefinition/Procedure are not filtered by status', () => {
    const op = buildFindMeansQuery('Operation', 'ws1', [], 20);
    expect(op.values).toEqual(['ws1', 'Operation', true, 20]);
    const wd = buildFindMeansQuery('WorkerDefinition', 'ws1', [], 20);
    expect(wd.values).toEqual(['ws1', 'WorkerDefinition', false, 20]);
  });

  it('no-hit shape: a token that matches nothing is still a normal bound parameter (no special-casing)', () => {
    const q = buildFindMeansQuery('WorkerDefinition', 'ws1', ['zzz-no-such-keyword'], 20);
    expect(q.values).toContain('%zzz-no-such-keyword%');
  });
});
