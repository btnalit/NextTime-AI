import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

/**
 * In-process fake Anthropic Messages endpoint: records each request body exactly as pi-ai built
 * and sent it, and answers with a scripted, well-formed SSE stream (one text or one tool_use
 * block). Lets a test assert what the real provider request carries — cache breakpoints, the order
 * of the system prompt, tools and messages — without a network or a key.
 */

export type FakeAnthropicReply =
  | { readonly text: string }
  | { readonly toolUse: { readonly name: string; readonly input: Record<string, unknown> } };

export interface FakeAnthropic {
  readonly url: string;
  /** Every `POST /v1/messages` body, parsed, in arrival order. */
  readonly requests: Record<string, unknown>[];
  /** The raw bodies, for byte-level comparisons. */
  readonly rawRequests: string[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sse(res: ServerResponse, events: readonly Record<string, unknown>[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) {
    res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

function replyEvents(reply: FakeAnthropicReply, index: number): Record<string, unknown>[] {
  const block =
    'text' in reply
      ? { type: 'text', text: '' }
      : { type: 'tool_use', id: `toolu_${index}`, name: reply.toolUse.name, input: {} };
  const delta =
    'text' in reply
      ? { type: 'text_delta', text: reply.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(reply.toolUse.input) };
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${index}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
}

export async function startFakeAnthropic(
  replies: readonly FakeAnthropicReply[],
): Promise<FakeAnthropic> {
  const requests: Record<string, unknown>[] = [];
  const rawRequests: string[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: req.url } }));
        return;
      }
      rawRequests.push(raw);
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      const reply = replies[requests.length - 1];
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unscripted' } }),
        );
        return;
      }
      sse(res, replyEvents(reply, requests.length));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    rawRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
