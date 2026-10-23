import { afterEach, describe, expect, it } from 'vitest';
import {
  type RunRuntimeReport,
  type RunSpec,
  buildRunSpec,
  environmentDigest,
  readRunEnvironment,
  sha256Hex,
  toRunRuntimeReport,
} from './run-fingerprint.js';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const MODELS_DIGEST = `sha256:${'b'.repeat(64)}`;

const originalKernelVersion = process.env.KERNEL_VERSION;
afterEach(() => {
  if (originalKernelVersion === undefined) Reflect.deleteProperty(process.env, 'KERNEL_VERSION');
  else process.env.KERNEL_VERSION = originalKernelVersion;
});

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    v: 1,
    definition: { id: 'def-1', version: 3 },
    model: 'anthropic/model-a',
    image: null,
    systemPromptDigest: sha256Hex('You are a plain worker.'),
    kernelVersion: 'v0.50.0 (abc1234)',
    ...overrides,
  };
}

function runtime(overrides: Partial<RunRuntimeReport> = {}): RunRuntimeReport {
  return {
    v: 1,
    imageRef: 'nexttime-ai-worker-runtime',
    imageId: IMAGE_ID,
    piVersion: '1.2.3',
    platformExtensionVersion: '0.50.0',
    builtFrom: 'v0.50.0 (abc1234)',
    modelsConfigDigest: MODELS_DIGEST,
    ...overrides,
  };
}

describe('buildRunSpec (S11 W1a)', () => {
  it('records the definition version, what was asked for and the prompt’s digest, never the prompt', () => {
    process.env.KERNEL_VERSION = 'v0.50.0 (abc1234)';
    const built = buildRunSpec({
      definitionId: 'def-1',
      definitionVersion: 3,
      model: undefined,
      image: 'nexttime-ai-worker-runtime:v0.50.0',
      systemPrompt: 'You are a plain worker.',
    });
    expect(built).toEqual({
      v: 1,
      definition: { id: 'def-1', version: 3 },
      model: null,
      image: 'nexttime-ai-worker-runtime:v0.50.0',
      systemPromptDigest: sha256Hex('You are a plain worker.'),
      kernelVersion: 'v0.50.0 (abc1234)',
    });
    expect(JSON.stringify(built)).not.toContain('plain worker');
  });

  it('records `dev` for a build that set no KERNEL_VERSION, and no digest when no prompt was composed', () => {
    Reflect.deleteProperty(process.env, 'KERNEL_VERSION');
    const built = buildRunSpec({
      definitionId: 'def-1',
      definitionVersion: 1,
      model: 'm',
      image: undefined,
      systemPrompt: undefined,
    });
    expect(built.kernelVersion).toBe('dev');
    expect(built.systemPromptDigest).toBeNull();
    expect(built.image).toBeNull();
  });
});

describe('environmentDigest v1 (S11 W1a)', () => {
  it('is stable for the same environment and has the stored shape', () => {
    const digest = environmentDigest(spec(), runtime());
    expect(digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(environmentDigest(spec(), runtime())).toBe(digest);
  });

  it('changes with each of the five things that make an environment', () => {
    const base = environmentDigest(spec(), runtime());
    const variants = [
      environmentDigest(spec({ definition: { id: 'def-1', version: 4 } }), runtime()),
      environmentDigest(spec({ model: 'anthropic/model-b' }), runtime()),
      environmentDigest(spec(), runtime({ imageId: `sha256:${'c'.repeat(64)}` })),
      environmentDigest(spec({ kernelVersion: 'v0.51.0 (def5678)' }), runtime()),
      environmentDigest(spec({ systemPromptDigest: sha256Hex('another prompt') }), runtime()),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('does not change with what only describes the image, or with models.json when a model was named', () => {
    const base = environmentDigest(spec(), runtime());
    expect(
      environmentDigest(
        spec({ image: 'nexttime-ai-worker-runtime:v0.50.0' }),
        runtime({
          imageRef: 'nexttime-ai-worker-runtime:v0.50.0',
          piVersion: null,
          builtFrom: null,
          modelsConfigDigest: `sha256:${'d'.repeat(64)}`,
        }),
      ),
    ).toBe(base);
  });

  it('takes models.json’s digest as the model when the run named none', () => {
    const defaultModel = environmentDigest(spec({ model: null }), runtime());
    expect(defaultModel).toMatch(/^v1:/);
    expect(
      environmentDigest(
        spec({ model: null }),
        runtime({ modelsConfigDigest: `sha256:${'d'.repeat(64)}` }),
      ),
    ).not.toBe(defaultModel);
    expect(defaultModel).not.toBe(environmentDigest(spec(), runtime()));
  });

  it('is unknown when the run never started, or ran the default model from an unread models.json', () => {
    expect(environmentDigest(spec(), null)).toBeNull();
    expect(
      environmentDigest(spec({ model: null }), runtime({ modelsConfigDigest: null })),
    ).toBeNull();
  });
});

describe('readRunEnvironment', () => {
  it('reads a run from before W1a, or a record that does not parse, as not recorded', () => {
    expect(
      readRunEnvironment({ run_spec: null, runtime_report: null, environment_digest: null }),
    ).toBeNull();
    expect(
      readRunEnvironment({ run_spec: { v: 2 }, runtime_report: null, environment_digest: null }),
    ).toBeNull();
  });

  it('reads the kernel’s half alone when the runtime was never reported', () => {
    expect(
      readRunEnvironment({ run_spec: spec(), runtime_report: null, environment_digest: null }),
    ).toEqual({ spec: spec(), runtime: null, environmentDigest: null });
  });

  it('round-trips what spawn stores', () => {
    const report = toRunRuntimeReport({
      imageRef: 'nexttime-ai-worker-runtime',
      imageId: IMAGE_ID,
      piVersion: '1.2.3',
      platformExtensionVersion: undefined,
      builtFrom: undefined,
      modelsConfigDigest: undefined,
    });
    expect(report).toEqual(
      runtime({ platformExtensionVersion: null, builtFrom: null, modelsConfigDigest: null }),
    );
    const stored = JSON.parse(JSON.stringify({ run_spec: spec(), runtime_report: report }));
    expect(
      readRunEnvironment({ ...stored, environment_digest: environmentDigest(spec(), report) }),
    ).toEqual({
      spec: spec(),
      runtime: report,
      environmentDigest: environmentDigest(spec(), report),
    });
  });
});
