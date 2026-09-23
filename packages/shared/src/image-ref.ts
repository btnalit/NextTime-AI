/**
 * image-ref: normalizes a Docker image reference the same way the Docker daemon itself resolves
 * an implicit tag — `name` and `name:latest` are the *identical* image reference (Docker's own
 * semantics, not a loosening of any allowlist this platform enforces).
 *
 * P1-a review follow-up (post-v0.16.0, PR #233): the default `WORKER_IMAGE` env value has no
 * explicit tag (`nexttime-ai-worker-runtime`), but Docker's own `docker images` / the Engine
 * API's `RepoTags` always reports the fully-resolved form (`nexttime-ai-worker-runtime:latest`)
 * for an image built without an explicit tag. An exact-string comparison between the two never
 * succeeds on a real host with no `WORKER_IMAGE_ALLOWLIST` override, making the one built image
 * un-activatable (`set_active_runtime_image` 409s `image_not_allowed`) and, via the same
 * mismatch, un-spawnable (worker-supervisor's own `isImageAllowed` would 403 it too). Both
 * worker-supervisor's `isImageAllowed`/`taskImageAllowlist` and the kernel's
 * `set_active_runtime_image`/`rollback_runtime_image` normalize through this one function before
 * comparing, so the two processes share exactly one definition of "what tag does this reference
 * mean" — never two independently-maintained ones that could drift.
 */
export function normalizeImageRef(ref: string): string {
  // A digest reference (`name@sha256:...`) already names an exact image — appending `:latest`
  // to it would be nonsensical, and Docker itself never does this.
  if (ref.includes('@')) return ref;

  // Only the last path segment (after the final `/`) is checked for a `:` — a registry
  // `host:port` prefix (`host:5000/name`) must never be mistaken for an explicit tag. This
  // mirrors Docker's own reference grammar: a `:` before the first `/` is part of the registry
  // authority, not a tag, unless there is no `/` at all (then it can only be a tag).
  const lastSlash = ref.lastIndexOf('/');
  const lastSegment = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  if (lastSegment.includes(':')) return ref;

  return `${ref}:latest`;
}
