import { PLANES, type PlaneKind } from './plane';
import { closestPointOnSegment } from './spatial-snap';
import type { EntityInput, Vertex } from './sketch';
import { add, clone, cross, distance, dot, length, normalize, scale, sub, type Vec3 } from './vec';

export const PARALLEL_SNAP_DEG = 10;

export interface JoinSegment {
  a: Vec3;
  b: Vec3;
  entityId?: string;
  index?: number;
}

export interface JoinTargets {
  vertices: readonly Vertex[];
  midpoints?: readonly Vertex[];
  segments?: readonly JoinSegment[];
}

export interface LineSegmentSnap {
  a: Vec3;
  b: Vec3;
  mode: 'collinear' | 'parallel' | 'perpendicular' | null;
  entityId?: string;
}

export interface SnapLineToSegmentsOptions {
  radius: number;
  plane?: PlaneKind | null;
  startOnSegmentId?: string | null;
  lockStart?: boolean;
}

function angleBetweenDirs(a: Vec3, b: Vec3): number {
  const da = normalize(a);
  const db = normalize(b);
  if (length(da) < 1e-12 || length(db) < 1e-12) return 90;
  return (Math.acos(Math.min(1, Math.abs(dot(da, db)))) * 180) / Math.PI;
}

function distanceToInfiniteLine(point: Vec3, origin: Vec3, dir: Vec3): number {
  const axis = normalize(dir);
  if (length(axis) < 1e-12) return distance(point, origin);
  const rel = sub(point, origin);
  return length(sub(rel, scale(axis, dot(rel, axis))));
}

function projectOntoInfiniteLine(point: Vec3, origin: Vec3, dir: Vec3): Vec3 {
  const axis = normalize(dir);
  if (length(axis) < 1e-12) return clone(origin);
  return add(origin, scale(axis, dot(sub(point, origin), axis)));
}

function closestPointOnSegmentToInfiniteLine(
  segA: Vec3,
  segB: Vec3,
  origin: Vec3,
  dir: Vec3,
): { point: Vec3; distance: number; parallel: boolean } {
  const d1 = normalize(dir);
  const ab = sub(segB, segA);
  const abLen = length(ab);
  if (abLen < 1e-12 || length(d1) < 1e-12) {
    return { point: clone(segA), distance: distanceToInfiniteLine(segA, origin, dir), parallel: true };
  }
  const d2 = scale(ab, 1 / abLen);
  const r = sub(origin, segA);
  const b = dot(d1, d2);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-12) {
    const t = Math.min(1, Math.max(0, dot(sub(origin, segA), ab) / (abLen * abLen)));
    const point = add(segA, scale(ab, t));
    return { point, distance: distanceToInfiniteLine(point, origin, dir), parallel: true };
  }
  const s = (dot(d2, r) - b * dot(d1, r)) / denom / abLen;
  const t = Math.min(1, Math.max(0, s));
  const point = add(segA, scale(ab, t));
  return { point, distance: distanceToInfiniteLine(point, origin, d1), parallel: false };
}

function nearestVertex(point: Vec3, vertices: readonly Vertex[], radius: number): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDistance = radius;
  for (const vertex of vertices) {
    const d = distance(point, vertex.point);
    if (d <= bestDistance) {
      best = vertex.point;
      bestDistance = d;
    }
  }
  return best;
}

function nearestOnEdge(
  point: Vec3,
  segments: readonly JoinSegment[],
  radius: number,
  line?: { origin: Vec3; dir: Vec3 },
): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDistance = radius;
  for (const segment of segments) {
    if (line && length(line.dir) > 1e-12) {
      const hit = closestPointOnSegmentToInfiniteLine(segment.a, segment.b, line.origin, line.dir);
      if (!hit.parallel && hit.distance <= radius) {
        const onLine = projectOntoInfiniteLine(hit.point, line.origin, line.dir);
        const along = distance(point, onLine);
        if (along <= radius && along <= bestDistance) {
          best = onLine;
          bestDistance = along;
          continue;
        }
      }
    }
    const foot = closestPointOnSegment(point, segment.a, segment.b);
    const d = distance(point, foot.point);
    if (d <= bestDistance) {
      best = foot.point;
      bestDistance = d;
    }
  }
  return best;
}

