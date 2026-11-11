import { test as base, expect } from '@playwright/test';
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { createServer } from '../../server/app';

type Message = { role: string; content: string };
type ResponsePlan = { kind: 'success' | 'error' | 'hold'; content?: string };
export interface UpstreamRequest {
  messages: Message[];
  receivedAt: number;
  plan: ResponsePlan;
  closed: boolean;
  templateError?: string;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP listen address');
  return `http://127.0.0.1:${address.port}`;
}

export class SmokeServer {
  url = '';
  online = true;
  plans: ResponsePlan[] = [];
  requests: UpstreamRequest[] = [];
  errors: string[] = [];
  private servers: Server[] = [];
  private sockets = new Set<Socket>();
  private lockDir = '';

  private track(server: Server): Server {
    this.servers.push(server);
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    return server;
  }

  async start(): Promise<void> {
    this.lockDir = await mkdtemp(join(tmpdir(), 'drone-browser-'));
    const upstream = this.track(createHttpServer(async (req, res) => {
      try {
        if (req.url === '/v1/models') {
          res.writeHead(this.online ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'jarvis', root: 'deterministic-browser-smoke' }] }));
          return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Message[] };
        const plan = this.plans.shift();
        if (!plan) throw new Error('Unexpected upstream chat: no response plan');
        const captured: UpstreamRequest = { messages: body.messages, receivedAt: Date.now(), plan, closed: false };
        this.requests.push(captured);
        // Model-template compatibility constraint discovered against the live model.
        // The real proxy must merge its two leading system messages to pass this.
        if (body.messages[0]?.role !== 'system' || body.messages.slice(1).some((m) => m.role === 'system')) {
          captured.templateError = 'Only one leading system message is supported';
          res.writeHead(400).end(captured.templateError);
          return;
        }
        if (plan.kind === 'error') {
          res.writeHead(503).end('Injected immediate upstream failure');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: plan.content ?? 'Ready, Captain.' } }] })}\n\n`);
        if (plan.kind === 'hold') {
          res.once('close', () => { captured.closed = true; });
        } else {
          res.end('data: [DONE]\n\n');
        }
      } catch (error) {
        this.errors.push(String(error));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    }));
    const upstreamUrl = await listen(upstream);
    const app = this.track(createServer({
      distDir: resolve('.cache/browser-smoke/site'),
      jarvis: { url: upstreamUrl, lockDir: this.lockDir, slots: 1, queueTimeoutMs: 2_000, timeoutMs: 15_000 },
    }));
    this.url = await listen(app);
  }

  async close(): Promise<void> {
    const closing = this.servers.map((server) => new Promise<void>((resolveClose, reject) => {
      if (!server.listening) { resolveClose(); return; }
      server.close((error) => error ? reject(error) : resolveClose());
      server.closeAllConnections();
    }));
    for (const socket of this.sockets) socket.destroy();
    const results = await Promise.allSettled(closing);
    if (this.lockDir) await rm(this.lockDir, { recursive: true, force: true });
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    if (this.sockets.size) throw new Error(`${this.sockets.size} HTTP sockets remain after teardown`);
  }
}

export const test = base.extend<{ smoke: SmokeServer }>({
  smoke: async ({ page }, use, testInfo) => {
    const smoke = new SmokeServer();
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
    // Chromium emits pageerror for unhandled promise rejections as well.
    try {
      await smoke.start();
      await use(smoke);
    } finally {
      const primaryFailed = testInfo.status !== testInfo.expectedStatus;
      const cleanupErrors: unknown[] = [];
      try {
        // Evidence is captured while the page, app and upstream are alive.
        await testInfo.attach('requests-and-errors', {
          body: JSON.stringify({ requests: smoke.requests, upstreamErrors: smoke.errors, browserErrors, failures: testInfo.errors }, null, 2),
          contentType: 'application/json',
        });
        if ((primaryFailed || browserErrors.length || smoke.errors.length) && !page.isClosed()) {
          await testInfo.attach('failure-before-teardown', { body: await page.screenshot(), contentType: 'image/png' });
        }
      } catch (error) {
        cleanupErrors.push(error);
      } finally {
        // Screenshot/attachment failures must never skip native HTTP cleanup.
        try { await smoke.close(); } catch (error) { cleanupErrors.push(error); }
      }
      if (primaryFailed) {
        // Preserve the primary failure and still expose any independent cleanup problem.
        for (const error of cleanupErrors) console.error('Smoke evidence/cleanup failure:', error);
      } else {
        expect(cleanupErrors, 'evidence capture and HTTP teardown').toEqual([]);
      }
      expect(browserErrors, 'browser page errors / unhandled rejections').toEqual([]);
      expect(smoke.errors, 'fake upstream failures').toEqual([]);
    }
  },
});

export { expect };
