import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { stepCrew } from '../src/sim/scenario/crew';
import { launchAscms } from '../src/sim/weapons';
import { executeCommand } from '../src/sim/commands';
import { formatCrewTimestamp } from '../src/ui/crewFeed';
import { WEAPONS_CONFIG } from '../src/sim/scenario/weaponsConfig';
import type { RadarContact, OwnShip } from '../src/sim/types';

const OWN: OwnShip = { position:{x:0,y:0}, courseDeg:0, speedKts:0, hullPct:100,
  inventory:{sam:24,chaff:6,gunBursts:40,ciws:1000} };
const CFG = { ...WEAPONS_CONFIG, ciws:{...WEAPONS_CONFIG.ciws,pkPerMissile:0},
  ascm:{...WEAPONS_CONFIG.ascm,pHit:0,pHitChaff:0} };

function mk(o: Partial<RadarContact> = {}): RadarContact {
  return { id:'c', trackId:'S-07', domain:'surface', truth:'hostile',
    position:{x:0,y:6}, courseDeg:180, speedKts:0, altitudeFt:0,
    classification:'unknown',
    sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}},
    alive:true, history:[], ...o };
}
function w(contacts: RadarContact[]): World {
  return new World({ seed:1, ownShip:structuredClone(OWN), contacts, weaponsConfig:CFG });
}
function tick(world: World): void { world.step(0.1); stepCrew(world); }
function ticks(world: World, n: number): void { for(let i=0;i<n;i++) tick(world); }
function crewR(world: World) { return world.events.filter(e=>e.type==='crew-report'); }
function texts(world: World): string[] { return crewR(world).map(e=>(e.payload as any).text); }
function cmds(world: World) { return world.events.filter(e=>e.type==='command'); }

describe('initial sensor values on first stepCrew', () => {
  it('surface AIS emits SWC routine and classify neutral crew-auto', () => {
    const c = mk({ sensors:{iff:{kind:'none'},ais:{kind:'vessel',name:'MT X',vesselType:'tanker'},esm:{kind:'none'},visual:{kind:'none'}} });
    const world = w([c]);
    stepCrew(world);
    expect(texts(world).some(t=>t.includes('AIS reports the vessel type as tanker'))).toBe(true);
    const cls = cmds(world).find(e=>(e.payload as any).command?.action==='classify');
    expect(cls).toBeDefined();
    expect(cls!.actor).toBe('crew-auto');
    expect((cls!.payload as any).command.classification).toBe('neutral');
    expect(world.contactById('c')!.classification).toBe('neutral');
  });
  it('air IFF mode4 emits TAO-Air and classify friendly crew-auto', () => {
    const c = mk({ domain:'air', trackId:'A-01', altitudeFt:15000,
      sensors:{iff:{kind:'mode4'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}} });
    const world = w([c]);
    stepCrew(world);
    expect(texts(world).some(t=>t.includes('IFF identifies a friendly aircraft'))).toBe(true);
    const cls = cmds(world).find(e=>(e.payload as any).command?.action==='classify');
    expect(cls!.actor).toBe('crew-auto');
    expect((cls!.payload as any).command.classification).toBe('friendly');
  });
  it('initial visual description emits Lookouts', () => {
    const c = mk({ sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'identified',description:'small craft'}} });
    const world = w([c]);
    stepCrew(world);
    expect(texts(world).some(t=>t.includes('visually identify a small craft'))).toBe(true);
  });
  it('initial ESM emits EW', () => {
    const c = mk({ sensors:{iff:{kind:'none'},ais:{kind:'none'},esm:{kind:'emitter',emitterType:'search radar'},visual:{kind:'none'}} });
    const world = w([c]);
    stepCrew(world);
    expect(texts(world).some(t=>t.includes('search radar emissions detected'))).toBe(true);
  });
  it('player hostile on AIS contact stays hostile', () => {
    const c = mk({ sensors:{iff:{kind:'none'},ais:{kind:'vessel',name:'MT X',vesselType:'tanker'},esm:{kind:'none'},visual:{kind:'none'}} });
    const world = w([c]);
    executeCommand(world,{action:'classify',target:'c',classification:'hostile'},'player');
    stepCrew(world);
    expect(world.contactById('c')!.classification).toBe('hostile');
  });
});

