export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatHealth {
  online: boolean;
  model: string;
  root: string | null;
}

export interface SseEvent {
  delta?: string;
  done?: boolean;
  error?: string;
}

function validateSseEvent(parsed: unknown): SseEvent | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Invalid SSE event: not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  const known = new Set(['delta', 'done', 'error']);
  for (const k of keys) {
    if (!known.has(k)) {
      return { error: `Unknown SSE event field: ${k}` };
    }
  }
  if ('delta' in obj && typeof obj.delta !== 'string') {
    return { error: 'Invalid SSE event: delta must be string' };
  }
  if ('done' in obj && typeof obj.done !== 'boolean') {
    return { error: 'Invalid SSE event: done must be boolean' };
  }
  if ('error' in obj && typeof obj.error !== 'string') {
    return { error: 'Invalid SSE event: error must be string' };
  }
  return obj as SseEvent;
}

export class SseParser {
  private buffer: string = '';
  private decoder: TextDecoder;

  constructor() {
    this.decoder = new TextDecoder('utf-8');
  }

  feed(chunk: Uint8Array): SseEvent[] {
    const text = this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    return this.drain();
  }

  flush(): SseEvent[] {
    const text = this.decoder.decode(new Uint8Array(0), { stream: false });
    this.buffer += text;
    const events = this.drain();
    if (this.buffer.trim().length > 0) {
      const remaining = this.buffer;
      this.buffer = '';
      const ev = this.parseEvent(remaining);
      if (ev) events.push(ev);
    }
    return events;
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = [];
    let normalized = this.buffer.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');
    this.buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim().length === 0) continue;
      const ev = this.parseEvent(part);
      if (ev) events.push(ev);
    }
    return events;
  }

  private parseEvent(raw: string): SseEvent | null {
    const lines = raw.split('\n');
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5));
      }
    }
    if (dataLines.length === 0) return null;
    const dataStr = dataLines.join('\n');
    if (dataStr.length === 0) return null;
    try {
      const parsed = JSON.parse(dataStr);
      const validated = validateSseEvent(parsed);
      return validated;
    } catch {
      return { error: `Invalid JSON in SSE data: ${dataStr}` };
    }
  }
}

export async function streamChat(
  messages: readonly ChatMessage[],
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.status} ${response.statusText}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error('Response body is null');
  }

  const reader = body.getReader();
  const parser = new SseParser();
  let done = false;
  let streamError: string | null = null;
  let aborted = false;

  let abortListener: (() => void) | null = null;
  if (signal) {
    abortListener = () => {
      aborted = true;
      reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abortListener);
  }

  try {
    while (!done && !aborted) {
      const { value, done: streamDone } = await reader.read();
      if (aborted || signal?.aborted) {
        aborted = true;
        break;
      }
      if (streamDone) break;
      if (value) {
        const events = parser.feed(value);
        for (const ev of events) {
          if (aborted || signal?.aborted) {
            aborted = true;
            break;
          }
          if (ev.done) {
            done = true;
            break;
          } else if (ev.error) {
            streamError = ev.error;
            break;
          } else if (ev.delta !== undefined) {
            onDelta(ev.delta);
          }
        }
      }
      if (streamError) break;
    }

    if (!done && !aborted && !streamError) {
      const remaining = parser.flush();
      for (const ev of remaining) {
        if (aborted || signal?.aborted) {
          aborted = true;
          break;
        }
        if (ev.done) {
          done = true;
          break;
        } else if (ev.error) {
          streamError = ev.error;
          break;
        } else if (ev.delta !== undefined) {
          onDelta(ev.delta);
        }
      }
    }
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  if (aborted || signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (streamError) {
    throw new Error(streamError);
  }

  if (!done) {
    throw new Error('Stream ended without done marker');
  }
}

export async function getAiHealth(signal?: AbortSignal): Promise<ChatHealth> {
  const response = await fetch('/api/ai/health', { signal });
  if (!response.ok) {
    throw new Error(`Health check failed: ${response.status}`);
  }
  const data = (await response.json()) as Partial<ChatHealth>;
  return {
    online: data.online === true,
    model: typeof data.model === 'string' ? data.model : '',
    root: typeof data.root === 'string' ? data.root : null,
  };
}
