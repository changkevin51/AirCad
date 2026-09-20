import type { WorkPlane } from './plane';
import { dedupePoints, simplifyRdp } from './recognize';
import { completeLineRectangle, sameRectangle } from './rect-completion';
import type { Projector } from './snap';
import { PARALLEL_SNAP_DEG } from './spatial-join';
import { closestPointOnSegment } from './spatial-snap';
import { entitySegments, isExtrudableProfile, isTriangleProfile, type Entity, type EntityInput, type Segment } from './sketch';
import type { StrokeResolution, StrokeSession } from './stroke';
import { add, cross2, distance, distance2, dot, dot2, isFinite3, lerp, nearlyEqual, normalize, normalize2, scale, sub, sub2, v2, type Vec2, type Vec3 } from './vec';

export interface EdgeGuide {
  reference: Segment;
  start: Vec3;
  end: Vec3;
  target: Vec3;
  targetLength: number;
  matchedLength: boolean;
  normal: Vec3;
  distancePx: number;
  angleDeg: number;
}

export interface EdgeInferenceContext {
  plane: WorkPlane;
  projector: Projector;
  segments: readonly Segment[];
  tolerancePx: number;
}

export type GuidedStrokeResolution = StrokeResolution & { guide: EdgeGuide | null };

const EPS = 1e-6;
const explicitSnap = (type: string): boolean => ['vertex', 'midpoint', 'edge', 'lock'].includes(type);

function project(projector: Projector, point: Vec3): Vec2 | null {
  if (!isFinite3(point)) return null;
  const screen = projector.project(point);
  return screen && Number.isFinite(screen.x) && Number.isFinite(screen.y) ? screen : null;
}

function worldPerPixel(context: EdgeInferenceContext, at: Vec3): number {
  const direct = context.projector.worldPerPixel?.(at);
  if (direct != null && Number.isFinite(direct) && direct > 0) return direct;
  const p = project(context.projector, at);
  const u = project(context.projector, add(at, context.plane.u));
  const v = project(context.projector, add(at, context.plane.v));
  if (!p) return 0;
  const pixels = Math.max(u ? distance2(p, u) : 0, v ? distance2(p, v) : 0);
  return pixels > EPS ? 1 / pixels : 0;
}

const compareGuides = (a: EdgeGuide, b: EdgeGuide): number =>
  a.distancePx - b.distancePx || a.angleDeg - b.angleDeg ||
  a.reference.entityId.localeCompare(b.reference.entityId) || a.reference.index - b.reference.index;

export function inferParallelEdge(a: Vec3, b: Vec3, context: EdgeInferenceContext): EdgeGuide | null {
  const { plane, projector, tolerancePx } = context;
  if (!(tolerancePx > 0) || !Number.isFinite(tolerancePx) || !isFinite3(a) || !isFinite3(b) || !plane.contains(a, EPS) || !plane.contains(b, EPS)) return null;
  const sa = project(projector, a);
  const sb = project(projector, b);
  const mid = lerp(a, b, 0.5);
  const sm = project(projector, mid);
  const size = distance(a, b);
  const wpp = worldPerPixel(context, mid);
  if (!sa || !sb || !sm || size <= EPS || !(wpp > 0) || distance2(sa, sb) < 12) return null;
  if (Math.abs(dot(normalize(projector.ray(sm).dir), plane.normal)) < 0.15) return null;
  const delta = sub(b, a);
  const rangePx = Math.max(24, tolerancePx * 2);
  const lengthPx = Math.min(16, tolerancePx);
  const candidates: EdgeGuide[] = [];
  for (const segment of context.segments) {
    if (![segment.a, segment.b].every(isFinite3) || !plane.contains(segment.a, EPS) || !plane.contains(segment.b, EPS)) continue;
    const ra = project(projector, segment.a);
    const rb = project(projector, segment.b);
    const targetLength = distance(segment.a, segment.b);
    if (!ra || !rb || targetLength <= EPS || distance2(ra, rb) < 12) continue;
    const axis = scale(sub(segment.b, segment.a), 1 / targetLength);
    const cosine = Math.min(1, Math.abs(dot(delta, axis)) / size);
    const angleDeg = Math.acos(cosine) * 180 / Math.PI;
    if (angleDeg > PARALLEL_SNAP_DEG + 1e-9) continue;
    const alongA = dot(sub(a, segment.a), axis);
    const alongB = dot(sub(b, segment.a), axis);
    const lo = Math.max(0, Math.min(alongA, alongB));
    const hi = Math.min(targetLength, Math.max(alongA, alongB));
    if (hi - lo <= EPS) continue;
    let gapPx = 0;
    let gapWorld = 0;
    let visible = true;
    for (const along of [lo, hi]) {
      const onEdge = add(a, scale(delta, (along - alongA) / (alongB - alongA)));
      const onReference = add(segment.a, scale(axis, along));
      const p = project(projector, onEdge);
      const q = project(projector, onReference);
      if (!p || !q) { visible = false; break; }
      gapPx = Math.max(gapPx, distance2(p, q));
      gapWorld = Math.max(gapWorld, distance(onEdge, onReference));
    }
    if (!visible || gapPx > rangePx || gapWorld > rangePx * wpp) continue;
    const forward = alongB > alongA;
    const dir = scale(axis, forward ? 1 : -1);
    const alignedEnd = add(a, scale(dir, size));
    const alignedScreen = project(projector, alignedEnd);
    const target = add(a, scale(dir, targetLength));
    const targetScreen = project(projector, target);
    if (!alignedScreen || !targetScreen || distance2(sb, alignedScreen) > tolerancePx || distance(b, alignedEnd) > tolerancePx * wpp) continue;
    const lengthError = Math.abs(size - targetLength);
    const matchedLength = lengthError <= targetLength * 0.12 && lengthError <= lengthPx * wpp &&
      distance2(alignedScreen, targetScreen) <= lengthPx && distance2(sb, targetScreen) <= tolerancePx && distance(b, target) <= tolerancePx * wpp;
    candidates.push({
      reference: { ...segment, a: { ...(forward ? segment.a : segment.b) }, b: { ...(forward ? segment.b : segment.a) } },
      start: { ...a }, end: matchedLength ? target : alignedEnd, target, targetLength, matchedLength,
      normal: { ...plane.normal }, distancePx: gapPx, angleDeg,
    });
  }
  return candidates.sort(compareGuides)[0] ?? null;
}

