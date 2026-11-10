import { describe, expect, it } from 'vitest';
import { loadScenario } from '../src/sim/scenario/scenario';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { stepScenario } from './helpers/sim';
import { createSensorState, sweep, visibleTracks } from '../src/sim/sensors';
import { mulberry32 } from '../src/sim/rng';
import type { Contact, SensorTrack } from '../src/sim/types';

function _typeChecks(): void {
  const t = null as unknown as SensorTrack;
  // @ts-expect-error truth not on SensorTrack
  t.truth;
  // @ts-expect-error personsAboard not on SensorTrack
  t.personsAboard;
  // @ts-expect-error rcs not on SensorTrack
  t.rcs;
  // @ts-expect-error pDetect not on SensorTrack
  t.pDetect;
  // @ts-expect-error size not on SensorTrack
  t.size;
  // @ts-expect-error motion not on SensorTrack
  t.motion;
  // @ts-expect-error responses not on SensorTrack
  t.responses;
  // @ts-expect-error visualDescription not on SensorTrack
  t.visualDescription;
}

const MANDATORY = ['id','trackId','domain','position','courseDeg','speedKts','altitudeFt','classification','sensors','alive','history','faded','firstDetectedAt','lastSeen','ageS'];
const FORBIDDEN = ['truth','personsAboard','rcs','pDetect','size','motion','responses','visualDescription'];

function mkContact(o: Partial<Contact> = {}): Contact {
  return {
    id:'c1',trackId:'A-01',domain:'air',truth:'hostile',
    position:{x:0,y:10},courseDeg:180,speedKts:100,altitudeFt:5000,
    classification:'unknown',
    sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}},
    alive:true,history:[],
    rcs:'normal',pDetect:1,size:'small',personsAboard:99,
    motion:{behavior:{kind:'straight'}},
    responses:{radio:'ignore'},
    visualDescription:'secret',
    ...o,
  };
}

const OWN = { position:{x:0,y:0},courseDeg:0,speedKts:0,hullPct:100,inventory:{sam:0,chaff:0,gunBursts:0,ciws:0} };

function detect(c: Contact): SensorTrack {
  const rng = mulberry32(1);
  const state = createSensorState();
  sweep(state, [c], OWN, 0, rng);
  const tracks = visibleTracks(state, [c], 0);
  expect(tracks).toHaveLength(1);
  return tracks[0];
}

