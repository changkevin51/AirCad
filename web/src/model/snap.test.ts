import { describe, expect, it } from 'vitest';
import { WorkPlane } from './plane';
import { adaptiveGridStep, snapCursor, type SnapContext, type SnapTargets } from './snap';
import { makeRect, Sketch, type Vertex } from './sketch';
import { frontViewProjector, topViewProjector } from './test-helpers';
import { v2, v3, type Vec2 } from './vec';

function targetsOf(sketch: Sketch): SnapTargets {
  return { vertices: sketch.vertices(), midpoints: sketch.midpoints(), segments: sketch.segments() };
}

function floorSketch(): Sketch {
  const sketch = new Sketch();
  sketch.addEntity({ type: 'rect', corners: makeRect(v3(0, 0, 0), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000) });
  return sketch;
}

// 0.1 px/mm: 10 mm per pixel, world origin at screen (400, 300).
const projector = topViewProjector(0.1, 400, 300);
const screenOf = (x: number, y: number) => projector.project(v3(x, y, 0))!;

function context(overrides: Partial<SnapContext>): SnapContext {
  return {
    cursor: v2(0, 0),
    projector,
    plane: new WorkPlane('XY'),
    targets: targetsOf(floorSketch()),
    gridStep: 100,
    gridEnabled: true,
    ...overrides,
  };
}

describe('snapCursor priorities', () => {
  it('snaps to a vertex within tolerance, beating a nearby edge', () => {
    const corner = screenOf(4000, 3000);
    const result = snapCursor(context({ cursor: v2(corner.x - 9, corner.y + 8) }));
    expect(result.type).toBe('vertex');
    expect(result.world).toEqual(v3(4000, 3000, 0));
    expect(result.onPlane).toBe(true);
    expect(result.entityId).toBe('e1');
  });

  it('prefers midpoints over edges and grid', () => {
    const mid = screenOf(2000, 0);
    const result = snapCursor(context({ cursor: v2(mid.x + 6, mid.y - 10) }));
    expect(result.type).toBe('midpoint');
    expect(result.world).toEqual(v3(2000, 0, 0));
  });

  it('snaps to an edge when no vertex or midpoint is close', () => {
    const onEdge = screenOf(1000, 0);
    const result = snapCursor(context({ cursor: v2(onEdge.x, onEdge.y - 7) }));
    expect(result.type).toBe('edge');
    expect(result.world.x).toBeCloseTo(1000);
    expect(result.world.y).toBeCloseTo(0);
  });

  it('falls back to the grid and then to free positions', () => {
    const cursor = screenOf(1234, 1567);
    const grid = snapCursor(context({ cursor }));
    expect(grid.type).toBe('grid');
    expect(grid.world).toEqual(v3(1200, 1600, 0));
    expect(grid.raw?.x).toBeCloseTo(1234);
    expect(grid.raw?.y).toBeCloseTo(1567);

    const free = snapCursor(context({ cursor, gridEnabled: false }));
    expect(free.type).toBe('free');
    expect(free.world.x).toBeCloseTo(1234);
    expect(free.world.y).toBeCloseTo(1567);
  });

  it('axis-aligns to the stroke start within 8 degrees and keeps grid on the free axis', () => {
    const start = v3(1000, 1000, 0);
    const nearlyHorizontal = snapCursor(context({ cursor: screenOf(2510, 1120), strokeStart: start }));
    expect(nearlyHorizontal.type).toBe('axis');
    expect(nearlyHorizontal.axis).toBe('u');
    expect(nearlyHorizontal.world).toEqual(v3(2500, 1000, 0));

    const nearlyVertical = snapCursor(context({ cursor: screenOf(1050, 2440), strokeStart: start }));
    expect(nearlyVertical.type).toBe('axis');
    expect(nearlyVertical.axis).toBe('v');
    expect(nearlyVertical.world).toEqual(v3(1000, 2400, 0));

    const diagonal = snapCursor(context({ cursor: screenOf(2000, 1800), strokeStart: start }));
    expect(diagonal.type).toBe('grid');
  });

  it('lets a vertex win over axis alignment', () => {
    const start = v3(0, 3020, 0);
    const corner = screenOf(4000, 3000);
    const result = snapCursor(context({ cursor: v2(corner.x - 4, corner.y), strokeStart: start }));
    expect(result.type).toBe('vertex');
  });

  it('reaches off-plane vertices through screen space', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 500, 0), b: v3(100, 500, 2500) });
    const plane = new WorkPlane('XZ', v3(0, 0, 0));
    const cursor = screenOf(100, 500);
    const result = snapCursor(context({ cursor: v2(cursor.x + 3, cursor.y), plane, targets: targetsOf(sketch) }));
    expect(result.type).toBe('vertex');
    expect(result.onPlane).toBe(false);
    expect(result.world.y).toBe(500);
  });

  it('hard-locks to a world axis through the stroke start', () => {
    const front = frontViewProjector(0.1, 400, 300);
    const start = v3(1000, 0, 0);
    const cursor = front.project(v3(1300, 0, 2000))!;
    const result = snapCursor(
      context({ cursor, projector: front, plane: new WorkPlane('XZ'), strokeStart: start, axisLock: 'z', gridStep: 100 }),
    );
    expect(result.type).toBe('lock');
    expect(result.axis).toBe('z');
    expect(result.world.x).toBeCloseTo(1000);
    expect(result.world.z).toBeCloseTo(2000);
  });

  it('reports a free off-plane point when the plane is edge-on', () => {
    const result = snapCursor(context({ cursor: v2(120, 80), plane: new WorkPlane('XZ') }));
    expect(result.type).toBe('free');
    expect(result.onPlane).toBe(false);
    expect(result.raw).toBeNull();
  });

  it('can ignore object snaps and exclude an entity', () => {
    const corner = screenOf(0, 0);
    const excluded = snapCursor(context({ cursor: corner, excludeEntityId: 'e1' }));
    expect(excluded.type).toBe('grid');
    const disabled = snapCursor(context({ cursor: corner, disableObjectSnaps: true }));
    expect(disabled.type).toBe('grid');
  });
});

