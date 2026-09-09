import {
  COMPOSE_DEPENDS_ON_LABEL,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
} from './docker-client.js';
import type {
  ContainerSummary,
  ImageSummary,
  NetworkSummary,
  VolumeSummary,
} from './docker-client.js';
import type { RawProcess } from './process-tree.js';
import type { RawRepository } from './repository.js';
import type { RawSystemdService } from './systemd.js';
import type { IngestLink, IngestObservation } from './types.js';

/**
 * observation-builder: pure functions turning already-collected, already-sanitized raw facts into
 * the three dependency-ordered `submit_observations` batches this collector submits per run
 * (`ontology/ops-assets-v1.yaml`'s own identity scheme — see `run.ts`'s module doc comment for the
 * full three-phase rationale). No IO here at all — every function takes plain data in, returns
 * plain `IngestObservation[]` out, so this file is fully unit-testable without Docker, `/proc`, or
 * a network.
 *
 * **Ordering contract this module assumes, enforced by its caller (`run.ts`), not by this file**:
 * process `commandLine` values must already be redacted (`redact.ts`'s `sanitizeCommandLines`)
 * *before* they reach `buildPhase1Observations` — "命令行...在形成 Observation 前脱敏" (docs/
 * development-tasks.md S3.3) means exactly this ordering, and this module has no redaction logic
 * of its own to enforce it a second time.
 */

// -------------------------------------------------------------------------------------------
// Phase 1 — no dependency on any previously-resolved graph id: Host, Repository, Image, Process.
// -------------------------------------------------------------------------------------------

export interface BuildPhase1Input {
  readonly hostname: string;
  readonly repositories: readonly RawRepository[];
  readonly images: readonly ImageSummary[];
  /** Already the agent-runtime subtree (`process-tree.ts`'s own scope), and already sanitized
   *  (`redact.ts`'s `sanitizeCommandLines`) — empty when `collectProcessTree` reported `skipped`. */
  readonly processes: readonly RawProcess[];
  /** `pid -> cwd` (`/proc/<pid>/cwd`, resolved separately by `run.ts` — a symlink read, not part
   *  of `process-tree.ts`'s own flat scan); a pid with no entry gets `workingDirectory: ''`
   *  (Process's identityKey still has a value to key off, just an empty one — an unreadable `cwd`
   *  is a normal race with process exit, not a reason to drop the whole process). */
  readonly workingDirectories: ReadonlyMap<number, string>;
}

function processIdentity(
  process: RawProcess,
  workingDirectories: ReadonlyMap<number, string>,
): Record<string, unknown> {
  return {
    executablePath: process.executablePath,
    workingDirectory: workingDirectories.get(process.pid) ?? '',
    parentPid: process.ppid,
  };
}

export function buildPhase1Observations(input: BuildPhase1Input): IngestObservation[] {
  const observations: IngestObservation[] = [
    { objectType: 'Host', identity: { hostname: input.hostname } },
  ];

  for (const repository of input.repositories) {
    observations.push({
      objectType: 'Repository',
      identity: { remoteUrl: repository.remoteUrl },
      properties: { repoPath: repository.repoPath, remoteName: repository.remoteName },
    });
  }

  for (const image of input.images) {
    if (!image.digest) continue; // Image identityKey = [digest] — nothing to key an untagged/undigested image by.
    observations.push({
      objectType: 'Image',
      identity: { digest: image.digest },
      properties: { repoTags: image.repoTags },
    });
  }

  const processesByPid = new Map(input.processes.map((p) => [p.pid, p]));
  for (const process of input.processes) {
    const links: IngestLink[] = [];
    const parent = processesByPid.get(process.ppid);
    if (parent) {
      links.push({
        linkType: 'spawned_by',
        target: {
          objectType: 'Process',
          identity: processIdentity(parent, input.workingDirectories),
        },
      });
    }
    observations.push({
      objectType: 'Process',
      identity: processIdentity(process, input.workingDirectories),
      properties: { commandLine: process.commandLine, pid: process.pid },
      links,
    });
  }

  return observations;
}

// -------------------------------------------------------------------------------------------
// Phase 2 — needs Host's resolved graph id: ComposeProject, Volume, Network, SystemdService.
// -------------------------------------------------------------------------------------------

export interface ComposeProjectInfo {
  readonly projectName: string;
  readonly containers: readonly ContainerSummary[];
}

/** Groups containers by their `com.docker.compose.project` label — a container carrying no such
 *  label is not compose-managed and is out of this v1's identity scheme (`ontology/ops-assets-v1.
 *  yaml`'s own header comment: "S3.3's collector only observes compose-managed containers"). */
export function groupContainersByComposeProject(
  containers: readonly ContainerSummary[],
): ComposeProjectInfo[] {
  const byProject = new Map<string, ContainerSummary[]>();
  for (const container of containers) {
    const projectName = container.labels[COMPOSE_PROJECT_LABEL];
    if (!projectName) continue;
    const list = byProject.get(projectName) ?? [];
    list.push(container);
    byProject.set(projectName, list);
  }
  return [...byProject.entries()].map(([projectName, projectContainers]) => ({
    projectName,
    containers: projectContainers,
  }));
}

