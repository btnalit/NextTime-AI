import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.ts';

// S3.6 CI fix: this package now has three `*.sdk.test.ts` files (entry/worker/interactive) that
// each load the real pi SDK, register a faux provider, and drive one or more real Agent Sessions
// end-to-end — legitimately CPU-heavy (~1s each on an unloaded dev machine). Vitest runs test
// files in parallel by default; three of these contending for CPU on a resource-constrained CI
// runner pushed `entry.sdk.test.ts` (pre-existing, unrelated to this task's own changes) past the
// 5000ms default `testTimeout` in CI, even though every test here still runs in ~1s locally — a
// resource-contention timeout, not a hang or a real regression (`interactive.sdk.test.ts`, added
// alongside `entry.sdk.test.ts`/`worker.sdk.test.ts` by this same task, is what tipped the count
// from two to three). A generous, package-scoped ceiling fixes the flake without masking an actual
// hang (30s is far beyond any real-SDK test's own ~1s local runtime).
export default mergeConfig(baseConfig, defineConfig({ test: { testTimeout: 30_000 } }));
