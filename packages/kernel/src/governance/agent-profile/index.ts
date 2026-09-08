/**
 * governance/agent-profile: AgentProfile/AgentPolicy storage and resolution (design doc-adjacent —
 * S3.13, docs/development-tasks.md "每用户智能体配置：AgentProfile / AgentPolicy"). `resolve.ts` is
 * pure (no IO): `resolveEffectiveAgentProfile()` applies a workspace's AgentPolicy defaults/caps to
 * one principal's AgentProfile row — see that file's own module doc comment for the exact rules.
 * `store.ts` is the DB-touching half: reads/writes `agent_profiles`/`agent_policies`
 * (migrations/governance/0010_agent_profiles.sql) and backs the `get_agent_profile`/
 * `set_agent_profile`/`get_agent_policy`/`set_agent_policy` capabilities.
 *
 * This module owns its own tables/migration and exposes only this service interface — it must not
 * be reached into from another module's internal files, and other modules must not query its
 * tables directly; `application/gateway`, `application/host-bridge`, and `application/task` each
 * call `readEffectiveAgentProfile` (or the raw row functions) through this published interface,
 * the same way `governance/approval` calls into `governance/policy`/`governance/capability`.
 */
export * from './types.js';
export * from './resolve.js';
export * from './store.js';
