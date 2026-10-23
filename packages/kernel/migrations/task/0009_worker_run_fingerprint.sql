-- module: task, version: 0009
--
-- 0009_worker_run_fingerprint (S11 W1a, docs/global-roadmap-2026-10-16.md W1a "运行指纹"): what
-- each WorkerRun ran with, so outcomes can later be compared between runs that ran the same thing
-- (E2) and an upgrade's effect on them can be seen at all. Recorded per WorkerRun, not per Task: a
-- Task's crash retry is a second WorkerRun that may start after an upgrade.
--
--   * `run_spec` — the kernel's half, written by `spawnWorkerRun` (application/task/spawn.ts) in
--     the INSERT that creates the run: WorkerDefinition id@version, the model asked for (null = the
--     runtime's default), the runtime image asked for (null = worker-supervisor's default), the
--     sha256 of the composed system prompt and the platform build (`KERNEL_VERSION`). Never a
--     prompt, an input or a credential.
--   * `runtime_report` — worker-supervisor's half, what it reported about the container it started
--     (packages/worker-supervisor/src/runtime-report.ts): the image reference, the image id it
--     resolved to, the image's version labels and the digest of the mounted `models.json`. Written
--     in the same UPDATE that moves the run `provisioning → running`; stays NULL for a run that
--     never started.
--   * `environment_digest` — `v1:` + sha256 over the WorkerDefinition version, the effective model,
--     the image id, the platform build and the prompt digest (application/task/run-fingerprint.ts).
--     Written with `runtime_report`, NULL when one of those is unknown. The key E2 groups runs by.
--
-- Each is written once: `run_spec` only at INSERT, the other two only from NULL and only in the
-- `provisioning → running` UPDATE. A trigger refuses every other change.
--
-- Nullable, no backfill: a run from before this migration reads "未记录". Reversibility: the
-- previous release names its columns on every insert and select of `worker_runs` and never sets
-- these; the trigger fires only on an UPDATE that names one of them, and the CHECKs hold for its
-- rows (all NULL).
--
-- Cross-process bootstrap lock: same `task`-module key as 0001–0008.
select pg_advisory_xact_lock(7241000401);

alter table worker_runs add column if not exists run_spec jsonb;
alter table worker_runs add column if not exists runtime_report jsonb;
alter table worker_runs add column if not exists environment_digest text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'worker_runs_run_spec_object') then
    alter table worker_runs add constraint worker_runs_run_spec_object check (
      run_spec is null or jsonb_typeof(run_spec) = 'object'
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'worker_runs_runtime_report_object') then
    alter table worker_runs add constraint worker_runs_runtime_report_object check (
      runtime_report is null
      or (jsonb_typeof(runtime_report) = 'object' and run_spec is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'worker_runs_environment_digest') then
    alter table worker_runs add constraint worker_runs_environment_digest check (
      environment_digest is null
      or (environment_digest ~ '^v[0-9]+:[0-9a-f]{64}$' and runtime_report is not null)
    );
  end if;
end
$$;

-- E2 groups a Skill version's runs by environment.
create index if not exists worker_runs_environment_digest_idx
  on worker_runs (workspace_id, environment_digest)
  where environment_digest is not null;

create or replace function worker_runs_fingerprint_write_once() returns trigger
language plpgsql as $$
begin
  if new.run_spec is distinct from old.run_spec
     or (old.runtime_report is not null
         and new.runtime_report is distinct from old.runtime_report)
     or (old.environment_digest is not null
         and new.environment_digest is distinct from old.environment_digest) then
    raise exception 'worker_runs: a run''s recorded configuration and runtime never change';
  end if;
  -- The supervisor's half arrives with the run's start, and only then.
  if ((old.runtime_report is null and new.runtime_report is not null)
      or (old.environment_digest is null and new.environment_digest is not null))
     and not (old.status = 'provisioning' and new.status = 'running') then
    raise exception 'worker_runs: a run''s runtime is recorded only as it starts';
  end if;
  return new;
end;
$$;

create or replace trigger worker_runs_fingerprint_write_once
  before update of run_spec, runtime_report, environment_digest on worker_runs
  for each row execute function worker_runs_fingerprint_write_once();
