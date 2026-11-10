import { join } from 'node:path';
import { acquireSlot, type SlotHandle } from './slots.js';

export interface JarvisOptions {
  url?: string;
  model?: string;
  slots?: number;
  lockDir?: string;
  queueTimeoutMs?: number;
  timeoutMs?: number;
}

export interface ResolvedJarvisOptions {
  url: string;
  model: string;
  slots: number;
  lockDir: string | undefined;
  queueTimeoutMs: number;
  timeoutMs: number;
}

export function resolveJarvisOptions(partial?: Partial<JarvisOptions>): ResolvedJarvisOptions {
  const slotsOff = process.env.JARVIS_SLOTS === 'off';
  const xdg = process.env.XDG_RUNTIME_DIR;

  return {
    url: partial?.url ?? process.env.JARVIS_URL ?? 'http://127.0.0.1:8088',
    model: partial?.model ?? process.env.JARVIS_MODEL ?? 'jarvis',
    slots: partial?.slots ?? (slotsOff ? 0 : 4),
    lockDir: partial?.lockDir ?? (xdg ? join(xdg, 'revue') : undefined),
    queueTimeoutMs: partial?.queueTimeoutMs ?? 60_000,
    timeoutMs: partial?.timeoutMs ?? 120_000
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface StreamDelta {
  type: 'delta';
  text: string;
}

export interface StreamDone {
  type: 'done';
}

export interface StreamError {
  type: 'error';
  message: string;
}

export type StreamEvent = StreamDelta | StreamDone | StreamError;

/**
 * Combine adjacent leading system messages into exactly one system message
 * joined by two LF. Non-leading system messages are left in place.
 * Does not mutate the input array.
 */
export function normalizeLeadingSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  let leadingCount = 0;
  while (leadingCount < messages.length && messages[leadingCount].role === 'system') {
    leadingCount++;
  }

  if (leadingCount <= 1) {
    return [...messages];
  }

  const combinedContent = messages
    .slice(0, leadingCount)
    .map((m) => m.content)
    .join('\n\n');

  return [
    { role: 'system', content: combinedContent },
    ...messages.slice(leadingCount)
  ];
}

export async function* streamUpstream(
  options: ResolvedJarvisOptions,
  body: ChatRequest,
  signal: AbortSignal
): AsyncGenerator<StreamEvent> {
  const normalizedMessages = normalizeLeadingSystemMessages(body.messages);

  const payload: Record<string, unknown> = {
    model: options.model,
    messages: normalizedMessages,
    stream: true
  };

  if (body.maxTokens !== undefined) {
    payload.max_tokens = body.maxTokens;
  }
  if (body.temperature !== undefined) {
    payload.temperature = body.temperature;
  }

  let slot: SlotHandle | null = null;

  try {
    if (options.slots > 0) {
      slot = await acquireSlot({
        lockDir: options.lockDir,
        queueTimeoutMs: options.queueTimeoutMs,
        slots: options.slots,
        signal
      });
    }

    const response = await fetch(`${options.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      yield { type: 'error', message: `Upstream returned ${response.status}` };
      yield { type: 'done' };
      return;
    }

    if (!response.body) {
      yield { type: 'error', message: 'Upstream returned no body' };
      yield { type: 'done' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let terminated = false;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Flush decoder
          buffer += decoder.decode();
          const { events } = parseSSE(buffer);
          for (const event of events) {
            const result = processEvent(event);
            if (result) {
              yield result;
              if (result.type === 'done') {
                terminated = true;
                return;
              }
              if (result.type === 'error') {
                yield { type: 'done' };
                terminated = true;
                return;
              }
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { events, remaining } = parseSSE(buffer);
        buffer = remaining;

        for (const event of events) {
          const result = processEvent(event);
          if (result) {
            yield result;
            if (result.type === 'done') {
              terminated = true;
              return;
            }
            if (result.type === 'error') {
              yield { type: 'done' };
              terminated = true;
              return;
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed or aborted
      }
    }

    if (!terminated) {
      yield { type: 'error', message: 'Upstream stream ended without completion signal' };
      yield { type: 'done' };
    }
  } catch (err: unknown) {
    if (signal.aborted) {
      // Client disconnected or timeout, don't emit error
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    yield { type: 'error', message: sanitizeError(message) };
    yield { type: 'done' };
  } finally {
    if (slot) {
      slot.release();
    }
  }
}

export interface HealthResult {
  online: boolean;
  model: string;
  root: string | null;
}

export async function probeHealth(options: ResolvedJarvisOptions): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${options.url}/v1/models`, {
      signal: controller.signal
    });

    if (!response.ok) {
      return { online: false, model: options.model, root: null };
    }

    const data = await response.json() as Record<string, unknown>;
    const entries = data?.data;

    if (!Array.isArray(entries)) {
      return { online: false, model: options.model, root: null };
    }

    for (const entry of entries) {
      if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === 'jarvis') {
        const root = (entry as Record<string, unknown>).root;
        return {
          online: true,
          model: options.model,
          root: typeof root === 'string' && root.length > 0 ? root : null
        };
      }
    }

    return { online: false, model: options.model, root: null };
  } catch {
    return { online: false, model: options.model, root: null };
  } finally {
    clearTimeout(timer);
  }
}

function parseSSE(buffer: string): { events: string[]; remaining: string } {
  const events: string[] = [];
  let remaining = buffer;

  while (true) {
    const lfIdx = remaining.indexOf('\n\n');
    const crlfIdx = remaining.indexOf('\r\n\r\n');

    let boundary: number;
    let boundaryLen: number;

    if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
      boundary = crlfIdx;
      boundaryLen = 4;
    } else if (lfIdx !== -1) {
      boundary = lfIdx;
      boundaryLen = 2;
    } else {
      break;
    }

    const eventBlock = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + boundaryLen);

    const lines = eventBlock.split(/\r?\n/);
    let data = '';
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        data += (data ? '\n' : '') + line.slice(6);
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5);
      }
    }

    if (data) {
      events.push(data);
    }
  }

  return { events, remaining };
}

function processEvent(data: string): StreamEvent | null {
  if (data === '[DONE]') {
    return { type: 'done' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { type: 'error', message: 'Malformed SSE data from upstream' };
  }

  const obj = parsed as Record<string, unknown>;
  const choices = obj?.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const choice = choices[0] as Record<string, unknown>;

  // Check finish_reason for truncation/filtering
  const finishReason = choice?.finish_reason;
  if (finishReason === 'length' || finishReason === 'content_filter') {
    return { type: 'error', message: `Upstream response incomplete: ${finishReason}` };
  }

  const delta = choice?.delta as Record<string, unknown> | undefined;

  if (!delta) {
    return null;
  }

  // Ignore reasoning deltas
  if (delta.reasoning_content !== undefined || delta.reasoning !== undefined) {
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      return { type: 'delta', text: delta.content };
    }
    return null;
  }

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    return { type: 'delta', text: delta.content };
  }

  return null;
}

function sanitizeError(message: string): string {
  if (/\/[a-zA-Z0-9_/.-]+/.test(message) && !message.includes('Upstream')) {
    return 'Upstream request failed';
  }
  if (message.length > 200) {
    return 'Upstream request failed';
  }
  return message;
}