describe('SensorTrack projection', () => {
  it('top-level keys exactly match allowlist (ownMissile absent unless true)', () => {
    const t = detect(mkContact());
    expect(Object.keys(t).sort()).toEqual([...MANDATORY].sort());
    expect('ownMissile' in t).toBe(false);
  });

  it('ownMissile present when true', () => {
    const t = detect(mkContact({ ownMissile: true }));
    expect(t.ownMissile).toBe(true);
  });

  it('forbidden keys absent at runtime', () => {
    const t = detect(mkContact());
    for (const fk of FORBIDDEN) expect(fk in t).toBe(false);
  });

  it('poisoned extra properties do not survive projection', () => {
    const c = mkContact();
    Object.assign(c.position, { hidden: 42 });
    Object.assign(c.sensors.iff, { hidden: 42 });
    Object.assign(c.sensors.ais, { hidden: 42 });
    Object.assign(c.sensors.esm, { hidden: 42 });
    Object.assign(c.sensors.visual, { hidden: 42 });
    c.history.push(Object.assign({ x: 1, y: 1 }, { hidden: 99 }));
    const t = detect(c);
    expect('hidden' in t.position).toBe(false);
    expect('hidden' in t.sensors.iff).toBe(false);
    expect('hidden' in t.sensors.ais).toBe(false);
    expect('hidden' in t.sensors.esm).toBe(false);
    expect('hidden' in t.sensors.visual).toBe(false);
    for (const h of t.history) expect('hidden' in h).toBe(false);
  });

  it('clone independence: mutation does not leak to Contact', () => {
    const c = mkContact();
    const t = detect(c);
    t.position.x = 999;
    t.sensors.iff = { kind: 'mode4' };
    t.history.push({ x: 1, y: 1 });
    expect(c.position.x).toBe(0);
    expect(c.sensors.iff).toEqual({ kind: 'none' });
    expect(c.history).toHaveLength(0);
  });

  it('nested sensors expose only allowed variant discriminant keys', () => {
    const c = mkContact({
      sensors: {
        iff: { kind: 'mode3', code: '1234' },
        ais: { kind: 'vessel', name: 'X', vesselType: 'tanker' },
        esm: { kind: 'emitter', emitterType: 'radar' },
        visual: { kind: 'none' },
      },
    });
    const s = detect(c).sensors;
    expect(Object.keys(s.iff).sort()).toEqual(['code','kind']);
    expect(s.iff).toEqual({ kind: 'mode3', code: '1234' });
    expect(Object.keys(s.ais).sort()).toEqual(['kind','name','vesselType']);
    expect(s.ais).toEqual({ kind: 'vessel', name: 'X', vesselType: 'tanker' });
    expect(Object.keys(s.esm).sort()).toEqual(['emitterType','kind']);
    expect(s.esm).toEqual({ kind: 'emitter', emitterType: 'radar' });
    expect(Object.keys(s.visual)).toEqual(['kind']);
    expect(s.visual).toEqual({ kind: 'none' });
  });

  it('visual fallback from contact.sensors.visual when track not latched', () => {
    const c = mkContact({
      domain: 'surface', size: 'small', position: { x: 0, y: 5 },
      sensors: { iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'identified',description:'Vessel'} },
      visualDescription: 'secret',
    });
    const t = detect(c);
    expect(t.sensors.visual).toEqual({ kind: 'identified', description: 'Vessel' });
    expect('visualDescription' in t).toBe(false);
  });

  it('latched visual persists out-of-range; hidden visualDescription never shown', () => {
    const rng = mulberry32(1);
    const state = createSensorState();
    const c = mkContact({ domain: 'surface', size: 'small', position: { x: 0, y: 2 }, visualDescription: 'Dhow' });
    sweep(state, [c], OWN, 0, rng);
    expect(visibleTracks(state, [c], 0)[0].sensors.visual).toEqual({ kind: 'identified', description: 'Dhow' });
    c.position = { x: 0, y: 50 };
    sweep(state, [c], OWN, 4, rng);
    const t = visibleTracks(state, [c], 4)[0];
    expect(t.sensors.visual).toEqual({ kind: 'identified', description: 'Dhow' });
    expect('visualDescription' in t).toBe(false);
  });
});

describe('Strait scenario: no truth leakage', () => {
  for (const seed of [42, 137, 2024]) {
    it(`seed ${seed}: forbidden keys absent across 900s`, () => {
      const { world, runner } = loadScenario(STRAIT_TRANSIT, seed);
      for (let t = 0; t < 900; t += 10) {
        stepScenario(runner, 10);
        for (const track of world.visibleTracks()) {
          for (const fk of FORBIDDEN) expect(fk in track).toBe(false);
        }
      }
    });
  }

  it('A-09: no civil/212 before ESM confirmation; no persons/casualty ever', () => {
    const { world, runner } = loadScenario(STRAIT_TRANSIT, 42);
    let esmConfirmed = false;
    for (let t = 0; t < 900; t += 10) {
      stepScenario(runner, 10);
      const a9 = world.visibleTracks().find(tr => tr.trackId === 'A-09');
      if (!a9) continue;
      const json = JSON.stringify(a9).toLowerCase();
      if (a9.sensors.esm.kind === 'emitter') esmConfirmed = true;
      if (!esmConfirmed) {
        expect(json).not.toContain('civil');
        expect(JSON.stringify(a9.sensors)).not.toContain('212');
      }
      expect(json).not.toContain('personsaboard');
      expect(json).not.toContain('casualty');
    }
  });
});
