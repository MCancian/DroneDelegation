import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SseParser, streamChat, getAiHealth } from '../src/ai/client';
import type { ChatMessage } from '../src/ai/client';

function encode(sse: string): Uint8Array {
  return new TextEncoder().encode(sse);
}

function makeStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeResponse(chunks: Uint8Array[]): Response {
  return new Response(makeStream(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('SseParser', () => {
  it('parses a single delta event', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"delta":"hello"}\n\n'));
    expect(events).toEqual([{ delta: 'hello' }]);
  });

  it('parses multiple events in one chunk', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\n'));
    expect(events).toEqual([{ delta: 'a' }, { delta: 'b' }]);
  });

  it('parses done event', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"done":true}\n\n'));
    expect(events).toEqual([{ done: true }]);
  });

  it('parses error event', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"error":"oops"}\n\n'));
    expect(events).toEqual([{ error: 'oops' }]);
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"delta":"hi"}\r\n\r\n'));
    expect(events).toEqual([{ delta: 'hi' }]);
  });

  it('handles events split across chunks', () => {
    const parser = new SseParser();
    const part1 = parser.feed(encode('data: {"del'));
    expect(part1).toEqual([]);
    const part2 = parser.feed(encode('ta":"x"}\n\n'));
    expect(part2).toEqual([{ delta: 'x' }]);
  });

  it('handles split UTF8 multi-byte characters', () => {
    const parser = new SseParser();
    const full = encode('data: {"delta":"\u00e9"}\n\n');
    const idx = full.indexOf(0xC3);
    const part1 = full.slice(0, idx + 1);
    const part2 = full.slice(idx + 1);
    const events1 = parser.feed(part1);
    expect(events1).toEqual([]);
    const events2 = parser.feed(part2);
    expect(events2).toEqual([{ delta: '\u00e9' }]);
  });

  it('handles multiline data fields', () => {
    const parser = new SseParser();
    // SSE multiline: data lines are joined with \n.
    // Split between token boundaries so joined result is valid JSON.
    // data: {"delta":\ndata: "line1\\nline2"}
    // After join: {"delta":\n"line1\\nline2"} which is valid JSON
    // (whitespace between : and value is allowed; \\n inside string is escaped newline)
    const events = parser.feed(encode('data: {"delta":\ndata: "line1\\nline2"}\n\n'));
    expect(events).toEqual([{ delta: 'line1\nline2' }]);
  });

  it('rejects literal newline inside JSON string', () => {
    const parser = new SseParser();
    // A literal LF inside a JSON string value is invalid JSON per spec
    const events = parser.feed(encode('data: {"delta":"line1\ndata: line2"}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('Invalid JSON');
  });

  it('handles data: without space after colon', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data:{"delta":"x"}\n\n'));
    expect(events).toEqual([{ delta: 'x' }]);
  });

  it('returns error for invalid JSON', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: not json\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('Invalid JSON');
  });

  it('flush processes remaining buffer', () => {
    const parser = new SseParser();
    const events1 = parser.feed(encode('data: {"delta":"tail"}\n'));
    expect(events1).toEqual([]);
    const events2 = parser.flush();
    expect(events2).toEqual([{ delta: 'tail' }]);
  });

  it('flush with empty buffer returns empty', () => {
    const parser = new SseParser();
    const events = parser.flush();
    expect(events).toEqual([]);
  });

  it('ignores empty data lines', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: \n\n'));
    expect(events).toEqual([]);
  });

  it('handles event with no data field', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('event: ping\n\n'));
    expect(events).toEqual([]);
  });

  it('rejects non-object parsed value', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: [1,2,3]\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('not an object');
  });

  it('rejects unknown fields', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"delta":"x","unknown":true}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('Unknown SSE event field');
  });

  it('rejects wrong type for delta', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"delta":123}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('delta must be string');
  });

  it('rejects wrong type for done', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"done":"yes"}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('done must be boolean');
  });

  it('rejects wrong type for error', () => {
    const parser = new SseParser();
    const events = parser.feed(encode('data: {"error":42}\n\n'));
    expect(events).toHaveLength(1);
    expect(events[0].error).toContain('error must be string');
  });
});

