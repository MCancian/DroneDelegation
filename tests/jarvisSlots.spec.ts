import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot } from '../server/slots.ts';

const flockResult = spawnSync('flock', ['--version'], { encoding: 'utf-8' });
const flockAvailable = flockResult.status === 0;
const tempDir = flockAvailable ? mkdtempSync(join(tmpdir(), 'jarvis-slots-')) : '';

const skipIfNoFlock = flockAvailable ? it : it.skip;

afterAll(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('slot locking', () => {
  skipIfNoFlock('acquires a slot', async () => {
    const handle = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 4
    });

    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe('function');
    handle.release();
  });

  skipIfNoFlock('busy slot falls through to next', async () => {
    // Acquire slot 0
    const handle0 = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 4
    });

    // Acquire another - should get a different slot (slot 1)
    const handle1 = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 4
    });

    // Both should be held simultaneously
    expect(handle0).toBeDefined();
    expect(handle1).toBeDefined();

    handle0.release();
    handle1.release();
  });

  skipIfNoFlock('all slots busy causes expiry', async () => {
    const handles: Array<{ release(): void }> = [];

    // Acquire all 4 slots
    for (let i = 0; i < 4; i++) {
      const h = await acquireSlot({
        lockDir: tempDir,
        queueTimeoutMs: 5000,
        pollIntervalMs: 50,
        slots: 4
      });
      handles.push(h);
    }

    // 5th acquisition should timeout
    await expect(
      acquireSlot({
        lockDir: tempDir,
        queueTimeoutMs: 200,
        pollIntervalMs: 50,
        slots: 4
      })
    ).rejects.toThrow(/No slot available/);

    for (const h of handles) {
      h.release();
    }
  });

  skipIfNoFlock('release allows reacquire', async () => {
    const handle1 = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 1
    });

    handle1.release();

    // Should be able to acquire again
    const handle2 = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 1
    });

    expect(handle2).toBeDefined();
    handle2.release();
  });

  skipIfNoFlock('release is idempotent', async () => {
    const handle = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 4
    });

    handle.release();
    handle.release(); // second call should not throw
    handle.release(); // third call should not throw
  });

  skipIfNoFlock('abort cancels acquisition', async () => {
    // Acquire all slots
    const handles: Array<{ release(): void }> = [];
    for (let i = 0; i < 4; i++) {
      const h = await acquireSlot({
        lockDir: tempDir,
        queueTimeoutMs: 5000,
        pollIntervalMs: 50,
        slots: 4
      });
      handles.push(h);
    }

    const controller = new AbortController();

    const promise = acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 10000,
      pollIntervalMs: 50,
      slots: 4,
      signal: controller.signal
    });

    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    await expect(promise).rejects.toThrow(/aborted/);

    for (const h of handles) {
      h.release();
    }
  });

  skipIfNoFlock('abort before acquisition rejects immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      acquireSlot({
        lockDir: tempDir,
        queueTimeoutMs: 5000,
        pollIntervalMs: 50,
        slots: 4,
        signal: controller.signal
      })
    ).rejects.toThrow(/aborted/);
  });

  skipIfNoFlock('slots=0 bypasses locking', async () => {
    const handle = await acquireSlot({
      lockDir: tempDir,
      slots: 0
    });

    expect(handle).toBeDefined();
    expect(typeof handle.release).toBe('function');
    handle.release();
  });

  skipIfNoFlock('never deletes lock files', async () => {
    const handle = await acquireSlot({
      lockDir: tempDir,
      queueTimeoutMs: 5000,
      pollIntervalMs: 50,
      slots: 4
    });

    handle.release();

    // Lock files should still exist
    const files = readdirSync(tempDir);
    const lockFiles = files.filter(f => f.startsWith('jarvis.') && f.endsWith('.lock'));
    expect(lockFiles.length).toBeGreaterThan(0);
  });
});
