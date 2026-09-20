import { describe, expect, it } from 'vitest';
import { WorkPlane } from './plane';
import { PlaneInference, rankPlaneCandidates, type PlaneInferenceContext } from './plane-inference';
import { makeRect, type Entity } from './sketch';
import type { Projector, SnapResult } from './snap';
import { add, cross, dot, length, normalize, scale, sub, v2, v3, type Vec2, type Vec3 } from './vec';

const CENTER = v2(400, 300);
const FOCAL = 400;

function pinhole(eye: Vec3, forward: Vec3): Projector {
  const f = normalize(forward);
  let right = cross(f, v3(0, 0, 1));
  if (length(right) < 1e-9) right = v3(1, 0, 0);
  right = normalize(right);
  const up = normalize(cross(right, f));
  return {
    project(world: Vec3): Vec2 | null {
      const rel = sub(world, eye);
      const depth = dot(rel, f);
      if (depth <= 1e-9) return null;
      return v2(CENTER.x + (FOCAL * dot(rel, right)) / depth, CENTER.y - (FOCAL * dot(rel, up)) / depth);
    },
    ray(screen: Vec2) {
      const dir = normalize(
        add(add(f, scale(right, (screen.x - CENTER.x) / FOCAL)), scale(up, (CENTER.y - screen.y) / FOCAL)),
      );
      return { origin: eye, dir };
    },
  };
}

const ISO_DIR = normalize(v3(-1, 1, -1));

function context(overrides: Partial<PlaneInferenceContext> = {}): PlaneInferenceContext {
  const eye = v3(6000, -6000, 5000);
  const forward = normalize(v3(-6000, 6000, -5000));
  return {
    currentPlane: new WorkPlane('XY'),
    projector: pinhole(eye, forward),
    cursor: CENTER,
    viewDirection: forward,
    snap: null,
    entities: [],
    ...overrides,
  };
}

function rectEntity(id: string, origin: Vec3, dirU: Vec3, dirV: Vec3, width: number, height: number): Entity {
  return { id, type: 'rect', corners: makeRect(origin, dirU, dirV, width, height) };
}

const floorAt = (id: string, z: number, width = 4000, height = 3000, origin = v3(0, 0, z)) =>
  rectEntity(id, origin, v3(1, 0, 0), v3(0, 1, 0), width, height);

function objectSnap(type: 'vertex' | 'midpoint' | 'edge', world: Vec3, entityId = 'e1'): SnapResult {
  return { type, world, plane: v2(0, 0), screen: v2(0, 0), onPlane: true, raw: world, entityId };
}

const topDown = (eyeZ = 8000, eyeXY = v2(2000, 1500)) => pinhole(v3(eyeXY.x, eyeXY.y, eyeZ), v3(0, 0, -1));

describe('rankPlaneCandidates', () => {
  it('keeps the baseline current plane on an initial tie', () => {
    const choice = new PlaneInference().update(context({ viewDirection: ISO_DIR }), 0);
    expect(choice.plane.kind).toBe('XY');
    expect(choice.reason).toBe('current');
  });

  it('picks the view-facing plane when the camera looks at the front', () => {
    const forward = v3(0, 1, 0);
    const ctx = context({ projector: pinhole(v3(2000, -8000, 1500), forward), viewDirection: forward });
    const choice = new PlaneInference().update(ctx, 0);
    expect(choice.plane.kind).toBe('XZ');
  });

  it('offers only edge-containing planes for an edge snap', () => {
    const floor = floorAt('e1', 0);
    const snap = objectSnap('edge', v3(2000, 0, 0));
    const candidates = rankPlaneCandidates(context({ snap, entities: [floor] }));
    const edgeCandidates = candidates.filter((candidate) => candidate.reason === 'edge');
    expect(edgeCandidates.length).toBe(2);
    for (const candidate of edgeCandidates) {
      expect(candidate.plane.contains(v3(0, 0, 0), 1e-6)).toBe(true);
      expect(candidate.plane.contains(v3(4000, 0, 0), 1e-6)).toBe(true);
    }
    expect(edgeCandidates.map((candidate) => candidate.plane.kind).sort()).toEqual(['XY', 'XZ']);
  });

  it('offers the wall plane coplanar with a floor edge', () => {
    const floor = floorAt('e1', 0);
    const snap = objectSnap('edge', v3(0, 1500, 0));
    const candidates = rankPlaneCandidates(context({ snap, entities: [floor] }));
    const yz = candidates.find((candidate) => candidate.plane.kind === 'YZ' && candidate.reason === 'edge');
    expect(yz).toBeDefined();
    expect(yz!.plane.contains(v3(0, 0, 0), 1e-6)).toBe(true);
    expect(yz!.plane.contains(v3(0, 3000, 0), 1e-6)).toBe(true);
  });

  it('prefers the plane holding the incident floor face at a corner snap', () => {
    const floor = floorAt('e1', 0);
    const snap = objectSnap('vertex', v3(0, 0, 0));
    const choice = new PlaneInference().update(context({ snap, entities: [floor], viewDirection: ISO_DIR }), 0);
    expect(choice.reason).toBe('vertex');
    expect(choice.plane.kind).toBe('XY');
  });

  it('lets a nearby edge snap outrank the view candidates', () => {
    const floor = floorAt('e1', 0);
    const snap = objectSnap('edge', v3(2000, 0, 0));
    const choice = new PlaneInference().update(context({ snap, entities: [floor], viewDirection: ISO_DIR }), 0);
    expect(choice.reason).toBe('edge');
  });

  it('ignores faces that are tilted, behind the camera, or only grazed near the border', () => {
    const projector = topDown();
    const tilted = rectEntity('e1', v3(0, 0, 2000), v3(1, 0, 0), normalize(v3(0, 1, 1)), 4000, 3000);
    const tiltedResult = rankPlaneCandidates(
      context({ projector, viewDirection: v3(0, 0, -1), entities: [tilted] }),
    );
    expect(tiltedResult.some((candidate) => candidate.reason === 'face')).toBe(false);

    const behind = floorAt('e1', 9000);
    const behindResult = rankPlaneCandidates(
      context({ projector, viewDirection: v3(0, 0, -1), entities: [behind] }),
    );
    expect(behindResult.some((candidate) => candidate.reason === 'face')).toBe(false);

    const floor = floorAt('e1', 2500);
    const edgePoint = projector.project(v3(0, 1500, 2500))!;
    const nearBorderCursor = v2(edgePoint.x + 5, edgePoint.y);
    const borderResult = rankPlaneCandidates(
      context({ projector, cursor: nearBorderCursor, viewDirection: v3(0, 0, -1), entities: [floor] }),
    );
    expect(borderResult.some((candidate) => candidate.reason === 'face')).toBe(false);
  });

  it('returns an unavailable current choice when no plane is usable', () => {
    const ctx = context({
      projector: {
        project: () => null,
        ray: () => ({ origin: v3(0, 0, 0), dir: v3(0, 0, 0) }),
      },
      viewDirection: ISO_DIR,
    });
    const candidates = rankPlaneCandidates(ctx);
    expect(candidates).toEqual([{ plane: ctx.currentPlane, reason: 'unavailable', score: 0 }]);
  });
});

