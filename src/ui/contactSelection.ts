import type { Contact, OwnShip, Vec2 } from '../sim/types';
import { bearingTo, cpa, rangeTo, velocityFrom } from '../sim/geo';

export const PICK_TOLERANCE_PX = 12;

const SCOPE_EPSILON = 1e-9;

export interface ContactDetailRow {
  label: string;
  value: string;
}

export interface ContactDetails {
  trackId: string;
  title: string;
  rows: ContactDetailRow[];
}

export function pickContact<T extends Contact>(
  contacts: readonly T[],
  worldPoint: Vec2,
  toleranceNm: number,
): T | null {
  if (!Number.isFinite(toleranceNm) || toleranceNm < 0) {
    return null;
  }

  let best: T | null = null;
  let bestDist = Infinity;

  for (const contact of contacts) {
    if (!contact.alive) continue;
    const dist = rangeTo(worldPoint, contact.position);
    if (dist <= toleranceNm && dist < bestDist) {
      best = contact;
      bestDist = dist;
    }
  }

  return best;
}

export function visibleContacts<T extends Contact>(
  contacts: readonly T[],
  ownShipPosition: Vec2,
  rangeNm: number,
): T[] {
  if (rangeNm < 0) {
    return [];
  }

  return contacts.filter(
    (contact) =>
      contact.alive &&
      rangeTo(ownShipPosition, contact.position) <= rangeNm + SCOPE_EPSILON,
  );
}

export function toleranceNmFromPx(tolerancePx: number, pxPerNm: number): number {
  if (!Number.isFinite(pxPerNm) || pxPerNm <= 0) {
    return 0;
  }
  return tolerancePx / pxPerNm;
}

export function formatBearing(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  const rounded = Math.round(normalized) % 360;
  return String(rounded).padStart(3, '0') + '\u00B0';
}

export function formatRange(nm: number): string {
  return nm.toFixed(1) + ' nm';
}

export function formatCourse(deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  const rounded = Math.round(normalized) % 360;
  return String(rounded).padStart(3, '0') + '\u00B0';
}

export function formatSpeed(kts: number): string {
  return Math.round(kts) + ' kts';
}

export function formatAltitude(ft: number): string {
  const rounded = Math.round(ft / 100) * 100;
  return rounded.toLocaleString('en-US') + ' ft';
}

export function formatCpaTime(tSec: number): string {
  const totalSec = Math.round(tSec);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

export function formatCpa(ownPos: Vec2, ownVel: Vec2, tgtPos: Vec2, tgtVel: Vec2): string {
  const result = cpa(ownPos, ownVel, tgtPos, tgtVel);
  if (result.tCpaSec <= 0) {
    return 'opening';
  }
  return result.rangeNm.toFixed(1) + ' nm in ' + formatCpaTime(result.tCpaSec);
}

function formatIff(iff: Contact['sensors']['iff']): string {
  switch (iff.kind) {
    case 'none':
      return '\u2014';
    case 'mode3':
      return 'Mode 3 ' + iff.code;
    case 'mode4':
      return 'Mode 4 valid';
  }
}

function formatAis(ais: Contact['sensors']['ais']): string {
  switch (ais.kind) {
    case 'none':
      return '\u2014';
    case 'vessel':
      return ais.name + ' (' + ais.vesselType + ')';
  }
}

function formatEsm(esm: Contact['sensors']['esm']): string {
  switch (esm.kind) {
    case 'none':
      return '\u2014';
    case 'emitter':
      return esm.emitterType;
  }
}

function formatVisual(visual: Contact['sensors']['visual']): string {
  switch (visual.kind) {
    case 'none':
      return '\u2014';
    case 'identified':
      return visual.description;
  }
}

export function describeContact(contact: Contact, ownShip: OwnShip): ContactDetails {
  const bearing = bearingTo(ownShip.position, contact.position);
  const range = rangeTo(ownShip.position, contact.position);

  const ownVel = velocityFrom(ownShip.courseDeg, ownShip.speedKts);
  const tgtVel = velocityFrom(contact.courseDeg, contact.speedKts);

  const domainLabel =
    contact.domain === 'air' ? 'AIR' :
    contact.domain === 'surface' ? 'SURFACE' : 'MISSILE';

  const altitudeValue =
    contact.domain === 'surface'
      ? '\u2014'
      : formatAltitude(contact.altitudeFt);

  const rows: ContactDetailRow[] = [
    { label: 'Track', value: contact.trackId },
    { label: 'Domain', value: domainLabel },
    { label: 'Class', value: contact.classification.toUpperCase() },
    { label: 'Bearing', value: formatBearing(bearing) },
    { label: 'Range', value: formatRange(range) },
    { label: 'Course', value: formatCourse(contact.courseDeg) },
    { label: 'Speed', value: formatSpeed(contact.speedKts) },
    { label: 'Altitude', value: altitudeValue },
    { label: 'CPA', value: formatCpa(ownShip.position, ownVel, contact.position, tgtVel) },
    { label: 'IFF', value: formatIff(contact.sensors.iff) },
    { label: 'AIS', value: formatAis(contact.sensors.ais) },
    { label: 'ESM', value: formatEsm(contact.sensors.esm) },
    { label: 'Visual', value: formatVisual(contact.sensors.visual) },
  ];

  return {
    trackId: contact.trackId,
    title: contact.trackId,
    rows,
  };
}
