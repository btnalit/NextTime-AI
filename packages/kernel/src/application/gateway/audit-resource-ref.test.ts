import { describe, expect, it } from 'vitest';
import { auditResourceRef } from './dispatch.js';

describe('auditResourceRef (dispatch audit safety net)', () => {
  it('passes a uuid resourceId through unchanged', () => {
    const id = '4c63ced9-18b1-451a-ba53-935a97c1ee74';
    expect(auditResourceRef(id)).toEqual({ resourceId: id, resourceRef: undefined });
  });

  it('passes undefined through unchanged', () => {
    expect(auditResourceRef(undefined)).toEqual({ resourceId: undefined, resourceRef: undefined });
  });

  it('moves a non-uuid reference (e.g. a quota key) out of resource_id into the payload ref', () => {
    expect(auditResourceRef('task.max_depth')).toEqual({
      resourceId: undefined,
      resourceRef: 'task.max_depth',
    });
  });
});
