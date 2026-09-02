import { describe, expect, it } from 'vitest';
import { createServer } from './index.js';

describe('GET /api/health', () => {
  it('responds with status ok', async () => {
    const app = createServer();

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