describe('PlaneInference dwell and switching', () => {
  function faceScenario(z = 2500) {
    const floor = floorAt('e1', z);
    const projector = topDown();
    const cursor = projector.project(v3(2000, 1500, z))!;
    return context({ projector, cursor, viewDirection: v3(0, 0, -1), entities: [floor] });
  }

  it('selects a clear face interior immediately', () => {
    const inference = new PlaneInference();
    const ctx = faceScenario(2500);
    const choice = inference.update(ctx, 0);
    expect(choice.reason).toBe('face');
    expect(choice.plane.kind).toBe('XY');
    expect(choice.plane.offset).toBeCloseTo(2500);
  });

  it('prefers the nearest eligible face in front of a deeper one', () => {
    const front = rectEntity('e1', v3(0, 0, 4000), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000);
    const back = rectEntity('e2', v3(-2000, -1500, 1000), v3(1, 0, 0), v3(0, 1, 0), 8000, 6000);
    const projector = topDown();
    const cursor = projector.project(v3(2000, 1500, 4000))!;
    const ctx = context({ projector, cursor, viewDirection: v3(0, 0, -1), entities: [back, front] });
    const inference = new PlaneInference();
    const choice = inference.update(ctx, 0);
    expect(choice.reason).toBe('face');
    expect(choice.plane.offset).toBeCloseTo(4000);
  });

  it('does not let an unusable near face hide a farther usable face', () => {
    const nearFloor = floorAt('e1', 1200);
    const wall = rectEntity('e2', v3(0, 2000, 0), v3(1, 0, 0), v3(0, 0, 1), 4000, 2500);
    const forward = normalize(v3(0, 1, -0.1));
    const projector = pinhole(v3(2000, -500, 1260), forward);
    const ctx = context({ projector, viewDirection: forward, entities: [nearFloor, wall] });
    const inference = new PlaneInference();
    const choice = inference.update(ctx, 0);
    expect(choice.reason).toBe('face');
    expect(choice.plane.kind).toBe('XZ');
    expect(choice.plane.offset).toBeCloseTo(2000);
  });

  it('selects the hovered face immediately when the cursor moves to another slab', () => {
    const inference = new PlaneInference();
    const rectA = rectEntity('e1', v3(0, 0, 2500), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000);
    const rectB = rectEntity('e2', v3(5000, 0, 3000), v3(1, 0, 0), v3(0, 1, 0), 4000, 3000);
    const projector = pinhole(v3(4500, 1500, 8000), v3(0, 0, -1));
    const base = { viewDirection: v3(0, 0, -1), entities: [rectA, rectB] };
    const cursorA = projector.project(v3(2000, 1500, 2500))!;
    const cursorB = projector.project(v3(7000, 1500, 3000))!;
    const ctxA = context({ projector, cursor: cursorA, ...base });
    const ctxB = context({ projector, cursor: cursorB, ...base });
    expect(inference.update(ctxA, 0).plane.offset).toBeCloseTo(2500);
    const choice = inference.update(ctxB, 10);
    expect(choice.reason).toBe('face');
    expect(choice.plane.offset).toBeCloseTo(3000);
  });

  it('does not switch without the score margin even after a long dwell', () => {
    const forward = normalize(v3(0.278, -0.75, 0.6));
    const ctx = context({ projector: pinhole(v3(0, 0, 0), forward), viewDirection: forward });
    const inference = new PlaneInference();
    expect(inference.update(ctx, 0).plane.kind).toBe('XY');
    const held = inference.update(ctx, 1000);
    expect(held.plane.kind).toBe('XY');
    expect(held.reason).toBe('current');
  });

  it('falls back to a usable plane immediately when the current plane is edge-on', () => {
    const forward = v3(1, 0, 0);
    const ctx = context({ projector: pinhole(v3(-8000, 2000, 1500), forward), viewDirection: forward });
    const choice = new PlaneInference().update(ctx, 0);
    expect(choice.plane.kind).toBe('YZ');
    expect(choice.reason).toBe('view');
  });
});
