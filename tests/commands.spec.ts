import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { STEP_S } from '../src/sim/clock';
import { executeCommand, validateCommand } from '../src/sim/commands';
import type { Command, CommandActor } from '../src/sim/commands';
import type { OwnShip, RadarContact } from '../src/sim/types';
import { launchAscms } from '../src/sim/weapons';
import { WEAPONS_CONFIG, type WeaponsConfig } from '../src/sim/scenario/weaponsConfig';
import type { MissileLaunchRequest } from '../src/sim/scenario/scenario';

function makeOwnShip(o: Partial<OwnShip> = {}): OwnShip {
  return { position: { x: 0, y: 0 }, courseDeg: 0, speedKts: 0, hullPct: 100,
    inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 }, ...o };
}
function makeContact(o: Partial<RadarContact> = {}): RadarContact {
  return { id: 'tgt', trackId: 'A-01', domain: 'air', truth: 'hostile',
    position: { x: 0, y: 10 }, courseDeg: 180, speedKts: 0, altitudeFt: 15000,
    classification: 'unknown',
    sensors: { iff: { kind: 'none' }, ais: { kind: 'none' }, esm: { kind: 'none' }, visual: { kind: 'none' } },
    alive: true, history: [], ...o };
}
function makeWorld(contacts: RadarContact[], ownShip?: Partial<OwnShip>, weaponsConfig?: WeaponsConfig): World {
  return new World({ seed: 1, ownShip: makeOwnShip(ownShip), contacts, weaponsConfig });
}
function stepFor(w: World, s: number): void { for (let i = 0; i < Math.round(s / STEP_S); i++) w.step(STEP_S); }
function ascmReq(pos: { x: number; y: number }): MissileLaunchRequest {
  return { count: 1, weapon: 'ASCM', speedKts: 600, altitudeFt: 50, launcherId: 'r', trackId: 'A-01', t: 0, position: pos, rangeNm: Math.hypot(pos.x, pos.y), bearingDeg: 0 };
}
const ACTORS: CommandActor[] = ['player', 'ai-chat', 'ai-auto', 'doctrine', 'crew-auto'];

describe('actor recording', () => {
  for (const actor of ACTORS) {
    it(`${actor} success event has actor, time, HOLD snapshot, detached clone`, () => {
      const w = makeWorld([makeContact()]);
      const cmd: Command = { action: 'classify', target: 'tgt', classification: 'hostile' };
      const ref = cmd;
      executeCommand(w, cmd, actor);
      (ref as any).classification = 'neutral';
      const ev = w.events.find(e => e.type === 'command')!;
      expect(ev.actor).toBe(actor);
      expect(ev.t).toBe(0);
      expect((ev.payload as any).autonomy).toEqual({ air: 'HOLD', surface: 'HOLD' });
      expect((ev.payload as any).command.classification).toBe('hostile');
    });
    it(`${actor} rejected event recorded`, () => {
      const w = makeWorld([]);
      const r = executeCommand(w, { action: 'engage_sam', target: 'nope' }, actor);
      expect(r.ok).toBe(false);
      const ev = w.events.find(e => e.type === 'command')!;
      expect(ev.actor).toBe(actor);
      expect((ev.payload as any).ok).toBe(false);
    });
  }
});

describe('validation errors', () => {
  const cases: [string, Command, RadarContact[], Partial<OwnShip>?][] = [
    ['missing target', { action: 'engage_sam', target: 'ghost' }, []],
    ['dead target', { action: 'engage_sam', target: 'tgt' }, [makeContact({ alive: false })]],
    ['undetected', { action: 'engage_sam', target: 'far' }, [makeContact({ id: 'far', position: { x: 0, y: 95 } })]],
    ['own missile', { action: 'engage_sam', target: 'own' }, [makeContact({ id: 'own', ownMissile: true })]],
    ['wrong domain sam', { action: 'engage_sam', target: 's' }, [makeContact({ id: 's', domain: 'surface', size: 'ship', position: { x: 0, y: 5 } })]],
    ['wrong domain gun', { action: 'engage_gun', target: 'tgt' }, [makeContact()]],
    ['wrong domain ciws', { action: 'ciws', target: 'tgt' }, [makeContact()]],
    ['wrong domain hail', { action: 'hail', target: 'tgt' }, [makeContact()]],
    ['wrong domain iff', { action: 'iff_challenge', target: 's' }, [makeContact({ id: 's', domain: 'surface', size: 'ship', position: { x: 0, y: 5 } })]],
    ['wrong domain illuminate', { action: 'illuminate', target: 's' }, [makeContact({ id: 's', domain: 'surface', size: 'ship', position: { x: 0, y: 5 } })]],
    ['wrong domain warning', { action: 'warning_shots', target: 'tgt' }, [makeContact()]],
  ];
  for (const [name, cmd, contacts, own] of cases) {
    it(name, () => {
      const w = makeWorld(contacts, own);
      if (cmd.action === 'engage_sam' && (cmd as any).target === 'tgt') {
        // ensure detected: contact at 10nm air is within 90nm range, detected on init sweep
      }
      const r = executeCommand(w, cmd, 'player');
      expect(r.ok).toBe(false);
    });
  }
});

