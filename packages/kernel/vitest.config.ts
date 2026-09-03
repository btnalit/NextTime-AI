import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.ts';

// The DB-gated integration suites (`describe.runIf(DATABASE_URL !== undefined)`) all share one
// Postgres database, and some of them start a full kernel — outbox dispatcher + FakeAgentRuntime
// (interfaces/ws/server.test.ts, application/outbox/dispatcher.test.ts, application/host-bridge/
// fake-runtime.test.ts) — that consumes *every* workspace's events, which is production behavior
// (one kernel serves all workspaces). Run as parallel worker files, one file's dispatcher can act
// on another file's freshly created Turn: seen in CI as application/chat/service.test.ts's
// paging test finding an extra (echoed) assistant message. Serialize test files whenever a real
// database is configured; the pure unit files (no DATABASE_URL) keep Vitest's default
// parallelism, so local runs are unaffected.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: { fileParallelism: process.env.DATABASE_URL === undefined },
  }),
);
