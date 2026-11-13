// Build-time self-check for the worker-runtime image (Dockerfile, the RUN right after
// `ENV PI_OFFLINE=1`; STATUS leftover 698). It runs pi's own `find` and `grep` tools, from the pinned
// pi this image installed, against a scratch directory, as the image's user and with the image's
// environment. If either cannot run, the build fails.
//
// Why: both tools shell out to a binary pi resolves the same way (`utils/tools-manager.js`). It
// takes a copy under pi's agent directory, then `fd` / `fdfind` (find) or `rg` (grep) on PATH, and
// otherwise downloads one from GitHub. The image sets PI_OFFLINE=1, which switches that download
// off, so a binary missing from the image fails the tool on every call. `fd` was missing until
// leftover 698: every Worker's `find` failed with "fd is not available and could not be
// downloaded" while `grep` (ripgrep was installed) worked. Checking the binaries with `--version`
// would not catch pi changing the names it looks for; running the tools does.
//
// The agent directory is a fresh one under the scratch directory, as at a real start (entrypoint.sh
// rebuilds /tmp/pi-agent), so a binary cached there cannot hide one missing from PATH, and nothing
// is left in the image.
//
// Usage: PI_OFFLINE=1 node selfcheck-search-tools.mjs [path to pi's dist/index.js]
// (the default is where the Dockerfile installs pi).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PI_ENTRY =
  process.argv[2] ?? '/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const NEEDLE_FILE = 'selfcheck-needle.txt';
const NEEDLE_TEXT = 'nexttime-runtime-selfcheck';

function fail(message) {
  console.error(`worker-runtime self-check: ${message}`);
  process.exit(1);
}

if (process.env.PI_OFFLINE !== '1') {
  fail('run with PI_OFFLINE=1, as the image runs pi; otherwise pi may download what is missing');
}

const root = await mkdtemp(join(tmpdir(), 'pi-selfcheck-'));
let failure;
try {
  // Before importing pi: its tools manager reads the agent directory when the module loads.
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
  const work = join(root, 'work');
  await mkdir(work);
  await writeFile(join(work, NEEDLE_FILE), `${NEEDLE_TEXT}\n`);

  const pi = await import(pathToFileURL(PI_ENTRY).href);
  const checks = [
    ['find', pi.createFindTool(work), { pattern: '*.txt' }],
    ['grep', pi.createGrepTool(work), { pattern: NEEDLE_TEXT }],
  ];
  for (const [name, tool, params] of checks) {
    let text;
    try {
      const result = await tool.execute(`selfcheck-${name}`, params);
      text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    } catch (error) {
      throw new Error(
        `pi's ${name} tool failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!text.includes(NEEDLE_FILE)) {
      throw new Error(`pi's ${name} tool did not find ${NEEDLE_FILE}; it answered: ${text}`);
    }
    console.log(`worker-runtime self-check: pi's ${name} tool runs offline`);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
if (failure !== undefined) fail(failure);
