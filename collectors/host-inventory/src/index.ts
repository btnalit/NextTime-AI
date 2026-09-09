import { loadConfig } from './config.js';
import { runOnce } from './run.js';

/**
 * index: CLI entry point (docs/development-tasks.md S3.3 — "Runs once per invocation (--once) or
 * on an interval env"). `--once` runs a single collection cycle and exits with that cycle's own
 * exit code; without it, this process loops on `HOST_INVENTORY_INTERVAL_MS` until terminated
 * (SIGTERM/SIGINT — `docker compose stop`'s own default signal), logging each cycle's own
 * success/failure without exiting the process on a single cycle's failure (a transient Docker/
 * kernel-network hiccup should not kill a long-running collector; `--once` mode, by contrast, is
 * meant for a host cron/systemd-timer-driven invocation, where "this run failed" must be this
 * process's own exit code).
 */

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.once) {
    await runOnce({ config });
    return;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      message: 'collector started (interval mode)',
      intervalMs: config.intervalMs,
    }),
  );
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopped) {
    try {
      await runOnce({ config });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'collection cycle failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'fatal',
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exitCode = 1;
});
