import { describe, expect, it } from 'vitest';
import { Commands } from './commands';
import { WorkPlane } from './plane';
import {
  completeLineRectangle,
  completeSharedBorder,
  sameRectangle,
  type CompletionContext,
} from './rect-completion';
import { makeRect, Sketch, type RectEntity } from './sketch';
import type { SnapResult } from './snap';
import { resolveStroke, StrokeSession } from './stroke';
import { seededRandom, topViewProjector } from './test-helpers';
import { add, scale, toArray, v2, v3, type Vec2, type Vec3 } from './vec';

const XY = new WorkPlane('XY');
const projector = topViewProjector(0.1, 400, 300);

function floorSketch(): Sketch {
  const sketch = new Sketch();
  sketch.addEntity({ type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000) });
  return sketch;
}

function context(sketch: Sketch, plane: WorkPlane = XY, gridStep = 0): CompletionContext {
  return { plane, entities: sketch.all, gridStep };
}

function sideStroke(corners: readonly Vec2[], options: { jitter?: number; pointsPerSide?: number; seed?: number } = {}): Vec2[] {
  const { jitter = 0, pointsPerSide = 30, seed = 9 } = options;
  const rand = seededRandom(seed);
  const points: Vec2[] = [];
  for (let side = 0; side < 3; side++) {
    const a = corners[side];
    const b = corners[side + 1];
    for (let i = side === 0 ? 0 : 1; i <= pointsPerSide; i++) {
      const t = i / pointsPerSide;
      const j = i === pointsPerSide ? 0 : jitter;
      points.push(v2(a.x + (b.x - a.x) * t + (rand() - 0.5) * j, a.y + (b.y - a.y) * t + (rand() - 0.5) * j));
    }
  }
  return points;
}

function snapOf(world: Vec3, type: SnapResult['type'] = 'free', plane: WorkPlane = XY): SnapResult {
  return {
    type,
    world,
    plane: plane.toPlane(world),
    screen: projector.project(world) ?? v2(0, 0),
    onPlane: plane.contains(world),
    raw: world,
  };
}

const floorAdjacent = () => sideStroke([v2(4000, 0), v2(7000, 0), v2(7000, 3000), v2(4000, 3000)]);

describe('sameRectangle', () => {
  const rect = [v3(0, 0, 0), v3(4000, 0, 0), v3(4000, 3000, 0), v3(0, 3000, 0)];

  it('matches cyclic rotations and reversed ordering', () => {
    expect(sameRectangle(rect, [v3(4000, 3000, 0), v3(0, 3000, 0), v3(0, 0, 0), v3(4000, 0, 0)])).toBe(true);
    expect(sameRectangle(rect, [v3(4000, 0, 0), v3(0, 0, 0), v3(0, 3000, 0), v3(4000, 3000, 0)])).toBe(true);
    expect(sameRectangle(rect, rect)).toBe(true);
  });

  it('rejects different rectangles', () => {
    expect(sameRectangle(rect, [v3(0, 0, 0), v3(4001, 0, 0), v3(4001, 3000, 0), v3(0, 3000, 0)])).toBe(false);
    expect(sameRectangle(rect, [v3(0, 0, 0), v3(1, 0, 0), v3(1, 1, 0)])).toBe(false);
  });
});

