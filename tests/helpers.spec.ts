import { describe, it, expect, vi } from 'vitest';
import {
  worldContact,
  cloneWeaponsConfig,
  deterministicWeaponsConfig,
  makeOwnShip,
  makeContact,
  makeWorld,
  stepWorld,
  stepWorldWithCrew,
  stepScenario,
} from './helpers/sim';
import { WEAPONS_CONFIG } from '../src/sim/scenario/weaponsConfig';
import { loadScenario, type Scenario } from '../src/sim/scenario/scenario';
import { fireSam } from '../src/sim/weapons';
import { STEP_S } from '../src/sim/clock';
import { stepCrew } from '../src/sim/scenario/crew';
import * as crewModule from '../src/sim/scenario/crew';

describe('worldContact', () => {
  it('returns the world-owned reference, not the input fixture', () => {
    const fixture = makeContact({ id: 'x' });
    const world = makeWorld([fixture]);
    const owned = worldContact(world, 'x');
    expect(owned).toBe(world.contacts[0]);
    expect(owned).not.toBe(fixture);
  });

  it('mutation through returned reference affects world, leaves fixture untouched', () => {
    const fixture = makeContact({ id: 'x' });
    const world = makeWorld([fixture]);
    const owned = worldContact(world, 'x');
    owned.classification = 'hostile';
    expect(worldContact(world, 'x').classification).toBe('hostile');
    expect(fixture.classification).toBe('unknown');
  });

  it('throws clear error for unknown id', () => {
    const world = makeWorld([]);
    expect(() => worldContact(world, 'missing')).toThrowError(
      /worldContact: contact 'missing' not found/,
    );
  });
});

describe('cloneWeaponsConfig', () => {
  it('returns a deeply independent copy from WEAPONS_CONFIG', () => {
    const a = cloneWeaponsConfig();
    const b = cloneWeaponsConfig();
    expect(a).toEqual(WEAPONS_CONFIG);
    expect(a).not.toBe(WEAPONS_CONFIG);
    expect(a.sam).not.toBe(WEAPONS_CONFIG.sam);
    expect(a.ascm).not.toBe(WEAPONS_CONFIG.ascm);
    a.sam.salvoSize = 99;
    expect(b.sam.salvoSize).toBe(WEAPONS_CONFIG.sam.salvoSize);
    expect(WEAPONS_CONFIG.sam.salvoSize).toBe(2);
  });

  it('accepts a custom base', () => {
    const custom = cloneWeaponsConfig();
    custom.gun.maxRangeNm = 42;
    const derived = cloneWeaponsConfig(custom);
    expect(derived.gun.maxRangeNm).toBe(42);
    expect(WEAPONS_CONFIG.gun.maxRangeNm).toBe(9);
  });
});

describe('deterministicWeaponsConfig', () => {
  it('sets all Pk fields to 1, preserves non-Pk values', () => {
    const cfg = deterministicWeaponsConfig(1);
    expect(cfg.sam.pkSalvoVsAircraft).toBe(1);
    expect(cfg.sam.pkPerMissileVsAscm).toBe(1);
    expect(cfg.gun.pkPerBurst).toBe(1);
    expect(cfg.ciws.pkPerMissile).toBe(1);
    expect(cfg.ascm.pHit).toBe(1);
    expect(cfg.ascm.pHitChaff).toBe(1);
    expect(cfg.sam.salvoSize).toBe(WEAPONS_CONFIG.sam.salvoSize);
    expect(cfg.sam.maxRangeNm).toBe(WEAPONS_CONFIG.sam.maxRangeNm);
    expect(cfg.gun.maxRangeNm).toBe(WEAPONS_CONFIG.gun.maxRangeNm);
    expect(cfg.ciws.maxRangeNm).toBe(WEAPONS_CONFIG.ciws.maxRangeNm);
    expect(cfg.ascm.damagePct).toBe(WEAPONS_CONFIG.ascm.damagePct);
    expect(cfg.chaff.durationS).toBe(WEAPONS_CONFIG.chaff.durationS);
  });

  it('sets all Pk fields to 0', () => {
    const cfg = deterministicWeaponsConfig(0);
    expect(cfg.sam.pkSalvoVsAircraft).toBe(0);
    expect(cfg.sam.pkPerMissileVsAscm).toBe(0);
    expect(cfg.gun.pkPerBurst).toBe(0);
    expect(cfg.ciws.pkPerMissile).toBe(0);
    expect(cfg.ascm.pHit).toBe(0);
    expect(cfg.ascm.pHitChaff).toBe(0);
  });

  it('throws for invalid pk values', () => {
    expect(() => deterministicWeaponsConfig(0.5 as 0 | 1)).toThrowError(/must be exactly 0 or 1/);
    expect(() => deterministicWeaponsConfig(2 as 0 | 1)).toThrowError(/must be exactly 0 or 1/);
    expect(() => deterministicWeaponsConfig(-1 as 0 | 1)).toThrowError(/must be exactly 0 or 1/);
  });

  it('does not mutate WEAPONS_CONFIG', () => {
    deterministicWeaponsConfig(1);
    expect(WEAPONS_CONFIG.sam.pkSalvoVsAircraft).toBe(0.85);
    expect(WEAPONS_CONFIG.ascm.pHit).toBe(0.8);
  });
});