describe('launcher association', () => {
  it('only visible missile classifies its launcher hostile', () => {
    const l1 = mk({ id:'l1', trackId:'A-10', domain:'air', altitudeFt:10000, position:{x:0,y:10}, classification:'neutral' });
    const l2 = mk({ id:'l2', trackId:'A-11', domain:'air', altitudeFt:10000, position:{x:0,y:-10} });
    const world = w([l1,l2]);
    stepCrew(world);
    launchAscms(world,{count:1,weapon:'ASCM',speedKts:0,altitudeFt:50,launcherId:'l1',trackId:'A-10',t:0,position:{x:0,y:5},rangeNm:5,bearingDeg:0});
    launchAscms(world,{count:1,weapon:'ASCM',speedKts:0,altitudeFt:50,launcherId:'l2',trackId:'A-11',t:0,position:{x:0,y:50},rangeNm:50,bearingDeg:0});
    ticks(world,45);
    expect(world.contactById('l1')!.classification).toBe('hostile');
    expect(world.contactById('l2')!.classification).toBe('unknown');
    expect(texts(world).some(t=>t.includes('VAMPIRE'))).toBe(true);
  });
  it('moving hidden missile into range classifies its launcher', () => {
    const l2 = mk({ id:'l2', trackId:'A-11', domain:'air', altitudeFt:10000, position:{x:0,y:-10} });
    const world = w([l2]);
    stepCrew(world);
    launchAscms(world,{count:1,weapon:'ASCM',speedKts:0,altitudeFt:50,launcherId:'l2',trackId:'A-11',t:0,position:{x:0,y:50},rangeNm:50,bearingDeg:0});
    ticks(world,45);
    expect(world.contactById('l2')!.classification).toBe('unknown');
    const m = world.contacts.find(c=>c.id.startsWith('ascm'));
    expect(m).toBeDefined();
    m!.position = {x:0,y:5};
    ticks(world,45);
    expect(world.contactById('l2')!.classification).toBe('hostile');
  });
});

describe('missiles outside range never FLASH', () => {
  it('missile at 50nm speed 0 no FLASH after 4s', () => {
    const world = w([]);
    stepCrew(world);
    launchAscms(world,{count:1,weapon:'ASCM',speedKts:0,altitudeFt:50,launcherId:'r',trackId:'A-01',t:0,position:{x:0,y:50},rangeNm:50,bearingDeg:0});
    ticks(world,45);
    expect(texts(world).some(t=>t.includes('VAMPIRE'))).toBe(false);
  });
});

describe('distinct weapon_result same target', () => {
  it('two results for same target both reported, gun uses SWC', () => {
    const world = w([]);
    stepCrew(world);
    world.logEvent('weapon_result','player',{weapon:'gun',targetId:'x',killed:false});
    stepCrew(world);
    world.logEvent('weapon_result','player',{weapon:'gun',targetId:'x',killed:true});
    stepCrew(world);
    const gunReports = crewR(world).filter(e=>(e.payload as any).station==='SWC');
    expect(gunReports.length).toBe(2);
    const all = texts(world).join(' ');
    expect(all).not.toContain('truth');
    expect(all).not.toContain('casualt');
  });
});

describe('formatCrewTimestamp', () => {
  it('pure function formats correctly', () => {
    expect(formatCrewTimestamp(0)).toBe('T+00:00');
    expect(formatCrewTimestamp(61.9)).toBe('T+01:01');
    expect(formatCrewTimestamp(900)).toBe('T+15:00');
  });
});
