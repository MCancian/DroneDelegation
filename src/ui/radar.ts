import type { Classification, OwnShip, RadarContact, Vec2 } from '../sim/types';
import type { Projection, ScreenRect } from './radarProjection';
import {
  bearingToScreenAngle,
  cappedLeaderLengthPx,
  clampRange,
  DEFAULT_RANGE_NM,
  isInsideScope,
  LEADER_MAX_SCOPE_FRACTION,
  makeProjection,
  nextRangeStep,
  pickRingLabelBearing,
  pointAtBearing,
  ringRadiiNm,
  screenToWorld as projectionScreenToWorld,
  worldToScreen as projectionWorldToScreen,
} from './radarProjection';

export interface RadarView {
  ownShip: OwnShip;
  contacts: RadarContact[];
  selectedId: string | null;
}

export interface RadarOptions {
  rangeNm?: number;
  onRangeChange?: (nm: number) => void;
  now?: () => number;
}

export interface Radar {
  render(view: RadarView): void;
  setRange(nm: number): void;
  getRange(): number;
  screenToWorld(px: number, py: number): Vec2;
  worldToScreen(pos: Vec2): Vec2;
  destroy(): void;
}

const TAU = Math.PI * 2;
const MONOSPACE_FONT = '"Courier New", Courier, monospace';

const PADDING_PX = 28;
const RING_COUNT = 4;

const TICK_MINOR_DEG = 10;
const TICK_MAJOR_DEG = 30;
const TICK_MINOR_LENGTH_PX = 5;
const TICK_MAJOR_LENGTH_PX = 10;
const BEARING_LABEL_OFFSET_PX = 14;
const BEARING_LABEL_FONT_PX = 11;

const SWEEP_PERIOD_MS = 4000;
const SWEEP_TRAIL_DEG = 40;
const SWEEP_SEGMENTS = 8;
const SWEEP_LINE_WIDTH_PX = 1.5;
const SWEEP_COLOR = 'rgba(0, 255, 102, 0.55)';
const SWEEP_LINE_COLOR = 'rgba(0, 255, 102, 0.8)';
const SWEEP_AFTERGLOW_ALPHA = 0.18;

const OWN_SHIP_COLOR = '#00ff66';
const OWN_SHIP_SYMBOL_RADIUS_PX = 3;
const OWN_SHIP_HEADING_RATIO = 0.18;
const OWN_SHIP_HEADING_MIN_PX = 12;
const OWN_SHIP_LINE_WIDTH_PX = 2;

const SYMBOL_RADIUS_PX = 7;
const SYMBOL_LINE_WIDTH_PX = 1.5;
const MISSILE_SIZE_PX = 4;
const HISTORY_DOT_RADIUS_PX = 1.5;

const LEADER_MIN_PX = 6;

const LABEL_FONT_PX = 11;
const LABEL_OFFSET_X_PX = 10;
const LABEL_OFFSET_Y_PX = 8;
const LABEL_LINE_HEIGHT_PX = 13;

const SELECTED_RADIUS_PX = 13;
const SELECTED_DASH_PX = 4;
const SELECTED_LINE_WIDTH_PX = 1.5;
const SELECTED_COLOR = '#ffffff';

const FADED_ALPHA = 0.35;
const FADED_OFF_ALPHA = 0.1;
const FADED_FLICKER_PERIOD_MS = 90;
const FADED_FLICKER_THRESHOLD = 0.6;

const RING_COLOR = 'rgba(0, 255, 102, 0.22)';
const RING_LABEL_COLOR = 'rgba(127, 255, 159, 0.7)';
const RING_LINE_WIDTH_PX = 1;

const TICK_COLOR = 'rgba(0, 255, 102, 0.35)';
const TICK_LINE_WIDTH_PX = 1;
const BEARING_LABEL_COLOR = 'rgba(127, 255, 159, 0.75)';

const SCOPE_OUTER_COLOR = 'rgba(0, 255, 102, 0.55)';
const SCOPE_LINE_WIDTH_PX = 1.5;

const CLASSIFICATION_COLORS: Record<Classification, string> = {
  unknown: '#ffd400',
  neutral: '#33ff66',
  friendly: '#33e0ff',
  suspect: '#ff9a1f',
  hostile: '#ff3b30',
};

