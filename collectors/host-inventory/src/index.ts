import { loadConfig } from './config.js';
import {
  INITIAL_FAILURE_STREAK,
  describeFailure,
  parseFailureStreakAlert,
  recordFailure,
  recordSuccess,
} from './failure-streak.js';
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
 *
 * S6 (leftover 41 後半): interval mode keeps a consecutive-failure streak (`failure-streak.ts`) —
 * every failed cycle's line carries `consecutiveFailures` and, for a refused kernel call, the
 * HTTP status and error code; at `HOST_INVENTORY_FAILURE_STREAK_ALERT` (default 3) failures in a
 * row the line becomes `level: 'error', message: 'collector failing repeatedly'`. The process
 * still does not exit — the documented contract above — the streak is what makes a week of 401s
 * look different from one hiccup in `docker compose logs`.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.once) {
    await runOnce({ config });
    return;
  }

  const alertAt = parseFailureStreakAlert(process.env.HOST_INVENTORY_FAILURE_STREAK_ALERT);
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'collector started (interval mode)',
      intervalMs: config.intervalMs,
      failureStreakAlertAt: alertAt,
    }),
  );
  let streak = INITIAL_FAILURE_STREAK;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  while (!stopped) {
    try {
      await runOnce({ config });
      streak = recordSuccess(streak);
    } catch (err) {
      streak = recordFailure(streak);
      console.error(JSON.stringify(describeFailure(err, streak, alertAt)));
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
