import { describe, expect, it } from 'vitest';
import { EventBus, isEventOfType } from '../src/sim/events';
import { executeCommand } from '../src/sim/commands';
import { setAutonomy } from '../src/ai/autonomy';
import { SituationHistory, serializeSituation } from '../src/ai/situation';
import { deterministicWeaponsConfig, makeContact, makeWorld, stepWorldWithCrew } from './helpers/sim';

// These examples are typechecked, not run. They protect producer and listener contracts.
function typeContracts(world: ReturnType<typeof makeWorld>, bus: EventBus): void {
  bus.on('weapon_result', event => {
    const killed: boolean = event.payload.killed;
    const type: 'weapon_result' = event.type;
    void killed; void type;
    // @ts-expect-error weapon result does not contain private truth
    event.payload.truth;
  });
  bus.on('command', event => {
    if (!event.payload.ok) {
      const error: string = event.payload.error;
      void error;
    }
  });
  // @ts-expect-error wrong known-event payload must not use custom-event fallback
  world.logEvent('weapon_result', 'player', { weapon: 'sam', targetId: 'x', killed: 'yes' });
  // @ts-expect-error a rejected command must include an error
  world.logEvent('command', 'player', { command: { action: 'chaff' }, ok: false, autonomy: { air: 'HOLD', surface: 'HOLD' } });
  // @ts-expect-error emitter rejects invalid known-event payloads
  bus.emit({ t: 0, type: 'ship_lost', actor: 'scenario', payload: { hullPct: 'zero' } });
  world.logCustomEvent('extension_example', 'player', { any: 'payload' });
  // @ts-expect-error unknown names must use the explicit custom API
  world.logEvent('extension_example', 'player', { any: 'payload' });
}
void typeContracts;

describe('event contracts and decision attribution', () => {
  it('prevents custom paths from impersonating known event names', () => {
    const world = makeWorld();
    expect(() => world.logCustomEvent('ship_lost', 'scenario', { hullPct: 'zero' })).toThrow();
    expect(() => world.eventBus.onCustom('ship_lost', () => {})).toThrow();
    expect(() => world.eventBus.emitCustom({ t: 0, type: 'ship_lost', actor: 'scenario', payload: {} })).toThrow();
    expect(world.events).toHaveLength(0);
  });
  it('retains decision-time authority and actor through delayed effects, without counting rejections', () => {
    const airliner = makeContact({ id: 'civil', trackId: 'A-09', truth: 'civil', personsAboard: 212 });
    const world = makeWorld([airliner], { weaponsConfig: deterministicWeaponsConfig(1) });
    setAutonomy(world, 'air', 'WEAPONS_FREE');
    expect(executeCommand(world, { action: 'engage_sam', target: 'missing' }, 'player').ok).toBe(false);
    expect(executeCommand(world, { action: 'engage_sam', target: 'civil' }, 'doctrine').ok).toBe(true);
    setAutonomy(world, 'air', 'HOLD');
    stepWorldWithCrew(world, 120);

    const attempts = world.events.filter(event => isEventOfType(event, 'command'));
    expect(attempts).toHaveLength(2);
    expect(attempts.filter(event => event.payload.ok)).toHaveLength(1);
    expect(attempts[0].payload.ok).toBe(false);
    expect(attempts[1].actor).toBe('doctrine');
    expect(attempts[1].payload.autonomy.air).toBe('WEAPONS_FREE');
    expect(world.autonomy.air).toBe('HOLD');
    const fired = world.events.find(event => isEventOfType(event, 'weapon_fired'));
    const result = world.events.find(event => isEventOfType(event, 'weapon_result'));
    const destruction = world.events.find(event => isEventOfType(event, 'contact_destroyed'));
    expect(fired?.actor).toBe('doctrine');
    expect(result?.actor).toBe('doctrine');
    expect(destruction?.actor).toBe('doctrine');
    expect(result!.t).toBeGreaterThan(fired!.t);
    expect(destruction?.payload).toMatchObject({ truth: 'civil', casualties: 212 });
    const narration = world.events.filter(event => isEventOfType(event, 'crew-report') && event.payload.text.includes('Splash'));
    expect(narration).toHaveLength(1);
    expect(narration[0].actor).toBe('crew-auto');

    const visible = JSON.stringify(world.visibleTracks());
    const crew = JSON.stringify(world.events.filter(event => isEventOfType(event, 'crew-report')));
    const situation = serializeSituation(world, new SituationHistory().acts());
    for (const publicOutput of [visible, crew, situation]) {
      expect(publicOutput).not.toContain('212');
      expect(publicOutput).not.toContain('casualties');
      expect(publicOutput).not.toContain('truth');
    }
  });
});
