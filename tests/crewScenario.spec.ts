import { describe, it, expect } from 'vitest';
import { STRAIT_TRANSIT, STRAIT_IDS, STRAIT_TRIGGERS } from '../src/sim/scenario/strait';
import { runScenario } from '../src/sim/scenario/scenario';
import type { World } from '../src/sim/world';

const SEED = 1;

interface CrewMsg { t: number; station: string; priority: string; text: string; contactId?: string }
function crewMsgs(world: World): CrewMsg[] {
  return world.events.filter(e => e.type === 'crew-report').map(e => {
    const p = e.payload as any;
    return { t: e.t, station: p.station ?? '', priority: p.priority ?? '', text: p.text ?? '', contactId: p.contactId };
  });
}

describe('S7 sprint crew reports', () => {
  const { world } = runScenario(STRAIT_TRANSIT, SEED, { untilS: 490 });
  const msgs = crewMsgs(world);

  it('SWC priority speed-40 report for S-7 at t>=480 <=490', () => {
    const swc = msgs.filter(r => r.station === 'SWC' && r.priority === 'priority'
      && r.contactId === STRAIT_IDS.s7 && r.text.includes('speed change') && r.text.includes('40'));
    expect(swc.length).toBeGreaterThanOrEqual(1);
    expect(swc[0].t).toBeGreaterThanOrEqual(480);
    expect(swc[0].t).toBeLessThanOrEqual(490);
  });

  it('Lookouts no visual 3nm scripted report', () => {
    const lk = msgs.filter(r => r.station === 'Lookouts' && r.text.includes('no visual') && r.text.includes('3 nm'));
    expect(lk.length).toBeGreaterThanOrEqual(1);
  });

  it('no SWC speed-40 report before 480', () => {
    const early = msgs.filter(r => r.station === 'SWC' && r.text.includes('speed change')
      && r.text.includes('40') && r.t < 480);
    expect(early.length).toBe(0);
  });
});

describe('A1 missile launch FLASH', () => {
  const { world } = runScenario(STRAIT_TRANSIT, SEED, { untilS: 400 });
  const launch = world.events.find(e => e.type === 'missile-launch' && (e.payload as any).launcherId === STRAIT_IDS.a1);
  const flash = crewMsgs(world).filter(r => r.priority === 'flash' && r.text.includes('VAMPIRE'));

  it('FLASH within one sweep period + 0.2 after launch', () => {
    expect(launch).toBeDefined();
    expect(flash.length).toBeGreaterThanOrEqual(1);
    const delay = flash[0].t - launch!.t;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(world.sensorConfig.sweepPeriodS + 0.2);
  });

  it('bearing 045/046 rounding ±1, count two', () => {
    const m = flash[0].text.match(/bearing (\d{3})/);
    expect(m).not.toBeNull();
    expect(parseInt(m![1])).toBeGreaterThanOrEqual(44);
    expect(parseInt(m![1])).toBeLessThanOrEqual(47);
    expect(flash[0].text).toMatch(/two|2/);
  });
});

describe('A9 crew reports no truth leak', () => {
  const { world } = runScenario(STRAIT_TRANSIT, SEED, { untilS: 900 });
  const msgs = crewMsgs(world);
  const a9 = msgs.filter(r => r.contactId === STRAIT_IDS.a9 || r.text.includes('A-09'));

  it('Mode3 uncorrelated scripted at t=560', () => {
    const iff = a9.filter(r => r.text.includes('Mode 3') && r.text.includes('could not correlate'));
    expect(iff.length).toBeGreaterThanOrEqual(1);
    expect(iff[0].t).toBeGreaterThanOrEqual(560);
    expect(iff[0].t).toBeLessThanOrEqual(560.15);
  });

  it('EW commercial weather radar report present', () => {
    const ew = a9.filter(r => r.station === 'EW' && r.text.includes('commercial weather radar'));
    expect(ew.length).toBeGreaterThanOrEqual(1);
  });

  it('Radio flight 417 report present', () => {
    const rad = a9.filter(r => r.station === 'Radio' && r.text.includes('417'));
    expect(rad.length).toBeGreaterThanOrEqual(1);
  });

  it('no civil/airliner/commercial before EW trigger time', () => {
    const ewT = a9.find(r => r.station === 'EW' && r.text.includes('commercial'))?.t ?? Infinity;
    const early = a9.filter(r => r.t < ewT - 0.01 && /civil|airliner|commercial/i.test(r.text));
    expect(early.length).toBe(0);
  });

  it('no 212 in any crew report', () => {
    expect(msgs.map(r => r.text).join(' ')).not.toContain('212');
  });

  it('SAM range 40 entry precedes first civil-confirming report', () => {
    const ewT = a9.find(r => r.station === 'EW' && r.text.includes('commercial'))?.t ?? Infinity;
    expect(ewT).toBeGreaterThan(0);
    expect(ewT).toBeGreaterThan(690);
  });
});

describe('Dead A9 suppresses scripted reports', () => {
  const { world } = runScenario(STRAIT_TRANSIT, SEED, {
    untilS: 900,
    onStep: (w: World) => {
      const c = w.contactById(STRAIT_IDS.a9);
      if (c && c.alive && w.time > 545 && w.time < 560) c.alive = false;
    },
  });
  const msgs = crewMsgs(world);
  const a9 = msgs.filter(r => r.contactId === STRAIT_IDS.a9 || r.text.includes('A-09'));

  it('no Mode3 uncorrelated or civil reports', () => {
    expect(a9.filter(r => r.text.includes('could not correlate')).length).toBe(0);
    expect(a9.filter(r => /civil|airliner|417/i.test(r.text)).length).toBe(0);
  });

  it('no truth leak in any crew report', () => {
    const all = msgs.map(r => r.text).join(' ');
    expect(all).not.toContain('212');
    expect(all).not.toContain('civil');
  });
});

describe('Determinism', () => {
  it('same seed identical crew reports', () => {
    const r1 = runScenario(STRAIT_TRANSIT, SEED, { untilS: 900 });
    const r2 = runScenario(STRAIT_TRANSIT, SEED, { untilS: 900 });
    const s = (w: World) => crewMsgs(w).map(r => `${r.t.toFixed(1)}|${r.station}|${r.priority}|${r.text}`);
    expect(s(r1.world)).toEqual(s(r2.world));
  });

  it('firedTriggers contain key scenario milestones', () => {
    const { runner } = runScenario(STRAIT_TRANSIT, SEED, { untilS: 900 });
    expect(runner.firedTriggers).toContain(STRAIT_TRIGGERS.s7Sprint);
    expect(runner.firedTriggers).toContain(STRAIT_TRIGGERS.s7Launch);
    expect(runner.firedTriggers).toContain(STRAIT_TRIGGERS.a1Launch);
  });
});
