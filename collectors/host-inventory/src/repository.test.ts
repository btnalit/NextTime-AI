import { describe, expect, it } from 'vitest';
import { collectRepositories, parseGitRemoteOutput, sanitizeRemoteUrl } from './repository.js';

describe('parseGitRemoteOutput (pure)', () => {
  it('de-duplicates the fetch/push pair for one remote into a single entry', () => {
    const stdout = [
      'origin\thttps://github.com/example/repo.git (fetch)',
      'origin\thttps://github.com/example/repo.git (push)',
    ].join('\n');
    expect(parseGitRemoteOutput(stdout)).toEqual([
      { name: 'origin', url: 'https://github.com/example/repo.git' },
    ]);
  });

  it('parses multiple distinct remotes', () => {
    const stdout = [
      'origin\thttps://github.com/example/repo.git (fetch)',
      'origin\thttps://github.com/example/repo.git (push)',
      'upstream\tgit@github.com:example/upstream.git (fetch)',
      'upstream\tgit@github.com:example/upstream.git (push)',
    ].join('\n');
    expect(parseGitRemoteOutput(stdout)).toEqual([
      { name: 'origin', url: 'https://github.com/example/repo.git' },
      { name: 'upstream', url: 'git@github.com:example/upstream.git' },
    ]);
  });

  it('returns an empty array for a repo with no remotes', () => {
    expect(parseGitRemoteOutput('')).toEqual([]);
  });

  it('ignores malformed lines', () => {
    expect(parseGitRemoteOutput('not a remote line\n')).toEqual([]);
  });
});

describe('collectRepositories', () => {
  it('collects remotes for every configured path', async () => {
    const result = await collectRepositories(['/repo-a', '/repo-b'], {
      runner: async (_args, cwd) => ({
        stdout: `origin\thttps://example.invalid/${cwd === '/repo-a' ? 'a' : 'b'}.git (fetch)\n`,
      }),
    });
    expect(result).toEqual([
      { remoteUrl: 'https://example.invalid/a.git', repoPath: '/repo-a', remoteName: 'origin' },
      { remoteUrl: 'https://example.invalid/b.git', repoPath: '/repo-b', remoteName: 'origin' },
    ]);
  });

  it('skips a path that is not a git repository without aborting the others', async () => {
    const result = await collectRepositories(['/not-a-repo', '/repo-a'], {
      runner: async (_args, cwd) => {
        if (cwd === '/not-a-repo') throw new Error('fatal: not a git repository');
        return { stdout: 'origin\thttps://example.invalid/a.git (fetch)\n' };
      },
    });
    expect(result).toEqual([
      { remoteUrl: 'https://example.invalid/a.git', repoPath: '/repo-a', remoteName: 'origin' },
    ]);
  });

  it('returns an empty array when no repo paths are configured (optional env, off by default)', async () => {
    const result = await collectRepositories([]);
    expect(result).toEqual([]);
  });
});

describe('sanitizeRemoteUrl (R-25, D-27)', () => {
  it.each([
    ['https://user:ghp_secret123@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https://x-access-token:abc@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https://oauth2:glpat-xyz@gitlab.example/org/repo.git', 'https://gitlab.example/org/repo.git'],
    ['https://token@github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['https://github.com/org/repo.git?private_token=abc#frag', 'https://github.com/org/repo.git'],
    ['ssh://git:pw@git.example:2222/org/repo.git', 'ssh://git.example:2222/org/repo.git'],
    ['git@github.com:org/repo.git', 'github.com:org/repo.git'],
    ['ghp_secret@github.com:org/repo.git?x=1', 'github.com:org/repo.git'],
    ['https://github.com/org/repo.git', 'https://github.com/org/repo.git'],
    ['/srv/mirrors/repo.git', '/srv/mirrors/repo.git'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeRemoteUrl(input)).toBe(expected);
  });

  it('collectRepositories never returns a credential-bearing remote URL', async () => {
    const result = await collectRepositories(['/repo-a'], {
      runner: async () => ({
        stdout: 'origin\thttps://bot:s3cr3t@example.invalid/a.git?token=t (fetch)\n',
      }),
    });
    expect(result).toEqual([
      { remoteUrl: 'https://example.invalid/a.git', repoPath: '/repo-a', remoteName: 'origin' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/s3cr3t|token=t|bot:/);
  });
});