describe('makeOwnShip', () => {
  it('returns correct defaults', () => {
    const ship = makeOwnShip();
    expect(ship.position).toEqual({ x: 0, y: 0 });
    expect(ship.courseDeg).toBe(0);
    expect(ship.speedKts).toBe(0);
    expect(ship.hullPct).toBe(100);
    expect(ship.inventory).toEqual({ sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 });
  });

  it('applies overrides and returns fully cloned object', () => {
    const ship = makeOwnShip({ hullPct: 50 });
    expect(ship.hullPct).toBe(50);
    expect(ship.position).toEqual({ x: 0, y: 0 });
    ship.position.x = 99;
    const ship2 = makeOwnShip();
    expect(ship2.position.x).toBe(0);
  });
});

describe('makeContact', () => {
  it('returns correct defaults', () => {
    const c = makeContact();
    expect(c.id).toBe('tgt');
    expect(c.trackId).toBe('A-01');
    expect(c.domain).toBe('air');
    expect(c.truth).toBe('hostile');
    expect(c.position).toEqual({ x: 0, y: 10 });
    expect(c.courseDeg).toBe(180);
    expect(c.speedKts).toBe(0);
    expect(c.altitudeFt).toBe(15000);
    expect(c.classification).toBe('unknown');
    expect(c.alive).toBe(true);
    expect(c.history).toEqual([]);
    expect(c.sensors.iff).toEqual({ kind: 'none' });
    expect(c.sensors.ais).toEqual({ kind: 'none' });
    expect(c.sensors.esm).toEqual({ kind: 'none' });
    expect(c.sensors.visual).toEqual({ kind: 'none' });
  });

  it('applies overrides', () => {
    const c = makeContact({ id: 'custom', speedKts: 500 });
    expect(c.id).toBe('custom');
    expect(c.speedKts).toBe(500);
    expect(c.trackId).toBe('A-01');
  });

  it('returns structuredClone independent of overrides object', () => {
    const overrides = { position: { x: 5, y: 5 } };
    const c = makeContact(overrides);
    overrides.position.x = 99;
    expect(c.position.x).toBe(5);
  });
});

describe('makeWorld', () => {
  it('independent worlds never share weapons config', () => {
    const w1 = makeWorld();
    const w2 = makeWorld();
    expect(w1.weapons.config).not.toBe(w2.weapons.config);
    expect(w1.weapons.config.sam).not.toBe(w2.weapons.config.sam);
    w1.weapons.config.sam.salvoSize = 99;
    expect(w2.weapons.config.sam.salvoSize).toBe(2);
  });

  it('accepts custom weaponsConfig and deep clones it', () => {
    const cfg = cloneWeaponsConfig();
    cfg.sam.salvoSize = 5;
    const w = makeWorld([], { weaponsConfig: cfg });
    expect(w.weapons.config.sam.salvoSize).toBe(5);
    cfg.sam.salvoSize = 99;
    expect(w.weapons.config.sam.salvoSize).toBe(5);
  });

  it('accepts ownShip overrides', () => {
    const w = makeWorld([], { ownShip: { hullPct: 50 } });
    expect(w.ownShip.hullPct).toBe(50);
    expect(w.ownShip.inventory.sam).toBe(24);
  });
});