describe('range boundaries', () => {
  const samCases: [number, boolean][] = [[3, true], [40, true], [2.9, false], [40.1, false]];
  for (const [r, ok] of samCases) {
    it(`SAM ${r}nm ${ok ? 'accepted' : 'rejected'}`, () => {
      const w = makeWorld([makeContact({ position: { x: 0, y: r } })]);
      expect(executeCommand(w, { action: 'engage_sam', target: 'tgt' }, 'player').ok).toBe(ok);
    });
  }
  const gunCases: [number, boolean][] = [[9, true], [9.1, false]];
  for (const [r, ok] of gunCases) {
    it(`gun ${r}nm ${ok ? 'accepted' : 'rejected'}`, () => {
      const w = makeWorld([makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: r } })]);
      expect(executeCommand(w, { action: 'engage_gun', target: 's' }, 'player').ok).toBe(ok);
    });
  }
  const warnCases: [number, boolean][] = [[6, true], [6.1, false]];
  for (const [r, ok] of warnCases) {
    it(`warning ${r}nm ${ok ? 'accepted' : 'rejected'}`, () => {
      const w = makeWorld([makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: r } })]);
      expect(executeCommand(w, { action: 'warning_shots', target: 's' }, 'player').ok).toBe(ok);
    });
  }
});

describe('inventory exhausted', () => {
  it('SAM', () => {
    const w = makeWorld([makeContact({ position: { x: 0, y: 10 } })], { inventory: { sam: 1, chaff: 6, gunBursts: 40, ciws: 1000 } });
    expect(executeCommand(w, { action: 'engage_sam', target: 'tgt' }, 'player').ok).toBe(false);
    expect(w.ownShip.inventory.sam).toBe(1);
  });
  it('chaff', () => {
    const w = makeWorld([], { inventory: { sam: 24, chaff: 0, gunBursts: 40, ciws: 1000 } });
    expect(executeCommand(w, { action: 'chaff' }, 'player').ok).toBe(false);
  });
  it('gun', () => {
    const w = makeWorld([makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 5 } })], { inventory: { sam: 24, chaff: 6, gunBursts: 0, ciws: 1000 } });
    expect(executeCommand(w, { action: 'engage_gun', target: 's' }, 'player').ok).toBe(false);
  });
  it('CIWS', () => {
    const w = makeWorld([], { inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 99 } });
    w.weapons.pointDefense = 'manual';
    launchAscms(w, ascmReq({ x: 0, y: 1.4 }));
    stepFor(w, 4);
    expect(w.trackFor('ascm-1')?.detected).toBe(true);
    expect(executeCommand(w, { action: 'ciws', target: 'ascm-1' }, 'player').ok).toBe(false);
    expect(w.ownShip.inventory.ciws).toBe(99);
  });
});

describe('gun busy', () => {
  it('second gun command rejected while burst active', () => {
    const w = makeWorld([makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 5 } })]);
    expect(executeCommand(w, { action: 'engage_gun', target: 's' }, 'player').ok).toBe(true);
    expect(executeCommand(w, { action: 'engage_gun', target: 's' }, 'player').ok).toBe(false);
    expect(w.ownShip.inventory.gunBursts).toBe(39);
  });
});

describe('classify', () => {
  it('valid', () => {
    const w = makeWorld([makeContact()]);
    expect(executeCommand(w, { action: 'classify', target: 'tgt', classification: 'hostile' }, 'player').ok).toBe(true);
    expect(w.contactById('tgt')!.classification).toBe('hostile');
  });
  it('invalid classification', () => {
    const w = makeWorld([makeContact()]);
    expect(executeCommand(w, { action: 'classify', target: 'tgt', classification: 'bogus' as any }, 'player').ok).toBe(false);
  });
});

