/**
 * spawn-spec: pure builder for the entry container's `ContainerSpec` (docs/development-tasks.md
 * S1.5a task brief; design doc §7.2, §7.3, §11). No I/O — exhaustively unit-testable, same shape
 * as `@nexttime/egress-proxy`'s `policy.ts` `decideEgress`.
 *
 * Env is the security-critical part: **exactly** `KERNEL_URL`, `KERNEL_LLM_URL`,
 * `CAPABILITY_HANDLE`, `NEXTTIME_MODE=entry`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`,
 * `PI_CODING_AGENT_DIR`, `HOME=/workspace` — plus two additions beyond the task brief's list:
 *
 * - `WORKSPACE_ID`: `@nexttime/platform-extension`'s `index.ts` (`readRequiredEnv('WORKSPACE_ID')`)
 *   throws on activation without it — verified by reading that file; it is not something this
 *   package may edit (see this task's "Ownership" — platform-extension is out of scope), so the
 *   container's env has to carry what the extension it must run actually requires.
 * - lowercase `http_proxy`/`https_proxy`/`no_proxy` mirrors: host verification (S1.5a) found
 *   `curl` (and, per its own documented rationale, most other HTTP clients) does **not** honor
 *   uppercase `HTTP_PROXY` for plain `http://` requests — only the lowercase form — a long-
 *   standing deliberate mitigation for the "httpoxy" class of CGI environment-variable-injection
 *   vulnerabilities (an incoming `Proxy:` header rewritten into `HTTP_PROXY` by some web servers'
 *   CGI environments); `HTTPS_PROXY` has no such ambiguity and both cases work for `https://`.
 *   Verified empirically in the entry container: `curl http://postgres:5432` failed local DNS
 *   resolution (never reached the proxy) with only `HTTP_PROXY` set, then correctly tunneled and
 *   got denied (403) once `http_proxy` was also present. Both cases are set so every tool inside
 *   the container — not just ones that happen to check the uppercase form — actually routes
 *   through the egress proxy instead of silently attempting (and failing) a direct connection.
 *
 * Nothing from this process's own env is ever forwarded (`docker-client.ts` passes exactly the
 * array built here, never inherits `process.env`).
 *
 * S2.6 addition: `input.model`, when set, becomes container CMD (`['--model', model]`) — same
 * `ContainerSpec.cmd` field and the same `entrypoint.sh` "appends CMD after its fixed pi flags"
 * mechanism `task-spawn-spec.ts`'s one-shot Task mode already uses (S2.8). The entry container's
 * `systemPrompt` is **not** part of this spec — `resident-service.ts` writes it straight to
 * `/workspace/.nexttime/system-prompt.md` (a file, not an env var or CMD arg) before calling
 * `buildSpawnSpec`, since `entrypoint.sh` already reads that exact path.
 */

import { createHash } from 'node:crypto';
import type { SupervisorConfig } from './config.js';
import type { TaskSkillInline } from './config.js';
import type { ContainerSpec } from './docker-client.js';
import { hostModelsJsonPath, workspacePaths } from './host-paths.js';

export const ENTRY_ROLE_LABEL = 'nexttime.role';
export const ENTRY_ROLE_VALUE = 'entry';
export const PRINCIPAL_LABEL = 'nexttime.principal';
export const WORKSPACE_LABEL = 'nexttime.workspace';
export const RESTARTS_LABEL = 'nexttime.restarts';
/** The spawning Handle's `jti` claim (best-effort, unverified — see `handle-jti.ts`), stamped on
 *  every entry container so a later spawn can tell whether the caller's Handle has been rotated
 *  since this container was created (lane-6 review P2-5; `resident-service.ts`'s own doc comment
 *  has the full rationale). Empty string when the incoming Handle couldn't be decoded — Docker
 *  labels must be strings, and `resident-service.ts` treats an empty label the same as "unknown"
 *  when deciding whether to recreate. */
export const HANDLE_JTI_LABEL = 'nexttime.handle-jti';
/** feat/egress-definition-lists: the entry WorkerDefinition's own `egressDeny` at the moment this
 *  container was (re)created, comma-joined (a hostname/`.suffix` entry can never itself contain a
 *  comma) — stamped so `resident-service.ts`'s `reconcile()` (run once, after a supervisor
 *  restart) can restore the per-source deny list into a fresh `SOURCE_MAP_FILE` entry for a
 *  container it did not itself just spawn, the same way `RESTARTS_LABEL`/`HANDLE_JTI_LABEL`
 *  already survive a supervisor restart on the container itself. Without this, a restart would
 *  silently *widen* egress for every still-running entry container until its next `startTurn`
 *  re-registers the list — the one persistence gap this field exists to close (this list may only
 *  ever narrow platform policy, never widen it, even transiently). Empty string when no list was
 *  set (equivalent to omitted — `resident-service.ts`'s reconcile splits and filters blanks). */
export const EGRESS_DENY_LABEL = 'nexttime.egress-deny';
/** S3.13: a deterministic digest of the `skillsInline` set this container was (re)created with —
 *  stamped so `resident-service.ts`'s `spawn()` can fold a Skill-set change into the same
 *  recreate decision `HANDLE_JTI_LABEL` already drives (see that label's own doc comment: "a
 *  mismatch means agent-host presented a Handle this container was never spawned with" — a
 *  Skill-set mismatch is the identical shape of problem: the running container's on-disk
 *  `skills/` mount no longer matches what the caller's AgentProfile currently selects, and pi
 *  only loads Skills at container startup, so nothing short of a recreate makes the change take
 *  effect). Empty string for "no Skills" (`hashSkillsInline([])`, below) — the same value an
 *  older container predating this label reads back as via `?? ''`, so neither ever forces a
 *  spurious recreate on its own. */
