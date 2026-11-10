import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function makeApp(overrides?: Record<string, unknown>) {
  return createServer({
    jarvis: {
      url: `http://127.0.0.1:${mockPort}`,
      model: 'jarvis',
      slots: 0,
      queueTimeoutMs: 5000,
      timeoutMs: 10000,
      ...overrides
    }
  });
}

function sseBody(chunks: string[]): string {
  return chunks.map(c => `data: ${c}\n\n`).join('');
}

describe('jarvis lifecycle', () => {
  describe('upstream truncation', () => {
    it('emits error when upstream EOF without [DONE]', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })
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
        expect(text).toContain('"error"');
        expect(text).toContain('without completion signal');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('emits error on finish_reason length', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'partial action' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })
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
        expect(text).toContain('"error"');
        expect(text).toContain('length');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });

    it('emits error on finish_reason content_filter', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'filtered' } }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] })
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
        expect(text).toContain('"error"');
        expect(text).toContain('content_filter');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });
  });

  describe('malformed SSE data', () => {
    it('emits error on invalid JSON in SSE data', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: not valid json {{{\n\n');
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
        expect(text).toContain('"error"');
        expect(text).toContain('Malformed');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });
  });

  describe('timeout', () => {
    it('emits error on timeout after partial text', async () => {
      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })
        ]));
        // Never send [DONE], keep connection open
        const interval = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(interval);
            return;
          }
          res.write(': keepalive\n\n');
        }, 50);
        res.on('close', () => clearInterval(interval));
      });

      const server = makeApp({ timeoutMs: 500 });
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        const text = await response.text();
        expect(text).toContain('{"delta":"partial"}');
        expect(text).toContain('"error"');
        expect(text).toContain('timed out');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });
  });

  describe('client abort', () => {
    it('no unhandled rejection on client abort', async () => {
      const unhandled: unknown[] = [];
      const handler = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', handler);

      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'start' } }] })
        ]));
        const interval = setInterval(() => {
          if (res.writableEnded) {
            clearInterval(interval);
            return;
          }
          res.write(': keepalive\n\n');
        }, 50);
        res.on('close', () => clearInterval(interval));
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

        const reader = response.body!.getReader();
        await reader.read();
        controller.abort();

        // Wait for abort to propagate
        await new Promise(r => setTimeout(r, 300));

        expect(unhandled.length).toBe(0);
      } finally {
        process.removeListener('unhandledRejection', handler);
        await close(server);
        clearMockHandler();
      }
    });
  });

  describe('slots with injectable lockDir', () => {
    it('acquires slot via injectable lockDir when slots > 0', async () => {
      const lockDir = mkdtempSync(join(tmpdir(), 'jarvis-lifecycle-slots-'));

      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
          '[DONE]'
        ]));
        res.end();
      });

      const server = createServer({
        jarvis: {
          url: `http://127.0.0.1:${mockPort}`,
          model: 'jarvis',
          slots: 2,
          lockDir,
          queueTimeoutMs: 5000,
          timeoutMs: 10000
        }
      });
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });

        const text = await response.text();
        expect(text).toContain('{"delta":"hello"}');
        expect(text).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
        rmSync(lockDir, { recursive: true, force: true });
      }
    });

    it('releases slot on successful completion', async () => {
      const lockDir = mkdtempSync(join(tmpdir(), 'jarvis-lifecycle-release-'));

      setMockHandler((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sseBody([
          JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
          '[DONE]'
        ]));
        res.end();
      });

      const server = createServer({
        jarvis: {
          url: `http://127.0.0.1:${mockPort}`,
          model: 'jarvis',
          slots: 1,
          lockDir,
          queueTimeoutMs: 5000,
          timeoutMs: 10000
        }
      });
      const port = await listen(server);

      try {
        // First request acquires and releases
        const response1 = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        await response1.text();

        // Second request should succeed (slot was released)
        const response2 = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        const text2 = await response2.text();
        expect(text2).toContain('{"delta":"ok"}');
        expect(text2).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
        rmSync(lockDir, { recursive: true, force: true });
      }
    });

    it('releases slot on upstream error', async () => {
      const lockDir = mkdtempSync(join(tmpdir(), 'jarvis-lifecycle-err-'));

      setMockHandler((_req, res) => {
        res.statusCode = 500;
        res.end('internal');
      });

      const server = createServer({
        jarvis: {
          url: `http://127.0.0.1:${mockPort}`,
          model: 'jarvis',
          slots: 1,
          lockDir,
          queueTimeoutMs: 5000,
          timeoutMs: 10000
        }
      });
      const port = await listen(server);

      try {
        const response1 = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        const text1 = await response1.text();
        expect(text1).toContain('"error"');

        // Slot should be released, second request should work
        setMockHandler((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(sseBody(['[DONE]']));
          res.end();
        });

        const response2 = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
        });
        const text2 = await response2.text();
        expect(text2).toContain('{"done":true}');
      } finally {
        await close(server);
        clearMockHandler();
        rmSync(lockDir, { recursive: true, force: true });
      }
    });
  });

  describe('body size limit', () => {
    it('returns 413 for oversized request body', async () => {
      const server = makeApp();
      const port = await listen(server);

      try {
        const largeContent = 'x'.repeat(300 * 1024);
        const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: largeContent }] })
        });

        expect(response.status).toBe(413);
        const json = await response.json();
        expect(json).toHaveProperty('error');
      } finally {
        await close(server);
      }
    });
  });

  describe('upstream error does not leak body', () => {
    it('does not leak upstream response body in error', async () => {
      setMockHandler((_req, res) => {
        res.statusCode = 503;
        res.end('secret internal path /home/user/models/jarvis');
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
        expect(text).toContain('"error"');
        expect(text).not.toContain('secret internal path');
        expect(text).not.toContain('/home/user');
      } finally {
        await close(server);
        clearMockHandler();
      }
    });
  });
});