describe('stepWorld', () => {
  it('executes correct number of steps', () => {
    const world = makeWorld();
    const count = stepWorld(world, 0.5);
    expect(count).toBe(5);
    expect(world.time).toBeCloseTo(0.5, 10);
  });

  it('does not call stepCrew (no crew-report events from crew-auto)', () => {
    const contact = makeContact({ id: 'detected' });
    const world = makeWorld([contact]);
    stepWorld(world, 0.3);
    const crewReports = world.events.filter(
      (e) => e.type === 'crew-report' && e.actor === 'crew-auto',
    );
    expect(crewReports.length).toBe(0);
  });

  it('throws for negative seconds', () => {
    const world = makeWorld();
    expect(() => stepWorld(world, -0.1)).toThrowError(/finite and nonnegative/);
  });

  it('throws for non-multiple of STEP_S', () => {
    const world = makeWorld();
    expect(() => stepWorld(world, 0.15)).toThrowError(/whole multiple/);
  });

  it('throws for non-finite seconds', () => {
    const world = makeWorld();
    expect(() => stepWorld(world, Infinity)).toThrowError(/finite and nonnegative/);
    expect(() => stepWorld(world, NaN)).toThrowError(/finite and nonnegative/);
  });
});

describe('stepWorldWithCrew', () => {
  it('produces crew-report events from crew-auto', () => {
    const contact = makeContact({ id: 'detected' });
    const world = makeWorld([contact]);
    stepWorldWithCrew(world, 0.3);
    const crewReports = world.events.filter(
      (e) => e.type === 'crew-report' && e.actor === 'crew-auto',
    );
    expect(crewReports.length).toBeGreaterThan(0);
  });

  it('executes correct number of steps', () => {
    const world = makeWorld();
    const count = stepWorldWithCrew(world, 0.4);
    expect(count).toBe(4);
    expect(world.time).toBeCloseTo(0.4, 10);
  });

  it('calls stepCrew exactly once per step (spy + sequence comparison)', () => {
    const spy = vi.spyOn(crewModule, 'stepCrew');
    try {
      const contact = makeContact({ id: 'cmp' });
      const world1 = makeWorld([contact]);
      stepWorldWithCrew(world1, 0.3);
      expect(spy).toHaveBeenCalledTimes(3);

      const world2 = makeWorld([contact]);
      for (let i = 0; i < 3; i++) {
        world2.step(STEP_S);
        stepCrew(world2);
      }

      const reports1 = world1.events.filter(
        (e) => e.type === 'crew-report' && e.actor === 'crew-auto',
      );
      const reports2 = world2.events.filter(
        (e) => e.type === 'crew-report' && e.actor === 'crew-auto',
      );
      expect(reports1.length).toBe(reports2.length);
      expect(reports1.map((e) => (e.payload as Record<string, unknown>).text)).toEqual(
        reports2.map((e) => (e.payload as Record<string, unknown>).text),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('stepScenario', () => {
  const miniScenario: Scenario = {
    id: 'test-mini',
    name: 'Test Mini',
    durationS: 0.4,
    ownShip: makeOwnShip(),
    contacts: [
      {
        id: 'late',
        trackId: 'L-01',
        name: 'Late',
        domain: 'air',
        truth: 'hostile',
        placement: { kind: 'absolute', position: { x: 0, y: 10 }, courseDeg: 180 },
        speedKts: 0,
        altitudeFt: 15000,
        behavior: { kind: 'straight' },
        spawnAtS: 0.2,
      },
    ],
    triggers: [
      {
        id: 't1',
        when: { kind: 'time', atS: 0.2 },
        actions: [
          { kind: 'crewReport', station: 'CIC', priority: 'routine', text: 'Scripted report' },
        ],
      },
    ],
  };

  it('triggers scripted events at correct time', () => {
    const { world, runner } = loadScenario(miniScenario, 1);
    stepScenario(runner, 0.3);
    const scriptedReport = world.events.find(
      (e) => e.type === 'crew-report' && e.actor === 'scenario' &&
        (e.payload as Record<string, unknown>).text === 'Scripted report',
    );
    expect(scriptedReport).toBeDefined();
    expect(scriptedReport!.t).toBeCloseTo(0.2, 10);
  });

  it('spawns contact at correct time', () => {
    const { world, runner } = loadScenario(miniScenario, 1);
    stepScenario(runner, 0.3);
    const spawnEvent = world.events.find(
      (e) => e.type === 'contact-spawn' &&
        (e.payload as Record<string, unknown>).contactId === 'late',
    );
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent!.t).toBeCloseTo(0.2, 10);
  });

  it('caps at scenario.durationS', () => {
    const { runner } = loadScenario(miniScenario, 1);
    const count = stepScenario(runner, 0.5);
    expect(count).toBe(4);
    expect(runner.world.time).toBeCloseTo(0.4, 10);
  });

  it('regression: sequential calls respect remaining duration', () => {
    const { runner } = loadScenario(miniScenario, 1);
    const first = stepScenario(runner, 0.3);
    expect(first).toBe(3);
    expect(runner.world.time).toBeCloseTo(0.3, 10);

    const second = stepScenario(runner, 0.3);
    expect(second).toBe(1);
    expect(runner.world.time).toBeCloseTo(0.4, 10);

    const third = stepScenario(runner, 0.3);
    expect(third).toBe(0);
    expect(runner.world.time).toBeCloseTo(0.4, 10);
  });

  it('stops early on shipLost', () => {
    const { world, runner } = loadScenario(miniScenario, 1);
    world.weapons.shipLost = true;
    const count = stepScenario(runner, 0.3);
    expect(count).toBe(0);
  });

  it('does not trigger scenario events when using stepWorld standalone', () => {
    const { world } = loadScenario(miniScenario, 1);
    stepWorld(world, 0.3);
    const scenarioEvents = world.events.filter((e) => e.actor === 'scenario');
    expect(scenarioEvents.length).toBe(0);
  });

  it('crew stepped exactly once per step via runner.update', () => {
    const { world, runner } = loadScenario({
      ...miniScenario,
      contacts: miniScenario.contacts.map((contact) => ({ ...contact, spawnAtS: 0 })),
    }, 1);
    const spy = vi.spyOn(crewModule, 'stepCrew');
    try {
      stepScenario(runner, 0.3);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
    const crewAutoReports = world.events.filter(
      (e) => e.type === 'crew-report' && e.actor === 'crew-auto',
    );
    const scenarioReports = world.events.filter(
      (e) => e.type === 'crew-report' && e.actor === 'scenario',
    );
    expect(scenarioReports.length).toBe(1);
    expect(crewAutoReports.length).toBeGreaterThan(0);
  });
});

describe('deterministic Pk fireSam integration', () => {
  it('Pk=1 guarantees kill on stationary target at 10nm', () => {
    const cfg = deterministicWeaponsConfig(1);
    const contact = makeContact({ id: 'kill-target', position: { x: 0, y: 10 } });
    const world = makeWorld([contact], { weaponsConfig: cfg });
    const result = fireSam(world, 'kill-target', 'player');
    expect(result.ok).toBe(true);
    stepWorld(world, 25);
    const target = world.contactById('kill-target');
    expect(target!.alive).toBe(false);
    const killEvent = world.events.find(
      (e) => e.type === 'weapon_result' &&
        (e.payload as Record<string, unknown>).targetId === 'kill-target' &&
        (e.payload as Record<string, unknown>).killed === true,
    );
    expect(killEvent).toBeDefined();
  });

  it('Pk=0 guarantees no kill on stationary target at 10nm', () => {
    const cfg = deterministicWeaponsConfig(0);
    const contact = makeContact({ id: 'miss-target', position: { x: 0, y: 10 } });
    const world = makeWorld([contact], { weaponsConfig: cfg });
    const result = fireSam(world, 'miss-target', 'player');
    expect(result.ok).toBe(true);
    stepWorld(world, 25);
    const target = world.contactById('miss-target');
    expect(target!.alive).toBe(true);
    const missEvent = world.events.find(
      (e) => e.type === 'weapon_result' &&
        (e.payload as Record<string, unknown>).targetId === 'miss-target' &&
        (e.payload as Record<string, unknown>).killed === false,
    );
    expect(missEvent).toBeDefined();
  });

  it('config fields are exact after deterministicWeaponsConfig', () => {
    const cfg = deterministicWeaponsConfig(1);
    expect(cfg.sam.pkSalvoVsAircraft).toBe(1);
    expect(cfg.sam.pkPerMissileVsAscm).toBe(1);
    expect(cfg.gun.pkPerBurst).toBe(1);
    expect(cfg.ciws.pkPerMissile).toBe(1);
    expect(cfg.ascm.pHit).toBe(1);
    expect(cfg.ascm.pHitChaff).toBe(1);
    expect(cfg.sam.salvoSize).toBe(2);
    expect(cfg.sam.minRangeNm).toBe(3);
    expect(cfg.sam.maxRangeNm).toBe(40);
    expect(cfg.sam.speedKts).toBe(1800);
    expect(cfg.gun.maxRangeNm).toBe(9);
    expect(cfg.gun.burstS).toBe(10);
    expect(cfg.ciws.maxRangeNm).toBe(1.5);
    expect(cfg.ciws.roundsPerEngagement).toBe(100);
    expect(cfg.chaff.durationS).toBe(60);
    expect(cfg.ascm.damagePct).toBe(40);
    expect(cfg.ascm.arrivalRadiusNm).toBe(0.1);
    expect(cfg.ascm.turnRateDegPerSec).toBe(6);
  });
});
