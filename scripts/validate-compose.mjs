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

console.log(`docker-compose.yml parsed OK: ${composePath}`);
console.log(`services (${services.length}): ${services.join(', ')}`);
console.log(`networks (${networks.length}): ${networks.join(', ')}`);
console.log(`secrets (${secrets.length}): ${secrets.join(', ')}`);

const missing = expectedServices.filter((name) => !services.includes(name));
if (missing.length > 0) {
  console.error(`MISSING expected services: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('All expected services from design doc §10.2 are present.');
}
