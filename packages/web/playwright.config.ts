import { defineConfig, devices } from '@playwright/test';

/**
 * playwright.config.ts: config for the opt-in acceptance suite (`packages/web/e2e/chat.spec.ts`,
 * docs/development-tasks.md S1.8 deliverable 3). Never run by `pnpm -r test` (CI has no browser
 * and no kernel) — only `pnpm --filter @nexttime/web e2e`, which requires:
 *   - `WEB_E2E_BASE_URL`: the running web app's origin (e.g. `http://127.0.0.1:5173` for
 *     `pnpm --filter @nexttime/web dev`, proxying `/api`/`/ws` to a kernel — see vite.config.ts —
 *     or the caddy origin against a full deployment).
 *   - `WEB_E2E_API_KEY`: a valid API key (human channel) for that kernel's workspace, with a
 *     kernel started `AGENT_RUNTIME=fake` (packages/kernel/src/index.ts) so the acceptance flow's
 *     "see a streamed reply" step has a deterministic, real-time-independent reply to wait for
 *     (packages/kernel/src/application/host-bridge/fake-runtime.ts echoes the prompt back).
 *
 * See README.md's "End-to-end (Playwright)" section for exact commands and how S1.10's
 * `scripts/accept_s1.sh` is expected to wire this up against the host.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_E2E_BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
