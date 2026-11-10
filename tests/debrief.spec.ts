import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDebriefMessages, streamDebrief } from '../src/ai/debrief';
import { analyze } from '../src/report/analyze';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import type { GameEvent } from '../src/sim/types';

// Build the real report from recorded facts, including all three key events.
const events: GameEvent[] = [
  { t: 100, type: 'missile-launch', actor: 'scenario', payload: { launcherId: 'a1', rangeNm: 30 } },
  { t: 200, type: 'command', actor: 'doctrine', payload: { command: { action: 'engage_gun', target: 's7' }, ok: true, autonomy: { air: 'HOLD', surface: 'VETO' } } },
  { t: 200, type: 'weapon_fired', actor: 'doctrine', payload: { weapon: 'gun', targetId: 's7', targetTrackId: 'S-07', rangeNm: 5.5 } },
  { t: 210, type: 'contact_destroyed', actor: 'doctrine', payload: { contactId: 's7', domain: 'surface', truth: 'hostile', casualties: 0 } },
  { t: 300, type: 'command', actor: 'player', payload: { command: { action: 'engage_sam', target: 'a9' }, ok: true, autonomy: { air: 'HOLD', surface: 'VETO' } } },
  { t: 300, type: 'weapon_fired', actor: 'player', payload: { weapon: 'sam', targetId: 'a9', targetTrackId: 'A-09', rangeNm: 38 } },
  { t: 330, type: 'contact_destroyed', actor: 'player', payload: { contactId: 'a9', domain: 'air', truth: 'civil', casualties: 212 } },
];
const facts = analyze(events, { scenario: STRAIT_TRANSIT, seed: 42, endedAtS: 900, hullPct: 60, shipLost: false });

function sse(value: string): Response {
  return new Response(value, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('AI debrief', () => {
  it('sends all and only report facts, requesting a grounded second-person narrative', () => {
    const [instruction, report] = buildDebriefMessages(facts);
    expect(instruction.role).toBe('system');
    expect(instruction.content).toMatch(/150.250 word/);
    expect(instruction.content).toContain('second person');
    expect(instruction.content).toContain('autonomy settings and timing');
    expect(instruction.content).toContain('do not invent facts');
    expect(instruction.content).toContain('do not issue commands');
    expect(report.role).toBe('user');
    const sent = JSON.parse(report.content);
    expect(sent).toEqual(facts);
    expect(sent.keyEvents.map((event: { id: string }) => event.id)).toEqual(['E1', 'E2', 'E3']);
    expect(sent.keyEvents[1].decisions[0]).toMatchObject({ t: 200, actor: 'doctrine', autonomy: 'VETO' });
    expect(sent.keyEvents[2].decisions[0]).toMatchObject({ t: 300, actor: 'player', autonomy: 'HOLD' });
    expect(sent.summary.civilianLivesLost).toBe(212);
    expect(report.content).not.toContain('visualDescription');
    expect(report.content).not.toContain('personsAboard');
    expect(report.content).not.toContain('visualDescription');
    expect(report.content).not.toContain('groundTruth');
  });

  it('forwards the report and deltas through the existing chat stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse('data: {"delta":"You "}\n\ndata: {"delta":"acted."}\n\ndata: {"done":true}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const delta = vi.fn();
    const controller = new AbortController();
    await streamDebrief(facts, delta, controller.signal);
    expect(delta.mock.calls).toEqual([['You '], ['acted.']]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/chat');
    expect(options.signal).toBe(controller.signal);
    expect(JSON.parse(options.body).messages).toEqual(buildDebriefMessages(facts));
  });

  it('propagates errors after partial output so the report can remove it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse('data: {"delta":"Partial"}\n\ndata: {"error":"Offline"}\n\n')));
    const delta = vi.fn();
    await expect(streamDebrief(facts, delta)).rejects.toThrow('Offline');
    expect(delta).toHaveBeenCalledWith('Partial');
  });

  it('propagates a pre-aborted signal without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(streamDebrief(facts, vi.fn(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops delivering deltas when aborted mid-stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"First"}\n\ndata: {"delta":"Second"}\n\n'));
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const controller = new AbortController();
    const delta = vi.fn(() => controller.abort());
    await expect(streamDebrief(facts, delta, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(delta.mock.calls).toEqual([['First']]);
  });
});
