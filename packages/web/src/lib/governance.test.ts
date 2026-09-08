import { describe, expect, it } from 'vitest';
import { healthView, principalDisplayRole } from './governance.js';

describe('healthView', () => {
  it('reads a bare boolean', () => {
    expect(healthView(true)).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView(false)).toEqual({ tone: 'danger', label: 'Unhealthy' });
  });

  it('reads {ok: boolean}', () => {
    expect(healthView({ ok: true })).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView({ ok: false })).toEqual({ tone: 'danger', label: 'Unhealthy' });
  });

  it('reads {status: string} by keyword, case-insensitively', () => {
    expect(healthView({ status: 'Healthy' })).toEqual({ tone: 'ok', label: 'Healthy' });
    expect(healthView({ status: 'unhealthy' })).toEqual({ tone: 'danger', label: 'unhealthy' });
    expect(healthView({ status: 'degraded' })).toEqual({ tone: 'neutral', label: 'degraded' });
  });

  it('falls back to neutral "Unknown" for anything unrecognized — never throws', () => {
    expect(healthView(undefined)).toEqual({ tone: 'neutral', label: 'Unknown' });
    expect(healthView(null)).toEqual({ tone: 'neutral', label: 'Unknown' });
    expect(healthView({ foo: 'bar' })).toEqual({ tone: 'neutral', label: 'Unknown' });
    expect(healthView('healthy')).toEqual({ tone: 'neutral', label: 'Unknown' });
  });
});

describe('principalDisplayRole', () => {
  it('shows the bare role for a human principal, role + kind otherwise', () => {
    expect(principalDisplayRole({ role: 'owner', kind: 'human' })).toBe('owner');
    expect(principalDisplayRole({ role: 'member', kind: 'agent' })).toBe('member · agent');
    expect(principalDisplayRole({ role: 'member', kind: 'service' })).toBe('member · service');
  });
});
