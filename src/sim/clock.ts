export const STEP_MS = 100;
export const STEP_S = STEP_MS / 1000;
export const GAME_DURATION_S = 900;
export const MAX_STEPS_PER_FRAME = 2000;

export interface GameClockOptions {
  timescale?: number;
  durationS?: number;
  maxStepsPerFrame?: number;
}

type StepCallback = (dtS: number, timeS: number) => void;
type EndCallback = (timeS: number) => void;

export class GameClock {
  private _steps = 0;
  private _accumulatorMs = 0;
  private _ended = false;
  private readonly _timescale: number;
  private readonly _durationS: number;
  private readonly _maxStepsPerFrame: number;
  private readonly _totalSteps: number;
  private readonly _stepCallbacks = new Set<StepCallback>();
  private readonly _endCallbacks = new Set<EndCallback>();

  constructor(options: GameClockOptions = {}) {
    const ts = options.timescale ?? 1;
    this._timescale = Number.isFinite(ts) && ts > 0 ? ts : 1;
    this._durationS = options.durationS ?? GAME_DURATION_S;
    this._maxStepsPerFrame = options.maxStepsPerFrame ?? MAX_STEPS_PER_FRAME;
    this._totalSteps = Math.round((this._durationS * 1000) / STEP_MS);
  }

  get steps(): number {
    return this._steps;
  }

  get time(): number {
    return (this._steps * STEP_MS) / 1000;
  }

  get timescale(): number {
    return this._timescale;
  }

  get durationS(): number {
    return this._durationS;
  }

  get ended(): boolean {
    return this._ended;
  }

  get pendingSteps(): number {
    if (this._ended) return 0;
    return Math.floor(this._accumulatorMs / STEP_MS);
  }

  onStep(cb: StepCallback): () => void {
    this._stepCallbacks.add(cb);
    return () => {
      this._stepCallbacks.delete(cb);
    };
  }

  onEnd(cb: EndCallback): () => void {
    this._endCallbacks.add(cb);
    return () => {
      this._endCallbacks.delete(cb);
    };
  }

  finish(): void {
    if (this._ended) return;
    this._ended = true;
    this._accumulatorMs = 0;
    const timeS = this.time;
    for (const cb of this._endCallbacks) {
      cb(timeS);
    }
  }

  advance(wallDeltaS: number): number {
    if (this._ended) return 0;

    if (Number.isFinite(wallDeltaS) && wallDeltaS >= 0) {
      this._accumulatorMs += wallDeltaS * 1000 * this._timescale;
    }

    let executed = 0;

    while (
      this._accumulatorMs >= STEP_MS - 1e-6 &&
      executed < this._maxStepsPerFrame &&
      !this._ended
    ) {
      this._accumulatorMs -= STEP_MS;
      this._steps += 1;
      executed += 1;

      const timeS = (this._steps * STEP_MS) / 1000;

      for (const cb of this._stepCallbacks) {
        cb(STEP_S, timeS);
      }

      if (this._steps >= this._totalSteps) {
        this.finish();
        break;
      }
    }

    return executed;
  }
}