export function joinPoint(point: Vec3, targets: JoinTargets, radius: number, line?: { origin: Vec3; dir: Vec3 }): Vec3 {
  const vertex = nearestVertex(point, targets.vertices, radius);
  if (vertex) return clone(vertex);
  if (targets.midpoints?.length) {
    const mid = nearestVertex(point, targets.midpoints, radius);
    if (mid) return clone(mid);
  }
  if (targets.segments?.length) {
    const edge = nearestOnEdge(point, targets.segments, radius, line);
    if (edge) return clone(edge);
  }
  return clone(point);
}

interface SegmentCandidate {
  mode: 'collinear' | 'parallel' | 'perpendicular';
  angle: number;
  offset: number;
  a: Vec3;
  b: Vec3;
  entityId?: string;
  index: number;
}

export function snapLineToSegments(
  a: Vec3,
  b: Vec3,
  segments: readonly JoinSegment[],
  options: SnapLineToSegmentsOptions,
): LineSegmentSnap {
  const delta = sub(b, a);
  const len = length(delta);
  if (len < 1e-9 || !segments.length) return { a: clone(a), b: clone(b), mode: null };
  const dir = normalize(delta);
  const mid = add(a, scale(delta, 0.5));
  const range = Math.max(options.radius * 3, len * 0.5);
  const plane = options.plane ? PLANES[options.plane] : null;
  const candidates: SegmentCandidate[] = [];

  for (const segment of segments) {
    const segDir = sub(segment.b, segment.a);
    if (length(segDir) < 1e-9) continue;
    const offset = distanceToInfiniteLine(mid, segment.a, segDir);
    const parallelAngle = angleBetweenDirs(dir, segDir);
    if (parallelAngle <= PARALLEL_SNAP_DEG && offset <= range) {
      const axis = normalize(segDir);
      const sign = dot(dir, axis) >= 0 ? 1 : -1;
      const start = !options.lockStart && offset <= options.radius ? projectOntoInfiniteLine(a, segment.a, segDir) : clone(a);
      const end = add(start, scale(axis, sign * len));
      candidates.push({
        mode: !options.lockStart && offset <= options.radius ? 'collinear' : 'parallel',
        angle: parallelAngle,
        offset,
        a: start,
        b: end,
        entityId: segment.entityId,
        index: segment.index ?? 0,
      });
    }
    if (plane && options.startOnSegmentId && segment.entityId === options.startOnSegmentId) {
      const perp = normalize(cross(plane.normal, normalize(segDir)));
      if (length(perp) >= 1e-9) {
        const perpAngle = angleBetweenDirs(dir, perp);
        if (perpAngle <= PARALLEL_SNAP_DEG) {
          const start = options.lockStart ? clone(a) : closestPointOnSegment(a, segment.a, segment.b).point;
          const sign = dot(dir, perp) >= 0 ? 1 : -1;
          candidates.push({
            mode: 'perpendicular',
            angle: perpAngle,
            offset: distance(a, start),
            a: start,
            b: add(start, scale(perp, sign * len)),
            entityId: segment.entityId,
            index: segment.index ?? 0,
          });
        }
      }
    }
  }

  if (!candidates.length) return { a: clone(a), b: clone(b), mode: null };
  candidates.sort((left, right) => {
    if (left.angle !== right.angle) return left.angle - right.angle;
    if (left.offset !== right.offset) return left.offset - right.offset;
    const byId = (left.entityId ?? '').localeCompare(right.entityId ?? '');
    if (byId !== 0) return byId;
    return left.index - right.index;
  });
  const best = candidates[0];
  return { a: best.a, b: best.b, mode: best.mode, entityId: best.entityId };
}