export interface BuildPhase2Input {
  readonly hostname: string;
  readonly hostId: string;
  readonly composeProjects: readonly ComposeProjectInfo[];
  readonly volumes: readonly VolumeSummary[];
  readonly networks: readonly NetworkSummary[];
  readonly systemdServices: readonly RawSystemdService[];
}

export function buildPhase2Observations(input: BuildPhase2Input): IngestObservation[] {
  const observations: IngestObservation[] = [];
  const hostTarget = { objectType: 'Host', identity: { hostname: input.hostname } };

  for (const project of input.composeProjects) {
    observations.push({
      objectType: 'ComposeProject',
      identity: { hostId: input.hostId, projectName: project.projectName },
      links: [{ linkType: 'runs_on', target: hostTarget }],
    });
  }

  for (const volume of input.volumes) {
    const projectName = volume.labels[COMPOSE_PROJECT_LABEL];
    const links: IngestLink[] = projectName
      ? [
          {
            linkType: 'part_of',
            target: {
              objectType: 'ComposeProject',
              identity: { hostId: input.hostId, projectName },
            },
          },
        ]
      : [];
    observations.push({
      objectType: 'Volume',
      identity: { hostId: input.hostId, volumeName: volume.name },
      links,
    });
  }

  for (const network of input.networks) {
    const projectName = network.labels[COMPOSE_PROJECT_LABEL];
    const links: IngestLink[] = projectName
      ? [
          {
            linkType: 'part_of',
            target: {
              objectType: 'ComposeProject',
              identity: { hostId: input.hostId, projectName },
            },
          },
        ]
      : [];
    observations.push({
      objectType: 'Network',
      identity: { hostId: input.hostId, networkName: network.name },
      links,
    });
  }

  for (const service of input.systemdServices) {
    observations.push({
      objectType: 'SystemdService',
      identity: { hostId: input.hostId, unitName: service.unitName },
      properties: {
        loadState: service.loadState,
        activeState: service.activeState,
        subState: service.subState,
        description: service.description,
      },
      links: [{ linkType: 'runs_on', target: hostTarget }],
    });
  }

  return observations;
}

// -------------------------------------------------------------------------------------------
// Phase 3 — needs each ComposeProject's resolved graph id: Container, and every link hanging off
// it (uses_image, mounts, attached_to, exposes, depends_on, part_of, runs_on). Image/Volume/
// Network/Endpoint/Host link *targets* only ever need their own natural identity (never a
// resolved id of their own) — see this module's own doc comment.
// -------------------------------------------------------------------------------------------

export interface BuildPhase3Input {
  readonly hostname: string;
  readonly hostId: string;
  /** `projectName -> resolved ComposeProject graph id` (from phase 2's own `submit_observations`
   *  response `objects[]`). A project missing from this map is skipped defensively (should not
   *  happen if phase 2 succeeded for every project in `composeProjects`). */
  readonly composeProjectIds: ReadonlyMap<string, string>;
  readonly composeProjects: readonly ComposeProjectInfo[];
}

export function buildPhase3Observations(input: BuildPhase3Input): IngestObservation[] {
  const observations: IngestObservation[] = [];

  for (const project of input.composeProjects) {
    const composeProjectId = input.composeProjectIds.get(project.projectName);
    if (!composeProjectId) continue;

    for (const container of project.containers) {
      const serviceName = container.labels[COMPOSE_SERVICE_LABEL] ?? container.name;
      const identity = { composeProjectId, serviceName };
      const links: IngestLink[] = [
        {
          linkType: 'runs_on',
          target: { objectType: 'Host', identity: { hostname: input.hostname } },
        },
        {
          linkType: 'part_of',
          target: {
            objectType: 'ComposeProject',
            identity: { hostId: input.hostId, projectName: project.projectName },
          },
        },
      ];

      if (container.imageDigest) {
        links.push({
          linkType: 'uses_image',
          target: { objectType: 'Image', identity: { digest: container.imageDigest } },
        });
      }

      for (const volumeName of container.volumeNames) {
        links.push({
          linkType: 'mounts',
          target: { objectType: 'Volume', identity: { hostId: input.hostId, volumeName } },
        });
      }

      for (const networkName of container.networkNames) {
        links.push({
          linkType: 'attached_to',
          target: { objectType: 'Network', identity: { hostId: input.hostId, networkName } },
        });
      }

      for (const port of container.ports) {
        links.push({
          linkType: 'exposes',
          target: {
            objectType: 'Endpoint',
            identity: {
              hostId: input.hostId,
              address: port.ip ?? '0.0.0.0',
              port: port.privatePort,
            },
          },
        });
      }

      const dependsOn = container.labels[COMPOSE_DEPENDS_ON_LABEL];
      if (dependsOn) {
        for (const dependencyServiceName of dependsOn
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)) {
          links.push({
            linkType: 'depends_on',
            target: {
              objectType: 'Container',
              identity: { composeProjectId, serviceName: dependencyServiceName },
            },
          });
        }
      }

      observations.push({
        objectType: 'Container',
        identity,
        properties: {
          containerId: container.id,
          image: container.image,
          state: container.state,
          status: container.status,
        },
        links,
      });
    }
  }

  return observations;
}
