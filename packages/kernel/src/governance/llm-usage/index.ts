/**
 * governance/llm-usage: ingests usage reports from llm-proxy; the 80%-daily-budget warning (I18-
 * adjacent — the full quota system is S2.7); publishes provider config (future).
 *
 * This module owns its own tables/migrations (migrations/llm-usage/0001_llm_usage.sql) and
 * exposes only this service interface — it must not be reached into from another module's
 * internal files, and other modules must not query its tables directly; cross-module
 * coordination happens through domain events (see packages/shared).
 */
export * from './service.js';