describe('axis-aligned edge snaps', () => {
  function sketchWithCrossing(): Sketch {
    const sketch = floorSketch();
    sketch.addEntity({ type: 'line', a: v3(2537, -500, 0), b: v3(2537, 1600, 0) });
    sketch.addEntity({ type: 'line', a: v3(2000, 2537, 0), b: v3(3500, 2537, 0) });
    return sketch;
  }

  it('snaps the axis endpoint to the exact edge crossing off the grid', () => {
    const sketch = sketchWithCrossing();
    const result = snapCursor(
      context({ cursor: screenOf(2567, 1010), strokeStart: v3(1000, 1000, 0), targets: targetsOf(sketch) }),
    );
    expect(result.type).toBe('edge');
    expect(result.axis).toBe('u');
    expect(result.entityId).toBe('e2');
    expect(result.world).toEqual(v3(2537, 1000, 0));
  });

  it('does the same on the v axis', () => {
    const sketch = sketchWithCrossing();
    const result = snapCursor(
      context({ cursor: screenOf(2510, 2527), strokeStart: v3(2500, 500, 0), targets: targetsOf(sketch) }),
    );
    expect(result.type).toBe('edge');
    expect(result.axis).toBe('v');
    expect(result.entityId).toBe('e3');
    expect(result.world).toEqual(v3(2500, 2537, 0));
  });

  it('keeps vertex priority over an axis edge crossing', () => {
    const sketch = floorSketch();
    sketch.addEntity({ type: 'line', a: v3(2545, 1005, 0), b: v3(2545, 2000, 0) });
    const result = snapCursor(
      context({ cursor: screenOf(2545, 1010), strokeStart: v3(1000, 1000, 0), targets: targetsOf(sketch) }),
    );
    expect(result.type).toBe('vertex');
  });

  it('ignores excluded entities and disabled object snaps', () => {
    const sketch = sketchWithCrossing();
    const base = { cursor: screenOf(2567, 1010), strokeStart: v3(1000, 1000, 0), targets: targetsOf(sketch) };
    const excluded = snapCursor(context({ ...base, excludeEntityId: 'e2' }));
    expect(excluded.type).toBe('axis');
    expect(excluded.world).toEqual(v3(2600, 1000, 0));
    const disabled = snapCursor(context({ ...base, disableObjectSnaps: true }));
    expect(disabled.type).toBe('axis');
    expect(disabled.world).toEqual(v3(2600, 1000, 0));
  });

  it('snaps an axis-collinear segment as an edge at the cursor position', () => {
    const result = snapCursor(
      context({ cursor: screenOf(2500, 0), strokeStart: v3(1000, 0, 0) }),
    );
    expect(result.type).toBe('edge');
    expect(result.axis).toBe('u');
    expect(result.entityId).toBe('e1');
    expect(result.world.x).toBeCloseTo(2500);
    expect(result.world.y).toBeCloseTo(0);
    expect(result.world.z).toBeCloseTo(0);
  });

  it('clamps a collinear edge snap to the segment range', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(2000, 1000, 0), b: v3(3000, 1000, 0) });
    const targets = targetsOf(sketch);
    const near = snapCursor(
      context({ cursor: screenOf(3050, 1010), strokeStart: v3(1000, 1000, 0), targets }),
    );
    expect(near.type).toBe('vertex');
    expect(near.world).toEqual(v3(3000, 1000, 0));
    const far = snapCursor(
      context({ cursor: screenOf(3500, 1010), strokeStart: v3(1000, 1000, 0), targets }),
    );
    expect(far.type).toBe('axis');
    expect(far.world).toEqual(v3(3500, 1000, 0));
  });

  it('ignores crossings behind the stroke start or outside the tolerance', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(500, 0, 0), b: v3(500, 2000, 0) });
    sketch.addEntity({ type: 'line', a: v3(1500, 0, 0), b: v3(1500, 2000, 0) });
    const result = snapCursor(
      context({ cursor: screenOf(800, 1010), strokeStart: v3(1000, 1000, 0), targets: targetsOf(sketch) }),
    );
    expect(result.type).toBe('axis');
    expect(result.world).toEqual(v3(800, 1000, 0));
  });
});

