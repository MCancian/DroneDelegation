import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveJarvisOptions,
  streamUpstream,
  probeHealth,
  type JarvisOptions,
  type ResolvedJarvisOptions,
  type ChatRequest
} from './jarvis.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultDistDir = resolve(currentDir, '..', 'dist');

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json'
};

const MAX_BODY_BYTES = 256 * 1024;

export interface CreateServerOptions {
  distDir?: string;
  jarvis?: JarvisOptions;
}

export function createServer(options: CreateServerOptions = {}) {
  const distDir = resolve(options.distDir ?? defaultDistDir);
  const jarvisOptions = resolveJarvisOptions(options.jarvis);

  return createHttpServer((req, res) => {
    void handleRequest(req, res, distDir, jarvisOptions).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
}

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  distDir = defaultDistDir,
  jarvisOptions?: ResolvedJarvisOptions
): Promise<void> {
  const method = req.method ?? 'GET';
  let pathname: string;

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'Bad Request', method);
    return;
  }

  // POST /api/chat
  if (pathname === '/api/chat') {
    if (method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }
    await handleChat(req, res, jarvisOptions ?? resolveJarvisOptions());
    return;
  }

  // GET /api/ai/health
  if (pathname === '/api/ai/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end();
      return;
    }
    await handleHealth(res, jarvisOptions ?? resolveJarvisOptions(), method);
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.end();
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true }, method);
      return;
    }

    sendJson(res, 404, { error: 'Not Found' }, method);
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end();
    return;
  }

  await serveStatic(res, distDir, pathname, method);
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResolvedJarvisOptions
): Promise<void> {
  let body: unknown;

  try {
    const raw = await readBody(req, MAX_BODY_BYTES);
    body = JSON.parse(raw);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'Body too large') {
      sendJson(res, 413, { error: 'Request body too large' });
      return;
    }
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const validation = validateChatBody(body);
  if (!validation.valid) {
    sendJson(res, 400, { error: validation.error });
    return;
  }

  const chatRequest = validation.data;

  // Set up abort controller for timeout + client disconnect
  const abortController = new AbortController();
  let streamComplete = false;
  let timedOut = false;
  let clientDisconnected = false;

  const timeout = setTimeout(() => {
    if (!streamComplete) {
      timedOut = true;
      abortController.abort();
    }
  }, options.timeoutMs);

  const onDisconnect = () => {
    if (!streamComplete) {
      clientDisconnected = true;
      abortController.abort();
    }
  };

  req.on('aborted', onDisconnect);
  res.on('close', onDisconnect);

  // Send SSE headers
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    for await (const event of streamUpstream(options, chatRequest, abortController.signal)) {
      if (streamComplete) break;

      if (event.type === 'delta') {
        writeSSE(res, { delta: event.text });
      } else if (event.type === 'error') {
        writeSSE(res, { error: event.message });
      } else if (event.type === 'done') {
        writeSSE(res, { done: true });
        streamComplete = true;
        break;
      }
    }

    if (!streamComplete) {
      if (timedOut) {
        writeSSE(res, { error: 'AI request timed out' });
        writeSSE(res, { done: true });
      }
      // If clientDisconnected, do not write done (response is closed)
      streamComplete = true;
    }
  } catch {
    if (!streamComplete && !clientDisconnected) {
      writeSSE(res, { error: 'Internal error' });
      writeSSE(res, { done: true });
      streamComplete = true;
    }
  } finally {
    clearTimeout(timeout);
    req.removeListener('aborted', onDisconnect);
    res.removeListener('close', onDisconnect);
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

async function handleHealth(
  res: ServerResponse,
  options: ResolvedJarvisOptions,
  method: string
): Promise<void> {
  const result = await probeHealth(options);
  sendJson(res, 200, result, method);
}

function validateChatBody(
  body: unknown
): { valid: true; data: ChatRequest } | { valid: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  if (!Array.isArray(obj.messages) || obj.messages.length === 0) {
    return { valid: false, error: 'messages must be a non-empty array' };
  }

  const validRoles = new Set(['system', 'user', 'assistant']);

  for (const msg of obj.messages) {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return { valid: false, error: 'Each message must be an object' };
    }

    const m = msg as Record<string, unknown>;

    if (typeof m.role !== 'string' || !validRoles.has(m.role)) {
      return { valid: false, error: 'Invalid role: must be system, user, or assistant' };
    }

    if (typeof m.content !== 'string' || m.content.length === 0) {
      return { valid: false, error: 'content must be a non-empty string' };
    }
  }

  if (obj.maxTokens !== undefined) {
    if (
      typeof obj.maxTokens !== 'number' ||
      !Number.isInteger(obj.maxTokens) ||
      obj.maxTokens < 1 ||
      obj.maxTokens > 32768
    ) {
      return { valid: false, error: 'maxTokens must be an integer between 1 and 32768' };
    }
  }

  if (obj.temperature !== undefined) {
    if (
      typeof obj.temperature !== 'number' ||
      !Number.isFinite(obj.temperature) ||
      obj.temperature < 0 ||
      obj.temperature > 2
    ) {
      return { valid: false, error: 'temperature must be a finite number between 0 and 2' };
    }
  }

  // Sanitize message fields explicitly
  const sanitizedMessages = (obj.messages as Array<Record<string, unknown>>).map((m) => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: String(m.content).trim()
  }));

  const data: ChatRequest = {
    messages: sanitizedMessages
  };

  if (obj.maxTokens !== undefined) {
    data.maxTokens = obj.maxTokens as number;
  }
  if (obj.temperature !== undefined) {
    data.temperature = obj.temperature as number;
  }

  return { valid: true, data };
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        rejected = true;
        reject(new Error('Body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', (err: unknown) => {
      if (!rejected) reject(err);
    });
  });
}

function writeSSE(res: ServerResponse, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function serveStatic(
  res: ServerResponse,
  distDir: string,
  pathname: string,
  method: string
): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');

  if (relative.includes('\0')) {
    sendText(res, 400, 'Bad Request', method);
    return;
  }

  const filePath = resolve(distDir, relative);

  if (!isInside(distDir, filePath)) {
    sendText(res, 403, 'Forbidden', method);
    return;
  }

  try {
    const stats = await stat(filePath);

    if (stats.isDirectory()) {
      sendText(res, 404, 'Not Found', method);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const body = method === 'HEAD' ? null : await readFile(filePath);

    res.statusCode = 200;
    res.setHeader('Content-Type', contentTypes[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(body ? body.length : stats.size));

    if (method === 'HEAD') {
      res.end();
      return;
    }

    res.end(body);
  } catch (error) {
    if (isNotFound(error)) {
      sendText(res, 404, 'Not Found', method);
      return;
    }

    sendText(res, 500, 'Internal Server Error', method);
  }
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown, method = 'GET'): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(payload)));

  if (method === 'HEAD') {
    res.end();
    return;
  }

  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string, method = 'GET'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));

  if (method === 'HEAD') {
    res.end();
    return;
  }

  res.end(body);
}
