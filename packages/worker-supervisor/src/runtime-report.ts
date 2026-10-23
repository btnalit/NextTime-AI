/**
 * runtime-report (S11 W1a): what a Task container actually runs, as `POST /task/spawn` reports it
 * back to the kernel — which records it once on the WorkerRun (`worker_runs.runtime_report`,
 * kernel `application/task/run-fingerprint.ts`).
 *
 * Everything comes from the container Docker created, not from the request: `imageId` is
 * Docker's top-level `Image` (`ContainerState.imageId`), the image the tag resolved to when the
 * container was created — a tag moved afterwards changes nothing here. The three version labels
 * are the image's own build labels (`deploy/worker-runtime/Dockerfile`), which Docker copies onto
 * the container.
 *
 * `modelsConfigDigest` is the sha256 of the `models.json` the container mounts, read by this
 * process from its own read-only view of `${NEXTTIME_DATA}/models` (docker-compose.yml) just
 * before the container is created. It says which model a run used when it named none: pi then
 * takes its default from that file. Only the default location is readable here — when
 * `MODELS_JSON_HOST_PATH` points elsewhere (an acceptance run) the digest is not reported rather
 * than the digest of a file the container never sees. llm-proxy replaces the file by rename, so a
 * provider saved in the instant between this read and the create is not seen; the next run is.
 * The file holds no credential: every provider's key in it is the literal `$CAPABILITY_HANDLE`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SupervisorConfig } from './config.js';
import {
  type ContainerState,
  IMAGE_BUILT_FROM_LABEL,
  IMAGE_PI_VERSION_LABEL,
  IMAGE_PLATFORM_EXTENSION_VERSION_LABEL,
} from './docker-client.js';
import { localModelsJsonPath } from './host-paths.js';

export interface TaskRuntimeReport {
  /** The image reference the container was created from (the request's, or `WORKER_IMAGE`). */
  readonly imageRef: string;
  /** Docker's resolved image id (`sha256:…`). */
  readonly imageId: string;
  readonly piVersion?: string;
  readonly platformExtensionVersion?: string;
  readonly builtFrom?: string;
  /** `sha256:<hex>` of the mounted `models.json`; absent when this process cannot read it. */
  readonly modelsConfigDigest?: string;
}

/** The digest of the `models.json` a Task container about to be created will mount, or
 *  `undefined` when it is not the default location this process can read, or the read fails. */
export function readModelsConfigDigest(config: SupervisorConfig): string | undefined {
  if (config.modelsJsonHostPath !== `${config.nextTimeData}/models/models.json`) return undefined;
  try {
    const content = readFileSync(localModelsJsonPath(config));
    return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return undefined;
  }
}

function label(container: ContainerState, key: string): string | undefined {
  const value = container.labels[key];
  return value === undefined || value === '' ? undefined : value;
}

export function taskRuntimeReport(
  imageRef: string,
  container: ContainerState,
  modelsConfigDigest: string | undefined,
): TaskRuntimeReport {
  return {
    imageRef,
    imageId: container.imageId,
    piVersion: label(container, IMAGE_PI_VERSION_LABEL),
    platformExtensionVersion: label(container, IMAGE_PLATFORM_EXTENSION_VERSION_LABEL),
    builtFrom: label(container, IMAGE_BUILT_FROM_LABEL),
    modelsConfigDigest,
  };
}
