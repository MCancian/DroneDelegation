import { describe, expect, it } from 'vitest';
import { Doctrine } from '../src/ai/doctrine';
import { ProposalManager } from '../src/ai/proposals';
import { SituationHistory } from '../src/ai/situation';
import { loadScenario } from '../src/sim/scenario/scenario';
import { STRAIT_IDS, STRAIT_TRANSIT, STRAIT_TRIGGERS } from '../src/sim/scenario/strait';
import type { AutonomyLevel, GameEvent } from '../src/sim/types';

function play(air: AutonomyLevel, surface: AutonomyLevel) {
  const { world, runner } = loadScenario(STRAIT_TRANSIT, 123);
  world.autonomy.air = air;
  world.autonomy.surface = surface;
  // Isolate the authority outcome from possible ship loss due to enemy missile
  // RNG. Weapon behavior against the targets retains the normal scenario Pk.
  world.weapons.config = structuredClone(world.weapons.config);
  world.weapons.config.ascm.pHit = 0;
  world.weapons.config.ascm.pHitChaff = 0;
  const manager = new ProposalManager(world);
  const history = new SituationHistory();
  const doctrine = new Doctrine(world, manager, { getHostileActs: () => history.acts() });
  history.observe(world);
  doctrine.update();
  for (let i = 0; i < 9000; i++) {
    world.step(0.1);
    runner.update();
    history.observe(world);
    doctrine.update();
    manager.update();
  }
  return { world, runner, manager };
}

function payload(event: GameEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function fired(events: GameEvent[], target: string): GameEvent | undefined {
  return events.find((event) => event.type === 'weapon_fired' && event.actor === 'doctrine' && payload(event).targetId === target);
}

describe('doctrine in the Strait Transit scenario', () => {
  it('WEAPONS FREE engages S-7 before launch and A-9 before the civil-confirming report', () => {
    const { world, runner } = play('WEAPONS_FREE', 'WEAPONS_FREE');
    expect(world.weapons.shipLost).toBe(false);
    expect(world.contactById(STRAIT_IDS.a9)?.truth).toBe('civil');
    const gun = fired(world.events, STRAIT_IDS.s7);
    const sam = fired(world.events, STRAIT_IDS.a9);
    expect(gun).toBeDefined();
    expect(sam).toBeDefined();
    expect(payload(gun!).weapon).toBe('gun');
    expect(payload(sam!).weapon).toBe('sam');
    expect(payload(sam!).rangeNm).toBeLessThanOrEqual(40);
    expect(payload(sam!).rangeNm).toBeGreaterThan(32);
    const s7Launch = world.events.find((event) => event.type === 'trigger' && payload(event).triggerId === STRAIT_TRIGGERS.s7Launch);
    // A successful gun burst may stop the launch entirely; the normal seed
    // used here misses and supplies a measured event for this timing check.
    expect(s7Launch).toBeDefined();
    expect(gun!.t).toBeLessThan(s7Launch!.t);
    // A successful intercept can remove the airliner before its 32 nm report.
    // Compare against the same-seed HOLD trajectory to retain a real report
    // time instead of assuming that a destroyed aircraft still reports.
    const reference = play('HOLD', 'HOLD');
    const civilReport = reference.world.events.find((event) => event.type === 'trigger' && payload(event).triggerId === STRAIT_TRIGGERS.a9Esm);
    expect(civilReport).toBeDefined();
    expect(sam!.t).toBeLessThan(civilReport!.t);
    expect(runner.firedTriggers).toContain(STRAIT_TRIGGERS.a1Launch);
    expect(world.events.filter((event) => event.type === 'doctrine_match' && payload(event).target === STRAIT_IDS.fastFerry)).toHaveLength(0);
  }, 30000);

  it('HOLD logs both rule matches without executing doctrine commands', () => {
    const { world } = play('HOLD', 'HOLD');
    const matches = world.events.filter((event) => event.type === 'doctrine_match').map(payload);
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'ROE-3', target: STRAIT_IDS.a9 }),
      expect.objectContaining({ rule: 'ROE-5', target: STRAIT_IDS.s7 }),
    ]));
    expect(matches.some((match) => match.target === STRAIT_IDS.fastFerry)).toBe(false);
    expect(world.events.filter((event) => event.type === 'command' && event.actor === 'doctrine')).toHaveLength(0);
  }, 30000);
});
