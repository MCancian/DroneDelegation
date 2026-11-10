import { describe, it, expect } from 'vitest';
import { missileThreats, formatMissileThreat } from '../src/ui/alerts';
import { makeContact, makeOwnShip } from './helpers/sim';

describe('sensor-visible missile alerts', () => {
  it('estimates time to closest inbound hostile missile using relative closing speed', () => {
    const ship = makeOwnShip({ courseDeg: 0, speedKts: 20 });
    const hostile = makeContact({ domain: 'missile', classification: 'hostile', position: { x: 0, y: 10 }, courseDeg: 180, speedKts: 580 });
    const second = makeContact({ domain: 'missile', classification: 'hostile', position: { x: 0, y: 8 }, courseDeg: 180, speedKts: 580 });
    const threat = missileThreats(ship, [hostile, second]);
    expect(threat.count).toBe(2);
    expect(threat.etaS).toBeCloseTo(48);
    expect(formatMissileThreat(threat.count, threat.etaS)).toBe('Missiles: 2 · ETA 0:48');
  });

  it('excludes interceptors, nonhostile contacts, and dead tracks; opening missiles lack an ETA', () => {
    const ship = makeOwnShip();
    const base = makeContact({ domain: 'missile', classification: 'hostile', courseDeg: 0, speedKts: 100 });
    expect(missileThreats(ship, [
      { ...base, ownMissile: true }, { ...base, alive: false },
      { ...base, classification: 'unknown' }, { ...base, domain: 'air' },
    ])).toEqual({ count: 0, etaS: null });
    expect(missileThreats(ship, [base])).toEqual({ count: 1, etaS: null });
    expect(formatMissileThreat(1, null)).toContain('ETA unavailable');
    expect(formatMissileThreat(0, null)).toBe('Missiles: none');
  });
});