describe('completeSharedBorder', () => {
  it('completes a three-sided stroke against a floor edge with exact corners', () => {
    const sketch = floorSketch();
    const completion = completeSharedBorder(floorAdjacent(), v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.corners).toEqual([v3(4000, 0, 0), v3(7000, 0, 0), v3(7000, 3000, 0), v3(4000, 3000, 0)]);
    expect(completion!.removeIds).toEqual([]);
  });

  it('accepts the shared border drawn in reverse', () => {
    const sketch = floorSketch();
    const path = sideStroke([v2(4000, 3000), v2(7000, 3000), v2(7000, 0), v2(4000, 0)]);
    const completion = completeSharedBorder(path, v3(4000, 3000, 0), v3(4000, 0, 0), context(sketch));
    expect(completion).not.toBeNull();
    expect(sameRectangle(completion!.corners, [v3(4000, 0, 0), v3(7000, 0, 0), v3(7000, 3000, 0), v3(4000, 3000, 0)])).toBe(true);
  });

  it('raises a wall on an XZ plane from a floor edge that is not coplanar with the floor face', () => {
    const sketch = floorSketch();
    const plane = new WorkPlane('XZ');
    const path = sideStroke([v2(0, 0), v2(0, 2500), v2(4000, 2500), v2(4000, 0)]);
    const completion = completeSharedBorder(path, v3(0, 0, 0), v3(4000, 0, 0), context(sketch, plane));
    expect(completion).not.toBeNull();
    expect(completion!.corners).toEqual([v3(0, 0, 0), v3(0, 0, 2500), v3(4000, 0, 2500), v3(4000, 0, 0)]);
  });

  it('works on the YZ plane too', () => {
    const sketch = floorSketch();
    const plane = new WorkPlane('YZ');
    const path = sideStroke([v2(0, 0), v2(0, 2500), v2(3000, 2500), v2(3000, 0)]);
    const completion = completeSharedBorder(path, v3(0, 0, 0), v3(0, 3000, 0), context(sketch, plane));
    expect(completion).not.toBeNull();
    expect(completion!.corners).toEqual([v3(0, 0, 0), v3(0, 0, 2500), v3(0, 3000, 2500), v3(0, 3000, 0)]);
  });

  it('follows a rotated shared border and absorbs the standalone line', () => {
    for (const degrees of [30, 6]) {
      const sketch = new Sketch();
      const angle = (degrees * Math.PI) / 180;
      const u = v3(Math.cos(angle), Math.sin(angle), 0);
      const end = scale(u, 4000);
      const border = sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: end });
      const v = v3(-Math.sin(angle), Math.cos(angle), 0);
      const far = (p: Vec3) => add(p, scale(v, 2500));
      const path = sideStroke([
        v2(0, 0),
        v2(far(v3(0, 0, 0)).x, far(v3(0, 0, 0)).y),
        v2(far(end).x, far(end).y),
        v2(end.x, end.y),
      ]);
      const completion = completeSharedBorder(path, v3(0, 0, 0), end, context(sketch));
      expect(completion, `${degrees} degree border`).not.toBeNull();
      expect(sameRectangle(completion!.corners, makeRect(v3(0, 0, 0), v, u, 2500, 4000))).toBe(true);
      expect(completion!.removeIds).toEqual([border.id]);
    }
  });

  it('tolerates freehand jitter and rounds only the new far edge to the grid', () => {
    const sketch = floorSketch();
    const path = sideStroke([v2(4000, 0), v2(7000, 0), v2(7000, 3000), v2(4000, 3000)], { jitter: 25, seed: 4 });
    const rough = completeSharedBorder(path, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch));
    expect(rough).not.toBeNull();
    expect(rough!.corners[0]).toEqual(v3(4000, 0, 0));
    expect(rough!.corners[3]).toEqual(v3(4000, 3000, 0));
    const snapped = completeSharedBorder(path, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch, XY, 100));
    expect(snapped).not.toBeNull();
    expect(snapped!.corners).toEqual([v3(4000, 0, 0), v3(7000, 0, 0), v3(7000, 3000, 0), v3(4000, 3000, 0)]);
  });

  it('rounds only the new far edge after validating the drawn sides', () => {
    const sketch = floorSketch();
    const path = sideStroke([v2(4000, 0), v2(5250, 0), v2(5250, 3000), v2(4000, 3000)]);
    const completion = completeSharedBorder(path, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch, XY, 1000));
    expect(completion).not.toBeNull();
    expect(completion!.corners).toEqual([v3(4000, 0, 0), v3(5000, 0, 0), v3(5000, 3000, 0), v3(4000, 3000, 0)]);
  });

  it('keeps a valid small rectangle when grid rounding would collapse it', () => {
    const sketch = floorSketch();
    const path = sideStroke([v2(4000, 0), v2(4400, 0), v2(4400, 3000), v2(4000, 3000)]);
    const completion = completeSharedBorder(path, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch, XY, 1000));
    expect(completion).not.toBeNull();
    expect(completion!.corners[1].x).toBeCloseTo(4400, 6);
    expect(completion!.corners[0]).toEqual(v3(4000, 0, 0));
    expect(completion!.corners[3]).toEqual(v3(4000, 3000, 0));
  });

  it('uses a subsegment of a longer border without absorbing it', () => {
    const sketch = new Sketch();
    const border = sketch.addEntity({ type: 'line', a: v3(4000, -1000, 0), b: v3(4000, 4000, 0) });
    const completion = completeSharedBorder(floorAdjacent(), v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.removeIds).not.toContain(border.id);
  });

  it('welds contiguous collinear pieces into one shared border', () => {
    const sketch = new Sketch();
    const first = sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(4000, 1500, 0) });
    const second = sketch.addEntity({ type: 'line', a: v3(4000, 1500, 0), b: v3(4000, 3000, 0) });
    const completion = completeSharedBorder(floorAdjacent(), v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.removeIds).toEqual([first.id, second.id]);
  });

  it('rejects a real 0.01 mm gap in the border', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(4000, 1499.995, 0) });
    sketch.addEntity({ type: 'line', a: v3(4000, 1500.005, 0), b: v3(4000, 3000, 0) });
    expect(completeSharedBorder(floorAdjacent(), v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch))).toBeNull();
  });

  it('still rejects the 0.01 mm gap when the border sits far from the origin', () => {
    const sketch = new Sketch();
    const shift = 1e8;
    sketch.addEntity({ type: 'line', a: v3(shift + 4000, 0, 0), b: v3(shift + 4000, 1499.995, 0) });
    sketch.addEntity({ type: 'line', a: v3(shift + 4000, 1500.005, 0), b: v3(shift + 4000, 3000, 0) });
    const path = sideStroke([v2(shift + 4000, 0), v2(shift + 7000, 0), v2(shift + 7000, 3000), v2(shift + 4000, 3000)]);
    expect(completeSharedBorder(path, v3(shift + 4000, 0, 0), v3(shift + 4000, 3000, 0), context(sketch))).toBeNull();
  });

  it('rejects an off-plane edge that only overlaps in projection', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 1000), b: v3(4000, 3000, 1000) });
    expect(completeSharedBorder(floorAdjacent(), v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch))).toBeNull();
  });

  it('rejects paths that do not form a U around the border', () => {
    const sketch = floorSketch();
    const triangle = sideStroke([v2(4000, 0), v2(5500, 1500), v2(5500, 1500), v2(4000, 3000)]);
    expect(completeSharedBorder(triangle, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch))).toBeNull();
    const bulge = sideStroke([v2(4000, 0), v2(7100, -800), v2(7100, 3800), v2(4000, 3000)]);
    expect(completeSharedBorder(bulge, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch))).toBeNull();
    const straight = sideStroke([v2(4000, 0), v2(4000, 1000), v2(4000, 2000), v2(4000, 3000)]);
    expect(completeSharedBorder(straight, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch))).toBeNull();
  });

  it('rejects strokes that stray to both sides of the border', () => {
    const sketch = floorSketch();
    const crossing = sideStroke([v2(4000, 0), v2(3000, 0), v2(7000, 3000), v2(4000, 3000)]);
    expect(completeSharedBorder(crossing, v3(4000, 0, 0), v3(4000, 3000, 0), context(sketch))).toBeNull();
  });
});

