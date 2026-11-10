import { describe, it, expect, vi } from 'vitest';
import { TacticalLoop } from '../src/ai/tacticalLoop';
import { ProposalManager } from '../src/ai/proposals';
import { setAutonomy } from '../src/ai/autonomy';
import { cloneWeaponsConfig, makeContact, makeWorld } from './helpers/sim';
import type { ChatMessage } from '../src/ai/client';
import type { ObservedHostileAct } from '../src/ai/situation';

const action = '```action\n{"action":"engage_sam","target":"A-01"}\n```';
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  const world = makeWorld([makeContact({ id: 'air', trackId: 'A-01', position: { x: 0, y: 20 }, courseDeg: 180, speedKts: 300 })]);
  const manager = new ProposalManager(world); const replies: string[] = []; const notices: string[] = [];
  let resolve!: (reply: string) => void;
  const request = vi.fn((_messages: readonly ChatMessage[], _signal: AbortSignal) => new Promise<string>((r) => { resolve = r; }));
  const loop = new TacticalLoop(world, manager, { getHostileActs: () => [], onReply: (s) => replies.push(s), onNotice: (s) => notices.push(s), request });
  return { world, manager, loop, request, replies, notices, resolve: (s: string) => resolve(s) };
}

describe('tactical requests', () => {
  it('only requests above HOLD, single flight, with system prompt and levels', async () => {
    const s = setup(); s.loop.update(); await tick(); expect(s.request).not.toHaveBeenCalled();
    setAutonomy(s.world, 'air', 'WEAPONS_FREE'); s.loop.update(); await tick();
    expect(s.request).toHaveBeenCalledTimes(1);
    const messages = s.request.mock.calls[0][0];
    expect(messages[0].role).toBe('system'); expect(messages[1].content).toContain('AIR WEAPONS_FREE');
    expect(messages[2].content).toContain('Air WEAPONS_FREE');
    s.world.time = 20; s.loop.update(); await tick(); expect(s.request).toHaveBeenCalledTimes(1);
    s.resolve(action); await tick(); expect(s.world.ownShip.inventory.sam).toBe(22);
    expect(s.request).toHaveBeenCalledTimes(2); s.loop.stop();
  });
  it('discards stale and authority-revoked replies', async () => {
    const stale = setup(); setAutonomy(stale.world, 'air', 'WEAPONS_FREE'); stale.loop.update(); await tick();
    stale.world.time = 31; stale.resolve(action); await tick();
    expect(stale.replies).toEqual([]); expect(stale.world.ownShip.inventory.sam).toBe(24); stale.loop.stop();
    const revoked = setup(); setAutonomy(revoked.world, 'air', 'WEAPONS_FREE'); revoked.loop.update(); await tick();
    setAutonomy(revoked.world, 'air', 'HOLD'); setAutonomy(revoked.world, 'air', 'WEAPONS_FREE');
    revoked.resolve(action); await tick(); expect(revoked.replies).toEqual([]); expect(revoked.world.ownShip.inventory.sam).toBe(24); revoked.loop.stop();
  });
  it('immediately reacts to observed hostile acts, entering range, and newly detected missiles', async () => {
    const world = makeWorld([makeContact({ id: 'air', trackId: 'A-01', position: { x: 0, y: 50 }, courseDeg: 180, speedKts: 0 })]);
    const acts: ObservedHostileAct[] = []; const request = vi.fn(async () => '');
    setAutonomy(world, 'air', 'CONSENT');
    const loop = new TacticalLoop(world, new ProposalManager(world), { getHostileActs: () => acts, onReply: () => {}, request });
    loop.update(); await tick(); expect(request).toHaveBeenCalledTimes(1);
    acts.push({ trackId: 'A-01', t: 1, altitudeFt: 15000, speedKts: 420, bearingDeg: 45, rangeNm: 30 });
    loop.update(); await tick(); expect(request).toHaveBeenCalledTimes(2);
    world.contacts[0].position = { x: 0, y: 39 }; world.step(4);
    loop.update(); await tick(); expect(request).toHaveBeenCalledTimes(3);
    world.contacts.push(makeContact({ id: 'missile', trackId: 'M-01', domain: 'missile', position: { x: 0, y: 10 }, courseDeg: 180, speedKts: 600 }));
    world.step(4); loop.update(); await tick(); expect(request).toHaveBeenCalledTimes(4);
    loop.stop();
  });
  it('triggers on configured SAM envelope boundaries including opening through minimum range', async () => {
    const config = cloneWeaponsConfig(); config.sam.minRangeNm = 5; config.sam.maxRangeNm = 25;
    const world = makeWorld([makeContact({ id: 'air', trackId: 'A-01', position: { x: 0, y: 2 }, courseDeg: 0, speedKts: 0 })], { weaponsConfig: config });
    const request = vi.fn(async () => ''); setAutonomy(world, 'air', 'CONSENT');
    const loop = new TacticalLoop(world, new ProposalManager(world), { getHostileActs: () => [], onReply: () => {}, request });
    loop.update(); await tick(); expect(request).toHaveBeenCalledTimes(1);
    world.contacts[0].position = { x: 0, y: 5 }; world.step(4); loop.update(); await tick();
    expect(request).toHaveBeenCalledTimes(2);
    world.contacts[0].position = { x: 0, y: 30 }; world.step(4); loop.update(); await tick();
    expect(request).toHaveBeenCalledTimes(2);
    world.contacts[0].position = { x: 0, y: 25 }; world.step(4); loop.update(); await tick();
    expect(request).toHaveBeenCalledTimes(3); loop.stop();
  });
  it('stops aborted responses and reports request errors', async () => {
    const s = setup(); setAutonomy(s.world, 'air', 'WEAPONS_FREE'); s.loop.update(); await tick();
    const signal = s.request.mock.calls[0][1]; s.loop.stop(); expect(signal.aborted).toBe(true);
    s.resolve(action); await tick(); expect(s.world.ownShip.inventory.sam).toBe(24);
    const world = makeWorld(); setAutonomy(world, 'air', 'CONSENT'); const notices: string[] = [];
    const loop = new TacticalLoop(world, new ProposalManager(world), { getHostileActs: () => [], onReply: () => {}, onNotice: (s) => notices.push(s), request: async () => { throw new Error('offline'); } });
    loop.update(); await tick(); expect(notices[0]).toContain('offline'); loop.stop();
  });
});
