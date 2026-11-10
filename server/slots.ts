import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface AcquireSlotOptions {
  lockDir?: string;
  queueTimeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  slots?: number;
}

export interface SlotHandle {
  release(): void;
}

export async function acquireSlot(options: AcquireSlotOptions = {}): Promise<SlotHandle> {
  const {
    lockDir = defaultLockDir(),
    queueTimeoutMs = 60_000,
    pollIntervalMs = 1_000,
    signal,
    slots = 4
  } = options;

  if (slots <= 0) {
    return { release() {} };
  }

  await mkdir(lockDir, { recursive: true });

  const deadline = Date.now() + queueTimeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('Slot acquisition aborted');
    }

    for (let i = 0; i < slots; i++) {
      if (signal?.aborted) {
        throw new Error('Slot acquisition aborted');
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const lockFile = join(lockDir, `jarvis.${i}.lock`);
      const handle = await tryAcquire(lockFile, remaining, signal);

      if (handle) {
        return handle;
      }

      if (Date.now() >= deadline) break;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }

  throw new Error(`No slot available within ${queueTimeoutMs}ms`);
}

function defaultLockDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, 'revue');
  return '/tmp/revue';
}

function tryAcquire(
  lockFile: string,
  remainingMs: number,
  signal?: AbortSignal
): Promise<SlotHandle | null> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawn(
        'flock',
        ['-n', '-E', '75', lockFile, 'sh', '-c', 'echo LOCKED; exec cat >/dev/null'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'spawn failed';
      reject(new Error(`flock spawn failed: ${msg}`));
      return;
    }

    let stdout = '';
    let settled = false;
    let released = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      child.stdout?.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const settle = (value: SlotHandle | null | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (value instanceof Error) {
        reject(value);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('LOCKED')) {
        settle({
          release() {
            if (released) return;
            released = true;
            try {
              child.stdin?.end();
            } catch {
              // already closed
            }
          }
        });
      }
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        settle(new Error('flock command not available'));
      } else {
        settle(new Error(`flock child error: ${err.message}`));
      }
    };

    const onExit = (code: number | null) => {
      if (code === 75) {
        // Lock is busy, try next slot
        settle(null);
      } else {
        // Unexpected exit - the lock was not acquired or was lost
        settle(new Error(`flock exited with code ${code}`));
      }
    };

    const onAbort = () => {
      if (!settled) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead
        }
        settle(new Error('Slot acquisition aborted'));
      }
    };

    // Consume stdin errors to prevent unhandled rejections
    child.stdin?.on('error', () => {});

    child.stdout?.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);

    // Bound confirmation by remaining deadline
    timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead
        }
        settle(new Error('Slot acquisition timed out waiting for lock confirmation'));
      }
    }, remainingMs);

    if (signal) {
      if (signal.aborted) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already dead
        }
        settle(new Error('Slot acquisition aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Slot acquisition aborted'));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Slot acquisition aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
