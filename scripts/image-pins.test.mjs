// Unit tests for scripts/image-pins.mjs (the weekly image-pins workflow); the network and Trivy parts
// run in that workflow, here the registry is a fake fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixedByMoving,
  loadPins,
  parseBearerChallenge,
  parseUpstream,
  renderReport,
  resolveAll,
  resolveDigest,
  summarizeTrivy,
} from './image-pins.mjs';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const entry = (over = {}) => ({
  name: 'postgres',
  upstream: 'postgres:17-alpine',
  source: 'mirror.gcr.io/library/postgres',
  tag: '17-alpine',
  digest: A,
  ...over,
});
const pinsJson = (images) =>
  JSON.stringify({ registry: 'ghcr.io/owner', prefix: 'nexttime-mirror-', images });

test('parseUpstream: Docker Hub official, user and explicit docker.io repositories; other registries keep their host', () => {
  assert.deepEqual(parseUpstream('node:24-bookworm-slim'), {
    host: 'registry-1.docker.io',
    repo: 'library/node',
    tag: '24-bookworm-slim',
    display: 'docker.io/library/node',
  });
  assert.deepEqual(parseUpstream('pgvector/pgvector:pg17'), {
    host: 'registry-1.docker.io',
    repo: 'pgvector/pgvector',
    tag: 'pg17',
    display: 'docker.io/pgvector/pgvector',
  });
  assert.equal(parseUpstream('docker.io/library/alpine:3.20').repo, 'library/alpine');
  assert.deepEqual(parseUpstream('quay.io/org/img:1.2'), {
    host: 'quay.io',
    repo: 'org/img',
    tag: '1.2',
    display: 'quay.io/org/img',
  });
  for (const bad of ['node', `node@${A}`, 'node:', ':tag'])
    assert.throws(() => parseUpstream(bad), /expected <repository>:<tag>/, bad);
});

test('parseBearerChallenge reads realm, service and scope; anything else is null', () => {
  assert.deepEqual(
    parseBearerChallenge(
      'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull"',
    ),
    {
      realm: 'https://auth.docker.io/token',
      service: 'registry.docker.io',
      scope: 'repository:library/node:pull',
    },
  );
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
  assert.equal(parseBearerChallenge(null), null);
});

test('loadPins rejects malformed entries', () => {
  assert.equal(loadPins(pinsJson([entry()])).images.length, 1);
  assert.throws(() => loadPins(pinsJson([entry({ digest: 'sha256:abc' })])), /bad digest/);
  assert.throws(() => loadPins(pinsJson([entry(), entry()])), /listed twice/);
  assert.throws(() => loadPins(pinsJson([entry({ upstream: undefined })])), /no upstream/);
  assert.throws(() => loadPins(pinsJson([entry({ tag: '-x' })])), /bad tag/);
});

/** A registry that asks for a token, then answers HEAD with `digest` (or `status`). */
function fakeRegistry({ digest = B, status = 200, challenge = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      auth: init.headers?.authorization,
    });
    const u = new URL(String(url));
    if (u.hostname === 'auth.example') {
      return new Response(JSON.stringify({ token: 'tkn' }), { status: 200 });
    }
    if (challenge && init.headers?.authorization !== 'Bearer tkn') {
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate':
            'Bearer realm="https://auth.example/token",service="reg",scope="repository:library/postgres:pull"',
        },
      });
    }
    return new Response(null, {
      status,
      headers: status === 200 && digest ? { 'docker-content-digest': digest } : {},
    });
  };
  return { fetchImpl, calls };
}

test('resolveDigest: HEAD, anonymous token on 401, HEAD again with it; the digest header is the answer', async () => {
  const { fetchImpl, calls } = fakeRegistry();
  const d = await resolveDigest(parseUpstream('postgres:17-alpine'), fetchImpl);
  assert.equal(d, B);
  assert.deepEqual(
    calls.map((c) => [c.method, new URL(c.url).hostname, c.auth ?? '']),
    [
      ['HEAD', 'registry-1.docker.io', ''],
      ['GET', 'auth.example', ''],
      ['HEAD', 'registry-1.docker.io', 'Bearer tkn'],
    ],
  );
  const token = new URL(calls[1].url);
  assert.equal(token.searchParams.get('service'), 'reg');
  assert.equal(token.searchParams.get('scope'), 'repository:library/postgres:pull');
  // Only HEAD touches the manifest: no GET against Docker Hub's pull limit.
  assert.ok(calls.filter((c) => c.url.includes('/manifests/')).every((c) => c.method === 'HEAD'));
});

test('resolveDigest fails on a missing tag, a missing or malformed digest header', async () => {
  await assert.rejects(
    resolveDigest(parseUpstream('postgres:17-alpine'), fakeRegistry({ status: 404 }).fetchImpl),
    /HTTP 404/,
  );
  await assert.rejects(
    resolveDigest(parseUpstream('postgres:17-alpine'), fakeRegistry({ digest: null }).fetchImpl),
    /no Docker-Content-Digest/,
  );
  await assert.rejects(
    resolveDigest(
      parseUpstream('postgres:17-alpine'),
      fakeRegistry({ digest: 'sha256:x' }).fetchImpl,
    ),
    /no Docker-Content-Digest/,
  );
});

