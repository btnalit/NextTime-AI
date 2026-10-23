import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TaskRuntimeReport } from '../../adapters/supervisor-client/index.js';

/**
 * application/task/run-fingerprint (S11 W1a; migrations/task/0009_worker_run_fingerprint.sql):
 * what a WorkerRun ran with, recorded once on the run.
 *
 *   - {@link RunSpec} — the kernel's half, resolved by the callers of `spawnWorkerRun` and written
 *     in the INSERT that creates the run (`spawn.ts`).
 *   - {@link RunRuntimeReport} — worker-supervisor's half, what the container it started actually
 *     runs, written in the UPDATE that moves the run `provisioning → running`.
 *   - {@link environmentDigest} — the key outcomes of runs are grouped by (E2).
 *
 * A goal step's attempt also keeps a RunConfigSnapshot on its Task (`goal-step.ts`): that is what
 * the next attempt starts from, this is what each run actually ran with. Where the two overlap
 * (WorkerDefinition version, model, requested image, prompt digest) they agree — a test holds them
 * to it.
 *
 * Never a prompt, a Task input or a credential: ids, versions, a model id, image references and
 * digests.
 */

export const RunSpecSchema = z
  .object({
    v: z.literal(1),
    definition: z.object({ id: z.string(), version: z.number().int().positive() }).strict(),
    /** `null`: neither the WorkerDefinition nor the requester named one — pi's default. */
    model: z.string().nullable(),
    /** `null`: worker-supervisor's own default image (`WORKER_IMAGE`). */
    image: z.string().nullable(),
    /** sha256 of the composed system prompt; `null` when none was composed. */
    systemPromptDigest: z.string().nullable(),
    /** `KERNEL_VERSION` of the build that started the run (`vX.Y.Z (sha)`, or `dev`). */
    kernelVersion: z.string(),
  })
  .strict();
export type RunSpec = z.infer<typeof RunSpecSchema>;

export const RunRuntimeReportSchema = z
  .object({
    v: z.literal(1),
    imageRef: z.string(),
    imageId: z.string(),
    piVersion: z.string().nullable(),
    platformExtensionVersion: z.string().nullable(),
    builtFrom: z.string().nullable(),
    modelsConfigDigest: z.string().nullable(),
  })
  .strict();
export type RunRuntimeReport = z.infer<typeof RunRuntimeReportSchema>;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The platform build this kernel process is (the image's build-time `KERNEL_VERSION`). */
export function currentKernelVersion(): string {
  const version = process.env.KERNEL_VERSION?.trim();
  return version ? version : 'dev';
}

export interface RunSpecInput {
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly model: string | undefined;
  readonly image: string | undefined;
  readonly systemPrompt: string | undefined;
}

export function buildRunSpec(input: RunSpecInput): RunSpec {
  return {
    v: 1,
    definition: { id: input.definitionId, version: input.definitionVersion },
    model: input.model ?? null,
    image: input.image ?? null,
    systemPromptDigest: input.systemPrompt === undefined ? null : sha256Hex(input.systemPrompt),
    kernelVersion: currentKernelVersion(),
  };
}

export function toRunRuntimeReport(report: TaskRuntimeReport): RunRuntimeReport {
  return {
    v: 1,
    imageRef: report.imageRef,
    imageId: report.imageId,
    piVersion: report.piVersion ?? null,
    platformExtensionVersion: report.platformExtensionVersion ?? null,
    builtFrom: report.builtFrom ?? null,
    modelsConfigDigest: report.modelsConfigDigest ?? null,
  };
}

/**
 * Environment digest, algorithm v1 — the five things docs/s10-evolution-plan-2026-10-04.md §5.4
 * names as a run's environment: the WorkerDefinition version, the model, the runtime image (by
 * id, so a tag moved to a rebuild is a different environment), the platform build and the system
 * prompt (by digest). Skill versions are deliberately not in it: they are what E2 compares across
 * environments.
 *
 * When the run named no model, the effective model is pi's default from the mounted `models.json`,
 * so its digest stands in for the model. `null` — no environment to group by — when the runtime is
 * unknown (the run never started, or the supervisor reported nothing) or when the model is the
 * default and the supervisor could not read `models.json`: two such runs may not have run the same
 * model.
 */
export function environmentDigest(spec: RunSpec, runtime: RunRuntimeReport | null): string | null {
  if (runtime === null) return null;
  const model =
    spec.model !== null
      ? `model:${spec.model}`
      : runtime.modelsConfigDigest !== null
        ? `default:${runtime.modelsConfigDigest}`
        : null;
  if (model === null) return null;
  const canonical = JSON.stringify([
    'v1',
    `${spec.definition.id}@${spec.definition.version}`,
    model,
    runtime.imageId,
    spec.kernelVersion,
    spec.systemPromptDigest,
  ]);
  return `v1:${sha256Hex(canonical)}`;
}

export interface RunEnvironment {
  readonly spec: RunSpec;
  readonly runtime: RunRuntimeReport | null;
  readonly environmentDigest: string | null;
}

/** A run's stored fingerprint, or `null` when it has none (a run from before W1a) or what is
 *  stored does not parse. A stored runtime that does not parse reads as unreported, and its
 *  environment digest with it: a digest is never shown without the runtime it was taken over. */
export function readRunEnvironment(row: {
  readonly run_spec: unknown;
  readonly runtime_report: unknown;
  readonly environment_digest: string | null;
}): RunEnvironment | null {
  const spec = RunSpecSchema.safeParse(row.run_spec);
  if (!spec.success) return null;
  const runtime =
    row.runtime_report === null ? null : RunRuntimeReportSchema.safeParse(row.runtime_report);
  const parsedRuntime = runtime?.success ? runtime.data : null;
  return {
    spec: spec.data,
    runtime: parsedRuntime,
    environmentDigest: parsedRuntime === null ? null : row.environment_digest,
  };
}
