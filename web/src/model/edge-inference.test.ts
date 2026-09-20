import { describe, expect, it } from 'vitest';
import { inferParallelEdge, inferStrokeEdges, type EdgeInferenceContext } from './edge-inference';
import { WorkPlane, type PlaneKind } from './plane';
import type { Projector, SnapResult } from './snap';
import { entitySegments, isExtrudableProfile, isTriangleProfile, type Entity } from './sketch';
import { StrokeSession, type StrokeResolution } from './stroke';
import { topViewProjector } from './test-helpers';
import { distance, dot, normalize, sub, v2, v3, type Vec3 } from './vec';

const plane = new WorkPlane('XY');
const projector = topViewProjector(1, 0, 0);

function lineEntity(id: string, a: Vec3, b: Vec3): Entity {
  return { id, type: 'line', a, b };
}

const reference = lineEntity('reference', v3(0, 0, 0), v3(200, 0, 0));
const context: EdgeInferenceContext = { plane, projector, segments: entitySegments(reference), tolerancePx: 40 };

function snapAt(world: Vec3, type: SnapResult['type'] = 'free', raw: Vec3 | null = world): SnapResult {
  return { type, world, plane: plane.toPlane(world), screen: projector.project(world) ?? v2(0, 0), onPlane: plane.contains(world), raw };
}

function sessionFrom(
  points: Vec3[],
  options: { startType?: SnapResult['type']; lastType?: SnapResult['type']; lastWorld?: Vec3; lastRaw?: Vec3 | null } = {},
): StrokeSession {
  const session = new StrokeSession(plane, snapAt(points[0], options.startType ?? 'free'));
  for (const point of points.slice(1, -1)) session.add(snapAt(point), point, snapAt(point).screen, 0);
  const lastWorld = options.lastWorld ?? points[points.length - 1];
  const lastRaw = options.lastRaw === undefined ? lastWorld : options.lastRaw;
  const last = snapAt(lastWorld, options.lastType ?? 'free', lastRaw);
  session.add(last, lastRaw, last.screen, 0);
  return session;
}

const readyLine = (a: Vec3, b: Vec3, reason = 'line'): StrokeResolution => ({
  status: 'ready',
  input: { type: 'line', a, b },
  removeIds: [],
  reason,
});

const readyRect = (corners: [Vec3, Vec3, Vec3, Vec3], reason = 'rectangle', removeIds: string[] = []): StrokeResolution => ({
  status: 'ready',
  input: { type: 'rect', corners },
  removeIds,
  reason,
});

const options = (entities: Entity[]) => ({ projector, entities, tolerancePx: 40 });