test('resolveAll: current, behind (with scan refs for the new digest), and errors kept per entry', async () => {
  const pins = loadPins(
    pinsJson([
      entry(),
      entry({
        name: 'pgvector',
        upstream: 'pgvector/pgvector:pg17',
        source: 'mirror.gcr.io/pgvector/pgvector',
        tag: 'pg17',
      }),
      entry({ name: 'bad', upstream: 'postgres:16-alpine' }),
      entry({ name: 'down', upstream: 'postgres:18-alpine', tag: '18-alpine' }),
    ]),
  );
  const rows = await resolveAll(pins, async (up) => {
    if (up.tag === '18-alpine') throw new Error('HTTP 503');
    return up.repo === 'library/postgres' ? A : B;
  });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by.postgres.status, 'current');
  assert.deepEqual(by.postgres.currentRefs, []);
  assert.deepEqual(by.postgres.pinnedRefs, [
    `ghcr.io/owner/nexttime-mirror-postgres@${A}`,
    `mirror.gcr.io/library/postgres@${A}`,
  ]);
  assert.equal(by.pgvector.status, 'behind');
  assert.equal(by.pgvector.current, B);
  assert.deepEqual(by.pgvector.currentRefs, [
    `mirror.gcr.io/pgvector/pgvector@${B}`,
    `docker.io/pgvector/pgvector@${B}`,
  ]);
  assert.equal(by.bad.status, 'error');
  assert.match(by.bad.error, /upstream tag 16-alpine is not the entry's tag 17-alpine/);
  assert.equal(by.down.status, 'error');
  assert.match(by.down.error, /HTTP 503/);
});

const trivy = (vulns) => ({ Results: [{ Vulnerabilities: vulns }] });
const v = (id, sev, fixed = '1.0') => ({
  VulnerabilityID: id,
  PkgName: 'openssl',
  Severity: sev,
  FixedVersion: fixed,
});

test('summarizeTrivy counts HIGH / CRITICAL once per id and package; fixedByMoving diffs two digests', () => {
  const pinned = summarizeTrivy(
    trivy([
      v('CVE-1', 'CRITICAL'),
      v('CVE-1', 'CRITICAL'),
      v('CVE-2', 'HIGH', ''),
      v('CVE-3', 'HIGH'),
      v('CVE-4', 'MEDIUM'),
    ]),
  );
  assert.deepEqual([pinned.critical, pinned.high, pinned.fixable], [1, 2, 2]);
  const current = summarizeTrivy(trivy([v('CVE-2', 'HIGH', '')]));
  assert.equal(fixedByMoving(pinned, current), 2);
  assert.equal(fixedByMoving(pinned, null), null);
  assert.deepEqual(summarizeTrivy({}).keys.size, 0);
});

test('renderReport: behind entries get their digests and references; errors and failed scans are visible', () => {
  const rows = [
    {
      name: 'postgres',
      upstream: 'postgres:17-alpine',
      status: 'behind',
      pinned: A,
      current: B,
      error: null,
    },
    {
      name: 'alpine',
      upstream: 'alpine:3.20',
      status: 'current',
      pinned: A,
      current: A,
      error: null,
    },
    { name: 'down', upstream: 'x:1', status: 'error', pinned: A, current: null, error: 'HTTP 503' },
  ];
  const scans = {
    postgres: {
      pinned: summarizeTrivy(trivy([v('CVE-1', 'HIGH')])),
      current: summarizeTrivy(trivy([])),
    },
    alpine: { pinned: null, current: null },
    down: { pinned: summarizeTrivy(trivy([])), current: null },
  };
  const md = renderReport(rows, scans, { postgres: ['docker-compose.yml:1321'] }, 'https://run');
  assert.match(md, /\*\*1 of 3 pinned third-party images are behind/);
  assert.match(md, /\*\*1 lookup\(s\) failed\*\*/);
  assert.match(
    md,
    /\| postgres \| `postgres:17-alpine` \| behind \| `aaaaaaaaaaaa` \| `bbbbbbbbbbbb` \| 0 \/ 1 \(1 fixable\) \| 0 \/ 0 \(0 fixable\) \| 1 \|/,
  );
  assert.match(md, /\| alpine \| .* \| current \| .* \| not scanned \|/);
  assert.match(md, /\| down \| .* \| error: HTTP 503 \|/);
  assert.match(md, new RegExp(`upstream now: \`${B}\``));
  assert.match(md, /references \(1\): `docker-compose.yml:1321`/);
  assert.match(md, /Run: https:\/\/run/);
  assert.doesNotMatch(md, /### alpine/);
});

test('renderReport with nothing behind says so and has no move section', () => {
  const md = renderReport(
    [
      {
        name: 'alpine',
        upstream: 'alpine:3.20',
        status: 'current',
        pinned: A,
        current: A,
        error: null,
      },
    ],
    { alpine: { pinned: summarizeTrivy(trivy([])), current: null } },
    {},
    '',
  );
  assert.match(md, /^All 1 resolved pins match their upstream tag\./);
  assert.doesNotMatch(md, /Moving a pin/);
});
