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

describe('platformErrorMessage — trial workspace (S11 AA3a)', () => {
  it('trial_workspace says why a trial workspace cannot be the default', () => {
    const err = new HttpError(
      'capability_error',
      'a trial workspace cannot be…',
      'trial_workspace',
    );
    expect(platformErrorMessage(err, zh)).toContain('试验工作区不能设为默认工作区');
    expect(platformErrorMessage(err, en)).toContain('trial workspace cannot be the default');
  });
});

describe('platformErrorMessage — removed membership (legacy 730)', () => {
  it('membership_removed says the role is frozen and the user comes back by being added again', () => {
    const err = new HttpError(
      'capability_error',
      "the user's membership in workspace ws-1 is removed",
      'membership_removed',
    );
    expect(platformErrorMessage(err, zh)).toContain('角色不能再改');
    expect(platformErrorMessage(err, zh)).toContain('在「加入工作区」里重新加入');
    expect(platformErrorMessage(err, en)).toContain('Add to a workspace');
    expect(platformErrorMessage(err, zh)).not.toContain('ws-1');
  });
});
