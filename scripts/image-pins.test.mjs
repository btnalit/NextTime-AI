// Unit tests for scripts/image-pins.mjs (the weekly image-pins workflow); the network and Trivy parts
// run in that workflow, here the registry is a fake fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchWithRetry,
  fixedByMoving,
  loadPins,
  parseBearerChallenge,
  parseUpstream,
  renderReport,
  resolveAll,
  resolveDigest,
  retryAfterSeconds,
  safeError,
  summarizeTrivy,
} from './image-pins.mjs';

const noSleep = async () => {};

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
  const d = await resolveDigest(parseUpstream('postgres:17-alpine'), fetchImpl, noSleep);
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
    resolveDigest(
      parseUpstream('postgres:17-alpine'),
      fakeRegistry({ status: 404 }).fetchImpl,
      noSleep,
    ),
    /HTTP 404/,
  );
  await assert.rejects(
    resolveDigest(
      parseUpstream('postgres:17-alpine'),
      fakeRegistry({ digest: null }).fetchImpl,
      noSleep,
    ),
    /no Docker-Content-Digest/,
  );
  await assert.rejects(
    resolveDigest(
      parseUpstream('postgres:17-alpine'),
      fakeRegistry({ digest: 'sha256:x' }).fetchImpl,
      noSleep,
    ),
    /no Docker-Content-Digest/,
  );
});

/** Answers `statuses` in order (a number, or 'throw' for a network error), recording the waits. */
function scripted(statuses, headers = {}) {
  const seen = [];
  const fetchImpl = async () => {
    const s = statuses[Math.min(seen.length, statuses.length - 1)];
    seen.push(s);
    if (s === 'throw') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    return new Response(null, {
      status: s,
      headers: s === 200 ? { 'docker-content-digest': B } : headers,
    });
  };
  const waits = [];
  return { fetchImpl, seen, waits, sleep: async (ms) => waits.push(ms) };
}

test('fetchWithRetry: 429 / 5xx / network errors back off 10, 30, 60 s, or Retry-After when given', async () => {
  const a = scripted([429, 503, 'throw', 200]);
  assert.equal((await fetchWithRetry(a.fetchImpl, 'https://r/x', {}, a.sleep)).status, 200);
  assert.deepEqual(a.waits, [10_000, 30_000, 60_000]);

  const b = scripted([429, 200], { 'retry-after': '7' });
  await fetchWithRetry(b.fetchImpl, 'https://r/x', {}, b.sleep);
  assert.deepEqual(b.waits, [7_000]);

  // The fourth failure is the answer: a response is returned, a network error thrown.
  const c = scripted([503]);
  assert.equal((await fetchWithRetry(c.fetchImpl, 'https://r/x', {}, c.sleep)).status, 503);
  assert.equal(c.seen.length, 4);
  const d = scripted(['throw']);
  await assert.rejects(fetchWithRetry(d.fetchImpl, 'https://r/x', {}, d.sleep), /fetch failed/);

  // 4xx other than 429 is an answer, not retried.
  const e = scripted([404, 200]);
  assert.equal((await fetchWithRetry(e.fetchImpl, 'https://r/x', {}, e.sleep)).status, 404);
  assert.deepEqual(e.waits, []);
});

test('retryAfterSeconds: delta-seconds or HTTP date, capped at 120 s; junk is ignored', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  assert.equal(retryAfterSeconds('5', now), 5);
  assert.equal(retryAfterSeconds('9999', now), 120);
  assert.equal(retryAfterSeconds('Fri, 16 Oct 2026 00:00:30 GMT', now), 30);
  assert.equal(retryAfterSeconds('soon', now), null);
  assert.equal(retryAfterSeconds(null, now), null);
});

test('resolveDigest retries a throttled lookup instead of failing it', async () => {
  const a = scripted([429, 429, 200]);
  assert.equal(await resolveDigest(parseUpstream('alpine:3.20'), a.fetchImpl, a.sleep), B);
  const b = scripted([429]);
  await assert.rejects(
    resolveDigest(parseUpstream('alpine:3.20'), b.fetchImpl, b.sleep),
    /manifest HEAD HTTP 429/,
  );
});

test('safeError: own messages kept on one line and truncated; foreign errors reduced to kind and code', async () => {
  // A token endpoint that answers HTML: its content never reaches the message.
  const html = async (url, init = {}) =>
    new URL(String(url)).hostname === 'auth.example'
      ? new Response('<html><b>secret | `body`</b></html>', { status: 200 })
      : new Response(null, {
          status: init.headers?.authorization ? 200 : 401,
          headers: { 'www-authenticate': 'Bearer realm="https://auth.example/token"' },
        });
  const err = await resolveDigest(parseUpstream('alpine:3.20'), html, noSleep).catch((x) => x);
  assert.equal(safeError(err), 'registry-1.docker.io: token response is not JSON');

  assert.equal(safeError(new Error('<script>| `x`\nsecond line')), 'network error');
  assert.equal(safeError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(
    safeError(new TypeError('fetch failed', { cause: { code: 'not a code; <b>' } })),
    'network error',
  );
  const long = await resolveAll(
    loadPins(pinsJson([entry({ upstream: `postgres:${'y'.repeat(300)}` })])),
    async () => A,
    { sleep: noSleep },
  );
  assert.equal(long[0].status, 'error');
  assert.ok(long[0].error.length <= 160 && long[0].error.endsWith('...'));
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
  const slept = [];
  const rows = await resolveAll(
    pins,
    async (up) => {
      if (up.tag === '18-alpine')
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return up.repo === 'library/postgres' ? A : B;
    },
    { sleep: async (ms) => slept.push(ms) },
  );
  assert.deepEqual(slept, [1500, 1500, 1500], 'lookups are paced, none before the first');
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
  assert.equal(by.down.error, 'network error (ECONNRESET)');
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
