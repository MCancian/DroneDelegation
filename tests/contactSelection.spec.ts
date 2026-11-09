import { describe, expect, it } from 'vitest';
import type { Contact, OwnShip, Vec2 } from '../src/sim/types';
import {
  describeContact,
  formatAltitude,
  formatBearing,
  formatCpaTime,
  formatRange,
  PICK_TOLERANCE_PX,
  pickContact,
  toleranceNmFromPx,
} from '../src/ui/contactSelection';

function makeContact(overrides: Partial<Contact> & { id: string; trackId: string }): Contact {
  return {
    domain: 'air',
    truth: 'unknown' as Contact['truth'],
    position: { x: 0, y: 0 },
    courseDeg: 0,
    speedKts: 0,
    altitudeFt: 0,
    classification: 'unknown',
    sensors: {
      iff: { kind: 'none' },
      ais: { kind: 'none' },
      esm: { kind: 'none' },
      visual: { kind: 'none' },
    },
    alive: true,
    history: [],
    ...overrides,
  };
}

const ownShip: OwnShip = {
  position: { x: 0, y: 0 },
  courseDeg: 0,
  speedKts: 10,
  hullPct: 100,
  inventory: { sam: 24, chaff: 6, gunBursts: 40, ciws: 1000 },
};

describe('pickContact', () => {
  it('picks the nearest alive contact within tolerance', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'A', trackId: 'A', position: { x: 1, y: 0 } }),
      makeContact({ id: 'B', trackId: 'B', position: { x: 0.5, y: 0 } }),
      makeContact({ id: 'C', trackId: 'C', position: { x: 5, y: 0 } }),
    ];

    const result = pickContact(contacts, { x: 0, y: 0 }, 2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('B');
  });

  it('returns null when no contact is within tolerance', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'A', trackId: 'A', position: { x: 10, y: 0 } }),
    ];

    const result = pickContact(contacts, { x: 0, y: 0 }, 2);
    expect(result).toBeNull();
  });

  it('ignores dead contacts', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'A', trackId: 'A', position: { x: 0.1, y: 0 }, alive: false }),
      makeContact({ id: 'B', trackId: 'B', position: { x: 1, y: 0 }, alive: true }),
    ];

    const result = pickContact(contacts, { x: 0, y: 0 }, 2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('B');
  });

  it('returns null for empty list', () => {
    const result = pickContact([], { x: 0, y: 0 }, 5);
    expect(result).toBeNull();
  });

  it('includes contacts exactly at the tolerance boundary', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'A', trackId: 'A', position: { x: 2, y: 0 } }),
    ];

    const result = pickContact(contacts, { x: 0, y: 0 }, 2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('A');
  });

  it('ties: first in array order wins', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'first', trackId: 'first', position: { x: 1, y: 0 } }),
      makeContact({ id: 'second', trackId: 'second', position: { x: 1, y: 0 } }),
    ];

    const result = pickContact(contacts, { x: 0, y: 0 }, 2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('first');
  });

  it('returns null for negative tolerance', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'A', trackId: 'A', position: { x: 0, y: 0 } }),
    ];

    expect(pickContact(contacts, { x: 0, y: 0 }, -1)).toBeNull();
  });

  it('returns null for non-finite tolerance', () => {
    const contacts: Contact[] = [
      makeContact({ id: 'A', trackId: 'A', position: { x: 0, y: 0 } }),
    ];

    expect(pickContact(contacts, { x: 0, y: 0 }, Infinity)).toBeNull();
    expect(pickContact(contacts, { x: 0, y: 0 }, NaN)).toBeNull();
  });
});

describe('toleranceNmFromPx', () => {
  it('converts pixels to nautical miles', () => {
    expect(toleranceNmFromPx(12, 10)).toBeCloseTo(1.2, 6);
  });

  it('returns 0 when pxPerNm is zero', () => {
    expect(toleranceNmFromPx(12, 0)).toBe(0);
  });

  it('returns 0 when pxPerNm is negative', () => {
    expect(toleranceNmFromPx(12, -5)).toBe(0);
  });

  it('returns 0 when pxPerNm is not finite', () => {
    expect(toleranceNmFromPx(12, Infinity)).toBe(0);
    expect(toleranceNmFromPx(12, NaN)).toBe(0);
  });
});

