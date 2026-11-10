import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { stepCrew } from '../src/sim/scenario/crew';
import { launchAscms } from '../src/sim/weapons';
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

describe('crew initial contact', () => {
  it('routine report has bearing/range/speed', () => {
    const world = w([mk({ courseDeg: 90 })]);
    stepCrew(world);
    const t = texts(world);
    expect(t.length).toBe(1);
    expect(t[0]).toContain('bearing 000');
    expect(t[0]).toContain('range 6.0');
    expect(t[0]).toContain('speed 5');
    expect((crewR(world)[0].payload as any).priority).toBe('routine');
  });
  it('no repeat on 100 unchanged calls', () => {
    const world = w([mk({ courseDeg: 90 })]);
    stepCrew(world);
    ticks(world, 100);
    expect(crewR(world).length).toBe(1);
  });
});

describe('crew speed jump', () => {
  it('5->40 reported once after sweep, not before', () => {
    const world = w([mk()]);
    stepCrew(world);
    world.contactById('c')!.speedKts = 40;
    ticks(world, 30); // 3s, before sweep at 4s
    expect(texts(world).filter(t=>t.includes('speed change')).length).toBe(0);
    ticks(world, 15); // past 4s sweep
    const speedReports = texts(world).filter(t=>t.includes('speed change'));
    expect(speedReports.length).toBe(1);
    expect(speedReports[0]).toContain('SWC');
    expect((crewR(world).find(e=>(e.payload as any).text.includes('speed change'))!.payload as any).priority).toBe('priority');
    ticks(world, 50);
    expect(texts(world).filter(t=>t.includes('speed change')).length).toBe(1);
  });
});

describe('crew turn toward', () => {
  it('course 90->180 detected after sweep', () => {
    const c = mk({ courseDeg:90 });
    delete c.motion;
    const world = w([c]);
    stepCrew(world);
    world.contactById('c')!.courseDeg = 180;
    ticks(world, 45); // past 4s sweep
    const turnReports = texts(world).filter(t=>t.includes('turning toward'));
    expect(turnReports.length).toBe(1);
    expect(turnReports[0]).toContain('SWC');
  });
});

describe('crew closing CPA and visual ETA', () => {
  it('CPA 0 and ETA 270s to 3nm', () => {
    const c = mk({ speedKts:40 });
    delete c.motion;
    const world = w([c]);
    stepCrew(world);
    ticks(world, 45);
    const cpaReports = texts(world).filter(t=>t.includes('closing'));
    expect(cpaReports.length).toBe(1);
    expect(cpaReports[0]).toContain('CPA 0.0');
    const visReports = texts(world).filter(t=>t.includes('est. visual'));
    expect(visReports.length).toBe(1);
    expect(visReports[0]).toContain('4:30'); // 270s = 4:30
  });
});

describe('crew sensor info once', () => {
  it('AIS/ESM/visual each reported once', () => {
    const c = mk();
    const world = w([c]);
    stepCrew(world);
    const contact = world.contactById('c')!;
    contact.sensors.ais = { kind:'vessel', name:'TEST', vesselType:'fishing' };
    contact.sensors.esm = { kind:'emitter', emitterType:'search radar' };
    contact.sensors.visual = { kind:'identified', description:'small craft' };
    ticks(world, 45);
    const t = texts(world);
    expect(t.filter(x=>x.includes('AIS TEST')).length).toBe(1);
    expect(t.filter(x=>x.includes('emitting search radar')).length).toBe(1);
    expect(t.filter(x=>x.includes('identified as small craft')).length).toBe(1);
    ticks(world, 50);
    expect(t.filter(x=>x.includes('AIS TEST')).length).toBe(1);
  });
});