describe('lenient edge snapping', () => {
  it('lets a nearby edge win over the soft axis fallback', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 1100, 0), b: v3(4000, 1100, 0) });
    const result = snapCursor(
      context({ cursor: screenOf(1000, 1080), strokeStart: v3(0, 1000, 0), targets: targetsOf(sketch), gridEnabled: false }),
    );
    expect(result.type).toBe('edge');
    expect(result.world).toEqual(v3(1000, 1100, 0));
  });

  it('reaches an edge within the wider default tolerance', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 0, 0), b: v3(4000, 0, 0) });
    const targets = targetsOf(sketch);
    const base = { targets, gridEnabled: false };
    const edge = snapCursor(context({ ...base, cursor: screenOf(1000, 180) }));
    expect(edge.type).toBe('edge');
    expect(edge.world).toEqual(v3(1000, 0, 0));
    expect(snapCursor(context({ ...base, cursor: screenOf(1000, 180), tolerancePx: 14 })).type).toBe('free');
    expect(snapCursor(context({ ...base, cursor: screenOf(1000, 230) })).type).toBe('free');
    expect(snapCursor(context({ ...base, cursor: screenOf(1000, 180), disableObjectSnaps: true })).type).toBe('free');
    expect(snapCursor(context({ ...base, cursor: screenOf(1000, 180), excludeEntityId: 'e1' })).type).toBe('free');
    const locked = snapCursor(
      context({ ...base, cursor: screenOf(1000, 180), strokeStart: v3(0, 500, 0), axisLock: 'x' }),
    );
    expect(locked.type).toBe('lock');
    expect(locked.world.x).toBeCloseTo(1000);
    expect(locked.world.y).toBeCloseTo(500);
  });

  it.each(['vertex', 'midpoint'] as const)(
    'keeps an off-plane %s behind a closer on-plane edge during a stroke',
    (kind) => {
      const offPlane: Vertex = { entityId: 'other', point: v3(1000, 175, 500), index: 0 };
      const targets: SnapTargets = {
        vertices: kind === 'vertex' ? [offPlane] : [],
        midpoints: kind === 'midpoint' ? [offPlane] : [],
        segments: [{ entityId: 'border', a: v3(0, 0, 0), b: v3(4000, 0, 0), index: 0 }],
      };
      const snap = (cursor: Vec2) =>
        snapCursor(context({ cursor, targets, gridEnabled: false, strokeStart: v3(1000, 1000, 0) }));
      const near = snap(screenOf(1000, 0));
      expect(near.type).toBe('edge');
      expect(near.world).toEqual(v3(1000, 0, 0));
      const exact = snap(screenOf(1000, 175));
      expect(exact.type).toBe(kind);
      expect(exact.world).toEqual(v3(1000, 175, 500));
    },
  );
});