describe('completeLineRectangle', () => {
  function twoSides(sketch: Sketch): string[] {
    return [
      sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(7000, 0, 0) }).id,
      sketch.addEntity({ type: 'line', a: v3(7000, 0, 0), b: v3(7000, 3000, 0) }).id,
    ];
  }

  const proposed = () => ({ type: 'line' as const, a: v3(4000, 3000, 0), b: v3(7000, 3000, 0) });

  it('assembles a rectangle from a proposed line plus existing borders', () => {
    const sketch = floorSketch();
    const sides = twoSides(sketch);
    const completion = completeLineRectangle(proposed(), context(sketch));
    expect(completion).not.toBeNull();
    expect(sameRectangle(completion!.corners, [v3(4000, 0, 0), v3(7000, 0, 0), v3(7000, 3000, 0), v3(4000, 3000, 0)])).toBe(true);
    expect(completion!.removeIds).toEqual(sides);
  });

  it('supports a T-junction on a partial long border', () => {
    const sketch = new Sketch();
    const border = sketch.addEntity({ type: 'line', a: v3(4000, -1000, 0), b: v3(4000, 4000, 0) });
    const sides = twoSides(sketch);
    const completion = completeLineRectangle(proposed(), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.removeIds).toEqual(sides);
    expect(completion!.removeIds).not.toContain(border.id);
  });

  it('accepts a border split into contiguous collinear pieces', () => {
    const sketch = new Sketch();
    const ids = [
      sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(4000, 1500, 0) }).id,
      sketch.addEntity({ type: 'line', a: v3(4000, 1500, 0), b: v3(4000, 3000, 0) }).id,
      ...twoSides(sketch),
    ];
    const completion = completeLineRectangle(proposed(), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.removeIds.sort()).toEqual(ids.sort());
  });

  it('returns null when two faces are equally eligible', () => {
    const sketch = floorSketch();
    twoSides(sketch);
    sketch.addEntity({ type: 'line', a: v3(4000, 3000, 0), b: v3(4000, 6000, 0) });
    sketch.addEntity({ type: 'line', a: v3(4000, 6000, 0), b: v3(7000, 6000, 0) });
    sketch.addEntity({ type: 'line', a: v3(7000, 3000, 0), b: v3(7000, 6000, 0) });
    expect(completeLineRectangle(proposed(), context(sketch))).toBeNull();
  });

  it('returns null when the proposed line has a tail off the face', () => {
    const sketch = floorSketch();
    twoSides(sketch);
    const tailed = { type: 'line' as const, a: v3(4000, 3000, 0), b: v3(8000, 3000, 0) };
    expect(completeLineRectangle(tailed, context(sketch))).toBeNull();
  });

  it('returns null when the only face is an existing rectangle', () => {
    const sketch = floorSketch();
    twoSides(sketch);
    sketch.addEntity({ type: 'rect', corners: makeRect(v3(4000, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 3000, 3000) });
    expect(completeLineRectangle(proposed(), context(sketch))).toBeNull();
  });

  it('returns null for non-rectangular loops and off-plane lines', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(2000, 3000, 0) });
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(2000, 3000, 0) });
    expect(completeLineRectangle({ type: 'line', a: v3(0, 0, 0), b: v3(2000, 3000, 0) }, context(sketch))).toBeNull();

    const floor = floorSketch();
    expect(completeLineRectangle({ type: 'line', a: v3(4000, 3000, 500), b: v3(7000, 3000, 500) }, context(floor))).toBeNull();
  });

  it('leaves unrelated lines out of removeIds', () => {
    const sketch = floorSketch();
    twoSides(sketch);
    const stray = sketch.addEntity({ type: 'line', a: v3(9000, 9000, 0), b: v3(9500, 9500, 0) });
    const completion = completeLineRectangle(proposed(), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.removeIds).not.toContain(stray.id);
  });

  it('does not form a face when the proposed line only retraces an existing border', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(4000, 3000, 0) });
    sketch.addEntity({ type: 'line', a: v3(4000, 3000, 0), b: v3(0, 3000, 0) });
    sketch.addEntity({ type: 'line', a: v3(0, 3000, 0), b: v3(0, 0, 0) });
    expect(completeLineRectangle({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) }, context(sketch))).toBeNull();
  });

  it('accepts a line that partly retraces existing coverage but adds novel geometry', () => {
    const sketch = floorSketch();
    const sides = twoSides(sketch);
    const half = sketch.addEntity({ type: 'line', a: v3(4000, 3000, 0), b: v3(5500, 3000, 0) });
    const completion = completeLineRectangle(proposed(), context(sketch));
    expect(completion).not.toBeNull();
    expect(completion!.removeIds.sort()).toEqual([...sides, half.id].sort());
  });

  it('rejects a trapezoid face instead of relaxing it to a rectangle', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
    sketch.addEntity({ type: 'line', a: v3(4000, 0, 0), b: v3(3980, 3000, 0) });
    sketch.addEntity({ type: 'line', a: v3(0, 3000, 0), b: v3(0, 0, 0) });
    const closing = { type: 'line' as const, a: v3(3980, 3000, 0), b: v3(0, 3000, 0) };
    expect(completeLineRectangle(closing, context(sketch))).toBeNull();
  });

  it('welds a side split into thirty contiguous pieces', () => {
    const sketch = new Sketch();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(sketch.addEntity({ type: 'line', a: v3(4000, i * 100, 0), b: v3(4000, (i + 1) * 100, 0) }).id);
    }
    ids.push(...twoSides(sketch));
    const completion = completeLineRectangle(proposed(), context(sketch));
    expect(completion).not.toBeNull();
    expect(sameRectangle(completion!.corners, [v3(4000, 0, 0), v3(7000, 0, 0), v3(7000, 3000, 0), v3(4000, 3000, 0)])).toBe(true);
    expect(completion!.removeIds.sort()).toEqual(ids.sort());
  });
});

