/**
 * runtime-contract: the mount layout this supervisor and the runtime image's `entrypoint.sh`
 * agree on. Since the whitelist start (STATUS leftover 422) the supervisor mounts the published
 * system prompt and Skills read-only at `/opt/nexttime/platform` and `models.json` at
 * `/opt/nexttime/models.json` (`host-paths.ts`), and nothing under `/workspace/.pi/agent`. An
 * image built before that reads all three from the workspace: started by this supervisor it
 * would come up without models and with a stale or default prompt — a broken agent that only
 * shows itself at its first prompt. So every image this supervisor starts must say, in its own
 * `IMAGE_RUNTIME_CONTRACT_LABEL` (`deploy/worker-runtime/Dockerfile`), that it speaks this
 * layout; one that doesn't is refused with `runtime_image_incompatible` before any container is
 * touched (`server.ts` maps it to 409). Bump `RUNTIME_CONTRACT_VERSION` together with the
 * Dockerfile's label whenever the layout changes again (`runtime-contract.test.ts` fails while they
 * differ). The containers it starts carry the version too (`spawn-spec.ts`
 * `CONTAINER_RUNTIME_CONTRACT_LABEL`), so one an older supervisor started is recreated.
 *
 * This is a compatibility check, not an authorization one (the image allowlist is that, in
 * `server.ts`): the image is read through the read-only images connection (`index.ts`; the
 * container connection may not read images), and when that read fails the spawn goes ahead with
 * a warning rather than making every spawn depend on that connection being up.
 */

import type { DockerClient } from './docker-client.js';

export const IMAGE_RUNTIME_CONTRACT_LABEL = 'ai.nexttime.runtime-contract';
export const RUNTIME_CONTRACT_VERSION = '2';

export class RuntimeImageIncompatibleError extends Error {
  readonly code = 'runtime_image_incompatible';
  readonly image: string;
  readonly found: string | undefined;

  constructor(image: string, found: string | undefined) {
    super(
      `image ${image} does not speak runtime contract ${RUNTIME_CONTRACT_VERSION} (label ${IMAGE_RUNTIME_CONTRACT_LABEL}=${found ?? '<missing>'}); build the runtime image from this release and make it active`,
    );
    this.name = 'RuntimeImageIncompatibleError';
    this.image = image;
    this.found = found;
  }
}

/** Refuses `image` unless it carries the current contract label. An image the host doesn't have
 *  passes through: `createAndStart` then fails on it the way it always has. */
export async function assertRuntimeContract(
  imagesDocker: DockerClient,
  image: string,
): Promise<void> {
  let info: Awaited<ReturnType<DockerClient['inspectImage']>>;
  try {
    info = await imagesDocker.inspectImage(image);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'runtime image contract check skipped: the image could not be read',
        image,
        error: String(err),
      }),
    );
    return;
  }
  if (!info) return;
  // Docker reports `Config.Labels` as null for an image without any label.
  const found = info.labels?.[IMAGE_RUNTIME_CONTRACT_LABEL];
  if (found !== RUNTIME_CONTRACT_VERSION) throw new RuntimeImageIncompatibleError(image, found);
}