describe('point defense', () => {
  it('valid modes', () => {
    const w = makeWorld([]);
    expect(executeCommand(w, { action: 'set_point_defense', mode: 'manual' }, 'player').ok).toBe(true);
    expect(w.weapons.pointDefense).toBe('manual');
    expect(executeCommand(w, { action: 'set_point_defense', mode: 'auto' }, 'player').ok).toBe(true);
    expect(w.weapons.pointDefense).toBe('auto');
  });
  it('invalid mode', () => {
    const w = makeWorld([]);
    expect(executeCommand(w, { action: 'set_point_defense', mode: 'bogus' as any }, 'player').ok).toBe(false);
  });
});

describe('maneuver', () => {
  const bad: [number, number][] = [[NaN, 10], [Infinity, 10], [-1, 10], [360, 10], [10, NaN], [10, Infinity], [10, -1], [10, 36]];
  for (const [c, s] of bad) {
    it(`rejects course=${c} speed=${s}`, () => {
      const w = makeWorld([]);
      expect(executeCommand(w, { action: 'maneuver', courseDeg: c, speedKts: s }, 'player').ok).toBe(false);
    });
  }
  const good: [number, number][] = [[0, 0], [359.9, 35], [180, 15]];
  for (const [c, s] of good) {
    it(`accepts course=${c} speed=${s}`, () => {
      const w = makeWorld([]);
      expect(executeCommand(w, { action: 'maneuver', courseDeg: c, speedKts: s }, 'player').ok).toBe(true);
      expect(w.ownShip.courseDeg).toBe(c);
      expect(w.ownShip.speedKts).toBe(s);
    });
  }
});

describe('ship lost', () => {
  it('all commands rejected', () => {
    const w = makeWorld([makeContact()]);
    w.weapons.shipLost = true;
    expect(executeCommand(w, { action: 'engage_sam', target: 'tgt' }, 'player').ok).toBe(false);
    expect(executeCommand(w, { action: 'maneuver', courseDeg: 90, speedKts: 10 }, 'player').ok).toBe(false);
    expect(executeCommand(w, { action: 'chaff' }, 'player').ok).toBe(false);
  });
});

describe('scenario actor rejected', () => {
  it('rejects scenario actor', () => {
    const w = makeWorld([]);
    const r = executeCommand(w, { action: 'maneuver', courseDeg: 90, speedKts: 10 }, 'scenario' as any);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('Invalid actor');
  });
});

describe('validateCommand purity', () => {
  it('no events or state changes', () => {
    const w = makeWorld([makeContact()]);
    const evLen = w.events.length;
    const inv = { ...w.ownShip.inventory };
    const cls = w.contactById('tgt')!.classification;
    validateCommand(w, { action: 'engage_sam', target: 'tgt' });
    validateCommand(w, { action: 'classify', target: 'tgt', classification: 'hostile' });
    validateCommand(w, { action: 'maneuver', courseDeg: 90, speedKts: 10 });
    expect(w.events.length).toBe(evLen);
    expect(w.ownShip.inventory).toEqual(inv);
    expect(w.contactById('tgt')!.classification).toBe(cls);
  });
});

describe('warning shot', () => {
  it('consumes 1 gun burst, no kill', () => {
    const w = makeWorld([makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 5 } })]);
    expect(executeCommand(w, { action: 'warning_shots', target: 's' }, 'player').ok).toBe(true);
    expect(w.ownShip.inventory.gunBursts).toBe(39);
    expect(w.contactById('s')!.alive).toBe(true);
  });
});

describe('SAM flight with Pk=1', () => {
  it('kills target', () => {
    const cfg: WeaponsConfig = { ...WEAPONS_CONFIG, sam: { ...WEAPONS_CONFIG.sam, pkSalvoVsAircraft: 1 } };
    const w = makeWorld([makeContact({ position: { x: 0, y: 10 } })], undefined, cfg);
    expect(executeCommand(w, { action: 'engage_sam', target: 'tgt' }, 'player').ok).toBe(true);
    stepFor(w, 25);
    expect(w.contactById('tgt')!.alive).toBe(false);
  });
});

describe('rejected commands consume no inventory', () => {
  it('SAM out of range no decrement', () => {
    const w = makeWorld([makeContact({ position: { x: 0, y: 41 } })]);
    executeCommand(w, { action: 'engage_sam', target: 'tgt' }, 'player');
    expect(w.ownShip.inventory.sam).toBe(24);
  });
  it('gun out of range no decrement', () => {
    const w = makeWorld([makeContact({ id: 's', domain: 'surface', size: 'small', position: { x: 0, y: 10 } })]);
    executeCommand(w, { action: 'engage_gun', target: 's' }, 'player');
    expect(w.ownShip.inventory.gunBursts).toBe(40);
  });
});