describe.each(['XY', 'XZ', 'YZ'] as const)('completeLineRectangle on the %s plane', (kind) => {
  const plane = new WorkPlane(kind);
  const w = (x: number, y: number): Vec3 => plane.toWorld(v2(x, y));
  const rectCorners = [w(4000, 0), w(7000, 0), w(7000, 3000), w(4000, 3000)];

  function planeSketch(): Sketch {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'rect', corners: [w(0, 0), w(4000, 0), w(4000, 3000), w(0, 3000)] });
    return sketch;
  }

  it('assembles the rectangle from the last line', () => {
    const sketch = planeSketch();
    const ids = [
      sketch.addEntity({ type: 'line', a: w(4000, 0), b: w(7000, 0) }).id,
      sketch.addEntity({ type: 'line', a: w(7000, 0), b: w(7000, 3000) }).id,
    ];
    const completion = completeLineRectangle({ type: 'line', a: w(4000, 3000), b: w(7000, 3000) }, context(sketch, plane));
    expect(completion).not.toBeNull();
    expect(sameRectangle(completion!.corners, rectCorners)).toBe(true);
    expect(completion!.removeIds).toEqual(ids);
  });

  it('accepts the last line drawn in reverse', () => {
    const sketch = planeSketch();
    sketch.addEntity({ type: 'line', a: w(4000, 0), b: w(7000, 0) });
    sketch.addEntity({ type: 'line', a: w(7000, 0), b: w(7000, 3000) });
    const completion = completeLineRectangle({ type: 'line', a: w(7000, 3000), b: w(4000, 3000) }, context(sketch, plane));
    expect(completion).not.toBeNull();
    expect(sameRectangle(completion!.corners, rectCorners)).toBe(true);
  });
});

