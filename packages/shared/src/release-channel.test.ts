import { describe, expect, it } from 'vitest';
import {
  ReleaseChannelReaderSchema,
  ReleaseChannelSchema,
  ReleaseChannelUrlSchema,
  comparePiVersions,
  comparePlatformVersions,
  platformVersionFromKernelVersion,
} from './release-channel.js';

describe('platformVersionFromKernelVersion', () => {
  it('takes the release tag off a published image’s KERNEL_VERSION', () => {
    expect(platformVersionFromKernelVersion('v0.42.0 (abc1234)')).toBe('v0.42.0');
    expect(platformVersionFromKernelVersion('v0.42.0')).toBe('v0.42.0');
  });

  it('is null for anything that is not a release tag', () => {
    for (const value of ['dev', '', 'v0.42', '0.42.0', 'main (abc)', 'v0.42.0-rc1']) {
      expect(platformVersionFromKernelVersion(value)).toBeNull();
    }
  });
});

describe('version comparison', () => {
  it('compares platform tags numerically, not as strings', () => {
    expect(comparePlatformVersions('v0.10.0', 'v0.9.9')).toBe(1);
    expect(comparePlatformVersions('v0.42.0', 'v0.42.0')).toBe(0);
    expect(comparePlatformVersions('v0.42.0', 'v1.0.0')).toBe(-1);
    expect(comparePlatformVersions('v0.42.0', 'dev')).toBeNull();
  });

  it('sorts a pi pre-release below its release', () => {
    expect(comparePiVersions('1.0.2', '0.99.2')).toBe(1);
    expect(comparePiVersions('1.1.0-beta.1', '1.1.0')).toBe(-1);
    expect(comparePiVersions('1.1.0-beta.2', '1.1.0-beta.1')).toBe(1);
    expect(comparePiVersions('1.0.2', 'latest')).toBeNull();
  });
});

describe('ReleaseChannelUrlSchema', () => {
  it('accepts only GitHub release-tag and Actions-run pages', () => {
    expect(
      ReleaseChannelUrlSchema.safeParse('https://github.com/o/r/releases/tag/v0.43.0').success,
    ).toBe(true);
    expect(
      ReleaseChannelUrlSchema.safeParse('https://github.com/o/r/actions/runs/42').success,
    ).toBe(true);
    for (const url of [
      'http://github.com/o/r/releases/tag/v0.43.0',
      'https://github.com.evil.example/o/r/releases/tag/v0.43.0',
      'https://github.com/o/r/releases/tag/v0.43.0?x=<script>',
      'javascript:alert(1)',
    ]) {
      expect(ReleaseChannelUrlSchema.safeParse(url).success).toBe(false);
    }
  });
});

describe('ReleaseChannelSchema / ReleaseChannelReaderSchema', () => {
  const record = {
    schema: 1,
    generatedAt: '2026-10-08T03:30:00Z',
    platform: {
      latest: 'v0.43.0',
      releases: [
        {
          version: 'v0.43.0',
          previousVersion: 'v0.42.0',
          publishedAt: '2026-10-08T03:00:00Z',
          pi: '1.0.2',
          migrations: ['core 0041'],
          breaking: false,
          notesUrl: 'https://github.com/o/r/releases/tag/v0.43.0',
        },
      ],
    },
    piUpstream: null,
  };

  it('the producer rejects an unknown key; the reader strips it', () => {
    const withExtra = {
      ...record,
      platform: {
        ...record.platform,
        releases: [{ ...record.platform.releases[0], addedLater: true }],
      },
    };
    expect(ReleaseChannelSchema.safeParse(withExtra).success).toBe(false);
    const read = ReleaseChannelReaderSchema.safeParse(withExtra);
    expect(read.success && read.data).toEqual(record);
  });

  it('both accept a record from before previousVersion, and reject a predecessor not older', () => {
    const { previousVersion: _, ...legacyRelease } = record.platform.releases[0] as Record<
      string,
      unknown
    >;
    const legacy = { ...record, platform: { ...record.platform, releases: [legacyRelease] } };
    expect(ReleaseChannelSchema.safeParse(legacy).success).toBe(true);
    expect(ReleaseChannelReaderSchema.safeParse(legacy).success).toBe(true);
    for (const previousVersion of ['v0.43.0', 'v0.44.0']) {
      const bad = {
        ...record,
        platform: {
          ...record.platform,
          releases: [{ ...record.platform.releases[0], previousVersion }],
        },
      };
      expect(ReleaseChannelSchema.safeParse(bad).success).toBe(false);
      expect(ReleaseChannelReaderSchema.safeParse(bad).success).toBe(false);
    }
  });
});
