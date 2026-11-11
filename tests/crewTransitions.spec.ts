import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { stepCrew } from '../src/sim/scenario/crew';
import { executeCommand } from '../src/sim/commands';
import type { RadarContact, OwnShip } from '../src/sim/types';

const OWN: OwnShip = { position:{x:0,y:0}, courseDeg:0, speedKts:0, hullPct:100,
  inventory:{sam:24,chaff:6,gunBursts:40,ciws:1000} };

function mk(o: Partial<RadarContact> = {}): RadarContact {
  return { id:'c', trackId:'S-07', domain:'surface', truth:'hostile',
    position:{x:0,y:6}, courseDeg:180, speedKts:5, altitudeFt:0,
    classification:'unknown',
    sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}},
    alive:true, history:[], ...o };
}

function w(contacts: RadarContact[]): World {
  return new World({ seed:1, ownShip:structuredClone(OWN), contacts });
}

function tick(world: World): void { world.step(0.1); stepCrew(world); }
function ticks(world: World, n: number): void { for(let i=0;i<n;i++) tick(world); }
function crewR(world: World) { return world.events.filter(e=>e.type==='crew-report'); }
function texts(world: World): string[] { return crewR(world).map(e=>(e.payload as any).text); }

describe('ESM transition not lost by cooldown', () => {
  it('search radar then fire control radar both emitted exactly once', () => {
    const c = mk({ domain:'air', trackId:'A-01', altitudeFt:15000, position:{x:0,y:40}, speedKts:420 });
    const world = w([c]);
    stepCrew(world);
    world.contactById('c')!.sensors.esm = { kind:'emitter', emitterType:'search radar' };
    ticks(world, 45);
    expect(texts(world).filter(t=>t.includes('search radar emissions detected')).length).toBe(1);
    world.contactById('c')!.sensors.esm = { kind:'emitter', emitterType:'fire control radar' };
    ticks(world, 45);
    expect(texts(world).filter(t=>t.includes('fire control radar emissions detected')).length).toBe(1);
    ticks(world, 100);
    expect(texts(world).filter(t=>t.includes('search radar emissions detected')).length).toBe(1);
    expect(texts(world).filter(t=>t.includes('fire control radar emissions detected')).length).toBe(1);
  });
});

describe('sensor value change within 0.1s emits new report', () => {
  const cases = [
    { label:'AIS', set:(c:RadarContact,v:string)=>{c.sensors.ais={kind:'vessel',name:'hidden vessel name',vesselType:v}}, first:'tanker', second:'cargo vessel', e1:'vessel type as tanker', e2:'vessel type as cargo vessel' },
    { label:'visual', set:(c:RadarContact,v:string)=>{c.sensors.visual={kind:'identified',description:v}}, first:'small craft', second:'patrol boat', e1:'visually identify a small craft', e2:'visually identify a patrol boat' },
    { label:'IFF', set:(c:RadarContact,v:string)=>{c.sensors.iff={kind:'mode3',code:v}}, first:'1111', second:'2222', e1:'IFF response received', e2:'IFF response received' },
  ];
  for (const tc of cases) {
    it(`${tc.label}: ${tc.first} then ${tc.second}`, () => {
      const c = mk({ domain:'air', trackId:'A-01', altitudeFt:15000, position:{x:0,y:40}, speedKts:420 });
      const world = w([c]);
      stepCrew(world);
      tc.set(world.contactById('c')!, tc.first);
      ticks(world, 45);
      expect(texts(world).filter(t=>t.includes(tc.e1)).length).toBe(1);
      tc.set(world.contactById('c')!, tc.second);
      ticks(world, 45);
      expect(texts(world).filter(t=>t.includes(tc.e2)).length).toBe(1);
    });
  }
});

describe('routine track motion', () => {
  it('5->20->40 changes do not generate feed messages', () => {
    const c = mk({ position:{x:0,y:6}, courseDeg:180, speedKts:5 });
    delete c.motion;
    const world = w([c]);
    stepCrew(world);
    const initialCount = texts(world).length;
    world.contactById('c')!.speedKts = 20;
    ticks(world, 45);
    world.contactById('c')!.speedKts = 40;
    ticks(world, 45);
    expect(texts(world)).toHaveLength(initialCount);
    expect(texts(world).join(' ')).not.toMatch(/speed|closing|turning|CPA/);
  });
});

describe('EW duplicate suppression does not block distinct change', () => {
  it('scripted EW suppresses same ESM but not different ESM', () => {
    const c = mk({ id:'c', trackId:'A-01', domain:'air', altitudeFt:15000, position:{x:0,y:40}, speedKts:420 });
    const world = w([c]);
    stepCrew(world);
    world.contactById('c')!.sensors.esm = { kind:'emitter', emitterType:'commercial weather radar' };
    world.logEvent('crew-report','scenario',{station:'EW',priority:'priority',text:'EW: A-01 emitting commercial weather radar.',contactId:'c'});
    stepCrew(world);
    ticks(world, 45);
    expect(texts(world).filter(t=>t.includes('commercial weather radar')).length).toBe(1);
    world.contactById('c')!.sensors.esm = { kind:'emitter', emitterType:'fire control radar' };
    ticks(world, 45);
    expect(texts(world).filter(t=>t.includes('fire control radar emissions detected')).length).toBe(1);
    ticks(world, 100);
    expect(texts(world).filter(t=>t.includes('fire control radar emissions detected')).length).toBe(1);
  });
});

describe('IFF command response does not duplicate automatic sensor info', () => {
  it('command_response sets announced so processSensorInfo skips', () => {
    const c = mk({ domain:'air', trackId:'A-01', altitudeFt:15000, position:{x:0,y:40}, speedKts:420,
      sensors:{iff:{kind:'mode3',code:'1111'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}},
      responses:{iff:{kind:'mode3',code:'1111'}} });
    const world = w([c]);
    stepCrew(world);
    executeCommand(world,{action:'iff_challenge',target:'c'},'player');
    ticks(world, 55);
    expect(texts(world).filter(t=>t.includes('IFF response received')).length).toBe(1); // Requested reply, without duplicate sensor chatter.
  });
});
