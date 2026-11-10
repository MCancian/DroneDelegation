import { expect, it } from 'vitest';
import { analyze } from '../src/report/analyze';
import { setAutonomy } from '../src/ai/autonomy';
import { Doctrine } from '../src/ai/doctrine';
import { ProposalManager } from '../src/ai/proposals';
import { SituationHistory } from '../src/ai/situation';
import { loadScenario } from '../src/sim/scenario/scenario';
import { STRAIT_TRANSIT } from '../src/sim/scenario/strait';

it('reports deciding authority and observed information from an actual delegated Strait playthrough', () => {
  const { world, runner } = loadScenario(STRAIT_TRANSIT, 123);
  setAutonomy(world, 'air', 'WEAPONS_FREE'); setAutonomy(world, 'surface', 'WEAPONS_FREE');
  // Isolate reporting of decisions from early ship loss, preserving target Pk.
  world.weapons.config = structuredClone(world.weapons.config);
  world.weapons.config.ascm.pHit = 0; world.weapons.config.ascm.pHitChaff = 0;
  const manager = new ProposalManager(world);
  const history = new SituationHistory();
  const doctrine = new Doctrine(world, manager, { getHostileActs: () => history.acts() });
  history.observe(world);
  for (let i = 0; i < 9000; i++) {
    world.step(0.1); runner.update(); history.observe(world); doctrine.update(); manager.update();
  }
  const report = analyze(world.events, { scenario: STRAIT_TRANSIT, seed: world.seed, endedAtS: world.time, hullPct: world.ownShip.hullPct, shipLost: world.weapons.shipLost });
  const airliner = report.keyEvents[2];
  expect(airliner.decisions[0]).toMatchObject({ actor: 'doctrine', autonomy: 'WEAPONS_FREE', trackId: 'A-09', executed: true });
  expect(airliner.decisions[0].rangeNm).toBeGreaterThan(32);
  expect(report.summary.civilianLivesLost).toBe(212);
  expect(airliner.information).toEqual([{ t: null, text: 'Civil confirmation was not recorded during this playthrough.' }]);
  expect(report.keyEvents[1].decisions[0]).toMatchObject({ actor: 'doctrine', autonomy: 'WEAPONS_FREE' });
  expect(report.autonomyTimeline).toEqual(expect.arrayContaining([{ t: 0, domain: 'air', level: 'WEAPONS_FREE' }, { t: 0, domain: 'surface', level: 'WEAPONS_FREE' }]));
}, 30000);
