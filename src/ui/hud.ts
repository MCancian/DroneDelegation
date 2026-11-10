export function formatClock(timeS: number, durationS = 900): string {
  const safeTime = Number.isFinite(timeS) ? timeS : 0;
  const clamped = Math.max(0, Math.min(safeTime, durationS));
  const elapsedSec = Math.floor(clamped);
  const durationSec = Math.floor(durationS);

  const eMin = Math.floor(elapsedSec / 60);
  const eSec = elapsedSec % 60;
  const dMin = Math.floor(durationSec / 60);
  const dSec = durationSec % 60;

  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(eMin)}:${pad(eSec)} / ${pad(dMin)}:${pad(dSec)}`;
}

export interface Hud {
  setClock(timeS: number): void;
  setHull(pct: number): void;
  setMissileAlert(text: string, active: boolean): void;
}

export function createHud(doc: Document = document, durationS = 900): Hud {
  const clockEl = doc.getElementById('clock');
  const hullEl = doc.getElementById('hull');
  const missileEl = doc.getElementById('missile-alert');

  let lastClockText = '';

  return {
    setClock(timeS: number): void {
      if (clockEl === null) return;
      const text = formatClock(timeS, durationS);
      if (text !== lastClockText) {
        lastClockText = text;
        clockEl.textContent = text;
      }
    },
    setHull(pct: number): void {
      if (hullEl === null) return;
      hullEl.textContent = `Hull ${Math.round(pct)}%`;
      hullEl.classList.toggle('hull-damaged', pct < 100);
      hullEl.classList.toggle('hull-critical', pct <= 35);
    },
    setMissileAlert(text: string, active: boolean): void {
      if (!missileEl) return;
      if (missileEl.textContent !== text) missileEl.textContent = text;
      missileEl.classList.toggle('missile-active', active);
    },
  };
}
