/**
 * wire/index: the wire-resource schema library (docs/wire-contract-conventions.md §5, S3.7 "使用
 * 共享的资源 schema... 一处定义，被结果与推送事件复用"). Every capability `resultSchema` in
 * `capabilities.ts` that returns a named platform resource, and every WS push event in
 * `events.ts` whose payload is that same resource (or an exact subset of it), imports from here —
 * never a second, independently-typed copy of the same shape.
 */

export * from './chat.js';
export * from './graph.js';
export * from './governance.js';
export * from './connection.js';
export * from './task.js';
export * from './worker.js';
export * from './identity.js';
