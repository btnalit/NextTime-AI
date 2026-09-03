import { describe, expect, it } from 'vitest';
import {
  ProposeSkillContentSchema,
  PublishedSkillDescriptionSchema,
  PublishedSkillNameSchema,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SkillApplicableSchema,
} from './skill.js';

describe('ProposeSkillContentSchema', () => {
  it('accepts a minimal skill (name/description/markdown only)', () => {
    const result = ProposeSkillContentSchema.safeParse({
      name: 'diagnose-network',
      description: 'Find the top talker on the network.',
      markdown: 'Run `ss -tnp` and look for the highest byte count.',
    });
    expect(result.success).toBe(true);
  });

  it('accepts applicable when present', () => {
    const result = ProposeSkillContentSchema.safeParse({
      name: 'diagnose-network',
      description: 'Find the top talker on the network.',
      markdown: 'Run `ss -tnp`.',
      applicable: { gateKinds: ['ssh'], objectTypes: ['Host'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing field', () => {
    expect(ProposeSkillContentSchema.safeParse({ name: 'x', description: 'y' }).success).toBe(
      false,
    );
  });

  it('rejects an empty name/description/markdown', () => {
    expect(
      ProposeSkillContentSchema.safeParse({ name: '', description: 'y', markdown: 'z' }).success,
    ).toBe(false);
    expect(
      ProposeSkillContentSchema.safeParse({ name: 'x', description: '', markdown: 'z' }).success,
    ).toBe(false);
    expect(
      ProposeSkillContentSchema.safeParse({ name: 'x', description: 'y', markdown: '' }).success,
    ).toBe(false);
  });

  it('accepts a name/description that would fail the stricter publish-time rule (propose is permissive)', () => {
    const result = ProposeSkillContentSchema.safeParse({
      name: 'Not Lowercase',
      description: 'y',
      markdown: 'z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(
      ProposeSkillContentSchema.safeParse({
        name: 'x',
        description: 'y',
        markdown: 'z',
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe('SkillApplicableSchema', () => {
  it('accepts an empty object', () => {
    expect(SkillApplicableSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(SkillApplicableSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('PublishedSkillNameSchema (pi Agent Skills rule)', () => {
  it('accepts a valid lowercase-hyphenated name', () => {
    expect(PublishedSkillNameSchema.safeParse('diagnose-network').success).toBe(true);
  });

  it('rejects uppercase letters', () => {
    expect(PublishedSkillNameSchema.safeParse('Diagnose-Network').success).toBe(false);
  });

  it('rejects leading/trailing hyphens', () => {
    expect(PublishedSkillNameSchema.safeParse('-diagnose').success).toBe(false);
    expect(PublishedSkillNameSchema.safeParse('diagnose-').success).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(PublishedSkillNameSchema.safeParse('diagnose--network').success).toBe(false);
  });

  it('rejects a name over the max length', () => {
    expect(PublishedSkillNameSchema.safeParse('a'.repeat(SKILL_NAME_MAX_LENGTH + 1)).success).toBe(
      false,
    );
  });

  it('accepts a name exactly at the max length', () => {
    expect(PublishedSkillNameSchema.safeParse('a'.repeat(SKILL_NAME_MAX_LENGTH)).success).toBe(
      true,
    );
  });
});

describe('PublishedSkillDescriptionSchema (pi Agent Skills rule)', () => {
  it('accepts a normal description', () => {
    expect(PublishedSkillDescriptionSchema.safeParse('What this skill does.').success).toBe(true);
  });

  it('rejects an empty description', () => {
    expect(PublishedSkillDescriptionSchema.safeParse('').success).toBe(false);
  });

  it('rejects a description over the max length', () => {
    expect(
      PublishedSkillDescriptionSchema.safeParse('a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });
});
