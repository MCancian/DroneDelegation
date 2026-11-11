import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { STEP_S } from '../src/sim/clock';
import { executeCommand } from '../src/sim/commands';
import { buildContact } from '../src/sim/scenario/scenario';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';
import { WEAPONS_CONFIG } from '../src/sim/scenario/weaponsConfig';
import { launchAscms } from '../src/sim/weapons';
import { sweep } from '../src/sim/sensors';
import { mulberry32 } from '../src/sim/rng';
import type { RadarContact, OwnShip } from '../src/sim/types';

const OWN: OwnShip = { position:{x:0,y:0}, courseDeg:0, speedKts:0, hullPct:100,
  inventory:{sam:24,chaff:6,gunBursts:40,ciws:1000} };
function mk(o: Partial<RadarContact> = {}): RadarContact {
  return { id:'c', trackId:'A-01', domain:'air', truth:'hostile',
    position:{x:0,y:10}, courseDeg:180, speedKts:0, altitudeFt:15000,
    classification:'unknown',
    sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}},
    alive:true, history:[], ...o };
}
function w(contacts: RadarContact[], cfg?: typeof WEAPONS_CONFIG) {
  return new World({ seed:1, ownShip:structuredClone(OWN), contacts, weaponsConfig:cfg });
}
function step(world: World, s: number) { for(let i=0;i<Math.round(s/STEP_S);i++) world.step(STEP_S); }
function resp(world: World) { return world.events.filter(e=>e.type==='command_response'); }
function cmds(world: World) { return world.events.filter(e=>e.type==='command'); }

