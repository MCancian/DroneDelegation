import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { EventBus } from '../src/sim/events';
import { executeCommand } from '../src/sim/commands';
import type { GameEvent, OwnShip, RadarContact } from '../src/sim/types';

const OWN: OwnShip = { position:{x:0,y:0}, courseDeg:0, speedKts:0, hullPct:100,
  inventory:{sam:24,chaff:6,gunBursts:40,ciws:1000} };

describe('EventBus', () => {
  it('on delivers, off stops delivery', () => {
    const bus = new EventBus();
    const received: GameEvent[] = [];
    const off = bus.onCustom('test', (e) => received.push(e));
    bus.emitCustom({ t:0, type:'test', actor:'player', payload:{} });
    expect(received.length).toBe(1);
    off();
    bus.emitCustom({ t:1, type:'test', actor:'player', payload:{} });
    expect(received.length).toBe(1);
  });
});

describe('World.logEvent', () => {
  it('publishes to bus and retains in log', () => {
    const world = new World({ seed:1, ownShip:structuredClone(OWN), contacts:[] });
    const received: GameEvent[] = [];
    world.eventBus.onCustom('custom', (e) => received.push(e));
    world.logCustomEvent('custom', 'player', { x: 42 });
    expect(received.length).toBe(1);
    expect(world.events.length).toBe(1);
    expect(world.events[0].payload).toEqual({ x: 42 });
  });
});

describe('Event order', () => {
  it('command before weapon_fired on SAM from 10nm actor preserved', () => {
    const contact: RadarContact = { id:'t', trackId:'A-01', domain:'air', truth:'hostile',
      position:{x:0,y:10}, courseDeg:180, speedKts:0, altitudeFt:15000, classification:'unknown',
      sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}},
      alive:true, history:[] };
    const world = new World({ seed:1, ownShip:structuredClone(OWN), contacts:[contact] });
    executeCommand(world, {action:'engage_sam', target:'t'}, 'ai-chat');
    const cmdIdx = world.events.findIndex(e => e.type === 'command');
    const fireIdx = world.events.findIndex(e => e.type === 'weapon_fired');
    expect(cmdIdx).toBeLessThan(fireIdx);
    expect(world.events[cmdIdx].actor).toBe('ai-chat');
    expect(world.events[fireIdx].actor).toBe('ai-chat');
  });
});