describe('PICK_TOLERANCE_PX', () => {
  it('is 12', () => {
    expect(PICK_TOLERANCE_PX).toBe(12);
  });
});

describe('formatBearing', () => {
  it('formats cardinal bearings with 3-digit zero-padding', () => {
    expect(formatBearing(0)).toBe('000\u00B0');
    expect(formatBearing(45)).toBe('045\u00B0');
    expect(formatBearing(90)).toBe('090\u00B0');
    expect(formatBearing(180)).toBe('180\u00B0');
    expect(formatBearing(359)).toBe('359\u00B0');
  });

  it('rounds fractional bearings', () => {
    expect(formatBearing(44.6)).toBe('045\u00B0');
    expect(formatBearing(44.4)).toBe('044\u00B0');
  });
});

describe('formatRange', () => {
  it('formats with 1 decimal', () => {
    expect(formatRange(10)).toBe('10.0 nm');
    expect(formatRange(12.34)).toBe('12.3 nm');
    expect(formatRange(0.05)).toBe('0.1 nm');
  });
});

describe('formatCpaTime', () => {
  it('formats seconds as MM:SS', () => {
    expect(formatCpaTime(0)).toBe('00:00');
    expect(formatCpaTime(60)).toBe('01:00');
    expect(formatCpaTime(90)).toBe('01:30');
    expect(formatCpaTime(330)).toBe('05:30');
    expect(formatCpaTime(1800)).toBe('30:00');
  });
});

describe('formatAltitude', () => {
  it('rounds to nearest 100 and adds comma grouping', () => {
    expect(formatAltitude(15000)).toBe('15,000 ft');
    expect(formatAltitude(35000)).toBe('35,000 ft');
    expect(formatAltitude(14500)).toBe('14,500 ft');
    expect(formatAltitude(14400)).toBe('14,400 ft');
    expect(formatAltitude(50)).toBe('100 ft');
    expect(formatAltitude(0)).toBe('0 ft');
  });
});

