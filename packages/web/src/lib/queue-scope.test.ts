import { describe, expect, it } from 'vitest';
import type { Translate } from './i18n.js';
import {
  actionTargetHoldsText,
  actionTargetOrSystemText,
  actionTargetText,
  operationQueueScopeShortText,
  operationQueueScopeText,
} from './queue-scope.js';

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('lib/queue-scope (S11 GO12)', () => {
  it('names a request’s instance, or the whole system', () => {
    const container = { objectType: 'Container', identity: ['c1'] };
    expect(actionTargetText(container, zh)).toBe('Container「c1」');
    expect(actionTargetText(container, en)).toBe('Container “c1”');
    expect(actionTargetText({ objectType: 'Thing', identity: ['eu', 7] }, zh)).toBe(
      'Thing「eu」「7」',
    );
    expect(actionTargetOrSystemText(null, zh)).toBe('整个系统');
    expect(actionTargetOrSystemText(null, en)).toBe('The whole system');
    // The caller's own value: unseen characters shown, a long one clipped.
    expect(actionTargetText({ objectType: 'Container', identity: ['a​b'] }, zh)).toBe(
      'Container「a\\u{200B}b」',
    );
    expect(actionTargetText({ objectType: 'Container', identity: ['x'.repeat(60)] }, zh)).toBe(
      `Container「${'x'.repeat(40)}…」`,
    );
  });

  it('says what a request holds back while it has not finished', () => {
    expect(actionTargetHoldsText({ objectType: 'Container', identity: ['c1'] }, zh)).toBe(
      '同一个 Container 上后来的请求要等它有了结果再执行；别的 Container 上的请求不等它。',
    );
    expect(actionTargetHoldsText(null, zh)).toBe('这个系统上后来的请求都要等它有了结果再执行。');
  });

  it('says an Operation’s queue scope in a few words and as a sentence', () => {
    const container = { objectType: 'Container', params: ['id'] };
    expect(operationQueueScopeShortText(container, zh)).toBe('按 Container（id）');
    expect(operationQueueScopeShortText({ objectType: 'Thing', params: ['zone', 'id'] }, en)).toBe(
      'Per Thing (zone, id)',
    );
    expect(operationQueueScopeShortText(null, zh)).toBe('整个系统');
    expect(operationQueueScopeShortText(undefined, en)).toBe('Whole system');
    expect(operationQueueScopeText(container, zh)).toBe(
      '按目标：Container（参数 id）。同一个 Container 上的请求按提出顺序执行；不同 Container 上的请求各自排队，互不等待。',
    );
    expect(operationQueueScopeText({ objectType: 'Thing', params: ['zone', 'id'] }, en)).toContain(
      'Per target: Thing (params zone, id).',
    );
    expect(operationQueueScopeText(undefined, zh)).toBe(
      '整个系统：这个系统上的请求按提出顺序逐个执行。',
    );
  });
});