export const SKILLS_HASH_LABEL = 'nexttime.skills-hash';

/**
 * A deterministic digest of `skillsInline`'s content — order-independent across both the skill
 * list and each skill's own `files` map, so two calls describing the identical Skill set always
 * hash identically regardless of how the caller happened to order either. Empty input hashes to
 * `''` (not a hash of `'[]'`), matching `SKILLS_HASH_LABEL`'s own "no Skills" convention and
 * `HANDLE_JTI_LABEL`'s established "empty string is the label's own default" shape.
 */
export function hashSkillsInline(skillsInline: readonly TaskSkillInline[]): string {
  if (skillsInline.length === 0) return '';
  const canonical = [...skillsInline]
    .map((skill) => ({
      name: skill.name,
      files: Object.fromEntries(Object.entries(skill.files).sort(([a], [b]) => a.localeCompare(b))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function entryContainerName(principalId: string): string {
  return `nexttime-entry-${principalId}`;
}

export interface BuildSpawnSpecInput {
  readonly config: SupervisorConfig;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly handle: string;
  readonly kernelUrl?: string;
  readonly llmUrl?: string;
  readonly networkName: string;
  /** Carried forward from the previous container's `nexttime.restarts` label (0 for a first-ever
   *  spawn) — see `resident-service.ts`. */
  readonly restarts: number;
  /** S2.6: `<provider>/<id>` from the workspace's published entry WorkerDefinition, when set —
   *  becomes container CMD `['--model', model]`; `entrypoint.sh` appends any CMD after its own
   *  fixed pi flags (same mechanism `task-spawn-spec.ts`'s one-shot Task mode already uses).
   *  `undefined` sets no CMD (pi's own default model selection). */
  readonly model?: string;
  /** The incoming Handle's `jti`, best-effort decoded by the caller (`resident-service.ts` via
   *  `handle-jti.ts`) — stamped as `HANDLE_JTI_LABEL`. `undefined` when it couldn't be decoded. */
  readonly handleJti?: string;
  /** feat/egress-definition-lists: the entry WorkerDefinition's own `egressDeny`, stamped as
   *  `EGRESS_DENY_LABEL` (comma-joined) — see that label's own doc comment. `undefined`/empty
   *  stamps an empty label. */
  readonly egressDeny?: readonly string[];
  /** S3.13: `hashSkillsInline(skillsInline)`, computed by the caller (`resident-service.ts`) —
   *  stamped as `SKILLS_HASH_LABEL`. `undefined`/empty stamps `''`, the same "no Skills" value
   *  that function itself returns for an empty list. */
  readonly skillsHash?: string;
}

export function buildSpawnSpec(input: BuildSpawnSpecInput): ContainerSpec {
  const { config } = input;
  const paths = workspacePaths(config, input.principalId);

  const env: string[] = [
    `KERNEL_URL=${input.kernelUrl ?? config.kernelUrl}`,
    `KERNEL_LLM_URL=${input.llmUrl ?? config.kernelLlmUrl}`,
    `CAPABILITY_HANDLE=${input.handle}`,
    // Required by @nexttime/platform-extension (index.ts readRequiredEnv) — see this module's
    // doc comment.
    `WORKSPACE_ID=${input.workspaceId}`,
    'NEXTTIME_MODE=entry',
    `HTTP_PROXY=${config.httpProxyForWorkers}`,
    `HTTPS_PROXY=${config.httpProxyForWorkers}`,
    `NO_PROXY=${config.noProxyForWorkers}`,
    // Lowercase mirrors — see this module's doc comment ("httpoxy" mitigation in most HTTP
    // clients means only lowercase http_proxy is honored for plain http:// requests).
    `http_proxy=${config.httpProxyForWorkers}`,
    `https_proxy=${config.httpProxyForWorkers}`,
    `no_proxy=${config.noProxyForWorkers}`,
    `PI_CODING_AGENT_DIR=${paths.piAgentDirInContainer}`,
    'HOME=/workspace',
  ];

  const binds: string[] = [
    `${paths.hostWorkspaceDir}:/workspace`,
    `${hostModelsJsonPath(config)}:${paths.modelsJsonTargetInContainer}:ro`,
  ];

  return {
    name: entryContainerName(input.principalId),
    image: config.workerImage,
    cmd: input.model ? ['--model', input.model] : undefined,
    env,
    binds,
    labels: {
      [ENTRY_ROLE_LABEL]: ENTRY_ROLE_VALUE,
      [PRINCIPAL_LABEL]: input.principalId,
      [WORKSPACE_LABEL]: input.workspaceId,
      [RESTARTS_LABEL]: String(input.restarts),
      [HANDLE_JTI_LABEL]: input.handleJti ?? '',
      [EGRESS_DENY_LABEL]: (input.egressDeny ?? []).join(','),
      [SKILLS_HASH_LABEL]: input.skillsHash ?? '',
    },
    networkName: input.networkName,
    runtime: config.workerRuntime,
    memoryMb: config.workerMemoryMb,
    pidsLimit: config.workerPidsLimit,
    tmpfsMb: config.workerTmpfsMb,
    cpus: config.workerCpus,
    dns: config.workerDnsSinkhole,
  };
}
