import { PublishedSkillNameSchema, matchesSuffix } from '@nexttime/shared';
import { describe, expect, it } from 'vitest';
import {
  egressDenyHost,
  finalizeSkillName,
  normalizeEgressDenyText,
  slugifySkillNameDraft,
} from './catalog-input.js';

describe('skill name normalization (publish rule: PublishedSkillNameSchema)', () => {
  it('rewrites toward the rule as typed, keeping one trailing hyphen for the next word', () => {
    expect(slugifySkillNameDraft('Restart Web')).toBe('restart-web');
    expect(slugifySkillNameDraft('restart_')).toBe('restart-');
    expect(slugifySkillNameDraft('  --a__b..c  ')).toBe('a-b-c-');
    expect(slugifySkillNameDraft('Café Ops')).toBe('cafe-ops');
    expect(slugifySkillNameDraft('x'.repeat(80))).toHaveLength(64);
  });

  it('finalizes to a name the publish schema accepts, or empty when nothing usable is left', () => {
    for (const raw of ['Restart Web', 'restart-', ' A  B ', `${'a'.repeat(63)}-b`, 'v2.Deploy']) {
      const name = finalizeSkillName(raw);
      expect(PublishedSkillNameSchema.safeParse(name).success, `${raw} → ${name}`).toBe(true);
    }
    expect(finalizeSkillName('重启服务')).toBe('');
    expect(finalizeSkillName('---')).toBe('');
  });
});

describe('egress deny normalization (matched by matchesSuffix)', () => {
  it('reduces an entry to the bare lowercase host', () => {
    expect(egressDenyHost('https://Admin.Example.com:8443/path?q=1#x')).toBe('admin.example.com');
    expect(egressDenyHost('user:pw@db.example.com:5432')).toBe('db.example.com');
    expect(egressDenyHost('*.corp.example')).toBe('corp.example');
    expect(egressDenyHost('.lan.example.')).toBe('lan.example');
    expect(egressDenyHost('[fd00::1]:80')).toBe('fd00::1');
    expect(egressDenyHost('fd00::1')).toBe('fd00::1');
    expect(egressDenyHost('https://')).toBe('');
  });

  it('a normalized entry matches the URL host it came from and its subdomains; the raw entry did not', () => {
    const raw = ['https://internal.example/x', '.corp.example'];
    expect(matchesSuffix('a.internal.example', raw)).toBe(false);
    expect(matchesSuffix('a.corp.example', raw)).toBe(false);
    const normalized = raw.map(egressDenyHost);
    expect(matchesSuffix('a.internal.example', normalized)).toBe(true);
    expect(matchesSuffix('a.corp.example', normalized)).toBe(true);
  });

  it('normalizes the whole list, dropping blanks and duplicates and reporting each rewrite', () => {
    expect(normalizeEgressDenyText('https://a.example/x, a.example\n\nb.example\nhttp://')).toEqual(
      {
        text: 'a.example\nb.example',
        changes: [
          { from: 'https://a.example/x', to: 'a.example' },
          { from: 'http://', to: '' },
        ],
      },
    );
    expect(normalizeEgressDenyText('a.example').changes).toEqual([]);
  });
});