describe('describeContact', () => {
  it('air contact at (0,10) from ship at (0,0): bearing 000, range 10.0', () => {
    const contact = makeContact({
      id: 'A-1',
      trackId: 'A-1',
      domain: 'air',
      position: { x: 0, y: 10 },
      courseDeg: 180,
      speedKts: 420,
      altitudeFt: 15000,
      classification: 'hostile',
    });

    const details = describeContact(contact, ownShip);

    expect(details.trackId).toBe('A-1');
    expect(details.title).toBe('A-1');

    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));

    expect(rowMap['Track']).toBe('A-1');
    expect(rowMap['Domain']).toBe('AIR');
    expect(rowMap['Class']).toBe('HOSTILE');
    expect(rowMap['Bearing']).toBe('000\u00B0');
    expect(rowMap['Range']).toBe('10.0 nm');
    expect(rowMap['Course']).toBe('180\u00B0');
    expect(rowMap['Speed']).toBe('420 kts');
    expect(rowMap['Altitude']).toBe('15,000 ft');
    expect(rowMap['IFF']).toBe('\u2014');
    expect(rowMap['AIS']).toBe('\u2014');
    expect(rowMap['ESM']).toBe('\u2014');
    expect(rowMap['Visual']).toBe('\u2014');
  });

  it('surface contact altitude is em dash', () => {
    const contact = makeContact({
      id: 'S-1',
      trackId: 'S-1',
      domain: 'surface',
      position: { x: 5, y: 0 },
      courseDeg: 270,
      speedKts: 14,
      altitudeFt: 0,
      classification: 'neutral',
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));

    expect(rowMap['Domain']).toBe('SURFACE');
    expect(rowMap['Altitude']).toBe('\u2014');
  });

  it('missile contact altitude is shown', () => {
    const contact = makeContact({
      id: 'M-1',
      trackId: 'M-1',
      domain: 'missile',
      position: { x: 0, y: 5 },
      courseDeg: 180,
      speedKts: 600,
      altitudeFt: 50,
      classification: 'hostile',
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));

    expect(rowMap['Domain']).toBe('MISSILE');
    expect(rowMap['Altitude']).toBe('100 ft');
  });

  it('IFF mode3', () => {
    const contact = makeContact({
      id: 'A-2',
      trackId: 'A-2',
      position: { x: 0, y: 10 },
      sensors: {
        iff: { kind: 'mode3', code: '4521' },
        ais: { kind: 'none' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));
    expect(rowMap['IFF']).toBe('Mode 3 4521');
  });

  it('IFF mode4', () => {
    const contact = makeContact({
      id: 'A-3',
      trackId: 'A-3',
      position: { x: 0, y: 10 },
      sensors: {
        iff: { kind: 'mode4' },
        ais: { kind: 'none' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));
    expect(rowMap['IFF']).toBe('Mode 4 valid');
  });

  it('AIS vessel', () => {
    const contact = makeContact({
      id: 'S-2',
      trackId: 'S-2',
      domain: 'surface',
      position: { x: 0, y: 10 },
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'vessel', name: 'MV Coral Trader', vesselType: 'tanker' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));
    expect(rowMap['AIS']).toBe('MV Coral Trader (tanker)');
  });

  it('ESM emitter', () => {
    const contact = makeContact({
      id: 'A-4',
      trackId: 'A-4',
      position: { x: 0, y: 10 },
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'none' },
        esm: { kind: 'emitter', emitterType: 'fire-control radar' },
        visual: { kind: 'none' },
      },
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));
    expect(rowMap['ESM']).toBe('fire-control radar');
  });

  it('Visual identified', () => {
    const contact = makeContact({
      id: 'S-3',
      trackId: 'S-3',
      domain: 'surface',
      position: { x: 0, y: 10 },
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'none' },
        esm: { kind: 'none' },
        visual: { kind: 'identified', description: 'small dhow, no wake' },
      },
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));
    expect(rowMap['Visual']).toBe('small dhow, no wake');
  });

  it('CPA closing contact shows range and time', () => {
    // Own ship at (0,0) heading north at 10 kts
    // Contact at (0, 10) heading south at 10 kts → head-on closing
    const contact = makeContact({
      id: 'A-5',
      trackId: 'A-5',
      position: { x: 0, y: 10 },
      courseDeg: 180,
      speedKts: 10,
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));

    // Head-on: CPA range ~0, time = 10nm / (20kts * 1/3600 nm/s) = 1800s = 30:00
    expect(rowMap['CPA']).toMatch(/^0\.0 nm in 30:00$/);
  });

  it('CPA opening contact shows "opening"', () => {
    // Own ship at (0,0) heading north at 10 kts
    // Contact at (0, 10) heading north at 20 kts → opening
    const contact = makeContact({
      id: 'A-6',
      trackId: 'A-6',
      position: { x: 0, y: 10 },
      courseDeg: 0,
      speedKts: 20,
    });

    const details = describeContact(contact, ownShip);
    const rowMap = Object.fromEntries(details.rows.map((r) => [r.label, r.value]));

    expect(rowMap['CPA']).toBe('opening');
  });

  it('rows are in the correct order', () => {
    const contact = makeContact({
      id: 'A-7',
      trackId: 'A-7',
      position: { x: 0, y: 10 },
    });

    const details = describeContact(contact, ownShip);
    const labels = details.rows.map((r) => r.label);

    expect(labels).toEqual([
      'Track',
      'Domain',
      'Class',
      'Bearing',
      'Range',
      'Course',
      'Speed',
      'Altitude',
      'CPA',
      'IFF',
      'AIS',
      'ESM',
      'Visual',
    ]);
  });
});
