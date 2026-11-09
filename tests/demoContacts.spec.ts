import { describe, expect, it } from 'vitest';
import { rangeTo } from '../src/sim/geo';
import { DEMO_CONTACTS, DEMO_OWN_SHIP } from '../src/ui/demoContacts';

const DOMAINS = ['air', 'surface', 'missile'] as const;
const CLASSIFICATIONS = [
  'unknown',
  'neutral',
  'friendly',
  'suspect',
  'hostile',
] as const;

describe('demoContacts', () => {
  it('defines the own ship', () => {
    expect(DEMO_OWN_SHIP.position).toEqual({ x: 0, y: 0 });
    expect(DEMO_OWN_SHIP.courseDeg).toBe(340);
    expect(DEMO_OWN_SHIP.speedKts).toBe(15);
    expect(DEMO_OWN_SHIP.hullPct).toBe(100);
    expect(DEMO_OWN_SHIP.inventory).toEqual({
      sam: 24,
      chaff: 6,
      gunBursts: 40,
      ciws: 1000,
    });
  });

  it('covers every domain', () => {
    const domains = new Set(DEMO_CONTACTS.map((contact) => contact.domain));
    expect(DOMAINS.every((domain) => domains.has(domain))).toBe(true);
  });

  it('covers every classification', () => {
    const classifications = new Set(
      DEMO_CONTACTS.map((contact) => contact.classification),
    );
    expect(CLASSIFICATIONS.every((classification) => classifications.has(classification))).toBe(
      true,
    );
  });

  it('has unique track ids', () => {
    const trackIds = new Set(DEMO_CONTACTS.map((contact) => contact.trackId));
    expect(trackIds.size).toBe(DEMO_CONTACTS.length);
  });

  it('has at least one faded surface contact', () => {
    expect(
      DEMO_CONTACTS.some(
        (contact) => contact.domain === 'surface' && contact.faded === true,
      ),
    ).toBe(true);
  });

  it('has six history points per contact', () => {
    expect(DEMO_CONTACTS.every((contact) => contact.history.length === 6)).toBe(
      true,
    );
  });

  it('keeps current contacts between 5 and 75 nm and history within 80 nm', () => {
    const ranges = DEMO_CONTACTS.map((contact) =>
      rangeTo(DEMO_OWN_SHIP.position, contact.position),
    );

    expect(Math.min(...ranges)).toBeCloseTo(5, 6);
    expect(Math.max(...ranges)).toBeCloseTo(75, 6);

    for (const contact of DEMO_CONTACTS) {
      const rangeNm = rangeTo(DEMO_OWN_SHIP.position, contact.position);
      expect(rangeNm).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(rangeNm).toBeLessThanOrEqual(75 + 1e-6);

      for (const historyPoint of contact.history) {
        expect(
          rangeTo(DEMO_OWN_SHIP.position, historyPoint),
        ).toBeLessThanOrEqual(80 + 1e-6);
      }
    }
  });

  it('has at least two classifications per domain', () => {
    for (const domain of DOMAINS) {
      const classifications = new Set(
        DEMO_CONTACTS.filter((contact) => contact.domain === domain).map(
          (contact) => contact.classification,
        ),
      );
      expect(classifications.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('uses plausible altitudes by domain', () => {
    for (const contact of DEMO_CONTACTS) {
      if (contact.domain === 'surface') {
        expect(contact.altitudeFt).toBe(0);
      }
      if (contact.domain === 'missile') {
        expect(contact.altitudeFt).toBeLessThanOrEqual(100);
      }
      if (contact.domain === 'air') {
        expect(contact.altitudeFt).toBeGreaterThan(0);
      }
    }
  });
});