describe('streamChat', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('streams deltas and resolves on done', async () => {
    const chunks = [
      encode('data: {"delta":"Hello"}\n\n'),
      encode('data: {"delta":" world"}\n\n'),
      encode('data: {"done":true}\n\n'),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await streamChat(messages, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hello', ' world']);
  });

  it('rejects on error event', async () => {
    const chunks = [
      encode('data: {"error":"model overloaded"}\n\n'),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {})).rejects.toThrow('model overloaded');
  });

  it('rejects on truncated stream (no done marker)', async () => {
    const chunks = [
      encode('data: {"delta":"partial"}\n\n'),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {})).rejects.toThrow('Stream ended without done marker');
  });

  it('rejects on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503, statusText: 'Service Unavailable' }));

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {})).rejects.toThrow('503');
  });

  it('rejects on null body', async () => {
    const resp = new Response(null, { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(resp);

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {})).rejects.toThrow('Response body is null');
  });

  it('aborts when signal is triggered', async () => {
    const controller = new AbortController();
    const chunks = [
      encode('data: {"delta":"start"}\n\n'),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(chunks[0]);
        // Don't close - simulate hanging stream
      },
    });
    const resp = new Response(stream, { status: 200 });
    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
      if (opts?.signal) {
        opts.signal.addEventListener('abort', () => {
          controller.abort();
        });
      }
      return Promise.resolve(resp);
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const promise = streamChat(messages, () => {}, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
  });

  it('rejects immediately if signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse([encode('data: {"done":true}\n\n')]));

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {}, controller.signal)).rejects.toThrow();
  });

  it('does not emit deltas after abort', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encode('data: {"delta":"first"}\n\n'));
        // After first chunk, abort
        setTimeout(() => controller.abort(), 5);
      },
    });
    const resp = new Response(stream, { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(resp);

    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, (d) => deltas.push(d), controller.signal)).rejects.toThrow();
    // Should not have received deltas after abort
    expect(deltas.length).toBeLessThanOrEqual(1);
  });

  it('handles invalid JSON in stream', async () => {
    const chunks = [
      encode('data: {invalid json}\n\n'),
      encode('data: {"done":true}\n\n'),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {})).rejects.toThrow('Invalid JSON');
  });

  it('handles CRLF in stream', async () => {
    const chunks = [
      encode('data: {"delta":"a"}\r\n\r\ndata: {"done":true}\r\n\r\n'),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await streamChat(messages, (d) => deltas.push(d));
    expect(deltas).toEqual(['a']);
  });

  it('handles split UTF8 across fetch chunks', async () => {
    const full = encode('data: {"delta":"caf\u00e9"}\n\ndata: {"done":true}\n\n');
    const idx = full.indexOf(0xC3);
    const chunks = [full.slice(0, idx + 1), full.slice(idx + 1)];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await streamChat(messages, (d) => deltas.push(d));
    expect(deltas).toEqual(['caf\u00e9']);
  });

  it('stops reading after done even if stream remains open', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encode('data: {"delta":"x"}\n\ndata: {"done":true}\n\n'));
        // Don't close - server keeps connection open
      },
    });
    const resp = new Response(stream, { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(resp);

    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await streamChat(messages, (d) => deltas.push(d));
    expect(deltas).toEqual(['x']);
  });

  it('error before done is not overwritten', async () => {
    const chunks = [
      encode('data: {"error":"fail"}\n\ndata: {"done":true}\n\n'),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(makeResponse(chunks));

    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    await expect(streamChat(messages, () => {})).rejects.toThrow('fail');
  });
});

describe('getAiHealth', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns health data', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ online: true, model: 'jarvis', root: '/tmp/jarvis' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const health = await getAiHealth();
    expect(health).toEqual({ online: true, model: 'jarvis', root: '/tmp/jarvis' });
  });

  it('returns offline on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));

    await expect(getAiHealth()).rejects.toThrow('503');
  });

  it('handles missing fields gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ online: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const health = await getAiHealth();
    expect(health).toEqual({ online: false, model: '', root: null });
  });

  it('aborts when signal triggered', async () => {
    const controller = new AbortController();
    controller.abort();

    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
      if (opts?.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    await expect(getAiHealth(controller.signal)).rejects.toThrow();
  });
});
