import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/app.ts';

const indexHtml = '<!doctype html><html><body><h1>index</h1></body></html>';
const appJs = 'console.log("app");';
const parentPackage = '{"name":"parent-secret"}';

let tempRoot = '';
let distDir = '';

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'drone-delegation-dist-'));
  distDir = join(tempRoot, 'dist');

  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), indexHtml, 'utf8');
  await writeFile(join(distDir, 'assets', 'app.js'), appJs, 'utf8');
  await writeFile(join(tempRoot, 'package.json'), parentPackage, 'utf8');
});

afterAll(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Server did not bind to a TCP port');
  }

  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

interface RawResponse {
  status: number;
  contentType: string | undefined;
  body: string;
}

function requestRaw(port: number, path: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        agent: false
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'],
            body
          });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

describe('server app', () => {
  it('GET /api/health returns ok', async () => {
    const server = createServer();
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await close(server);
    }
  });

  it('unknown /api/* returns 404 JSON', async () => {
    const server = createServer();
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/unknown`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    } finally {
      await close(server);
    }
  });

  describe('static serving', () => {
    it('GET / returns index.html', async () => {
      const server = createServer({ distDir });
      const port = await listen(server);

      try {
        const response = await requestRaw(port, '/');
        expect(response.status).toBe(200);
        expect(response.contentType).toContain('text/html');
        expect(response.body).toContain('<h1>index</h1>');
      } finally {
        await close(server);
      }
    });

    it('GET /assets/app.js returns text/javascript', async () => {
      const server = createServer({ distDir });
      const port = await listen(server);

      try {
        const response = await requestRaw(port, '/assets/app.js');
        expect(response.status).toBe(200);
        expect(response.contentType).toContain('text/javascript');
        expect(response.body).toBe(appJs);
      } finally {
        await close(server);
      }
    });

    it('missing file returns 404', async () => {
      const server = createServer({ distDir });
      const port = await listen(server);

      try {
        const response = await requestRaw(port, '/missing.js');
        expect(response.status).toBe(404);
      } finally {
        await close(server);
      }
    });

    it('path traversal does not escape distDir', async () => {
      const server = createServer({ distDir });
      const port = await listen(server);

      try {
        for (const path of ['/../package.json', '/%2e%2e/package.json']) {
          const response = await requestRaw(port, path);
          expect(response.status === 403 || response.status === 404).toBe(true);
          expect(response.body).not.toContain('parent-secret');
        }
      } finally {
        await close(server);
      }
    });
  });
});
