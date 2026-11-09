import { describe, expect, it } from 'vitest';
import type { Contact, GameEvent, OwnShip } from '../src/sim/types';
import { move } from '../src/sim/geo';

interface EngagePayload {
  contactId: string;
  weapon: 'sam';
}

describe('sim types', () => {
  it('constructs typed sample objects and moves a contact', () => {
    const airContact: Contact = {
      id: 'contact-air-1',
      trackId: 'A-01',
      domain: 'air',
      truth: 'hostile',
      position: { x: 0, y: 0 },
      courseDeg: 90,
      speedKts: 20,
      altitudeFt: 12000,
      classification: 'hostile',
      sensors: {
        iff: { kind: 'mode3', code: '7700' },
        ais: { kind: 'none' },
        esm: { kind: 'emitter', emitterType: 'radar' },
        visual: { kind: 'identified', description: 'fighter' },
      },
      alive: true,
      history: [{ x: 0, y: 0 }],
    };

    const surfaceContact: Contact = {
      id: 'contact-surface-1',
      trackId: 'S-07',
      domain: 'surface',
      truth: 'civil',
      position: { x: 5, y: 5 },
      courseDeg: 0,
      speedKts: 12,
      altitudeFt: 0,
      classification: 'neutral',
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'vessel', name: 'MV TEST', vesselType: 'cargo' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
      alive: true,
      history: [{ x: 5, y: 5 }],
    };

    const missileContact: Contact = {
      id: 'contact-missile-1',
      trackId: 'M-03',
      domain: 'missile',
      truth: 'hostile',
      position: { x: 10, y: 10 },
      courseDeg: 225,
      speedKts: 450,
      altitudeFt: 15000,
      classification: 'hostile',
      sensors: {
        iff: { kind: 'none' },
        ais: { kind: 'none' },
        esm: { kind: 'none' },
        visual: { kind: 'none' },
      },
      alive: true,
      history: [{ x: 10, y: 10 }],
    };

    const ownShip: OwnShip = {
      position: { x: 0, y: 0 },
      courseDeg: 0,
      speedKts: 15,
      hullPct: 100,
      inventory: {
        sam: 4,
        chaff: 2,
        gunBursts: 20,
        ciws: 1,
      },
    };

    const event: GameEvent<EngagePayload> = {
      t: 0,
      type: 'engage',
      actor: 'player',
      payload: {
        contactId: 'M-03',
        weapon: 'sam',
      },
    };

    expect(airContact.trackId).toBe('A-01');
    expect(airContact.sensors.esm.kind).toBe('emitter');
    expect(surfaceContact.trackId).toBe('S-07');
    expect(surfaceContact.sensors.ais.kind).toBe('vessel');
    expect(missileContact.domain).toBe('missile');
    expect(ownShip.inventory.sam).toBe(4);
    expect(event.type).toBe('engage');
    expect(event.payload.weapon).toBe('sam');

    const moved = move(
      airContact.position,
      airContact.courseDeg,
      airContact.speedKts,
      1800,
    );

    airContact.position = moved;

    expect(airContact.position.x).toBeCloseTo(10, 6);
    expect(airContact.position.y).toBeCloseTo(0, 6);
  });
});
