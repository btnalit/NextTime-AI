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
 */

import type { SupervisorConfig } from './config.js';
import type { ContainerSpec } from './docker-client.js';
import { hostModelsJsonPath, workspacePaths } from './host-paths.js';

export const ENTRY_ROLE_LABEL = 'nexttime.role';
export const ENTRY_ROLE_VALUE = 'entry';
export const PRINCIPAL_LABEL = 'nexttime.principal';
export const WORKSPACE_LABEL = 'nexttime.workspace';
export const RESTARTS_LABEL = 'nexttime.restarts';

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
    env,
    binds,
    labels: {
      [ENTRY_ROLE_LABEL]: ENTRY_ROLE_VALUE,
      [PRINCIPAL_LABEL]: input.principalId,
      [WORKSPACE_LABEL]: input.workspaceId,
      [RESTARTS_LABEL]: String(input.restarts),
    },
    networkName: input.networkName,
    runtime: config.workerRuntime,
    memoryMb: config.workerMemoryMb,
    pidsLimit: config.workerPidsLimit,
    tmpfsMb: config.workerTmpfsMb,
  };
}
