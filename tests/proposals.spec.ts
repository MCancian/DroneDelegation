import { describe, it, expect } from 'vitest';
import { ProposalManager } from '../src/ai/proposals';
import { setAutonomy } from '../src/ai/autonomy';
import { executeCommand } from '../src/sim/commands';
import { makeContact, makeWorld } from './helpers/sim';

function setup() {
  const world = makeWorld([makeContact({ id: 'air', trackId: 'A-01', position: { x: 0, y: 20 } })]);
  return { world, manager: new ProposalManager(world), cmd: { action: 'engage_sam' as const, target: 'air' } };
}

describe('autonomous proposals', () => {
  it('records HOLD as advice and executes WEAPONS FREE immediately', () => {
    const { world, manager, cmd } = setup();
    expect(manager.submit(cmd, 'ai-auto')?.status).toBe('advice');
    expect(world.ownShip.inventory.sam).toBe(24);
    setAutonomy(world, 'air', 'WEAPONS_FREE');
    expect(manager.submit(cmd, 'doctrine')?.status).toBe('executed');
    expect(world.ownShip.inventory.sam).toBe(22);
    expect(manager.submit(cmd, 'ai-auto')).toBeNull();
    expect(world.events.filter((e) => e.type === 'proposal_executed')[0].actor).toBe('doctrine');
  });
  it('only approves consent while pending and expires after 30 seconds of game time', () => {
    const { world, manager, cmd } = setup();
    setAutonomy(world, 'air', 'CONSENT');
    const p = manager.submit(cmd, 'ai-auto')!;
    world.time = 29.9; manager.update();
    expect(manager.list()[0].status).toBe('pending');
    manager.approve(p.id);
    expect(manager.list()[0].status).toBe('executed');
    expect(world.events.some((e) => e.type === 'proposal_approved')).toBe(true);
    const other = setup();
    setAutonomy(other.world, 'air', 'CONSENT');
    const late = other.manager.submit(other.cmd, 'ai-auto')!;
    other.world.time = 30; other.manager.approve(late.id);
    expect(other.manager.list()[0].status).toBe('expired');
    expect(other.world.ownShip.inventory.sam).toBe(24);
  });
  it('veto executes at 10s, and denial or cancellation suppresses repeats', () => {
    const a = setup(); setAutonomy(a.world, 'air', 'VETO');
    a.manager.submit(a.cmd, 'ai-auto'); a.world.time = 9.9; a.manager.update();
    expect(a.world.ownShip.inventory.sam).toBe(24);
    a.world.time = 10; a.manager.update(); expect(a.world.ownShip.inventory.sam).toBe(22);
    const b = setup(); setAutonomy(b.world, 'air', 'VETO');
    const veto = b.manager.submit(b.cmd, 'ai-auto')!; b.manager.veto(veto.id);
    expect(b.manager.submit(b.cmd, 'doctrine')).toBeNull();
    b.world.time = 30; b.manager.update(); expect(b.world.ownShip.inventory.sam).toBe(24);
    const c = setup(); setAutonomy(c.world, 'air', 'CONSENT');
    const deny = c.manager.submit(c.cmd, 'doctrine')!; c.manager.deny(deny.id);
    expect(c.manager.submit(c.cmd, 'ai-auto')).toBeNull();
    expect(c.world.events.some((e) => e.type === 'proposal_denied')).toBe(true);
  });
  it('cancels on revoke-and-restore and direct engagement; ignores point defense changes', () => {
    const a = setup(); setAutonomy(a.world, 'air', 'VETO'); a.manager.submit(a.cmd, 'ai-auto');
    setAutonomy(a.world, 'air', 'HOLD'); setAutonomy(a.world, 'air', 'VETO'); a.world.time = 10; a.manager.update();
    expect(a.manager.list()[0].status).toBe('expired'); expect(a.world.ownShip.inventory.sam).toBe(24);
    const b = setup(); setAutonomy(b.world, 'air', 'VETO'); b.manager.submit(b.cmd, 'ai-auto');
    expect(executeCommand(b.world, b.cmd, 'player').ok).toBe(true);
    b.world.time = 10; b.manager.update(); expect(b.world.ownShip.inventory.sam).toBe(22);
    expect(b.manager.submit(b.cmd, 'doctrine')).toBeNull();
    const c = setup(); setAutonomy(c.world, 'air', 'VETO'); c.manager.submit(c.cmd, 'ai-auto');
    executeCommand(c.world, { action: 'set_point_defense', mode: 'manual' }, 'player');
    c.world.time = 10; c.manager.update(); expect(c.world.ownShip.inventory.sam).toBe(22);
  });
  it('never autonomously executes untargeted commands or acts after scenario end', () => {
    const { world, cmd } = setup(); let ended = false; const manager = new ProposalManager(world, () => ended);
    setAutonomy(world, 'air', 'WEAPONS_FREE');
    manager.submit({ action: 'chaff' }, 'ai-auto'); expect(world.ownShip.inventory.chaff).toBe(6);
    setAutonomy(world, 'air', 'VETO'); manager.submit(cmd, 'ai-auto'); ended = true; world.time = 10; manager.update();
    expect(world.ownShip.inventory.sam).toBe(24);
  });
});
