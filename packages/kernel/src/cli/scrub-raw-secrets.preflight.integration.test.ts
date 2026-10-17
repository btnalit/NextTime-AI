import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDRESS_CREDENTIAL_SQL, addressCredential } from '@nexttime/shared';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../adapters/db/pool.js';
import { findConnectionParamsCredential } from '../governance/connections/index.js';
import { KERNEL_AUTHORED_OBJECT_TYPES } from '../substrate/ontology/index.js';

/**
 * cli/scrub-raw-secrets.preflight: the read-only preflight SQL an operator runs before a release
 * (review of #549, B1) must count at least what the kernel's address rule refuses — it is an upper
 * bound of `@nexttime/shared`'s `addressCredential`, written as PostgreSQL regular expressions. The
 * file carries `ADDRESS_CREDENTIAL_SQL` verbatim and the Object types the scrub leaves out; with a
 * database, both patterns run in PostgreSQL over one corpus next to the TypeScript rule.
 */

const PREFLIGHT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'scrub-raw-secrets.preflight.sql'),
  'utf8',
);
const DATABASE_URL = process.env.DATABASE_URL;
/** Synthetic — spelled out from the alphabet (`.gitleaks.toml`). */
const FAKE = 'abcdefghijklmnopqrstuvwxyz0123';

const CARRYING = [
  `https://ops:${FAKE}@grafana.example`,
  `ssh://deploy:${FAKE}@db-1.example`,
  `https://api.example/v1?token=${FAKE}`,
  `https://api.example/v1?format=json&access_token=${FAKE}`,
  `https://api.example/v1?api_key=${FAKE}`,
  `https://api.example/v1?apikey=${FAKE}`,
  `https://api.example/v1?Password=${FAKE}`,
  `https://api.example/v1?client_secret=${FAKE}`,
  `https://maps.example/api?key=${FAKE}`,
  `https://store.blob.example/c/b?sv=2022-11-02&sp=r&sig=${FAKE}`,
  `https://cdn.example/f?signature=${FAKE}`,
  `https://bucket.s3.example/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20261010&X-Amz-Signature=${FAKE}`,
  `https://bucket.s3.example/o?x-amz-security-token=${FAKE}`,
  `https://storage.example/o?X-Goog-Signature=${FAKE}`,
  `https://storage.example/o?X-Goog-Credential=${FAKE}`,
  `https://app.example/cb#access_token=${FAKE}&token_type=bearer`,
  `https://api.example/v1;jsessionid=x?pwd=${FAKE}`,
  `grafana.example/api?auth=${FAKE}`,
];
const PLAIN = [
  'https://grafana.example.com',
  'https://api.example/openapi.json?format=json',
  'https://api.example/openapi.json?version=3&lang=en',
  'https://api.example/v1?keyName=primary',
  'https://api.example/v1?token=',
  'https://grafana.example:8443/d/abc#panel-2',
  'ssh://deploy@db-1.example',
  'https://deploy@grafana.example',
  'deploy@db-1',
];

describe('scrub-raw-secrets.preflight.sql', () => {
  it('carries the address rule verbatim and the Object types the scrub leaves out', () => {
    expect(PREFLIGHT).toContain(`'${ADDRESS_CREDENTIAL_SQL.password}'`);
    expect(PREFLIGHT).toContain(`'${ADDRESS_CREDENTIAL_SQL.query}'`);
    expect(PREFLIGHT).toContain(
      `object_type not in (${KERNEL_AUTHORED_OBJECT_TYPES.map((type) => `'${type}'`).join(', ')})`,
    );
  });

  it('the corpus is what the TypeScript rule says it is', () => {
    for (const address of CARRYING) {
      expect(addressCredential(address), address).not.toBeNull();
      expect(findConnectionParamsCredential({ target: address }), address).not.toBeNull();
    }
    for (const address of PLAIN) {
      expect(addressCredential(address), address).toBeNull();
      expect(findConnectionParamsCredential({ target: address }), address).toBeNull();
    }
  });
});

describe.runIf(DATABASE_URL !== undefined)(
  'scrub-raw-secrets.preflight.sql (PostgreSQL) — an upper bound of the address rule',
  () => {
    let pool: Pool;

    beforeAll(() => {
      pool = createPool();
    });
    afterAll(async () => {
      await pool.end();
    });

    async function flagged(address: string): Promise<boolean> {
      const result = await pool.query<{ flagged: boolean }>(
        'select ($1 ~* $2 or $1 ~* $3) as flagged',
        [address, ADDRESS_CREDENTIAL_SQL.password, ADDRESS_CREDENTIAL_SQL.query],
      );
      return result.rows[0]?.flagged === true;
    }

    it('flags every address the rule refuses', async () => {
      for (const address of CARRYING) expect(await flagged(address), address).toBe(true);
    });

    it('keeps the plain ones', async () => {
      for (const address of PLAIN) expect(await flagged(address), address).toBe(false);
    });

    it('runs as a whole inside a read-only transaction, as the runbook feeds it to psql', async () => {
      const client = await pool.connect();
      try {
        await client.query('begin transaction read only');
        await expect(client.query(PREFLIGHT)).resolves.toBeDefined();
      } finally {
        await client.query('rollback');
        client.release();
      }
    });
  },
);
