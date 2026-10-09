// Unit tests for scripts/guards/image-mirrors.mjs's detectors; the guard itself runs against the real
// repository in CI (`quality`) and `pnpm ci:guards`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFile, dockerfileRefs, isDockerHub, loadMirrors, shellRefs, workflowRefs } from './image-mirrors.mjs';

const D = `sha256:${'a'.repeat(64)}`;
const OLD = `sha256:${'b'.repeat(64)}`;
const mirrors = loadMirrors(
  JSON.stringify({
    registry: 'ghcr.io/owner',
    prefix: 'nexttime-mirror-',
    images: [{ name: 'node', upstream: 'node:24', source: 'mirror.gcr.io/library/node', tag: '24', digest: D }],
  }),
);
const COPY = `ghcr.io/owner/nexttime-mirror-node@${D}`;
const msgs = (file, kind, text) => checkFile(file, kind, text, mirrors).map((p) => p.msg);

test('isDockerHub: no registry host or docker.io is Docker Hub; any other host is not', () => {
  for (const r of ['alpine', 'node:24', 'pgvector/pgvector:pg17@' + D, 'docker.io/library/alpine', 'docker/dockerfile:1.7']) {
    assert.ok(isDockerHub(r), r);
  }
  for (const r of ['ghcr.io/x/y', 'mirror.gcr.io/library/node', 'localhost:5000/x', 'registry:5000/x']) assert.ok(!isDockerHub(r), r);
});

test('loadMirrors refuses a bad digest or a duplicate name', () => {
  const base = { registry: 'ghcr.io/o', prefix: 'p-' };
  assert.throws(() => loadMirrors(JSON.stringify({ ...base, images: [{ name: 'a', digest: 'sha256:1' }] })));
  assert.throws(() => loadMirrors(JSON.stringify({ ...base, images: [{ name: 'a', digest: D }, { name: 'a', digest: D }] })));
});

test('dockerfileRefs: the syntax frontend and FROM images, not build stages', () => {
  const df = ['# syntax=docker/dockerfile:1.7', 'FROM node:24 AS build', 'FROM build AS test', 'FROM scratch', 'FROM --platform=$X alpine:3'].join('\n');
  assert.deepEqual(dockerfileRefs(df).map((r) => r.ref), ['docker/dockerfile:1.7', 'node:24', 'scratch', 'alpine:3']);
});

test('shellRefs: the image argument after options, continuations joined, comments and variables seen', () => {
  const sh = [
    '# docker run alpine true',
    'docker run --rm --runtime=runsc alpine:3.20 true',
    'out=$(docker run --rm --network "net" --entrypoint sh \\',
    '  -e A=b nexttime-ai-worker-runtime -c id)',
    'docker pull -q "$fe" >/dev/null',
    'IMAGE="pgvector/pgvector:pg17"',
    'COSIGN_IMAGE=${COSIGN_IMAGE:-ghcr.io/sigstore/cosign:v3@' + D + '}',
  ].join('\n');
  assert.deepEqual(shellRefs(sh).map((r) => r.ref), [
    'alpine:3.20',
    'nexttime-ai-worker-runtime',
    '$fe',
    'pgvector/pgvector:pg17',
    `ghcr.io/sigstore/cosign:v3@${D}`,
  ]);
});

test('workflowRefs: services, implicit buildkit and SBOM scanner, run steps', () => {
  const wf = `
jobs:
  a:
    services:
      pg: { image: 'pgvector/pgvector:pg17' }
    steps:
      - uses: docker/setup-buildx-action@x
      - uses: docker/setup-buildx-action@x
        with: { driver-opts: 'image=${COPY}' }
      - uses: docker/build-push-action@x
        with: { sbom: true }
      - uses: docker/build-push-action@x
        with: { sbom: 'generator=${COPY}' }
      - name: r
        run: sudo docker run --rm alpine true
`;
  assert.deepEqual(workflowRefs(wf).map((r) => r.ref), ['pgvector/pgvector:pg17', 'moby/buildkit', COPY, 'docker/buildkit-syft-scanner', COPY, 'alpine']);
});

test('checkFile: a copy reference must carry the listed digest; Docker Hub pulls are refused', () => {
  assert.deepEqual(msgs('Dockerfile', 'dockerfile', `FROM ${COPY} AS build\nFROM build`), []);
  assert.match(msgs('Dockerfile', 'dockerfile', `FROM ghcr.io/owner/nexttime-mirror-node@${OLD}`)[0], /the list pins/);
  assert.match(msgs('a.sh', 'shell', 'docker pull ghcr.io/owner/nexttime-mirror-node:24')[0], /no digest/);
  assert.match(msgs('a.sh', 'shell', `docker pull ghcr.io/owner/nexttime-mirror-ruby@${D}`)[0], /not in deploy\/image-mirrors.json/);
  assert.match(msgs('Dockerfile', 'dockerfile', 'FROM node:24')[0], /from Docker Hub/);
  assert.deepEqual(msgs('c.yml', 'compose', `services:\n  k: { image: nexttime-ai-kernel, build: . }\n  p: { image: '${COPY}' }\n`), []);
  assert.match(msgs('c.yml', 'compose', 'services:\n  p: { image: postgres:17-alpine }\n')[0], /services\.p\.image pulls postgres/);
  // A comment naming an old pin is not a reference.
  assert.deepEqual(msgs('a.sh', 'shell', `# was ghcr.io/owner/nexttime-mirror-node@${OLD}`), []);
});
