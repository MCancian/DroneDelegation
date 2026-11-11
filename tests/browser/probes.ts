import type { Page } from '@playwright/test';

declare global {
  interface Window {
    smokeProbe: {
      arcs: { x: number; y: number; radius: number }[];
      contexts: AudioContext[];
      oscillatorStarts: number;
      trustedGestures: number;
    };
  }
}

/** Observe native drawing/audio; preserve browser implementations and gestures. */
export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = window.smokeProbe = { arcs: [], contexts: [], oscillatorStarts: 0, trustedGestures: 0 } as Window['smokeProbe'];
    document.addEventListener('pointerdown', (event) => { if (event.isTrusted) probe.trustedGestures++; }, true);
    const clearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'radar-canvas') probe.arcs = [];
      return clearRect.apply(this, args);
    };
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...args) {
      if (this.canvas.id === 'radar-canvas') probe.arcs.push({ x: args[0], y: args[1], radius: args[2] });
      return arc.apply(this, args);
    };
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        probe.contexts.push(this);
      }
      override createOscillator(): OscillatorNode {
        const oscillator = super.createOscillator();
        const nativeStart = oscillator.start.bind(oscillator);
        oscillator.start = (when?: number) => { probe.oscillatorStarts++; nativeStart(when); };
        return oscillator;
      }
    };
  });
}

export async function startWatch(page: Page, url: string): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto(`${url}/?seed=1`);
  await page.getByRole('heading', { name: 'Take command with Jarvis' }).waitFor();
  // Pause while briefing prevents simulation progress. runFor fires every rAF.
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
}

export async function render(page: Page): Promise<void> {
  await page.clock.runFor(32);
}
