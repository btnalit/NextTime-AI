-- module: llm-usage, version: 0003
--
-- Refused model calls are metered (legacy 589). Until now llm-proxy only logged a call it refused
-- because the workspace's daily budget was spent (402 `budget_exhausted`, S6-B leftover 19); the
-- kernel never learned of it. A Worker whose every model call was refused still settled, worker
-- mode posted its synthesized contract, and the Task completed: an evaluation trial scored that
-- empty answer as `failed`, a goal step judged it, and an entry Turn ended `completed` with no
-- reply. llm-proxy now reports each such call as a usage record with `status = 'refused'`, no
-- tokens and no cost, and the scope that refused it; the kernel fails a Task whose Worker session
-- has refused calls and no completed one with `model_refused`, and ends such an entry Turn failed
-- with a system message (governance/llm-usage/service.ts `sessionRefusedOnly` / `entryTurnRefusedOnly`).
--
--   `refusal_scope` — which budget refused the call: `workspace_daily_tokens`
--   (`LLM_DAILY_TOKEN_BUDGET`) or `workspace_daily_cost` (`task.daily_cost_budget_usd`); the
--   values of `LLM_REFUSAL_SCOPE_VALUES` (packages/shared/src/enums.ts). Set exactly on a refused
--   row, and a refused row carries no tokens and no cost (`llm_usage_refusal`): a refusal never
--   reaches the provider, so it must not move a budget, a Task's token count or a trial's cost.
--
-- Lock: `add column` without a default is catalog-only. The CHECK is added `not valid` (catalog
-- only) and validated in the same transaction: validation reads the table once under SHARE UPDATE
-- EXCLUSIVE, which does not block the inserts llm-proxy keeps sending. No existing row is
-- refused, so it holds on every one. The two indexes are partial on `status = 'refused'`: each
-- build reads the table once under SHARE (llm-proxy's inserts wait for that read; its reporter
-- retries) and writes nothing.
--
-- Rolling back (docs/runbooks/release.md §6). The previous release's kernel never writes
-- `refusal_scope` and never writes `status = 'refused'`, so it inserts under this schema
-- unchanged. Never roll back the kernel alone: its strict usage schema refuses a whole batch that
-- holds a record carrying `refusalScope`, so this llm-proxy's queue fills (1000 records) and then
-- drops real usage with it, and the budgets undercount. The previous llm-proxy ships with it (the
-- two always ship in one release). The default rollback keeps the schema and the refused rows
-- already stored: they are the evidence of runs the platform refused, they carry no tokens and no
-- cost, so the previous code's budget sums are unchanged; its model-call counts (platform runtime
-- `callCount`, scripts/report-usage.sh) count them as calls. Dropping the schema too is optional
-- and loses them: re-applying this migration validates `llm_usage_refusal`, which a refused row
-- without a scope fails, so they go with it (export them first if they are still needed). With
-- the kernel stopped, in one transaction: drop the indexes `llm_usage_refused_session_idx` and
-- `llm_usage_refused_turn_idx` and the constraint `llm_usage_refusal`, `delete from llm_usage where status = 'refused'`, `alter table
-- llm_usage drop column refusal_scope`, then `delete from schema_migrations where module =
-- 'llm-usage' and version = 3`.
--
-- Runner ordering / advisory lock: same module (`llm-usage`), same key as 0001–0002.
select pg_advisory_xact_lock(7241000301);

alter table llm_usage add column if not exists refusal_scope text;

alter table llm_usage drop constraint if exists llm_usage_refusal;
alter table llm_usage add constraint llm_usage_refusal check (
  (status = 'refused') = (refusal_scope is not null)
  and (refusal_scope is null or refusal_scope in ('workspace_daily_tokens', 'workspace_daily_cost'))
  and (
    status <> 'refused'
    or (
      input_tokens = 0 and output_tokens = 0
      and coalesce(cache_read_tokens, 0) = 0 and coalesce(cache_write_tokens, 0) = 0
      and coalesce(cost_usd, 0) = 0
    )
  )
) not valid;
alter table llm_usage validate constraint llm_usage_refusal;

-- The Task check asks "did this session have a refused call" on every Worker result, the entry-Turn
-- check "did this Turn have one" on every Turn that ends completed: a partial index for each keeps
-- that a lookup however many refused rows a workspace has piled up, and they hold only refused rows.
-- (The second half of either check, "was any call answered", runs only after a refusal was found.)
create index if not exists llm_usage_refused_session_idx
  on llm_usage (workspace_id, session_id)
  where status = 'refused';
create index if not exists llm_usage_refused_turn_idx
  on llm_usage (workspace_id, turn_id)
  where status = 'refused';
