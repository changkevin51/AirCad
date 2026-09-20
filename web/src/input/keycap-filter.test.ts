import { describe, expect, it } from 'vitest';
import { KeycapFilter } from './keycap-filter';
import { v2 } from '../model/vec';

describe('keycap smoothing from the supplied prototype', () => {
  it.each([15, 30, 60, 120])('bounds lag and interpolates through stops and reversals at %i fps', (fps) => {
    const filter = new KeycapFilter();
    let previous = v2(0, 0);
    for (let i = 0; i < fps * 3; i++) {
      const t = i / fps;
      const x = t < 1 ? t * 600 : t < 2 ? 600 : 600 - (t - 2) * 600;
      const raw = v2(x, x / 2);
      const point = filter.filter(raw, t);
      expect(Math.hypot(point.x - raw.x, point.y - raw.y)).toBeLessThanOrEqual(1.00001);
      expect(point.x).toBeGreaterThanOrEqual(Math.min(previous.x, x) - 1e-9);
      expect(point.x).toBeLessThanOrEqual(Math.max(previous.x, x) + 1e-9);
      previous = point;
    }
  });

  it('reduces stationary noise and resets across a missing-frame gap', () => {
    const filter = new KeycapFilter();
    let squaredRaw = 0, squaredOutput = 0;
    for (let i = 0; i < 120; i++) {
      const noise = Math.sin(i * 2.3) * .7;
      const output = filter.filter(v2(100 + noise, 100), i / 60);
      squaredRaw += noise ** 2;
      squaredOutput += (output.x - 100) ** 2;
    }
    expect(squaredOutput).toBeLessThan(squaredRaw * .5);
    expect(filter.filter(v2(500, 200), 3)).toEqual(v2(500, 200));
  });
});