describe('inferParallelEdge', () => {
  it('suggests a parallel length without pulling a deliberately shorter side', () => {
    const guide = inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), context)!;
    expect(guide.matchedLength).toBe(false);
    expect(guide.target).toEqual(v3(200, 60, 0));
    expect(guide.end.y).toBe(60);
    expect(distance(guide.start, guide.end)).toBeCloseTo(Math.hypot(120, 2));
  });

  it('matches length rather than an endpoint coordinate and keeps the start gap', () => {
    const guide = inferParallelEdge(v3(70, 60, 0), v3(268, 62, 0), context)!;
    expect(guide.matchedLength).toBe(true);
    expect(guide.start).toEqual(v3(70, 60, 0));
    expect(guide.end).toEqual(v3(270, 60, 0));
    expect(guide.reference.entityId).toBe('reference');
  });

  it.each([
    { draw: [v3(70, 60, 0), v3(268, 62, 0)] as [Vec3, Vec3], ref: [v3(0, 0, 0), v3(200, 0, 0)] as [Vec3, Vec3], target: v3(270, 60, 0) },
    { draw: [v3(270, 60, 0), v3(72, 62, 0)] as [Vec3, Vec3], ref: [v3(0, 0, 0), v3(200, 0, 0)] as [Vec3, Vec3], target: v3(70, 60, 0) },
    { draw: [v3(70, 60, 0), v3(268, 62, 0)] as [Vec3, Vec3], ref: [v3(200, 0, 0), v3(0, 0, 0)] as [Vec3, Vec3], target: v3(270, 60, 0) },
    { draw: [v3(270, 60, 0), v3(72, 62, 0)] as [Vec3, Vec3], ref: [v3(200, 0, 0), v3(0, 0, 0)] as [Vec3, Vec3], target: v3(70, 60, 0) },
  ])('follows the drawn direction for reversed strokes or references %#', ({ draw, ref, target }) => {
    const flipped = lineEntity('reference', ref[0], ref[1]);
    const guide = inferParallelEdge(draw[0], draw[1], { ...context, segments: entitySegments(flipped) })!;
    expect(guide.matchedLength).toBe(true);
    expect(guide.end).toEqual(target);
    expect(guide.start).toEqual(draw[0]);
  });

  it('corrects a near-parallel edge to the rotated reference direction', () => {
    const refAngle = (38 * Math.PI) / 180;
    const refDir = v3(Math.cos(refAngle), Math.sin(refAngle), 0);
    const rotated = lineEntity('reference', v3(0, 0, 0), v3(refDir.x * 200, refDir.y * 200, 0));
    const drawAngle = (40 * Math.PI) / 180;
    const a = v3(-Math.sin(refAngle) * 60, Math.cos(refAngle) * 60, 0);
    const b = v3(a.x + Math.cos(drawAngle) * 195, a.y + Math.sin(drawAngle) * 195, 0);
    const guide = inferParallelEdge(a, b, { ...context, segments: entitySegments(rotated) });
    expect(guide).not.toBeNull();
    const dir = normalize(sub(guide!.end, guide!.start));
    expect(dot(dir, refDir)).toBeCloseTo(1, 6);
    expect(guide!.matchedLength).toBe(true);
    expect(guide!.targetLength).toBeCloseTo(200);
  });

  it.each(['XY', 'XZ', 'YZ'] as const)('guides on the %s work plane', (kind: PlaneKind) => {
    const workPlane = new WorkPlane(kind);
    const ortho: Projector = {
      project: (world) => {
        const q = workPlane.toPlane(world);
        return v2(q.x, -q.y);
      },
      ray: () => ({ origin: workPlane.toWorld(v2(0, 0)), dir: { ...workPlane.normal } }),
    };
    const ref = lineEntity('reference', workPlane.toWorld(v2(0, 0)), workPlane.toWorld(v2(200, 0)));
    const guide = inferParallelEdge(workPlane.toWorld(v2(70, 60)), workPlane.toWorld(v2(268, 62)), {
      plane: workPlane,
      projector: ortho,
      segments: entitySegments(ref),
      tolerancePx: 40,
    });
    expect(guide).not.toBeNull();
    expect(guide!.matchedLength).toBe(true);
    const end = workPlane.toPlane(guide!.end);
    expect(end.x).toBeCloseTo(270, 6);
    expect(end.y).toBeCloseTo(60, 6);
  });

  it.each([0.25, 1, 4])('keeps the same pixel-space behaviour at zoom %s', (scale) => {
    const proj = topViewProjector(scale, 0, 0);
    const s = 1 / scale;
    const ref = lineEntity('reference', v3(0, 0, 0), v3(200 * s, 0, 0));
    const ctx: EdgeInferenceContext = { plane, projector: proj, segments: entitySegments(ref), tolerancePx: 40 };
    const guide = inferParallelEdge(v3(70 * s, 60 * s, 0), v3(268 * s, 62 * s, 0), ctx);
    expect(guide?.matchedLength).toBe(true);
    expect(guide?.end.x).toBeCloseTo(270 * s, 6);
    expect(guide?.end.y).toBeCloseTo(60 * s, 6);
    expect(inferParallelEdge(v3(0, 81 * s, 0), v3(200 * s, 83 * s, 0), ctx)).toBeNull();
  });

  it('rejects degenerate or unsuitable input', () => {
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, segments: [] })).toBeNull();
    expect(inferParallelEdge(v3(0, 60, 0), v3(0, 60, 0), context)).toBeNull();
    expect(inferParallelEdge(v3(Number.NaN, 60, 0), v3(120, 62, 0), context)).toBeNull();
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, tolerancePx: 0 })).toBeNull();
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, tolerancePx: Number.NaN })).toBeNull();
    const offPlane = lineEntity('reference', v3(0, 0, 5), v3(200, 0, 5));
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, segments: entitySegments(offPlane) })).toBeNull();
    const blind: Projector = { project: () => null, ray: (screen) => ({ origin: v3(screen.x, -screen.y, 0), dir: v3(0, 0, -1) }) };
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, projector: blind })).toBeNull();
    const edgeOn: Projector = { project: projector.project, ray: () => ({ origin: v3(0, 0, 0), dir: v3(1, 0, 0) }) };
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, projector: edgeOn })).toBeNull();
    const angled = (15 * Math.PI) / 180;
    expect(inferParallelEdge(v3(0, 60, 0), v3(Math.cos(angled) * 120, 60 + Math.sin(angled) * 120, 0), context)).toBeNull();
    expect(inferParallelEdge(v3(0, 81, 0), v3(200, 83, 0), context)).toBeNull();
    const distant = lineEntity('reference', v3(5000, 0, 0), v3(5200, 0, 0));
    expect(inferParallelEdge(v3(0, 60, 0), v3(120, 62, 0), { ...context, segments: entitySegments(distant) })).toBeNull();
  });

  it('caps the suggested jump at a fraction of the reference length', () => {
    const short = lineEntity('reference', v3(0, 0, 0), v3(30, 0, 0));
    const guide = inferParallelEdge(v3(0, 60, 0), v3(16, 62, 0), { ...context, segments: entitySegments(short) });
    expect(guide).not.toBeNull();
    expect(guide!.matchedLength).toBe(false);
    expect(guide!.target).toEqual(v3(30, 60, 0));
    expect(distance(guide!.start, guide!.end)).toBeCloseTo(Math.hypot(16, 2));
  });

  it('picks the lowest entity id deterministically for identical references', () => {
    const a = lineEntity('a', v3(0, 0, 0), v3(200, 0, 0));
    const b = lineEntity('b', v3(0, 0, 0), v3(200, 0, 0));
    const ctx = (entities: Entity[]): EdgeInferenceContext => ({
      plane,
      projector,
      segments: entities.flatMap(entitySegments),
      tolerancePx: 40,
    });
    expect(inferParallelEdge(v3(0, 60, 0), v3(198, 62, 0), ctx([a, b]))!.reference.entityId).toBe('a');
    expect(inferParallelEdge(v3(0, 60, 0), v3(198, 62, 0), ctx([b, a]))!.reference.entityId).toBe('a');
  });

  it('does not mutate the stroke endpoints or reference segments', () => {
    const a = v3(70, 60, 0);
    const b = v3(268, 62, 0);
    const before = JSON.parse(JSON.stringify({ a, b, segments: context.segments }));
    inferParallelEdge(a, b, context);
    expect({ a, b, segments: context.segments }).toEqual(before);
  });
});

