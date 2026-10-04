import { describe, expect, it } from 'vitest';
import {
  linkTouchesHiddenOperationDraftSql,
  operationDraftHiddenSql,
  operationDraftVisibleTo,
} from './operation-draft-visibility.js';

/**
 * Unit tests (no database) for the Operation-draft read rule (STATUS leftover 123, D-26). The SQL
 * form runs against real Postgres in application/gateway/graph-draft-visibility.integration.test.ts.
 */

const PROPOSER = 'proposer-id';
const OTHER = 'other-id';

describe('operationDraftVisibleTo', () => {
  const member = (principalId: string) => ({ principalId, seesEveryDraft: false });
  const reviewer = (principalId: string) => ({ principalId, seesEveryDraft: true });

  it('published and deprecated rows are visible to everyone', () => {
    for (const status of ['published', 'deprecated']) {
      expect(operationDraftVisibleTo(member(OTHER), { status, proposedBy: PROPOSER })).toBe(true);
    }
  });

  it('a draft is visible to its proposer and to reviewers, hidden from anyone else', () => {
    const draft = { status: 'draft', proposedBy: PROPOSER };
    expect(operationDraftVisibleTo(member(PROPOSER), draft)).toBe(true);
    expect(operationDraftVisibleTo(reviewer(OTHER), draft)).toBe(true);
    expect(operationDraftVisibleTo(member(OTHER), draft)).toBe(false);
  });

  it('a row with no status reads as a draft; a draft with no proposer is reviewers only', () => {
    expect(
      operationDraftVisibleTo(member(PROPOSER), { status: undefined, proposedBy: OTHER }),
    ).toBe(false);
    expect(operationDraftVisibleTo(member(OTHER), { status: 'draft', proposedBy: undefined })).toBe(
      false,
    );
    expect(
      operationDraftVisibleTo(reviewer(OTHER), { status: 'draft', proposedBy: undefined }),
    ).toBe(true);
  });
});

describe('SQL form', () => {
  it('names only Operation drafts, and binds the reviewer bit and the principal by placeholder', () => {
    const sql = operationDraftHiddenSql('o', '$5', '$6');
    expect(sql).toContain("o.object_type = 'Operation'");
    expect(sql).toContain("coalesce(o.properties ->> 'status', 'draft') = 'draft'");
    expect(sql).toContain('not $5::boolean');
    expect(sql).toContain("o.properties ->> 'proposedBy' is distinct from $6::text");
    expect(sql).toContain("o.properties ->> 'proposedByKind' is null");
  });

  it('a Fact is tested on both endpoints with primary-key probes', () => {
    const sql = linkTouchesHiddenOperationDraftSql('l', '$3', '$4');
    expect(sql).toContain('hidden_op.workspace_id = l.workspace_id');
    expect(sql).toContain('hidden_op.id in (l.source_object_id, l.target_object_id)');
    expect(sql).toContain("hidden_op.object_type = 'Operation'");
  });
});
