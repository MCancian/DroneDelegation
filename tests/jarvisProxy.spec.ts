import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server/app.ts';

let mockUpstream: Server;
let mockPort: number;
let mockHandler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) | null = null;

beforeAll(async () => {
  mockUpstream = createHttpServer((req, res) => {
    if (mockHandler) {
      mockHandler(req, res);
    } else {
      res.statusCode = 500;
      res.end();
    }
  });

  await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
  const addr = mockUpstream.address() as AddressInfo;
  mockPort = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    mockUpstream.close((err) => err ? reject(err) : resolve());
  });
});

function setMockHandler(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
  mockHandler = handler;
}

function clearMockHandler() {
  mockHandler = null;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to a TCP port');
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function makeApp() {
  return createServer({
    jarvis: {
      url: `http://127.0.0.1:${mockPort}`,
      model: 'jarvis',
      slots: 0,
      queueTimeoutMs: 5000,
      timeoutMs: 10000
    }
  });
}

function sseBody(chunks: string[]): string {
  return chunks.map(c => `data: ${c}\n\n`).join('');
}

describe('jarvis proxy', () => {
  describe('POST /api/chat', () => {
    it('relays text deltas from upstream', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
          JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
          '[DONE]'
        ]));
        res.end();
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');

        const text = await response.text();
        expect(text).toContain('{"delta":"Hello"}');
        expect(text).toContain('{"delta":" world"}');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('strips reasoning_content deltas', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
          JSON.stringify({ choices: [{ delta: { reasoning: 'more thinking' } }] }),
          '[DONE]'
        ]));
        res.end();
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        const text = await response.text();
        expect(text).toContain('{"delta":"answer"}');
        expect(text).not.toContain('thinking');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('handles fragmented UTF-8 across chunks', async () => {
      // Encode a multi-byte character split across two writes
      const fullEvent = `data: ${JSON.stringify({ choices: [{ delta: { content: 'café' } }] })}\n\n`;
      const encoder = new TextEncoder();
      const bytes = encoder.encode(fullEvent);
      const mid = Math.floor(bytes.length / 2);
      const part1 = bytes.slice(0, mid);
      const part2 = bytes.slice(mid);

      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(Buffer.from(part1));
        res.write(Buffer.from(part2));
        res.write('data: [DONE]\n\n');
        res.end();
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        const text = await response.text();
        expect(text).toContain('café');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('handles CRLF line endings in SSE', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n');
        res.write('data: [DONE]\r\n\r\n');
        res.end();
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        const text = await response.text();
        expect(text).toContain('{"delta":"crlf"}');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('reports upstream error after headers sent', async () => {
      setMockHandler((_req, res) => {
        res.statusCode = 502;
        res.end('upstream internal error details');
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        expect(response.status).toBe(200); // SSE headers already sent
        const text = await response.text();
        expect(text).toContain('"error"');
        expect(text).toContain('{"done":true}');
        // Must not leak upstream body
        expect(text).not.toContain('upstream internal error details');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('rejects invalid body: empty messages', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [] })
        });

        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toHaveProperty('error');
      } finally {
        await close(server);
      }
    });

    it('rejects invalid body: unknown role', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'admin', content: 'hi' }] })
        });

        expect(response.status).toBe(400);
        const json = await response.json();
        expect(json).toHaveProperty('error');
      } finally {
        await close(server);
      }
    });

    it('rejects invalid body: empty content', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: '' }] })
        });

        expect(response.status).toBe(400);
      } finally {
        await close(server);
      }
    });

    it('rejects invalid body: bad maxTokens', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            maxTokens: 0
          })
        });

        expect(response.status).toBe(400);
      } finally {
        await close(server);
      }
    });

    it('rejects invalid body: bad temperature', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'hi' }],
            temperature: 3
          })
        });

        expect(response.status).toBe(400);
      } finally {
        await close(server);
      }
    });

    it('rejects non-POST method', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`);
        expect(response.status).toBe(405);
      } finally {
        await close(server);
      }
    });

    it('aborts upstream when client disconnects', async () => {
      let upstreamAborted = false;

      setMockHandler((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');

        req.on('aborted', () => {
          upstreamAborted = true;
        });

        // Keep connection open
        const interval = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(interval);
            return;
          }
          res.write(': keepalive\n\n');
        }, 50);

        res.on('close', () => {
          clearInterval(interval);
          upstreamAborted = true;
        });
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const controller = new AbortController();
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
          signal: controller.signal
        });

        // Read first chunk then abort
        const reader = response.body!.getReader();
        await reader.read();
        controller.abort();

        // Give time for abort to propagate
        await new Promise(r => setTimeout(r, 200));

        expect(upstreamAborted).toBe(true);
      } finally {
        await close(server);
        clearMockHandler();
      }
    });
  });

  describe('GET /api/ai/health', () => {
    it('returns online when jarvis model exists', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'jarvis', root: '/models/jarvis-v1', max_model_len: 8192 },
            { id: 'other', root: '/models/other' }
          ]
        }));
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ai/health`);
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ online: true, model: 'jarvis', root: '/models/jarvis-v1' });
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('returns offline when jarvis model missing', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'other', root: '/models/other' }]
        }));
      });

      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ai/health`);
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ online: false, model: 'jarvis', root: null });
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('returns offline when upstream unreachable', async () => {
      const server = createServer({
        jarvis: {
          url: 'http://127.0.0.1:1',
          model: 'jarvis',
          slots: 0,
          timeoutMs: 5000
        }
      });
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ai/health`);
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json).toEqual({ online: false, model: 'jarvis', root: null });
      } finally {
        await close(server);
      }
    });

    it('rejects non-GET method', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ai/health`, {
          method: 'POST'
        });
        expect(response.status).toBe(405);
      } finally {
        await close(server);
      }
    });
  });

  describe('existing routes still work', () => {
    it('GET /api/health returns ok', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
      } finally {
        await close(server);
      }
    });

    it('unknown /api/* returns 404', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/unknown`);
        expect(response.status).toBe(404);
      } finally {
        await close(server);
      }
    });
  });
});
