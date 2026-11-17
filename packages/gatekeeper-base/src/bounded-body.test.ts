import { describe, expect, it } from 'vitest';
import { ResponseBodyTooLargeError, readBodyWithin } from './bounded-body.js';
import { MAX_OPENAPI_DOCUMENT_BYTES, readOpenApiDocument } from './kinds/index.js';

/** A body that sends `chunk` again on every read, for as long as it is read — and says whether it
 *  was cancelled and how many chunks it gave. Nothing is pulled before the first read. */
function endless(chunk: Uint8Array): {
  readonly response: Response;
  readonly state: { pulls: number; cancelled: boolean };
} {
  const state = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(stream), state };
}

describe('readBodyWithin (legacy 797)', () => {
  it('reads a body up to the limit, the limit itself included', async () => {
    await expect(readBodyWithin(new Response('héllo'), 6, 'the body')).resolves.toBe('héllo');
    await expect(readBodyWithin(new Response(''), 6, 'the body')).resolves.toBe('');
    await expect(readBodyWithin(new Response(null), 6, 'the body')).resolves.toBe('');
    const declaredAtLimit = new Response('héllo', { headers: { 'content-length': '6' } });
    await expect(readBodyWithin(declaredAtLimit, 6, 'the body')).resolves.toBe('héllo');
  });

  it('drops a leading UTF-8 BOM, as response.text() does', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new Uint8Array([...bom, ...new TextEncoder().encode('{}')]);
    await expect(readBodyWithin(new Response(body), 6, 'the body')).resolves.toBe('{}');
    expect(await new Response(body).text()).toBe('{}');
  });

  it('refuses a body one byte past the limit, naming it and what to do', async () => {
    const read = readBodyWithin(new Response('héllo!'), 6, 'the body', { fix: 'send less' });
    await expect(read).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    await expect(
      readBodyWithin(new Response('héllo!'), 6, 'the body', { fix: 'send less' }),
    ).rejects.toThrow('the body is larger than 6 bytes: send less');
  });

  it('refuses a declared content-length past the limit without reading the body', async () => {
    const { response, state } = endless(new Uint8Array(4));
    const declared = new Response(response.body, { headers: { 'content-length': '7' } });
    await expect(readBodyWithin(declared, 6, 'the body')).rejects.toThrow(
      'the body is larger than 6 bytes',
    );
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBe(0);
  });

  it('stops reading a body that never ends once it passes the limit, and cancels it', async () => {
    const { response, state } = endless(new Uint8Array(1024));
    await expect(readBodyWithin(response, 4096, 'the body')).rejects.toThrow(
      'the body is larger than 4096 bytes',
    );
    expect(state.cancelled).toBe(true);
    // The fifth chunk passes the limit; a stream reads a little ahead, never far.
    expect(state.pulls).toBeLessThan(10);
  });

  it('names a whole number of MiB as MiB', async () => {
    const { response } = endless(new Uint8Array(1024 * 1024));
    await expect(readBodyWithin(response, 2 * 1024 * 1024, 'the document')).rejects.toThrow(
      'the document is larger than 2 MiB',
    );
  });
});

describe('readOpenApiDocument (legacy 797)', () => {
  it('reads a JSON document', async () => {
    await expect(readOpenApiDocument(new Response('{"openapi":"3.1.0"}'))).resolves.toEqual({
      openapi: '3.1.0',
    });
  });

  it('refuses a document larger than MAX_OPENAPI_DOCUMENT_BYTES, saying what to do', async () => {
    expect(MAX_OPENAPI_DOCUMENT_BYTES).toBe(16 * 1024 * 1024);
    const { response, state } = endless(new Uint8Array(1024 * 1024).fill(0x20));
    await expect(readOpenApiDocument(response)).rejects.toThrow(
      'the OpenAPI document is larger than 16 MiB: serve a document with only the paths this gate needs, or write its manifest by hand',
    );
    expect(state.cancelled).toBe(true);
  });

  it('reads a document saved with a UTF-8 BOM, as response.json() did', async () => {
    const json = new TextEncoder().encode('{"openapi":"3.1.0"}');
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...json]);
    await expect(readOpenApiDocument(new Response(body))).resolves.toEqual({ openapi: '3.1.0' });
  });

  it('a body that is not JSON throws as JSON.parse does', async () => {
    await expect(readOpenApiDocument(new Response('<html>'))).rejects.toBeInstanceOf(SyntaxError);
  });
});