describe('completeLineRectangle on rotated geometry', () => {
  const angle = Math.PI / 6;
  const rot = (x: number, y: number): Vec2 => v2(x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle));
  const rw = (x: number, y: number): Vec3 => XY.toWorld(rot(x, y));

  it('assembles a rectangle rotated 30 degrees in the plane', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'rect', corners: [rw(0, 0), rw(4000, 0), rw(4000, 3000), rw(0, 3000)] });
    const ids = [
      sketch.addEntity({ type: 'line', a: rw(4000, 0), b: rw(7000, 0) }).id,
      sketch.addEntity({ type: 'line', a: rw(7000, 0), b: rw(7000, 3000) }).id,
    ];
    const completion = completeLineRectangle({ type: 'line', a: rw(4000, 3000), b: rw(7000, 3000) }, context(sketch));
    expect(completion).not.toBeNull();
    expect(sameRectangle(completion!.corners, [rw(4000, 0), rw(7000, 0), rw(7000, 3000), rw(4000, 3000)])).toBe(true);
    expect(completion!.removeIds).toEqual(ids);
  });
});

describe('completion through resolveStroke + commitStroke', () => {
  it('assembles separate lines into one rectangle with exact undo/redo snapshots', () => {
    const sketch = floorSketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(4000, 0, 0), v3(7000, 0, 0));
    commands.addLine(v3(7000, 0, 0), v3(7000, 3000, 0));
    const before = sketch.serialize();

    const session = new StrokeSession(XY, snapOf(v3(4000, 3000, 0), 'vertex'));
    session.add(snapOf(v3(5500, 3000, 0)), v3(5500, 3000, 0), v2(950, 0));
    session.add(snapOf(v3(7000, 3000, 0), 'vertex'), v3(7000, 3000, 0), v2(1100, 0));
    const resolution = resolveStroke(session, {
      projector,
      vertices: sketch.vertices(),
      entities: sketch.all,
      tolerancePx: 14,
    });
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') return;
    expect(resolution.reason).toBe('assembled rectangle');
    expect(resolution.removeIds).toEqual(['e2', 'e3']);

    const commit = commands.commitStroke(resolution.input, resolution.removeIds);
    expect(commit.ok).toBe(true);
    const after = sketch.serialize();
    expect(sketch.all.map((entity) => entity.id)).toEqual(['e1', 'e4']);

    sketch.undo();
    expect(sketch.serialize()).toBe(before);
    sketch.redo();
    expect(sketch.serialize()).toBe(after);
  });

  it('exports the completed rectangle as ordinary millimetre geometry that stays editable', () => {
    const sketch = floorSketch();
    const commands = new Commands(sketch);
    commands.addLine(v3(4000, 0, 0), v3(7000, 0, 0));
    commands.addLine(v3(7000, 0, 0), v3(7000, 3000, 0));
    const session = new StrokeSession(XY, snapOf(v3(4000, 3000, 0), 'vertex'));
    session.add(snapOf(v3(7000, 3000, 0), 'vertex'), v3(7000, 3000, 0), v2(1100, 0));
    const resolution = resolveStroke(session, {
      projector,
      vertices: sketch.vertices(),
      entities: sketch.all,
      tolerancePx: 14,
    });
    if (resolution.status !== 'ready') throw new Error('expected a ready resolution');
    const commit = commands.commitStroke(resolution.input, resolution.removeIds);
    expect(commit.ok).toBe(true);
    const rect = commit.ok ? (commit.entity as RectEntity) : null;
    expect(rect?.type).toBe('rect');
    expect(commands.exportPayload()).toEqual({
      units: 'mm',
      entities: [
        { type: 'rect', points: [[0, 0, 0], [4000, 0, 0], [4000, 3000, 0], [0, 3000, 0]] },
        { type: 'rect', points: rect!.corners.map(toArray) },
      ],
    });
    expect(commands.setDimension(rect!.id, '5000x2000').ok).toBe(true);
    expect(commands.deleteEntity(rect!.id).ok).toBe(true);
  });
});
