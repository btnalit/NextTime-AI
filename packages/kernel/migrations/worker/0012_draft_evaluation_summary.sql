-- module: worker, version: 0012
--
-- 0012_draft_evaluation_summary (S10 E3-3: docs/s10-evolution-plan-2026-10-04.md §3.1 EvalRun,
-- §3.2 "EvalRun generated 一条摘要 Observation，作为发布审阅的 Evidence", §3.3 I-E4, §5.5 封闭 /
-- 结果去哪). What a draft evaluation leaves when it finishes, beside its verdict:
--
--   * `summary_observation_id` — the one Observation the graph holds of it: its verdict, the draft
--     it evaluated (family, version, content digest) and its id, never a case. Recorded under an
--     Activity of `kind = 'evaluation'` from the workspace's evaluation Source, which is private to
--     the evaluation Principal — no other Principal's transaction reads the row (RLS on
--     `observations`), so no read an agent reaches can show the verdict it carries. A publish made
--     on the evaluation names it in its audit record (application/eval/publish-evidence.ts).
--   * `dev_verdict` — what the draft's proposer, and an agent acting for them, is told: the
--     evaluation's own rules read on its `dev` cases alone (`@nexttime/shared` wire/eval.ts
--     `DRAFT_EVALUATION_DEV_VERDICT_VALUES` says how). `get_skill_draft_verdicts` (Handle channel)
--     reads this column and nothing else of the row's outcome.
--
-- Checks: both are set together, and only on a finished evaluation; the 0010 guard already keeps
-- an ended evaluation from changing, so the update that finishes it is the only one that sets them.
-- Neither is required of a finished row: one that finished before this migration has neither, and
-- the previous release finishes evaluations without them.
--
-- Reversible: two nullable columns nothing earlier reads or writes, and checks every row the
-- previous release writes satisfies (it sets neither). Rolled back, evaluations it finishes have no
-- summary Observation and no dev verdict — `get_skill_draft_verdicts` lists none of them. One
-- declared delta (migrations/reversibility-deltas.json, docs/runbooks/release.md §6): the foreign
-- key into `observations` is one the previous release's observation compaction does not know, and
-- it refuses to run (fail-closed) until this release is applied again — nothing is deleted.
--
-- The workspace purge cascade (application/platform/purge-workspace.ts) orders its deletes by the
-- live foreign keys: `eval_draft_evaluations` goes before `observations`.
--
-- Advisory lock: same module key as 0001–0011.
select pg_advisory_xact_lock(7241000501);

alter table eval_draft_evaluations
  add column if not exists summary_observation_id uuid,
  add column if not exists dev_verdict text;

alter table eval_draft_evaluations drop constraint if exists eval_draft_evaluations_summary;
alter table eval_draft_evaluations add constraint eval_draft_evaluations_summary check (
  (summary_observation_id is null) = (dev_verdict is null)
  and (dev_verdict is null or status = 'finished')
  and (dev_verdict is null or dev_verdict in (
    'regressed', 'refuted', 'worse', 'better', 'non_inferior', 'inconclusive', 'unmeasured'))
);

alter table eval_draft_evaluations
  drop constraint if exists eval_draft_evaluations_summary_observation;
alter table eval_draft_evaluations add constraint eval_draft_evaluations_summary_observation
  foreign key (workspace_id, summary_observation_id) references observations (workspace_id, id);

-- The observation compaction's reference probe (application/platform/compact-observations.ts,
-- condition (a)): the summary of an evaluation is never deleted.
create index if not exists eval_draft_evaluations_summary_observation_idx
  on eval_draft_evaluations (workspace_id, summary_observation_id)
  where summary_observation_id is not null;
