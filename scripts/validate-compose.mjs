#!/usr/bin/env node
// Parses docker-compose.yml with the `yaml` package and lists its services.
//
// Docker is not installed on this development machine, so `docker compose config` cannot be
// run here — this script is the R1 stand-in: it proves the file is syntactically valid YAML
// with the expected top-level shape, without needing Docker. Image builds and a real
// `docker compose config` run remain unverified until the target-host checkout (E3) — see
// docs/development-tasks.md milestone E.
//
// Usage: node scripts/validate-compose.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const composePath = fileURLToPath(new URL('../docker-compose.yml', import.meta.url));
const raw = readFileSync(composePath, 'utf8');
const doc = parse(raw);

const services = Object.keys(doc.services ?? {});
const networks = Object.keys(doc.networks ?? {});
const secrets = Object.keys(doc.secrets ?? {});

const expectedServices = [
  'postgres',
  'kernel',
  'agent-host',
  'worker-supervisor',
  'gatekeeper-docker',
  'gatekeeper-ragflow',
  'caddy',
  'llm-proxy',
  'egress-proxy',
  'backup',
];

// fix/gate-protocol-hardening: every credential/token file compose hands a container as a secret
// — pg_password/handle_key/internal_token predate this task; gate_token is this task's own
// addition (@nexttime/gatekeeper-base's gate-token.ts / scripts/gen-handle-keys.sh). Kept here
// (not just "services present") because a secret silently dropped from the top-level `secrets:`
// block, or from a service's own `secrets:` list, fails a container at runtime in a way this
// static parse is the only pre-host check for (§10.2, docs/runbooks/host-gatekeepers.md).
// R-03 adds the per-service internal-plane credentials (scripts/derive-internal-tokens.sh).
const expectedSecrets = [
  'pg_password',
  'handle_key',
  'internal_token',
  'gate_token',
  'internal_agent_host_to_kernel',
  'internal_llm_proxy_to_kernel',
  'internal_egress_proxy_to_kernel',
  'internal_gate_to_kernel',
  'internal_gate_host_to_kernel',
  'internal_kernel_to_worker_supervisor',
  'internal_agent_host_to_worker_supervisor',
];

console.log(`docker-compose.yml parsed OK: ${composePath}`);
console.log(`services (${services.length}): ${services.join(', ')}`);
console.log(`networks (${networks.length}): ${networks.join(', ')}`);
console.log(`secrets (${secrets.length}): ${secrets.join(', ')}`);

const missingServices = expectedServices.filter((name) => !services.includes(name));
if (missingServices.length > 0) {
  console.error(`MISSING expected services: ${missingServices.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('All expected services from design doc §10.2 are present.');
}

const missingSecrets = expectedSecrets.filter((name) => !secrets.includes(name));
if (missingSecrets.length > 0) {
  console.error(`MISSING expected top-level secrets: ${missingSecrets.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('All expected top-level secrets are declared.');
}

// R-03: the internal-plane root reaches the kernel only, and every secret a service names is
// declared at the top level.
const sourceOf = (entry) => (typeof entry === 'string' ? entry : entry?.source);
for (const [name, service] of Object.entries(doc.services ?? {})) {
  for (const entry of service.secrets ?? []) {
    const source = sourceOf(entry);
    if (source === 'internal_token' && name !== 'kernel') {
      console.error(`service ${name} mounts the internal-plane root internal_token (kernel only)`);
      process.exitCode = 1;
    }
    if (!secrets.includes(source)) {
      console.error(`service ${name} names undeclared secret ${source}`);
      process.exitCode = 1;
    }
  }
}