describe('inferStrokeEdges', () => {
  it('commits the suggested equal length for a ready line', () => {
    const session = sessionFrom([v3(0, 60, 0), v3(198, 60, 0)], { lastRaw: v3(198, 62, 0) });
    const resolution = inferStrokeEdges(session, readyLine(v3(0, 60, 0), v3(198, 60, 0)), options([reference]));
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    expect(resolution.input).toEqual({ type: 'line', a: v3(0, 60, 0), b: v3(200, 60, 0) });
    expect(resolution.reason).toBe('equal-length line');
    expect(resolution.guide?.matchedLength).toBe(true);
    expect(resolution.guide?.reference.entityId).toBe('reference');
  });

  it('keeps the reference direction instead of the axis-recognised angle', () => {
    const refAngle = (10 * Math.PI) / 180;
    const refDir = v2(Math.cos(refAngle), Math.sin(refAngle));
    const rotated = lineEntity('reference', v3(0, 0, 0), v3(refDir.x * 200, refDir.y * 200, 0));
    const start = v3(-refDir.y * 60, refDir.x * 60, 0);
    const drawAngle = (9 * Math.PI) / 180;
    const raw = v3(start.x + Math.cos(drawAngle) * 198, start.y + Math.sin(drawAngle) * 198, 0);
    const snapped = v3(start.x + 198, start.y, 0);
    const session = sessionFrom([start, snapped], { lastRaw: raw, lastType: 'axis' });
    const resolution = inferStrokeEdges(session, readyLine(start, snapped, 'axis-aligned line'), options([rotated]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    const dir = normalize(sub(resolution.input.b, resolution.input.a));
    expect(dot(dir, v3(refDir.x, refDir.y, 0))).toBeCloseTo(1, 5);
    expect(Math.abs(resolution.input.b.y - resolution.input.a.y)).toBeGreaterThan(30);
  });

  it.each(['vertex', 'midpoint', 'edge'] as const)('keeps an explicit %s endpoint and only suggests', (type) => {
    const session = sessionFrom([v3(0, 60, 0), v3(198, 60, 0)], { lastType: type });
    const resolution = inferStrokeEdges(session, readyLine(v3(0, 60, 0), v3(198, 60, 0)), options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    expect(resolution.input.b).toEqual(v3(198, 60, 0));
    expect(resolution.guide).not.toBeNull();
    expect(resolution.guide!.matchedLength).toBe(false);
    expect(resolution.guide!.target).toEqual(v3(200, 60, 0));
  });

  it('returns an axis-locked line untouched with no guide', () => {
    const session = sessionFrom([v3(0, 60, 0), v3(198, 60, 0)], { lastType: 'lock' });
    const resolution = inferStrokeEdges(session, readyLine(v3(0, 60, 0), v3(198, 60, 0)), options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    expect(resolution.input.b).toEqual(v3(198, 60, 0));
    expect(resolution.guide).toBeNull();
  });

  it('leaves a lock-started stroke alone', () => {
    const session = sessionFrom([v3(0, 60, 0), v3(198, 60, 0)], { startType: 'lock' });
    const resolution = inferStrokeEdges(session, readyLine(v3(0, 60, 0), v3(198, 60, 0)), options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    expect(resolution.input.b).toEqual(v3(198, 60, 0));
    expect(resolution.guide).toBeNull();
  });

  it('keeps a snapped start vertex while correcting the free end', () => {
    const session = sessionFrom([v3(0, 60, 0), v3(198, 60, 0)], { startType: 'vertex', lastRaw: v3(198, 62, 0) });
    const resolution = inferStrokeEdges(session, readyLine(v3(0, 60, 0), v3(198, 60, 0)), options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    expect(resolution.input.a).toEqual(v3(0, 60, 0));
    expect(resolution.input.b).toEqual(v3(200, 60, 0));
  });

  it('leaves an off-plane snapped endpoint unchanged', () => {
    const session = sessionFrom([v3(0, 60, 0), v3(198, 60, 5)], { lastType: 'vertex', lastRaw: v3(198, 60, 5) });
    const resolution = inferStrokeEdges(session, readyLine(v3(0, 60, 0), v3(198, 60, 5)), options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'line') throw new Error('expected a line');
    expect(resolution.input.b).toEqual(v3(198, 60, 5));
    expect(resolution.guide).toBeNull();
  });

  it('stretches a drawn rectangle to the matched side while keeping it rectangular', () => {
    const corners: [Vec3, Vec3, Vec3, Vec3] = [v3(0, 60, 0), v3(198, 60, 0), v3(198, 150, 0), v3(0, 150, 0)];
    const session = sessionFrom([corners[0], corners[2]]);
    const resolution = inferStrokeEdges(session, readyRect(corners), options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'rect') throw new Error('expected a rect');
    expect(resolution.input.corners[0]).toEqual(v3(0, 60, 0));
    expect(resolution.input.corners[1].x).toBeCloseTo(200, 6);
    expect(resolution.input.corners[1].y).toBeCloseTo(60, 6);
    expect(resolution.input.corners[2].x).toBeCloseTo(200, 6);
    expect(resolution.input.corners[2].y).toBeCloseTo(150, 6);
    expect(resolution.input.corners[3]).toEqual(v3(0, 150, 0));
    expect(isExtrudableProfile(resolution.input.corners)).toBe(true);
    expect(resolution.guide?.matchedLength).toBe(true);
    expect(resolution.guide?.targetLength).toBe(200);
    expect(corners).toEqual([v3(0, 60, 0), v3(198, 60, 0), v3(198, 150, 0), v3(0, 150, 0)]);
  });

  it('stretches a drawn triangle base to the matched side', () => {
    const corners: [Vec3, Vec3, Vec3] = [v3(0, 60, 0), v3(198, 60, 0), v3(60, 150, 0)];
    const session = sessionFrom([corners[0], corners[2]]);
    const resolution = inferStrokeEdges(session, { status: 'ready', input: { type: 'triangle', corners }, removeIds: [], reason: 'triangle' }, options([reference]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'triangle') throw new Error('expected a triangle');
    expect(distance(resolution.input.corners[0], resolution.input.corners[1])).toBeCloseTo(200, 5);
    expect(resolution.input.corners[2].y).toBeCloseTo(150, 5);
    expect(isTriangleProfile(resolution.input.corners)).toBe(true);
    expect(resolution.guide?.matchedLength).toBe(true);
    expect(corners).toEqual([v3(0, 60, 0), v3(198, 60, 0), v3(60, 150, 0)]);
  });

  it('cannot dislodge a corner anchored on an existing edge', () => {
    const anchor = lineEntity('anchor', v3(198, 55, 0), v3(198, 65, 0));
    const corners: [Vec3, Vec3, Vec3, Vec3] = [v3(0, 60, 0), v3(198, 60, 0), v3(198, 150, 0), v3(0, 150, 0)];
    const session = sessionFrom([corners[0], corners[2]]);
    const resolution = inferStrokeEdges(session, readyRect(corners), options([reference, anchor]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'rect') throw new Error('expected a rect');
    expect(resolution.input.corners).toEqual(corners);
    expect(resolution.guide).toBeNull();
  });

  it('leaves a rectangle whose side is attached to an existing edge unchanged', () => {
    const wall = lineEntity('wall', v3(198, 40, 0), v3(198, 160, 0));
    const corners: [Vec3, Vec3, Vec3, Vec3] = [v3(0, 60, 0), v3(198, 60, 0), v3(198, 150, 0), v3(0, 150, 0)];
    const session = sessionFrom([corners[0], corners[2]]);
    const resolution = inferStrokeEdges(session, readyRect(corners), options([reference, wall]));
    if (resolution.status !== 'ready' || resolution.input.type !== 'rect') throw new Error('expected a rect');
    for (const [index, corner] of resolution.input.corners.entries()) {
      expect(corner.x).toBeCloseTo(corners[index].x, 6);
      expect(corner.y).toBeCloseTo(corners[index].y, 6);
    }
  });

  it.each([
    { reason: 'shared-border rectangle', removeIds: [] as string[] },
    { reason: 'assembled rectangle', removeIds: ['e9'] },
    { reason: 'rectangle', removeIds: ['e9'] },
  ])('does not reshape a completed rectangle ($reason)', ({ reason, removeIds }) => {
    const corners: [Vec3, Vec3, Vec3, Vec3] = [v3(0, 60, 0), v3(198, 60, 0), v3(198, 150, 0), v3(0, 150, 0)];
    const session = sessionFrom([corners[0], corners[2]]);
    const resolution = inferStrokeEdges(session, readyRect(corners, reason, removeIds), options([reference]));
    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready' || resolution.input.type !== 'rect') return;
    expect(resolution.input.corners).toEqual(corners);
    expect(resolution.removeIds).toEqual(removeIds);
  });

  it('infers on the last straight leg of an unfinished outline', () => {
    const wall = lineEntity('reference', v3(60, 60, 0), v3(60, 260, 0));
    const session = sessionFrom([v3(300, 60, 0), v3(0, 60, 0), v3(0, 258, 0)]);
    const resolution = inferStrokeEdges(session, { status: 'unrecognized', input: null, removeIds: [], reason: 'unrecognized' }, options([wall]));
    expect(resolution.status).toBe('unrecognized');
    expect(resolution.guide?.matchedLength).toBe(true);
    expect(resolution.guide?.start).toEqual(v3(0, 60, 0));
    expect(resolution.guide?.target).toEqual(v3(0, 260, 0));
    expect(resolution.guide?.reference.entityId).toBe('reference');
  });

  it('keeps a duplicate resolution free of guides', () => {
    const session = sessionFrom([v3(0, 60, 0), v3(200, 150, 0)]);
    const resolution = inferStrokeEdges(session, { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists' }, options([reference]));
    expect(resolution.status).toBe('duplicate');
    expect(resolution.guide).toBeNull();
  });

  it('still reports a fitted rectangle that matches an existing one as duplicate', () => {
    const existing: Entity = { id: 'existing', type: 'rect', corners: [v3(0, 60, 0), v3(200, 60, 0), v3(200, 150, 0), v3(0, 150, 0)] };
    const corners: [Vec3, Vec3, Vec3, Vec3] = [v3(0, 60, 0), v3(200, 60, 0), v3(200, 150, 0), v3(0, 150, 0)];
    const session = sessionFrom([corners[0], corners[2]]);
    const resolution = inferStrokeEdges(session, readyRect(corners), options([existing]));
    expect(resolution.status).toBe('duplicate');
    expect(resolution.input).toBeNull();
    expect(resolution.guide).toBeNull();
  });
});
