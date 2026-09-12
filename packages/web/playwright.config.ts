import { defineConfig, devices } from '@playwright/test';

/**
 * playwright.config.ts: config for the opt-in acceptance suite (`packages/web/e2e/*.spec.ts`,
 * docs/development-tasks.md S1.8 deliverable 3). Not part of `pnpm -r test`/the `quality`/`test`
 * CI jobs (no browser, no kernel there) — run via `pnpm --filter @nexttime/web e2e`, either by
 * hand against a host you started yourself (see README.md "End-to-end (Playwright)") or by
 * `.github/workflows/e2e.yml`, which brings up a throwaway `AGENT_RUNTIME=fake` stack in the CI
 * runner itself and passes:
 *   - `WEB_E2E_BASE_URL`: the running web app's origin (e.g. `http://127.0.0.1:5173` for
 *     `pnpm --filter @nexttime/web dev`, proxying `/api`/`/ws` to a kernel — see vite.config.ts —
 *     or a caddy origin, `https://<host>:8443`, against a full deployment / the CI stack).
 *   - `WEB_E2E_API_KEY`: a valid API key (human channel) for that kernel's workspace, with a
 *     kernel started `AGENT_RUNTIME=fake` (packages/kernel/src/index.ts) so the acceptance flow's
 *     "see a streamed reply" step has a deterministic, real-time-independent reply to wait for
 *     (packages/kernel/src/application/host-bridge/fake-runtime.ts echoes the prompt back).
 *
 * See README.md's "End-to-end (Playwright)" section for exact commands, docs/runbooks/
 * web-console.md's "CI（Playwright）" section for how `.github/workflows/e2e.yml` wires this up,
 * and how S1.10's `scripts/accept_s1.sh` bootstraps the same kind of workspace by hand.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Every spec here drives one shared kernel/Postgres (a real deployment, or the throwaway CI
  // stack) and several assume exclusive access to server-side state a second concurrent test
  // could perturb (e.g. approvals.spec.ts's own "the most recently created Chat" — see its doc
  // comment). `fullyParallel: false` alone only serializes tests *within* one file; Playwright's
  // default worker count still runs separate spec files concurrently. Forced to 1 after the first
  // real `.github/workflows/e2e.yml` run showed chat.spec.ts's Turn taking long enough under a
  // second worker's concurrent CPU/DB load on a shared runner to blow its own 15s settle timeout
  // — this suite's total runtime is small enough that trading a little wall-clock time for
  // determinism is the right call.
  workers: 1,
  // One retry in CI only (W7, e2e.yml's own comment): a retried-then-passed test is reported as
  // "flaky" in the always-uploaded HTML report rather than failing a required check outright; a
  // local run keeps 0 so a real regression is never masked while iterating.
  retries: process.env.CI ? 1 : 0,
  // CI additionally gets an HTML report written to disk (never auto-opened — `open: 'never'`) so
  // `.github/workflows/e2e.yml` has something to upload as an artifact on failure; local runs stay
  // console-only, matching this suite's existing convention.
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: process.env.WEB_E2E_BASE_URL,
    trace: 'retain-on-failure',
    // Every target this suite runs against — a `docker compose up` deployment or the CI stack —
    // serves the web UI through caddy's own internal-CA, self-signed TLS (deploy/caddy/Caddyfile
    // `tls internal { on_demand }`; docs/runbooks/web-console.md), never a publicly trusted cert.
    // Relaxing verification here (once, for every test) is the documented alternative to
    // importing that internal root CA into the runner's trust store.
    ignoreHTTPSErrors: true,
  },
  // Two projects for one browser, purely to pin file order. Playwright discovers spec files
  // alphabetically (`approvals`, `chat`, `explorer`, `governance`, `login`, `workspaces`), and
  // login.spec.ts's last test deliberately locks the `admin` account for five minutes
  // (`LOGIN_LOCK_MINUTES`, packages/kernel/src/application/identity/users.ts) — which
  // workspaces.spec.ts, alphabetically after it, would then run head-first into on its own `admin`
  // sign-in. `dependencies` is the documented way to say "this project runs after that one": every
  // other spec runs in `chromium`, login.spec.ts alone in `chromium-login` behind it. Note the
  // trade this makes: a genuine failure anywhere in `chromium` now *skips* `chromium-login` rather
  // than running it and reporting both.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /login\.spec\.ts$/,
    },
    {
      name: 'chromium-login',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /login\.spec\.ts$/,
      dependencies: ['chromium'],
    },
  ],
});
