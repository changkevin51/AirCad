import { v2, type Vec2 } from '../model/vec';
import type { OneEuroOptions } from './one-euro';

const alpha = (cutoff: number, dt: number): number => {
  const response = 2 * Math.PI * cutoff * dt;
  return response / (1 + response);
};

/** The supplied keycap prototype's adaptive filter, in viewport CSS pixels. */
export class KeycapFilter {
  private point: Vec2 | null = null;
  private raw: Vec2 | null = null;
  private timestamp: number | null = null;
  private velocity = v2(0, 0);
  private readonly options: OneEuroOptions;

  constructor(options: Partial<OneEuroOptions> = {}) {
    this.options = { minCutoff: 1.5, beta: .12, dCutoff: 6, ...options };
  }

  reset(): void {
    this.point = this.raw = null;
    this.timestamp = null;
    this.velocity = v2(0, 0);
  }

  filter(raw: Vec2, timestamp: number): Vec2 {
    if (this.timestamp !== null && timestamp < this.timestamp && this.point) return this.point;
    if (timestamp === this.timestamp) {
      // Distinct packets can share a reduced-precision browser clock tick.
      // Take the measurement directly rather than divide by a zero interval.
      this.raw = this.point = { ...raw };
      this.velocity = v2(0, 0);
      return this.point;
    }
    const dt = this.timestamp === null ? Infinity : timestamp - this.timestamp;
    if (!this.point || !this.raw || dt > .15) {
      this.reset();
      this.point = { ...raw };
    } else {
      const derivative = alpha(this.options.dCutoff, dt);
      this.velocity.x += derivative * ((raw.x - this.raw.x) / dt - this.velocity.x);
      this.velocity.y += derivative * ((raw.y - this.raw.y) / dt - this.velocity.y);
      const cutoff = this.options.minCutoff + this.options.beta * Math.hypot(this.velocity.x, this.velocity.y);
      const distance = Math.hypot(raw.x - this.point.x, raw.y - this.point.y);
      const blend = Math.max(alpha(cutoff, dt), distance > 1 ? 1 - 1 / distance : 0);
      // Update the bounded state itself: no extrapolation on stops or reversals.
      this.point = v2(this.point.x + blend * (raw.x - this.point.x), this.point.y + blend * (raw.y - this.point.y));
    }
    this.raw = { ...raw };
    this.timestamp = timestamp;
    return this.point;
  }
}
