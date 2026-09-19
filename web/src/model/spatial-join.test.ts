import { describe, expect, it } from 'vitest';
import { joinEndpoints, shouldCloseLoop } from './spatial-join';
import { v3 } from './vec';

describe('joinEndpoints', () => {
  it('pulls line endpoints onto nearby vertices', () => {
    const joined = joinEndpoints(
      { type: 'line', a: v3(35, 0, 0), b: v3(4030, 8, 4) },
      {
        vertices: [
          { point: v3(0, 0, 0), entityId: 'a', index: 0 },
          { point: v3(4000, 0, 0), entityId: 'b', index: 1 },
        ],
      },
      40,
    );
    expect(joined).toEqual({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
  });

  it('moves whole rectangle edges so the result stays a rectangle', () => {
    const joined = joinEndpoints(
      {
        type: 'rect',
        corners: [v3(12, 0, 0), v3(2010, 0, 0), v3(2010, 1500, 0), v3(12, 1500, 0)],
      },
      {
        vertices: [
          { point: v3(0, 0, 0), entityId: 'a', index: 0 },
          { point: v3(2000, 0, 0), entityId: 'b', index: 1 },
        ],
      },
      40,
    );
    expect(joined.type).toBe('rect');
    if (joined.type === 'rect') {
      expect(joined.corners[0].x).toBeCloseTo(0, 1);
      expect(joined.corners[0].y).toBeCloseTo(0, 1);
      expect(joined.corners[1].x).toBeCloseTo(2000, 1);
      expect(joined.corners[1].y).toBeCloseTo(0, 1);
      const width = Math.hypot(joined.corners[1].x - joined.corners[0].x, joined.corners[1].y - joined.corners[0].y);
      const height = Math.hypot(joined.corners[3].x - joined.corners[0].x, joined.corners[3].y - joined.corners[0].y);
      expect(width).toBeGreaterThan(1000);
      expect(height).toBeGreaterThan(1000);
    }
  });

  it('closes a loop when pen-up is within the magnet radius of start', () => {
    expect(shouldCloseLoop(v3(0, 0, 0), v3(30, 8, 4), 40)).toBe(true);
    expect(shouldCloseLoop(v3(0, 0, 0), v3(80, 0, 0), 40)).toBe(false);
  });
});