describe('crew IFF response', () => {
  it('IFF report after 5s command_response', () => {
    const c = mk({ domain:'air', trackId:'A-01', altitudeFt:15000,
      responses:{iff:{kind:'mode3',code:'7700'}} });
    const world = w([c]);
    stepCrew(world);
    executeCommand(world, {action:'iff_challenge', target:'c'}, 'player');
    ticks(world, 45); // 4.5s, before 5s response
    expect(texts(world).filter(t=>t.includes('Mode 3')).length).toBe(0);
    ticks(world, 10); // past 5s
    const iffReports = texts(world).filter(t=>t.includes('Mode 3'));
    expect(iffReports.length).toBe(1);
    expect(iffReports[0]).toContain('TAO-Air');
  });
});

describe('crew invisible no flash', () => {
  it('air at 100nm outside range produces no track', () => {
    const c = mk({ domain:'air', trackId:'A-99', position:{x:0,y:100}, altitudeFt:10000 });
    const world = w([c]);
    stepCrew(world);
    ticks(world, 50);
    expect(texts(world).filter(t=>t.includes('A-99')).length).toBe(0);
    expect(texts(world).filter(t=>t.includes('VAMPIRE')).length).toBe(0);
  });
  it('own SAM produces no VAMPIRE', () => {
    const c = mk({ domain:'air', trackId:'A-01', position:{x:0,y:10}, altitudeFt:15000 });
    const world = w([c]);
    stepCrew(world);
    executeCommand(world, {action:'engage_sam', target:'c'}, 'player');
    ticks(world, 50);
    expect(texts(world).filter(t=>t.includes('VAMPIRE')).length).toBe(0);
  });
});

describe('crew missile FLASH', () => {
  it('2 ASCMs at range 5 give FLASH bearing 000 two', () => {
    const world = w([]);
    stepCrew(world);
    launchAscms(world, {count:2, weapon:'ASCM', speedKts:600, altitudeFt:50,
      launcherId:'r', trackId:'A-01', t:0, position:{x:0,y:5}, rangeNm:5, bearingDeg:0});
    ticks(world, 45); // past sweep
    const flash = crewR(world).filter(e=>(e.payload as any).priority==='flash');
    expect(flash.length).toBe(1);
    const ft = (flash[0].payload as any).text;
    expect(ft).toContain('VAMPIRE');
    expect(ft).toContain('bearing 000');
    expect(ft).toContain('two');
  });
});

describe('crew weapon results', () => {
  it('Birds away / Splash / Miss', () => {
    const world = w([]);
    stepCrew(world);
    world.logEvent('weapon_fired','player',{weapon:'sam',targetId:'x',targetTrackId:'A-01'});
    stepCrew(world);
    world.logEvent('weapon_result','player',{weapon:'sam',targetId:'x',killed:true});
    stepCrew(world);
    world.logEvent('weapon_result','player',{weapon:'sam',targetId:'y',killed:false});
    stepCrew(world);
    const t = texts(world);
    expect(t.some(x=>x.includes('Birds away'))).toBe(true);
    expect(t.some(x=>x.includes('Splash one'))).toBe(true);
    expect(t.some(x=>x.includes('Miss'))).toBe(true);
  });
});

describe('crew contact_destroyed no leak', () => {
  it('no casualty/truth in crew reports', () => {
    const world = w([]);
    stepCrew(world);
    world.logEvent('contact_destroyed','player',{contactId:'x',trackId:'A-09',domain:'air',truth:'civil',casualties:212,weapon:'sam'});
    stepCrew(world);
    const all = texts(world).join(' ');
    expect(all).not.toContain('212');
    expect(all).not.toContain('civil');
    expect(all).not.toContain('casualt');
  });
});

describe('crew damage FLASH', () => {
  it('missile_impact hit hull 60 -> Bridge FLASH', () => {
    const world = w([]);
    stepCrew(world);
    world.logEvent('missile_impact','scenario',{missileId:'m',launcherId:'r',hit:true,chaffActive:false,hullPct:60});
    stepCrew(world);
    const flash = crewR(world).filter(e=>(e.payload as any).priority==='flash');
    expect(flash.length).toBe(1);
    expect((flash[0].payload as any).text).toContain('Hull 60');
    expect((flash[0].payload as any).station).toBe('Bridge');
  });
});