function fixedGuide(guide: EdgeGuide | null, end: Vec3): EdgeGuide | null {
  if (!guide || dot(normalize(sub(end, guide.start)), normalize(sub(guide.target, guide.start))) < 1 - 1e-9) return null;
  return { ...guide, end: { ...end }, matchedLength: Math.abs(distance(guide.start, end) - guide.targetLength) <= EPS };
}

function activeGuide(session: StrokeSession, context: EdgeInferenceContext): EdgeGuide | null {
  if (explicitSnap(session.last.type) || session.start.type === 'lock') return null;
  const path = session.worldPath();
  path[path.length - 1] = session.last.raw ?? session.last.world;
  if (!path.every(point => isFinite3(point) && session.plane.contains(point, EPS))) return null;
  const points = simplifyRdp(dedupePoints(path.map(point => session.plane.toPlane(point))), 3 * worldPerPixel(context, path[path.length - 1]));
  if (points.length < 2) return null;
  return inferParallelEdge(session.plane.toWorld(points[points.length - 2]), session.plane.toWorld(points[points.length - 1]), context);
}

function fitProfile(
  input: Extract<EntityInput, { type: 'rect' | 'triangle' }>,
  session: StrokeSession,
  context: EdgeInferenceContext,
  allowCorrection: boolean,
): { input: typeof input; guide: EdgeGuide } | null {
  const corners = input.corners;
  const candidates = corners.map((a, index) => ({ index, guide: inferParallelEdge(a, corners[(index + 1) % corners.length], context) }))
    .filter((item): item is { index: number; guide: EdgeGuide } => item.guide !== null)
    .sort((a, b) => compareGuides(a.guide, b.guide) || a.index - b.index);
  const onSegment = (point: Vec3, a: Vec3, b: Vec3): boolean => distance(point, closestPointOnSegment(point, a, b).point) <= EPS;
  const anchors = [corners[0], ...corners.filter(point => context.segments.some(segment => onSegment(point, segment.a, segment.b)))];
  for (const snap of [session.start, session.last]) {
    if (explicitSnap(snap.type) && corners.some((point, index) => onSegment(snap.world, point, corners[(index + 1) % corners.length]))) anchors.push(snap.world);
  }
  for (const { index, guide } of candidates) {
    const next = (index + 1) % corners.length;
    if (!allowCorrection) {
      const fixed = fixedGuide(guide, corners[next]);
      if (fixed) return { input, guide: fixed };
      continue;
    }
    const pivot = session.plane.toPlane(corners[0]);
    const from = normalize2(sub2(session.plane.toPlane(corners[next]), session.plane.toPlane(corners[index])));
    const to = normalize2(sub2(session.plane.toPlane(guide.target), session.plane.toPlane(guide.start)));
    const cosine = dot2(from, to);
    const sine = cross2(from, to);
    const factor = distance(guide.start, guide.end) / distance(corners[index], corners[next]);
    const transform = (point: Vec3): Vec3 => {
      const p = sub2(session.plane.toPlane(point), pivot);
      const rotated = v2(p.x * cosine - p.y * sine, p.x * sine + p.y * cosine);
      const along = dot2(rotated, to) * (factor - 1);
      return session.plane.toWorld(v2(pivot.x + rotated.x + to.x * along, pivot.y + rotated.y + to.y * along));
    };
    if (anchors.some(point => !nearlyEqual(point, transform(point), EPS))) continue;
    const fitted = corners.map(transform);
    if (fitted.some((point, i) => {
      const before = project(context.projector, corners[i]);
      const after = project(context.projector, point);
      return !before || !after || distance2(before, after) > context.tolerancePx || distance(corners[i], point) > context.tolerancePx * worldPerPixel(context, corners[i]);
    })) continue;
    if (input.type === 'rect' ? !isExtrudableProfile(fitted) : !isTriangleProfile(fitted)) continue;
    const start = fitted[index];
    const end = fitted[next];
    const target = add(start, scale(normalize(sub(end, start)), guide.targetLength));
    const result = input.type === 'rect'
      ? { type: 'rect' as const, corners: fitted as [Vec3, Vec3, Vec3, Vec3] }
      : { type: 'triangle' as const, corners: fitted as [Vec3, Vec3, Vec3] };
    return { input: result, guide: { ...guide, start, end, target, matchedLength: Math.abs(distance(start, end) - guide.targetLength) <= EPS } };
  }
  return null;
}