const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatNmLabel(nm: number): string {
  return Number.isInteger(nm) ? String(nm) : nm.toFixed(1);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function isFlickerOff(nowMs: number, trackId: string): boolean {
  return Math.sin(nowMs / FADED_FLICKER_PERIOD_MS + hashString(trackId)) > FADED_FLICKER_THRESHOLD;
}

function contactLabelInfo(
  contact: RadarContact,
  screen: Vec2,
): { lines: string[]; x: number; y: number } {
  const lines: string[] = [contact.trackId];
  if (contact.domain === 'air') {
    lines.push(`ALT ${String(Math.round(contact.altitudeFt / 100)).padStart(3, '0')}`);
  }
  lines.push(`SPD ${Math.round(contact.speedKts)}`);

  const labelX = screen.x + SYMBOL_RADIUS_PX + LABEL_OFFSET_X_PX;
  const labelY =
    screen.y - SYMBOL_RADIUS_PX - LABEL_OFFSET_Y_PX - (lines.length - 1) * LABEL_LINE_HEIGHT_PX;

  return { lines, x: labelX, y: labelY };
}

export function createRadar(canvas: HTMLCanvasElement, opts?: RadarOptions): Radar {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable');
  }

  const nowFn = opts?.now ?? defaultNow;
  const onRangeChange = opts?.onRangeChange;

  let rangeNm = clampRange(opts?.rangeNm ?? DEFAULT_RANGE_NM);
  let projection: Projection | null = null;
  let lastOwnShipPosition: Vec2 = { x: 0, y: 0 };

  const measure = (): { cssWidth: number; cssHeight: number } => {
    const cssWidth = positiveFinite(canvas.clientWidth, 1);
    const cssHeight = positiveFinite(canvas.clientHeight, 1);
    return { cssWidth, cssHeight };
  };

  const currentProjection = (): Projection => {
    if (projection) {
      return projection;
    }
    const { cssWidth, cssHeight } = measure();
    return makeProjection(cssWidth, cssHeight, rangeNm, lastOwnShipPosition, PADDING_PX);
  };

  const setRange = (nm: number): void => {
    const next = clampRange(nm);
    if (next !== rangeNm) {
      rangeNm = next;
      onRangeChange?.(next);
    }
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (event.deltaY > 0) {
      setRange(nextRangeStep(rangeNm, 1));
    } else if (event.deltaY < 0) {
      setRange(nextRangeStep(rangeNm, -1));
    }
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });

  const computeContactObstacles = (
    proj: Projection,
    contacts: RadarContact[],
  ): ScreenRect[] => {
    const obstacles: ScreenRect[] = [];
    ctx.font = `${LABEL_FONT_PX}px ${MONOSPACE_FONT}`;

    for (const contact of contacts) {
      if (!contact.alive) {
        continue;
      }
      if (!isInsideScope(proj, contact.position)) {
        continue;
      }

      const screen = projectionWorldToScreen(proj, contact.position);

      const symbolHalf = SYMBOL_RADIUS_PX + 2;
      obstacles.push({
        x: screen.x - symbolHalf,
        y: screen.y - symbolHalf,
        width: symbolHalf * 2,
        height: symbolHalf * 2,
      });

      const { lines, x: labelX, y: labelY } = contactLabelInfo(contact, screen);
      let maxWidth = 0;
      for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxWidth) {
          maxWidth = w;
        }
      }
      obstacles.push({
        x: labelX,
        y: labelY,
        width: maxWidth,
        height: lines.length * LABEL_LINE_HEIGHT_PX,
      });
    }

    return obstacles;
  };

  const drawRings = (proj: Projection, contacts: RadarContact[]): void => {
    const center = proj.centerPx;
    const obstacles = computeContactObstacles(proj, contacts);

    ctx.strokeStyle = RING_COLOR;
    ctx.fillStyle = RING_LABEL_COLOR;
    ctx.lineWidth = RING_LINE_WIDTH_PX;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const nm of ringRadiiNm(proj.rangeNm, RING_COUNT)) {
      const ringRadius = (nm / proj.rangeNm) * proj.radiusPx;

      ctx.beginPath();
      ctx.arc(center.x, center.y, ringRadius, 0, TAU);
      ctx.stroke();

      ctx.font = `${BEARING_LABEL_FONT_PX}px ${MONOSPACE_FONT}`;
      const text = formatNmLabel(nm);
      const textWidth = ctx.measureText(text).width;
      const bearing = pickRingLabelBearing(
        proj,
        ringRadius,
        textWidth + 4,
        BEARING_LABEL_FONT_PX + 4,
        obstacles,
      );
      const label = pointAtBearing(proj, bearing, ringRadius);
      ctx.fillText(text, label.x, label.y);
    }
  };

  const drawScopeOuter = (proj: Projection): void => {
    const center = proj.centerPx;
    ctx.strokeStyle = SCOPE_OUTER_COLOR;
    ctx.lineWidth = SCOPE_LINE_WIDTH_PX;
    ctx.beginPath();
    ctx.arc(center.x, center.y, proj.radiusPx, 0, TAU);
    ctx.stroke();
  };

  const drawBearingTicks = (proj: Projection): void => {
    ctx.strokeStyle = TICK_COLOR;
    ctx.lineWidth = TICK_LINE_WIDTH_PX;
    ctx.font = `${BEARING_LABEL_FONT_PX}px ${MONOSPACE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = 0; deg < 360; deg += TICK_MINOR_DEG) {
      const major = deg % TICK_MAJOR_DEG === 0;
      const tickLength = Math.min(
        major ? TICK_MAJOR_LENGTH_PX : TICK_MINOR_LENGTH_PX,
        Math.max(0, proj.radiusPx),
      );

      const outer = pointAtBearing(proj, deg, proj.radiusPx);
      const inner = pointAtBearing(proj, deg, proj.radiusPx - tickLength);

      ctx.beginPath();
      ctx.moveTo(outer.x, outer.y);
      ctx.lineTo(inner.x, inner.y);
      ctx.stroke();

      if (major) {
        ctx.fillStyle = BEARING_LABEL_COLOR;
        const label = pointAtBearing(proj, deg, proj.radiusPx + BEARING_LABEL_OFFSET_PX);
        ctx.fillText(String(deg).padStart(3, '0'), label.x, label.y);
      }
    }
  };

  const drawSweep = (proj: Projection, sweepBearing: number): void => {
    const center = proj.centerPx;

    for (let i = 0; i < SWEEP_SEGMENTS; i += 1) {
      const startBearing = sweepBearing - SWEEP_TRAIL_DEG * ((i + 1) / SWEEP_SEGMENTS);
      const endBearing = sweepBearing - SWEEP_TRAIL_DEG * (i / SWEEP_SEGMENTS);
      const startAngle = bearingToScreenAngle(startBearing);
      const endAngle = bearingToScreenAngle(endBearing);

      ctx.globalAlpha = SWEEP_AFTERGLOW_ALPHA * (1 - i / SWEEP_SEGMENTS);
      ctx.fillStyle = SWEEP_COLOR;
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.arc(center.x, center.y, proj.radiusPx, startAngle, endAngle);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.strokeStyle = SWEEP_LINE_COLOR;
    ctx.lineWidth = SWEEP_LINE_WIDTH_PX;

    const angle = bearingToScreenAngle(sweepBearing);
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(center.x + Math.cos(angle) * proj.radiusPx, center.y + Math.sin(angle) * proj.radiusPx);
    ctx.stroke();
  };

  const drawOwnShip = (proj: Projection, ownShip: OwnShip): void => {
    const center = proj.centerPx;
    const angle = bearingToScreenAngle(ownShip.courseDeg);
    const headingLength = Math.max(OWN_SHIP_HEADING_MIN_PX, proj.radiusPx * OWN_SHIP_HEADING_RATIO);

    ctx.strokeStyle = OWN_SHIP_COLOR;
    ctx.fillStyle = OWN_SHIP_COLOR;
    ctx.lineWidth = OWN_SHIP_LINE_WIDTH_PX;

    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(center.x + Math.cos(angle) * headingLength, center.y + Math.sin(angle) * headingLength);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(center.x, center.y, OWN_SHIP_SYMBOL_RADIUS_PX, 0, TAU);
    ctx.fill();
  };

  const drawContacts = (proj: Projection, contacts: RadarContact[], nowMs: number): void => {
    ctx.font = `${LABEL_FONT_PX}px ${MONOSPACE_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (const contact of contacts) {
      if (!contact.alive) {
        continue;
      }
      if (!isInsideScope(proj, contact.position)) {
        continue;
      }

      const screen = projectionWorldToScreen(proj, contact.position);
      const color = CLASSIFICATION_COLORS[contact.classification] ?? '#ffffff';
      const alpha = contact.faded
        ? isFlickerOff(nowMs, contact.trackId)
          ? FADED_OFF_ALPHA
          : FADED_ALPHA
        : 1;

      const history = contact.history ?? [];
      for (let i = 0; i < history.length; i += 1) {
        const h = history[i];
        if (!h) {
          continue;
        }

        const hp = projectionWorldToScreen(proj, h);
        ctx.globalAlpha = alpha * (0.2 + 0.8 * ((i + 1) / history.length));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(hp.x, hp.y, HISTORY_DOT_RADIUS_PX, 0, TAU);
        ctx.fill();
      }

      ctx.globalAlpha = alpha;

      const capped = cappedLeaderLengthPx(contact.speedKts, proj);
      const leader =
        contact.speedKts <= 0
          ? 0
          : Math.min(
              Math.max(capped, LEADER_MIN_PX),
              proj.radiusPx * LEADER_MAX_SCOPE_FRACTION,
            );

      if (leader > 0) {
        const angle = bearingToScreenAngle(contact.courseDeg);
        ctx.strokeStyle = color;
        ctx.lineWidth = SYMBOL_LINE_WIDTH_PX;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y);
        ctx.lineTo(screen.x + Math.cos(angle) * leader, screen.y + Math.sin(angle) * leader);
        ctx.stroke();
      }

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = SYMBOL_LINE_WIDTH_PX;

      if (contact.domain === 'air') {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, SYMBOL_RADIUS_PX, Math.PI, 0);
        ctx.stroke();
      } else if (contact.domain === 'surface') {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, SYMBOL_RADIUS_PX, 0, TAU);
        ctx.stroke();
      } else {
        const s = MISSILE_SIZE_PX;
        ctx.beginPath();
        ctx.moveTo(screen.x, screen.y - s);
        ctx.lineTo(screen.x + s, screen.y);
        ctx.lineTo(screen.x, screen.y + s);
        ctx.lineTo(screen.x - s, screen.y);
        ctx.closePath();
        ctx.fill();
      }

      const { lines, x: labelX, y: labelY } = contactLabelInfo(contact, screen);

      ctx.fillStyle = color;
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i] ?? '', labelX, labelY + i * LABEL_LINE_HEIGHT_PX);
      }
    }

    ctx.globalAlpha = 1;
  };

  const drawSelected = (proj: Projection, view: RadarView): void => {
    if (view.selectedId === null) {
      return;
    }

    for (const contact of view.contacts) {
      if (!contact.alive) {
        continue;
      }
      if (!isInsideScope(proj, contact.position)) {
        continue;
      }
      if (contact.id !== view.selectedId && contact.trackId !== view.selectedId) {
        continue;
      }

      const screen = projectionWorldToScreen(proj, contact.position);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = SELECTED_COLOR;
      ctx.lineWidth = SELECTED_LINE_WIDTH_PX;
      ctx.setLineDash([SELECTED_DASH_PX, SELECTED_DASH_PX]);
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, SELECTED_RADIUS_PX, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
  };

  const render = (view: RadarView): void => {
    const { cssWidth, cssHeight } = measure();
    const dpr = positiveFinite(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1);
    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);

    if (canvas.width !== backingWidth) {
      canvas.width = backingWidth;
    }
    if (canvas.height !== backingHeight) {
      canvas.height = backingHeight;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    lastOwnShipPosition = { ...view.ownShip.position };
    projection = makeProjection(cssWidth, cssHeight, rangeNm, view.ownShip.position, PADDING_PX);

    const rawNow = nowFn();
    const nowMs = Number.isFinite(rawNow) ? rawNow : 0;
    const sweepPhase = ((nowMs % SWEEP_PERIOD_MS) + SWEEP_PERIOD_MS) % SWEEP_PERIOD_MS;
    const sweepBearing = (sweepPhase / SWEEP_PERIOD_MS) * 360;

    const center = projection.centerPx;

    drawRings(projection, view.contacts);
    drawScopeOuter(projection);
    drawBearingTicks(projection);

    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, projection.radiusPx, 0, TAU);
    ctx.clip();

    drawSweep(projection, sweepBearing);
    drawOwnShip(projection, view.ownShip);
    drawContacts(projection, view.contacts, nowMs);

    ctx.restore();

    drawSelected(projection, view);
  };

  const destroy = (): void => {
    canvas.removeEventListener('wheel', onWheel);
    projection = null;
  };

  return {
    render,
    setRange,
    getRange: () => rangeNm,
    screenToWorld: (px: number, py: number): Vec2 => projectionScreenToWorld(currentProjection(), px, py),
    worldToScreen: (pos: Vec2): Vec2 => projectionWorldToScreen(currentProjection(), pos),
    destroy,
  };
}