describe('IFF challenge', () => {
  it('mode4 hidden until 5s then revealed', () => {
    const c = mk({ responses:{iff:{kind:'mode4'}} });
    const world = w([c]);
    executeCommand(world,{action:'iff_challenge',target:'c'},'player');
    step(world, 4.9);
    expect(world.contactById('c')!.sensors.iff.kind).toBe('none');
    step(world, 0.1);
    expect(world.contactById('c')!.sensors.iff).toEqual({kind:'mode4'});
  });
  it('no configured iff falls back to existing mode3', () => {
    const c = mk({ sensors:{iff:{kind:'mode3',code:'1234'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}} });
    const world = w([c]);
    executeCommand(world,{action:'iff_challenge',target:'c'},'player');
    step(world, 5.1);
    expect((resp(world)[0].payload as any).iff).toEqual({kind:'mode3',code:'1234'});
  });
  it('duplicate pending rejected', () => {
    const c = mk({ responses:{iff:{kind:'mode4'}} });
    const world = w([c]);
    expect(executeCommand(world,{action:'iff_challenge',target:'c'},'player').ok).toBe(true);
    expect(executeCommand(world,{action:'iff_challenge',target:'c'},'player').ok).toBe(false);
  });
  it('delayed actor ai-chat preserved', () => {
    const c = mk({ responses:{iff:{kind:'mode4'}} });
    const world = w([c]);
    executeCommand(world,{action:'iff_challenge',target:'c'},'ai-chat');
    step(world, 5.1);
    expect(resp(world)[0].actor).toBe('ai-chat');
  });
  it('dead target no response', () => {
    const c = mk({ responses:{iff:{kind:'mode4'}} });
    const world = w([c]);
    executeCommand(world,{action:'iff_challenge',target:'c'},'player');
    world.contactById('c')!.alive = false;
    step(world, 5.1);
    expect(resp(world).length).toBe(0);
  });
});
describe('Hail', () => {
  it('civil with AIS answers', () => {
    const c = mk({ domain:'surface', trackId:'S-01', truth:'civil',
      sensors:{iff:{kind:'none'},ais:{kind:'vessel',name:'X',vesselType:'t'},esm:{kind:'none'},visual:{kind:'none'}},
      responses:{hail:'answer'} });
    const world = w([c]);
    executeCommand(world,{action:'hail',target:'c'},'player');
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('answered');
  });
  it('hostile ignores', () => {
    const c = mk({ domain:'surface', trackId:'S-02', truth:'hostile', responses:{hail:'ignore'} });
    const world = w([c]);
    executeCommand(world,{action:'hail',target:'c'},'player');
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('ignored');
  });
});
describe('Illuminate', () => {
  it('civil turn-away', () => {
    const c = mk({ truth:'civil', responses:{illuminate:'turn-away'} });
    const world = w([c]);
    executeCommand(world,{action:'illuminate',target:'c'},'player');
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('complied');
    expect(world.contactById('c')!.motion?.behavior.kind).toBe('turnAway');
  });
  it('hostile unchanged', () => {
    const c = mk({ truth:'hostile', responses:{illuminate:'ignore'} });
    const world = w([c]);
    executeCommand(world,{action:'illuminate',target:'c'},'player');
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('ignored');
    expect(world.contactById('c')!.motion).toBeUndefined();
    expect(world.contactById('c')!.courseDeg).toBe(180);
  });
});
describe('Warning shots', () => {
  it('civil turn-away speed<=5 consumes 1', () => {
    const c = mk({ domain:'surface', trackId:'S-01', truth:'civil',
      position:{x:0,y:5}, speedKts:12, responses:{warningShots:'turn-away'} });
    const world = w([c]);
    const before = world.ownShip.inventory.gunBursts;
    executeCommand(world,{action:'warning_shots',target:'c'},'player');
    expect(world.ownShip.inventory.gunBursts).toBe(before-1);
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('complied');
    expect(world.contactById('c')!.speedKts).toBeLessThanOrEqual(5);
  });
  it('hostile unchanged', () => {
    const c = mk({ domain:'surface', trackId:'S-02', truth:'hostile',
      position:{x:0,y:5}, speedKts:40, responses:{warningShots:'ignore'} });
    const world = w([c]);
    executeCommand(world,{action:'warning_shots',target:'c'},'player');
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('ignored');
    expect(world.contactById('c')!.speedKts).toBe(40);
  });
});
describe('A-9 radio by range', () => {
  const a9Def = STRAIT_TRANSIT.contacts.find(c=>c.id==='a9')!;
  it('ignored at 29nm complied at 27nm', () => {
    const c29 = buildContact(a9Def, OWN); c29.position={x:0,y:29}; c29.speedKts=0; delete c29.motion;
    const w29 = w([c29]);
    executeCommand(w29,{action:'radio_warning',target:c29.id},'player');
    step(w29, 5.1);
    expect((resp(w29)[0].payload as any).outcome).toBe('ignored');
    const c27 = buildContact(a9Def, OWN); c27.position={x:0,y:27}; c27.speedKts=0; delete c27.motion;
    const w27 = w([c27]);
    executeCommand(w27,{action:'radio_warning',target:c27.id},'player');
    step(w27, 5.1);
    expect((resp(w27)[0].payload as any).outcome).toBe('complied');
  });
  it('issue at 29 move to 27 before 5s remains ignored', () => {
    const c = buildContact(a9Def, OWN); c.position={x:0,y:29}; c.speedKts=0; delete c.motion;
    const world = w([c]);
    executeCommand(world,{action:'radio_warning',target:c.id},'player');
    world.contactById(c.id)!.position={x:0,y:27};
    step(world, 5.1);
    expect((resp(world)[0].payload as any).outcome).toBe('ignored');
  });
});
describe('Sensor drop', () => {
  it('undetected before response discards pending', () => {
    const c = mk({ responses:{illuminate:'turn-away'} });
    const world = w([c]);
    executeCommand(world,{action:'illuminate',target:'c'},'player');
    step(world, 4);
    world.trackFor('c')!.detected = false;
    step(world, 1.1);
    expect(resp(world).length).toBe(0);
  });
});
describe('Truth-independent', () => {
  it('same flags different truth same outcome no hidden strings', () => {
    const ais = {iff:{kind:'none' as const},ais:{kind:'vessel' as const,name:'X',vesselType:'t'},esm:{kind:'none' as const},visual:{kind:'none' as const}};
    const c1 = mk({ domain:'surface', trackId:'S-01', truth:'civil', sensors:ais, responses:{hail:'answer'} });
    const c2 = mk({ domain:'surface', trackId:'S-02', truth:'hostile', sensors:ais, responses:{hail:'answer'} });
    const w1 = w([c1]); const w2 = w([c2]);
    executeCommand(w1,{action:'hail',target:'c'},'player');
    executeCommand(w2,{action:'hail',target:'c'},'player');
    step(w1,5.1); step(w2,5.1);
    const p1 = resp(w1)[0].payload as any;
    const p2 = resp(w2)[0].payload as any;
    expect(p1.outcome).toBe(p2.outcome);
    expect(JSON.stringify(p1)).not.toContain('212');
    expect(JSON.stringify(p1)).not.toContain('truth');
  });
});
describe('Auto defense', () => {
  it('ASCM at 1nm triggers chaff+ciws crew-auto no repeat', () => {
    const cfg = {...WEAPONS_CONFIG, ciws:{...WEAPONS_CONFIG.ciws, pkPerMissile:0}};
    const world = w([], cfg);
    executeCommand(world, { action: 'set_point_defense', mode: 'auto' }, 'player');
    expect(world.weapons.config.ciws.pkPerMissile).toBe(0);
    launchAscms(world, {count:1,weapon:'ASCM',speedKts:600,altitudeFt:50,
      launcherId:'r',trackId:'A-01',t:0,position:{x:0,y:1},rangeNm:1,bearingDeg:0});
    step(world, 4.2);
    const auto = cmds(world).filter(e=>e.actor==='crew-auto');
    expect(auto.length).toBeGreaterThanOrEqual(2);
    const ciwsN = auto.filter(e=>(e.payload as any).command?.action==='ciws').length;
    step(world, 0.2);
    expect(cmds(world).filter(e=>e.actor==='crew-auto'&&(e.payload as any).command?.action==='ciws').length).toBe(ciwsN);
  });
});
describe('CIWS range boundary', () => {
  const cfg = {...WEAPONS_CONFIG, ciws:{...WEAPONS_CONFIG.ciws, pkPerMissile:0}};
  for (const [rangeNm, accepted] of [[1.5, true], [1.6, false]] as [number, boolean][]) {
    it(`${rangeNm}nm ${accepted ? 'accepted' : 'rejected'}`, () => {
      const world = w([], cfg);
      world.weapons.pointDefense = 'manual';
      launchAscms(world, {count:1,weapon:'ASCM',speedKts:0,altitudeFt:50,
        launcherId:'r',trackId:'M-01',t:0,position:{x:0,y:rangeNm},rangeNm,bearingDeg:0});
      sweep(world.sensors, world.contacts, world.ownShip, world.time, mulberry32(1), world.sensorConfig);
      const before = world.ownShip.inventory.ciws;
      const r = executeCommand(world, {action:'ciws', target:'ascm-1'}, 'player');
      expect(r.ok).toBe(accepted);
      if (accepted) {
        expect(world.ownShip.inventory.ciws).toBe(before - 100);
        const r2 = executeCommand(world, {action:'ciws', target:'ascm-1'}, 'player');
        expect(r2.ok).toBe(false);
        expect((r2 as any).error).toContain('already engaged');
      } else {
        expect(world.ownShip.inventory.ciws).toBe(before);
      }
    });
  }
});
