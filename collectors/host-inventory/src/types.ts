/**
 * types: the local, package-owned shape of `submit_observations`' wire params (design doc §5.1.3;
 * docs/development-tasks.md S3.3). Duplicated from `packages/shared/src/capabilities.ts`'s
 * registry shape rather than depending on `@nexttime/shared` — this collector talks to the kernel
 * purely over HTTP (`kernel-client.ts`), the same "an external client of the platform" position a
 * real third-party collector would be in; it has no in-process access to kernel-only types and
 * should not need a workspace dependency on the kernel's own domain package just to describe the
 * JSON it sends.
 */

export interface IngestLinkTarget {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
}

export interface IngestLink {
  readonly linkType: string;
  readonly target: IngestLinkTarget;
  readonly properties?: Record<string, unknown>;
}

export interface IngestObservation {
  readonly objectType: string;
  readonly identity: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
  readonly links?: readonly IngestLink[];
}
