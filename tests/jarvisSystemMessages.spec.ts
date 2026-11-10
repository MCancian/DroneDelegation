import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server/app.ts';

let mockUpstream: Server;
let mockPort: number;
let capturedBody: Record<string, unknown> | null = null;
let rejectMultipleSystem = false;

beforeAll(async () => {
  mockUpstream = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString());
      const msgs = capturedMessages();
      let count = 0;
      for (const m of msgs) { if (m.role === 'system') count++; else break; }
      if (rejectMultipleSystem && count > 1) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'System message must be at the beginning.' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', r));
  mockPort = (mockUpstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r, j) => mockUpstream.close(e => e ? j(e) : r()));
});

function capturedMessages(): Array<{ role: string; content: string }> {
  if (capturedBody === null || !Array.isArray(capturedBody.messages)) {
    throw new Error('Mock upstream did not capture messages');
  }
  return capturedBody.messages as Array<{ role: string; content: string }>;
}

function makeApp() {
  return createServer({ jarvis: { url: `http://127.0.0.1:${mockPort}`, model: 'jarvis', slots: 0, timeoutMs: 5000 } });
}

async function listen(s: Server): Promise<number> {
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

async function close(s: Server): Promise<void> {
  await new Promise<void>((r, j) => s.close(e => e ? j(e) : r()));
}

describe('leading system message normalization', () => {
  it('combines two leading system messages into one joined by double-LF', async () => {
    rejectMultipleSystem = true;
    capturedBody = null;
    const server = makeApp();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'You are Jarvis.' },
          { role: 'system', content: 'Situation: bearing 045.' },
          { role: 'user', content: 'Engage.' }
        ] })
      });
      const text = await res.text();
      expect(text).toContain('{"delta":"ok"}');
      expect(text).toContain('{"done":true}');
      const msgs = capturedMessages();
      expect(msgs[0].role).toBe('system');
      expect(msgs[0].content).toBe('You are Jarvis.\n\nSituation: bearing 045.');
      expect(msgs[1].role).toBe('user');
      expect(msgs.length).toBe(2);
    } finally { await close(server); rejectMultipleSystem = false; }
  });

  it('one leading system message passes through unchanged', async () => {
    rejectMultipleSystem = true;
    capturedBody = null;
    const server = makeApp();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'Solo system.' },
          { role: 'user', content: 'Hello.' }
        ] })
      });
      const text = await res.text();
      expect(text).toContain('{"done":true}');
      const msgs = capturedMessages();
      expect(msgs[0].content).toBe('Solo system.');
      expect(msgs.length).toBe(2);
    } finally { await close(server); rejectMultipleSystem = false; }
  });

  it('no system messages passes through unchanged', async () => {
    rejectMultipleSystem = true;
    capturedBody = null;
    const server = makeApp();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'user', content: 'Hello.' },
          { role: 'assistant', content: 'Hi.' },
          { role: 'user', content: 'Status?' }
        ] })
      });
      const text = await res.text();
      expect(text).toContain('{"done":true}');
      const msgs = capturedMessages();
      expect(msgs[0].role).toBe('user');
      expect(msgs.length).toBe(3);
    } finally { await close(server); rejectMultipleSystem = false; }
  });

  it('preserves non-leading system messages in original position', async () => {
    rejectMultipleSystem = false;
    capturedBody = null;
    const server = makeApp();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [
          { role: 'system', content: 'Prompt.' },
          { role: 'system', content: 'Situation.' },
          { role: 'user', content: 'Q.' },
          { role: 'assistant', content: 'A.' },
          { role: 'system', content: 'Mid note.' },
          { role: 'user', content: 'Follow-up.' }
        ] })
      });
      const text = await res.text();
      expect(text).toContain('{"done":true}');
      const msgs = capturedMessages();
      expect(msgs[0].role).toBe('system');
      expect(msgs[0].content).toBe('Prompt.\n\nSituation.');
      expect(msgs[1].role).toBe('user');
      expect(msgs[2].role).toBe('assistant');
      expect(msgs[3].role).toBe('system');
      expect(msgs[3].content).toBe('Mid note.');
      expect(msgs[4].role).toBe('user');
      expect(msgs.length).toBe(5);
    } finally { await close(server); }
  });
});
