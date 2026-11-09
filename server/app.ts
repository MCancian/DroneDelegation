import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export interface CreateServerOptions {
  distDir?: string;
}

export function createServer(options: CreateServerOptions = {}) {
  const distDir = resolve(options.distDir ?? defaultDistDir);
  return createHttpServer((req, res) => {
    void handleRequest(req, res, distDir).catch(() => {
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
  distDir = defaultDistDir
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
