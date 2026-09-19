import { v2, type Vec2 } from '../model/vec';

/**
 * One-Euro filter (Casiez et al.): low jitter when the pointer is slow,
 * low lag when it moves fast.  Time is in seconds.
 */
export interface OneEuroOptions {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}

export const DEFAULT_ONE_EURO: OneEuroOptions = { minCutoff: 1.2, beta: 0.01, dCutoff: 1.0 };

class LowPass {
  private value: number | null = null;

  filter(x: number, alpha: number): number {
    this.value = this.value === null ? x : this.value + alpha * (x - this.value);
    return this.value;
  }

  get last(): number | null {
    return this.value;
  }

  reset(): void {
    this.value = null;
  }
}

function smoothingFactor(dt: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private lastTime: number | null = null;
  readonly options: OneEuroOptions;

  constructor(options: Partial<OneEuroOptions> = {}) {
    this.options = { ...DEFAULT_ONE_EURO, ...options };
  }

  filter(value: number, timeS: number): number {
    if (this.lastTime === null || timeS <= this.lastTime) {
      this.lastTime = timeS;
      this.dx.filter(0, 1);
      return this.x.filter(value, 1);
    }
    const dt = timeS - this.lastTime;
    this.lastTime = timeS;
    const previous = this.x.last ?? value;
    const derivative = (value - previous) / dt;
    const edx = this.dx.filter(derivative, smoothingFactor(dt, this.options.dCutoff));
    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(edx);
    return this.x.filter(value, smoothingFactor(dt, cutoff));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTime = null;
  }
}

export class OneEuroFilter2D {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(options: Partial<OneEuroOptions> = {}) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
  }

  filter(point: Vec2, timeS: number): Vec2 {
    return v2(this.fx.filter(point.x, timeS), this.fy.filter(point.y, timeS));
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
