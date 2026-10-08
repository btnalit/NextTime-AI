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
    // R-01 (D-01): the accept-s2 gates are self-connected — they authenticate the kernel with their
    // own connection secret and must never be handed the platform gate token.
    if (source === 'gate_token' && (service.profiles ?? []).includes('accept-s2')) {
      console.error(
        `service ${name} is a self-connected acceptance gate and must not mount gate_token`,
      );
      process.exitCode = 1;
    }
  }
}

// R-24: a credential must never be a service's container env — the read-only collector socket proxy
// can inspect every container. Compose may only name the *file* (`..._FILE`) or the directory
// (`LLM_PROVIDER_KEYS_DIR`) a credential is read from; the two services that read provider / RAGFlow
// keys must carry that wiring. (An operator's env_file is outside this static check — the services
// log a deprecation warning when they still fall back to it.)
const CREDENTIAL_ENV_NAME = /^GATE_CREDENTIAL_(?!MODE$)[A-Z0-9_]+$|_API_KEY$/;
const envNamesOf = (environment) =>
  Array.isArray(environment)
    ? environment.map((entry) => String(entry).split('=')[0])
    : Object.keys(environment ?? {});
for (const [name, service] of Object.entries(doc.services ?? {})) {
  for (const envName of envNamesOf(service.environment)) {
    if (CREDENTIAL_ENV_NAME.test(envName) && !envName.endsWith('_FILE')) {
      console.error(
        `service ${name} sets credential env ${envName} — read it from a mounted file instead (${envName}_FILE, or for llm-proxy a file in LLM_PROVIDER_KEYS_DIR) (R-24)`,
      );
      process.exitCode = 1;
    }
  }
}
const requiredCredentialWiring = [
  ['llm-proxy', 'LLM_PROVIDER_KEYS_DIR'],
  ['gatekeeper-ragflow', 'GATE_CREDENTIAL_RAGFLOW_API_KEY_FILE'],
];
for (const [name, envName] of requiredCredentialWiring) {
  if (!envNamesOf(doc.services?.[name]?.environment).includes(envName)) {
    console.error(`service ${name} must read its keys from files: ${envName} is not set (R-24)`);
    process.exitCode = 1;
  }
}

// D-28: the one thing from backups/ any service other than `backup` may mount is the success
// marker, read-only — backups/ holds the dumps and the files tarballs with provider keys.
const BACKUPS_SOURCE = /\/backups(\/|$)/;
for (const [name, service] of Object.entries(doc.services ?? {})) {
  if (name === 'backup') continue;
  for (const entry of service.volumes ?? []) {
    let source;
    let readOnly;
    if (typeof entry === 'string') {
      // `${NEXTTIME_DATA:?}` itself contains a colon — blank out interpolations before splitting.
      const [src = '', , mode = ''] = entry.replace(/\$\{[^}]*\}/g, '$VAR').split(':');
      source = src;
      readOnly = mode.split(',').includes('ro');
    } else {
      source = String(entry?.source ?? '');
      readOnly = entry?.read_only === true;
    }
    if (!BACKUPS_SOURCE.test(source)) continue;
    if (!/\/backups\/last-success$/.test(source) || !readOnly) {
      console.error(
        `service ${name} mounts ${source} — only backups/last-success, read-only, may leave the backup service (D-28)`,
      );
      process.exitCode = 1;
    }
  }
}