export function inferStrokeEdges(
  session: StrokeSession,
  resolution: StrokeResolution,
  options: { projector: Projector; entities: readonly Entity[]; tolerancePx: number; gridStep?: number },
): GuidedStrokeResolution {
  const context: EdgeInferenceContext = { ...options, plane: session.plane, segments: options.entities.flatMap(entitySegments) };
  const unchanged: GuidedStrokeResolution = { ...resolution, guide: null };
  if (!context.segments.length || session.start.type === 'lock' || session.last.type === 'lock') return unchanged;
  if (resolution.status !== 'ready') return { ...resolution, guide: resolution.status === 'unrecognized' ? activeGuide(session, context) : null };
  let input = resolution.input;
  let guide: EdgeGuide | null = null;
  let reason = resolution.reason;
  if (input.type === 'line') {
    const lineStart = input.a;
    const lineEnd = input.b;
    const protectedEnd = explicitSnap(session.last.type) || context.segments.some(segment => distance(lineEnd, closestPointOnSegment(lineEnd, segment.a, segment.b).point) <= EPS);
    guide = inferParallelEdge(lineStart, protectedEnd ? lineEnd : session.last.raw ?? lineEnd, context);
    if (protectedEnd) return { ...resolution, guide: fixedGuide(guide, lineEnd) };
    if (!guide) return unchanged;
    input = { type: 'line', a: guide.start, b: guide.end };
    reason = guide.matchedLength ? 'equal-length line' : resolution.reason === 'collinear line' ? resolution.reason : 'parallel line';
    const completion = completeLineRectangle(input, { plane: session.plane, entities: options.entities, gridStep: options.gridStep });
    if (completion) {
      if (options.entities.some(entity => entity.type === 'rect' && sameRectangle(entity.corners, completion.corners))) return { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists', guide: null };
      return { status: 'ready', input: { type: 'rect', corners: completion.corners }, removeIds: completion.removeIds, reason: 'assembled rectangle', guide };
    }
  } else if (input.type === 'rect' || input.type === 'triangle') {
    const fitted = fitProfile(input, session, context, resolution.removeIds.length === 0 && reason !== 'shared-border rectangle' && reason !== 'assembled rectangle');
    if (!fitted) return unchanged;
    input = fitted.input;
    guide = fitted.guide;
    if (input.type === 'rect') {
      const fittedCorners = input.corners;
      if (options.entities.some(entity => entity.type === 'rect' && sameRectangle(entity.corners, fittedCorners))) return { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists', guide: null };
    }
  }
  return { ...resolution, input, reason, guide };
}
