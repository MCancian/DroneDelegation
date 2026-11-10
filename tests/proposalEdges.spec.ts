import { describe, expect, it } from 'vitest';
import { ProposalManager } from '../src/ai/proposals';
import { setAutonomy } from '../src/ai/autonomy';
import { executeCommand } from '../src/sim/commands';
import { GameClock } from '../src/sim/clock';
import { makeContact, makeWorld } from './helpers/sim';

describe('proposal execution against changing simulation state', () => {
  it('revalidates scarce ammunition after a different direct engagement', () => {
    const world = makeWorld([
      makeContact({ id: 'first', position: { x: 0, y: 20 } }),
      makeContact({ id: 'second', position: { x: 10, y: 20 } }),
    ]);
    world.ownShip.inventory.sam = 3;
    setAutonomy(world, 'air', 'CONSENT');
    const proposals = new ProposalManager(world);
    const p = proposals.submit({ action: 'engage_sam', target: 'first' }, 'doctrine')!;
    expect(executeCommand(world, { action: 'engage_sam', target: 'second' }, 'player').ok).toBe(true);
    proposals.approve(p.id);
    expect(world.ownShip.inventory.sam).toBe(1);
    expect(proposals.list()[0].status).toBe('failed');
    expect(world.events.find(e => e.type === 'proposal_failed')?.actor).toBe('doctrine');
  });

  it('expires a proposal when its target disappears before consent', () => {
    const world = makeWorld([makeContact({ id: 'air' })]);
    setAutonomy(world, 'air', 'CONSENT');
    const proposals = new ProposalManager(world);
    const p = proposals.submit({ action: 'engage_sam', target: 'air' }, 'ai-auto')!;
    world.contacts[0].alive = false;
    proposals.approve(p.id);
    expect(proposals.list()[0].status).toBe('expired');
    expect(world.ownShip.inventory.sam).toBe(24);
  });

  it('keeps Surface veto authority independent of an Air authority change', () => {
    const world = makeWorld([makeContact({ id: 'boat', domain: 'surface', position: { x: 0, y: 8 } })]);
    setAutonomy(world, 'surface', 'VETO');
    const proposals = new ProposalManager(world);
    proposals.submit({ action: 'engage_gun', target: 'boat' }, 'doctrine');
    setAutonomy(world, 'air', 'WEAPONS_FREE');
    world.time = 10;
    proposals.update();
    expect(proposals.list()[0].status).toBe('executed');
    const command = world.events.find(e => e.type === 'command');
    expect(command?.payload).toMatchObject({ autonomy: { air: 'WEAPONS_FREE', surface: 'VETO' } });
  });

  it('uses elapsed game time for the veto countdown at accelerated timescale', () => {
    const world = makeWorld([makeContact({ id: 'air', position: { x: 0, y: 20 } })]);
    setAutonomy(world, 'air', 'VETO');
    const clock = new GameClock({ timescale: 2 });
    const proposals = new ProposalManager(world, () => clock.ended);
    proposals.submit({ action: 'engage_sam', target: 'air' }, 'ai-auto');
    clock.onStep(dt => { world.step(dt); proposals.update(); });
    clock.advance(4.95);
    expect(world.ownShip.inventory.sam).toBe(24);
    clock.advance(0.05);
    expect(world.ownShip.inventory.sam).toBe(22);
    expect(world.events.find(e => e.type === 'proposal_executed')?.t).toBeCloseTo(10, 8);
  });
});