// R-27: the kernel's fixed acceptance-fixture allow-list (NEXTTIME_CONNECTION_FIXTURE_HOSTS) is
// allowed past the owner-supplied-URL predicate permanently, which is only harmless while every
// name on it is an acceptance fixture: `accept-`-prefixed, an existing service, and never handed
// the platform gate token.
const fixtureHostsRaw = doc.services?.kernel?.environment?.NEXTTIME_CONNECTION_FIXTURE_HOSTS;
if (typeof fixtureHostsRaw !== 'string' || fixtureHostsRaw.includes('$')) {
  console.error(
    'kernel NEXTTIME_CONNECTION_FIXTURE_HOSTS must be a literal list (no interpolation)',
  );
  process.exitCode = 1;
} else {
  for (const host of fixtureHostsRaw.split(',').map((entry) => entry.trim())) {
    if (!host.startsWith('accept-')) {
      console.error(`NEXTTIME_CONNECTION_FIXTURE_HOSTS: "${host}" is not an accept-* fixture`);
      process.exitCode = 1;
      continue;
    }
    const fixture = doc.services?.[host];
    if (!fixture) {
      console.error(`NEXTTIME_CONNECTION_FIXTURE_HOSTS: "${host}" names no service`);
      process.exitCode = 1;
      continue;
    }
    if ((fixture.secrets ?? []).some((entry) => sourceOf(entry) === 'gate_token')) {
      console.error(
        `NEXTTIME_CONNECTION_FIXTURE_HOSTS: fixture "${host}" must not mount gate_token`,
      );
      process.exitCode = 1;
    }
  }
  console.log(`kernel fixture allow-list (R-27): ${fixtureHostsRaw}`);
}

// S10 U1: `update-feed` is the one always-on service that reaches the internet on its own. It must
// stay a dumb, credential-less fetch: digest-pinned image, no secrets, no Docker socket, read-only
// root, no capabilities, its own uid, exactly its script plus its own output directory mounted,
// and a network no other service joins.
const feed = doc.services?.['update-feed'];
if (!feed) {
  console.error('MISSING service update-feed (S10 U1)');
  process.exitCode = 1;
} else {
  const problems = [];
  if (!/@sha256:[0-9a-f]{64}$/.test(String(feed.image ?? '')))
    problems.push('image is not digest-pinned');
  if ((feed.secrets ?? []).length > 0) problems.push('mounts secrets');
  if (feed.read_only !== true) problems.push('root filesystem is not read_only');
  if (!(feed.cap_drop ?? []).includes('ALL') || (feed.cap_add ?? []).length > 0) {
    problems.push('capabilities not dropped');
  }
  if (feed.user !== '10002:10002') problems.push(`user is ${feed.user}, expected 10002:10002`);
  const volumes = (feed.volumes ?? []).map(String);
  const expectedVolumes = [
    './deploy/update-feed/update-feed.sh:/update-feed.sh:ro',
    '${NEXTTIME_DATA:?}/config/update-feed:/data/update-feed',
  ];
  if (JSON.stringify(volumes) !== JSON.stringify(expectedVolumes)) {
    problems.push(`volumes are ${JSON.stringify(volumes)}`);
  }
  if (volumes.some((volume) => volume.includes('docker.sock')))
    problems.push('mounts the Docker socket');
  if (JSON.stringify(feed.networks) !== JSON.stringify(['update-feed'])) {
    problems.push(`networks are ${JSON.stringify(feed.networks)}, expected only update-feed`);
  }
  for (const [name, service] of Object.entries(doc.services ?? {})) {
    if (name !== 'update-feed' && (service.networks ?? []).includes('update-feed')) {
      problems.push(`service ${name} joins the update-feed network`);
    }
  }
  if (doc.networks?.['update-feed']?.internal === true) {
    problems.push('the update-feed network is internal: it could not reach GitHub');
  }
  const feedUrl = feed.environment?.UPDATE_FEED_URL;
  if (!feedUrl || doc.services?.kernel?.environment?.UPDATE_FEED_URL !== feedUrl) {
    problems.push('kernel UPDATE_FEED_URL differs from the update-feed service (link binding)');
  }
  for (const problem of problems) {
    console.error(`update-feed (S10 U1): ${problem}`);
    process.exitCode = 1;
  }
  if (problems.length === 0) console.log('update-feed (S10 U1): isolated, credential-less fetch');
}