describe('crew warnings', () => {
  it('ignored -> Radio PRIORITY, complied -> Radio ROUTINE', () => {
    const world = w([]);
    stepCrew(world);
    world.logEvent('command_response','player',{action:'radio_warning',target:'c',trackId:'S-07',outcome:'ignored'});
    stepCrew(world);
    world.logEvent('command_response','player',{action:'radio_warning',target:'d',trackId:'S-08',outcome:'complied'});
    stepCrew(world);
    const ignored = crewR(world).find(e=>(e.payload as any).text.includes('ignored warning'));
    const complied = crewR(world).find(e=>(e.payload as any).text.includes('acknowledged'));
    expect((ignored!.payload as any).priority).toBe('priority');
    expect((complied!.payload as any).priority).toBe('routine');
    expect((ignored!.payload as any).station).toBe('Radio');
  });
});

describe('crew truth-independent', () => {
  it('same sensors different truth/persons -> identical texts', () => {
    const base = { domain:'surface' as const, trackId:'S-07', position:{x:0,y:6},
      courseDeg:180, speedKts:5, altitudeFt:0, classification:'unknown' as const,
      sensors:{iff:{kind:'none' as const},ais:{kind:'none' as const},esm:{kind:'none' as const},visual:{kind:'none' as const}},
      alive:true, history:[] as any[] };
    const c1 = mk({ ...base, truth:'civil', personsAboard:212 });
    const c2 = mk({ ...base, truth:'hostile', personsAboard:0 });
    const w1 = w([c1]); const w2 = w([c2]);
    stepCrew(w1); stepCrew(w2);
    ticks(w1, 50); ticks(w2, 50);
    expect(texts(w1)).toEqual(texts(w2));
  });
});

describe('crew A9 no early leak', () => {
  it('no civil/airliner/212/SECRET until ESM set', () => {
    const c = mk({ id:'a9', trackId:'A-09', domain:'air', truth:'civil',
      personsAboard:212, visualDescription:'AIRLINER_SECRET', altitudeFt:15000,
      position:{x:0,y:60}, speedKts:420,
      sensors:{iff:{kind:'mode3',code:'4217'},ais:{kind:'none'},esm:{kind:'none'},visual:{kind:'none'}} });
    const world = w([c]);
    stepCrew(world);
    ticks(world, 50);
    const all = texts(world).join(' ');
    expect(all).not.toContain('civil');
    expect(all).not.toContain('AIRLINER');
    expect(all).not.toContain('212');
    expect(all).not.toContain('SECRET');
    world.contactById('a9')!.sensors.esm = { kind:'emitter', emitterType:'commercial weather radar' };
    ticks(world, 45);
    const esmTexts = texts(world).filter(t=>t.includes('commercial weather radar'));
    expect(esmTexts.length).toBe(1);
    const allAfter = texts(world).join(' ');
    expect(allAfter).not.toContain('civil');
    expect(allAfter).not.toContain('212');
    expect(allAfter).not.toContain('SECRET');
  });
});

describe('crew EW duplicate suppression', () => {
  it('scripted EW report suppresses sensor-triggered duplicate', () => {
    const c = mk({ id:'a9', trackId:'A-09', domain:'air', altitudeFt:15000, position:{x:0,y:40}, speedKts:420 });
    const world = w([c]);
    stepCrew(world);
    world.logEvent('crew-report','scenario',{station:'EW',priority:'priority',text:'EW: A-09 emitting commercial weather radar.',contactId:'a9'});
    stepCrew(world);
    world.contactById('a9')!.sensors.esm = { kind:'emitter', emitterType:'commercial weather radar' };
    ticks(world, 45);
    const ewReports = texts(world).filter(t=>t.includes('emitting commercial weather radar'));
    expect(ewReports.length).toBe(1);
  });
});