describe('snap tie-breaking', () => {
  it('prefers the nearer vertex on a screen tie when idle', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 100, 0), b: v3(500, 500, 0) });
    sketch.addEntity({ type: 'line', a: v3(100, 100, 2500), b: v3(900, 900, 2500) });
    const result = snapCursor(context({ cursor: screenOf(100, 100), targets: targetsOf(sketch) }));
    expect(result.type).toBe('vertex');
    expect(result.entityId).toBe('e2');
    expect(result.world).toEqual(v3(100, 100, 2500));
  });

  it('prefers the on-plane vertex during a stroke', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 100, 0), b: v3(500, 500, 0) });
    sketch.addEntity({ type: 'line', a: v3(100, 100, 2500), b: v3(900, 900, 2500) });
    const result = snapCursor(
      context({ cursor: screenOf(100, 100), targets: targetsOf(sketch), strokeStart: v3(3000, 3000, 0) }),
    );
    expect(result.type).toBe('vertex');
    expect(result.entityId).toBe('e1');
    expect(result.onPlane).toBe(true);
  });

  it('applies the same depth and on-plane rules to edge snaps', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(0, 2000, 0), b: v3(4000, 2000, 0) });
    sketch.addEntity({ type: 'line', a: v3(0, 2000, 2500), b: v3(4000, 2000, 2500) });
    const base = { cursor: screenOf(1000, 2000), targets: targetsOf(sketch) };
    const idle = snapCursor(context(base));
    expect(idle.type).toBe('edge');
    expect(idle.entityId).toBe('e2');
    const stroking = snapCursor(context({ ...base, strokeStart: v3(3000, 3000, 0) }));
    expect(stroking.type).toBe('edge');
    expect(stroking.entityId).toBe('e1');
  });

  it('never lets a deeper candidate outside the near-tie band beat a closer pixel', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 100, 0), b: v3(500, 500, 0) });
    sketch.addEntity({ type: 'line', a: v3(150, 100, 2500), b: v3(900, 900, 2500) });
    const result = snapCursor(context({ cursor: screenOf(100, 100), targets: targetsOf(sketch) }));
    expect(result.type).toBe('vertex');
    expect(result.entityId).toBe('e1');
  });

  it('still connects to a deliberate off-plane vertex during a stroke', () => {
    const sketch = new Sketch();
    sketch.addEntity({ type: 'line', a: v3(100, 100, 2500), b: v3(900, 900, 2500) });
    const result = snapCursor(
      context({ cursor: screenOf(100, 100), targets: targetsOf(sketch), strokeStart: v3(3000, 3000, 0) }),
    );
    expect(result.type).toBe('vertex');
    expect(result.onPlane).toBe(false);
    expect(result.world).toEqual(v3(100, 100, 2500));
  });
});

describe('adaptiveGridStep', () => {
  it('picks the smallest step that is at least minPx on screen', () => {
    const plane = new WorkPlane('XY');
    expect(adaptiveGridStep(topViewProjector(0.1), plane, v3(0, 0, 0), 10)).toBe(100);
    expect(adaptiveGridStep(topViewProjector(1.5), plane, v3(0, 0, 0), 10)).toBe(10);
    expect(adaptiveGridStep(topViewProjector(20), plane, v3(0, 0, 0), 10)).toBe(1);
    expect(adaptiveGridStep(topViewProjector(0.005), plane, v3(0, 0, 0), 10)).toBe(1000);
  });
});
