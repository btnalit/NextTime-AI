import { describe, expect, it } from 'vitest';
import { HttpError } from './http-client.js';
import type { Translate } from './i18n.js';
import { platformErrorMessage } from './platform-errors.js';

/** platform-errors.test: the 运行层 page's four refusals (S7-E, `application/platform/runtime.ts`)
 *  read in the viewer's language — they used to fall through to the generic pointer at the
 *  technical details. */

const zh: Translate = (z) => z;
const en: Translate = (_z, e) => e;

describe('platformErrorMessage — runtime refusals', () => {
  it.each([
    ['image_not_in_inventory', '先在主机或 CI 上构建它'],
    ['image_not_allowed', '允许列表'],
    ['runtime_unreachable', '连不上运行层'],
    ['no_previous_settings_version', '没有另一个活动镜像可以回滚'],
  ])('%s has bilingual copy, not the kernel’s text', (code, phrase) => {
    const err = new HttpError(
      'capability_error',
      'image "x" is not in worker-supervisor’s WORKER_IMAGE_ALLOWLIST',
      code,
    );
    expect(platformErrorMessage(err, zh)).toContain(phrase);
    expect(platformErrorMessage(err, zh)).not.toContain('WORKER_IMAGE_ALLOWLIST');
    expect(platformErrorMessage(err, en)?.length).toBeGreaterThan(0);
    expect(platformErrorMessage(err, en)).not.toContain('WORKER_IMAGE_ALLOWLIST');
  });

  it('an unmapped code is left to the shared copy', () => {
    expect(platformErrorMessage(new HttpError('capability_error', 'x', 'conflict'), zh)).toBeNull();
  });
});
