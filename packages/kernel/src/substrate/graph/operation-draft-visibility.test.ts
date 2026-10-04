import { describe, expect, it } from 'vitest';
import {
  linkTouchesHiddenOperationDraftSql,
  operationDraftHiddenSql,
  operationDraftVisibleTo,
} from './operation-draft-visibility.js';

/**
 * Unit tests (no database) for the Operation-draft read rule (STATUS leftover 123, D-26). The SQL
 * form is checked against this TS form on the full row × viewer matrix in
 * operation-draft-visibility.integration.test.ts (real Postgres).
 */

const PROPOSER = 'proposer-id';
const OTHER = 'other-id';

describe('operationDraftVisibleTo', () => {
  const member = (principalId: string) => ({ principalId, seesEveryDraft: false });
  const reviewer = (principalId: string) => ({ principalId, seesEveryDraft: true });
  const recorded = { proposedBy: PROPOSER, proposedByKind: 'agent' };

  it('published and deprecated rows are visible to everyone', () => {
    for (const status of ['published', 'deprecated']) {
      expect(operationDraftVisibleTo(member(OTHER), { status, ...recorded })).toBe(true);
    }
  });

  it('a draft is visible to its recorded proposer and to reviewers, hidden from anyone else', () => {
    const draft = { status: 'draft', ...recorded };
    expect(operationDraftVisibleTo(member(PROPOSER), draft)).toBe(true);
    expect(operationDraftVisibleTo(reviewer(OTHER), draft)).toBe(true);
    expect(operationDraftVisibleTo(member(OTHER), draft)).toBe(false);
  });

  it('a row with no status reads as a draft', () => {
    expect(operationDraftVisibleTo(member(OTHER), { status: undefined, ...recorded })).toBe(false);
    expect(operationDraftVisibleTo(member(OTHER), { status: null, ...recorded })).toBe(false);
    expect(operationDraftVisibleTo(member(PROPOSER), { status: undefined, ...recorded })).toBe(
      true,
    );
  });

  it('a proposer counts only when recorded with its kind — otherwise the draft is reviewers only', () => {
    // A legacy row: proposedBy without proposedByKind is nobody's draft (#455), even for that id.
    for (const proposedByKind of [undefined, null]) {
      const legacy = { status: 'draft', proposedBy: PROPOSER, proposedByKind };
      expect(operationDraftVisibleTo(member(PROPOSER), legacy)).toBe(false);
      expect(operationDraftVisibleTo(reviewer(OTHER), legacy)).toBe(true);
    }
    const noProposer = { status: 'draft', proposedBy: undefined, proposedByKind: undefined };
    expect(operationDraftVisibleTo(member(OTHER), noProposer)).toBe(false);
    expect(operationDraftVisibleTo(reviewer(OTHER), noProposer)).toBe(true);
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
