import { describe, it, expect } from 'vitest';
import { GameClock, STEP_S } from '../src/sim/clock';
import { World } from '../src/sim/world';
import { executeCommand } from '../src/sim/commands';
import { launchAscms } from '../src/sim/weapons';
import { WEAPONS_CONFIG } from '../src/sim/scenario/weaponsConfig';
import { runScenario } from '../src/sim/scenario/scenario';
import type { Scenario } from '../src/sim/scenario/scenario';
import type { OwnShip } from '../src/sim/types';

const OWN: OwnShip = { position:{x:0,y:0}, courseDeg:0, speedKts:0, hullPct:100,
  inventory:{sam:24,chaff:6,gunBursts:40,ciws:1000} };

function cfg(pHit:number, pHitChaff:number) {
  return { ...WEAPONS_CONFIG, ascm:{...WEAPONS_CONFIG.ascm, pHit, pHitChaff} };
}

describe('M3 end conditions', () => {
  it('finish inside onStep stops catchup immediately', () => {
    const world = new World({ seed:1, ownShip:{...structuredClone(OWN), hullPct:40},
      contacts:[], weaponsConfig:cfg(1,1) });
    executeCommand(world, {action:'set_point_defense', mode:'manual'}, 'player');
    launchAscms(world, {count:1,weapon:'ASCM',speedKts:0,altitudeFt:50,
      launcherId:'r',trackId:'A-01',t:0,position:{x:0,y:0.06},rangeNm:0.06,bearingDeg:0});
    const clock = new GameClock({ durationS:900 });
    let endCount = 0;
    clock.onStep((dt) => { world.step(dt); if(world.weapons.shipLost) clock.finish(); });
    clock.onEnd((t) => { endCount++; world.logEvent('scenario-end','crew-auto',{t}); });
    const executed = clock.advance(20);
    expect(executed).toBe(1);
    expect(world.time).toBeCloseTo(0.1,6);
    expect(clock.time).toBeCloseTo(0.1,6);
    expect(clock.ended).toBe(true);
    expect(clock.pendingSteps).toBe(0);
    expect(endCount).toBe(1);
    expect(world.events.some(e=>e.type==='scenario-end')).toBe(true);
    expect(clock.advance(100)).toBe(0);
    expect(world.time).toBeCloseTo(0.1,6);
    clock.finish();
    expect(endCount).toBe(1);
  });

  it('natural final tick does not double end', () => {
    const world = new World({ seed:1, ownShip:structuredClone(OWN), contacts:[],
      weaponsConfig:cfg(0,0) });
    const clock = new GameClock({ durationS:0.1 });
    let endCount = 0;
    clock.onStep((dt) => { world.step(dt); if(world.weapons.shipLost) clock.finish(); });
    clock.onEnd(() => { endCount++; });
    clock.advance(1);
    expect(endCount).toBe(1);
    expect(clock.ended).toBe(true);
    expect(world.weapons.shipLost).toBe(false);
  });

  it('runScenario early stop on ship lost', () => {
    const scenario: Scenario = {
      id:'early', name:'Early', durationS:100,
      ownShip:{ position:{x:0,y:0}, courseDeg:0, speedKts:0, hullPct:100,
        inventory:{sam:24,chaff:0,gunBursts:40,ciws:0} },
      contacts:[{ id:'enemy', trackId:'A-01', name:'enemy', domain:'air', truth:'hostile',
        placement:{kind:'absolute',position:{x:0,y:0.06},courseDeg:180},
        speedKts:0, altitudeFt:0, behavior:{kind:'straight'} }],
      triggers:[
        { id:'launch', when:{kind:'time',atS:0.1}, actions:[
          { kind:'launchMissiles', contactId:'enemy',
            launch:{count:3,weapon:'ASCM',speedKts:0,altitudeFt:50} }]},
        { id:'after', when:{kind:'time',atS:10}, actions:[
          { kind:'crewReport', station:'CIC', priority:'routine', text:'AFTER LOSS' }]},
      ],
    };
    const stepTimes: number[] = [];
    const { world } = runScenario(scenario, 1, {
      onStep: (w) => {
        stepTimes.push(w.time);
        if (w.time >= 0.1 - 1e-6) {
          w.weapons.config.ascm.pHit = 1;
          w.weapons.config.ascm.pHitChaff = 1;
          executeCommand(w, {action:'set_point_defense',mode:'manual'}, 'player');
        }
      },
    });
    expect(world.time).toBeCloseTo(0.2,6);
    expect(world.weapons.shipLost).toBe(true);
    expect(world.events.filter(e=>e.type==='ship_lost').length).toBe(1);
    const crewReports = world.events.filter(e=>e.type==='crew-report');
    expect(crewReports.some(e=>(e.payload as any).text?.includes('AFTER LOSS'))).toBe(false);
    expect(crewReports.some(e=>(e.payload as any).station==='Bridge'
      &&(e.payload as any).priority==='flash')).toBe(true);
    expect(stepTimes[stepTimes.length-1]).toBeCloseTo(0.2,6);
  });
});