/** Move whole rectangle edges so corners land on nearby vertices and the result stays a rectangle. */
export function pullRectCornersWorld(
  corners: readonly Vec3[],
  vertices: readonly Vertex[],
  radius: number,
  segments?: readonly JoinSegment[],
): Vec3[] {
  const [c0, c1, , c3] = corners;
  const e1 = normalize(sub(c1, c0));
  const e2 = normalize(sub(c3, c0));
  if (dot(e1, e1) < 1e-12 || dot(e2, e2) < 1e-12) return corners.map(clone);
  const width = dot(sub(c1, c0), e1);
  const height = dot(sub(c3, c0), e2);
  const bounds = { uLo: 0, uHi: width, vLo: 0, vHi: height };
  const assigned = { uLo: false, uHi: false, vLo: false, vHi: false };
  const edgesOf: Array<[keyof typeof bounds, keyof typeof bounds]> = [
    ['uLo', 'vLo'],
    ['uHi', 'vLo'],
    ['uHi', 'vHi'],
    ['uLo', 'vHi'],
  ];

  const candidates: { corner: number; distance: number; u: number; v: number }[] = [];
  corners.forEach((corner, index) => {
    for (const vertex of vertices) {
      const d = distance(corner, vertex.point);
      if (d > radius) continue;
      const rel = sub(vertex.point, c0);
      candidates.push({ corner: index, distance: d, u: dot(rel, e1), v: dot(rel, e2) });
    }
  });
  candidates.sort((left, right) => left.distance - right.distance);
  const usedCorners = new Set<number>();
  for (const candidate of candidates) {
    if (usedCorners.has(candidate.corner)) continue;
    const [uEdge, vEdge] = edgesOf[candidate.corner];
    if (assigned[uEdge] && assigned[vEdge]) continue;
    if (!assigned[uEdge]) {
      bounds[uEdge] = candidate.u;
      assigned[uEdge] = true;
    }
    if (!assigned[vEdge]) {
      bounds[vEdge] = candidate.v;
      assigned[vEdge] = true;
    }
    usedCorners.add(candidate.corner);
  }

  if (segments?.length) {
    const normal = normalize(cross(e1, e2));
    const edgeBounds: Array<{ bound: keyof typeof bounds; along: Vec3; across: Vec3; origin: Vec3; current: number }> = [
      { bound: 'vLo', along: e1, across: e2, origin: c0, current: bounds.vLo },
      { bound: 'vHi', along: e1, across: e2, origin: add(c0, scale(e2, bounds.vHi)), current: bounds.vHi },
      { bound: 'uLo', along: e2, across: e1, origin: c0, current: bounds.uLo },
      { bound: 'uHi', along: e2, across: e1, origin: add(c0, scale(e1, bounds.uHi)), current: bounds.uHi },
    ];
    for (const edge of edgeBounds) {
      if (assigned[edge.bound]) continue;
      let best: { distance: number; value: number; entityId: string; index: number } | null = null;
      for (const segment of segments) {
        const offA = Math.abs(dot(sub(segment.a, c0), normal));
        const offB = Math.abs(dot(sub(segment.b, c0), normal));
        if (offA > radius || offB > radius) continue;
        if (angleBetweenDirs(sub(segment.b, segment.a), edge.along) > PARALLEL_SNAP_DEG) continue;
        const value = dot(sub(segment.a, c0), edge.across);
        const d = Math.abs(value - edge.current);
        if (d > radius) continue;
        const next = { distance: d, value, entityId: segment.entityId ?? '', index: segment.index ?? 0 };
        if (
          !best ||
          next.distance < best.distance ||
          (next.distance === best.distance && (next.entityId.localeCompare(best.entityId) || next.index - best.index) < 0)
        ) {
          best = next;
        }
      }
      if (best) {
        bounds[edge.bound] = best.value;
        assigned[edge.bound] = true;
      }
    }
  }

  if (bounds.uHi - bounds.uLo < 1e-6 || bounds.vHi - bounds.vLo < 1e-6) return corners.map(clone);

  const at = (u: number, v: number): Vec3 => add(add(c0, scale(e1, u)), scale(e2, v));
  return [at(bounds.uLo, bounds.vLo), at(bounds.uHi, bounds.vLo), at(bounds.uHi, bounds.vHi), at(bounds.uLo, bounds.vHi)];
}

export function joinEndpoints(input: EntityInput, targets: JoinTargets, radius: number): EntityInput {
  if (input.type === 'line') {
    const dir = sub(input.b, input.a);
    const line = length(dir) > 1e-12 ? { origin: input.a, dir } : undefined;
    return { type: 'line', a: joinPoint(input.a, targets, radius, line), b: joinPoint(input.b, targets, radius, line) };
  }
  if (input.type !== 'rect' && input.type !== 'extrusion') return input;
  const corners = pullRectCornersWorld(input.corners, targets.vertices, radius, targets.segments);
  return input.type === 'extrusion'
    ? { type: 'extrusion', corners: corners as [Vec3, Vec3, Vec3, Vec3], depth: input.depth }
    : { type: 'rect', corners: corners as [Vec3, Vec3, Vec3, Vec3] };
}

export function shouldCloseLoop(start: Vec3, end: Vec3, radius: number): boolean {
  return distance(start, end) <= radius;
}
