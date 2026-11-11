import { describe, expect, it } from 'vitest';
import { crewRoleForReport } from '../src/ui/crewFeed';

describe('Crew Feed routing', () => {
  it('routes contact reports by sensor domain before auxiliary station', () => {
    expect(crewRoleForReport('EW', 'air')).toBe('air-search');
    expect(crewRoleForReport('Radio', 'surface')).toBe('surface-search');
    expect(crewRoleForReport('TAO-Air', 'missile')).toBe('weapons-officer');
  });

  it('routes reports without a contact by their operating station', () => {
    expect(crewRoleForReport('CIC')).toBe('air-search');
    expect(crewRoleForReport('Lookouts')).toBe('air-search');
    expect(crewRoleForReport('SWC')).toBe('surface-search');
    expect(crewRoleForReport('Bridge')).toBe('weapons-officer');
    expect(crewRoleForReport('EW')).toBe('weapons-officer');
  });
});
