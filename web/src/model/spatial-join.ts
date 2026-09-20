import { PLANES, type PlaneKind, type WorkPlane } from './plane';
import type { Projector } from './snap';
import { closestPointOnSegment } from './spatial-snap';
import type { EntityInput, Vertex } from './sketch';
import {
  add,
  add2,
  clone,
  cross,
  cross2,
  distance,
  distance2,
  dot,
  dot2,
  length,
  length2,
  normalize,
  scale,
  scale2,
  sub,
  sub2,
  v2,
  type Vec2,
  type Vec3,
} from './vec';

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

export interface ProtectedTriangleAnchor {
  /** World point that an explicit object snap deliberately placed. */
  point: Vec3;
  /** Triangle corner that should remain at `point`. */
  cornerIndex: number;
}

export interface TriangleEdgeSnapOptions {
  plane: WorkPlane;
  projector: Projector;
  tolerancePx: number;
  /** Maximum angle between the two finite edges, in degrees. */
  orientationDeg?: number;
  /** Preserve this explicit object-snap corner when fitting an edge. */
  protectedAnchor?: ProtectedTriangleAnchor;
}

export interface TriangleEdgeSnapResult {
  corners: [Vec3, Vec3, Vec3];
  mode: 'parallel' | 'contact';
  edgeIndex: number;
  entityId?: string;
  segmentIndex?: number;
  distance: number;
  angleDeg: number;
}

interface TriangleEdgeCandidate {
  edgeIndex: number;
  segment: JoinSegment;
  angleDeg: number;
  distance: number;
  overlap: number;
}

function rotate2(point: Vec2, pivot: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rel = sub2(point, pivot);
  return v2(pivot.x + rel.x * c - rel.y * s, pivot.y + rel.x * s + rel.y * c);
}

function screenDistance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Estimate the world length represented by one screen pixel for simple test projectors. */
function worldPerPixelAt(projector: Projector, plane: WorkPlane, reference: Vec3): number {
  const direct = projector.worldPerPixel?.(reference);
  if (direct != null && Number.isFinite(direct) && direct > 0) return direct;
  const screen = projector.project(reference);
  const alongU = projector.project(add(reference, plane.u));
  const alongV = projector.project(add(reference, plane.v));
  if (!screen || (!alongU && !alongV)) return 1;
  const pixelsPerWorld = Math.max(
    alongU ? screenDistance(screen, alongU) : 0,
    alongV ? screenDistance(screen, alongV) : 0,
  );
  return pixelsPerWorld > 1e-9 ? 1 / pixelsPerWorld : 1;
}

function triangleEdgeCandidate(
  edgeIndex: number,
  triangle: readonly Vec2[],
  segment: JoinSegment,
  plane: WorkPlane,
  orientationDeg: number,
  distanceLimit: number,
): TriangleEdgeCandidate | null {
  const edgeA = triangle[edgeIndex];
  const edgeB = triangle[(edgeIndex + 1) % 3];
  if (!edgeA || !edgeB || !plane.contains(segment.a, 1e-6) || !plane.contains(segment.b, 1e-6)) return null;
  const edge = sub2(edgeB, edgeA);
  const target = sub2(plane.toPlane(segment.b), plane.toPlane(segment.a));
  const edgeLength = length2(edge);
  const targetLength = length2(target);
  if (edgeLength < 1e-9 || targetLength < 1e-9) return null;
  const cosine = Math.min(1, Math.abs(dot2(edge, target)) / (edgeLength * targetLength));
  const angleDeg = (Math.acos(cosine) * 180) / Math.PI;
  if (angleDeg > orientationDeg + 1e-9) return null;

  const axis = v2(target.x / targetLength, target.y / targetLength);
  const targetStart = plane.toPlane(segment.a);
  const edgeStartAlong = dot2(sub2(edgeA, targetStart), axis);
  const edgeEndAlong = dot2(sub2(edgeB, targetStart), axis);
  const edgeLo = Math.min(edgeStartAlong, edgeEndAlong);
  const edgeHi = Math.max(edgeStartAlong, edgeEndAlong);
  const overlap = Math.min(targetLength, edgeHi) - Math.max(0, edgeLo);
  // A nearby infinite line is not enough. The finite target edge must cover part
  // of the triangle edge before it can influence the completed triangle.
  if (overlap <= 1e-6) return null;

  const normal = v2(-axis.y, axis.x);
  const edgeOffset = Math.max(
    Math.abs(dot2(sub2(edgeA, targetStart), normal)),
    Math.abs(dot2(sub2(edgeB, targetStart), normal)),
  );
  if (edgeOffset > distanceLimit) return null;
  return { edgeIndex, segment, angleDeg, distance: edgeOffset, overlap };
}

/**
 * Align a recognised triangle edge to the nearest compatible finite shape edge.
 * The candidate fit is rigid: side lengths, angles, and winding are preserved.
 * A fit within one snap radius is translated onto the target line; a fit in the
 * wider alignment band is only rotated so the original gap remains visible.
 */
export function snapTriangleToSegments(
  corners: readonly Vec3[],
  segments: readonly JoinSegment[],
  options: TriangleEdgeSnapOptions,
): TriangleEdgeSnapResult | null {
  if (
    corners.length !== 3 ||
    !corners.every((point) => options.plane.contains(point, 1e-6)) ||
    !corners.every((point) => options.projector.project(point) !== null) ||
    !(options.tolerancePx > 0) ||
    !Number.isFinite(options.tolerancePx)
  ) {
    return null;
  }
  const triangle = corners.map((point) => options.plane.toPlane(point));
  const orientationDeg = options.orientationDeg ?? PARALLEL_SNAP_DEG;
  if (!(orientationDeg >= 0) || !Number.isFinite(orientationDeg)) return null;
  const reference = options.plane.toWorld(v2(
    triangle.reduce((sum, point) => sum + point.x, 0) / 3,
    triangle.reduce((sum, point) => sum + point.y, 0) / 3,
  ));
  const snapRadius = options.tolerancePx * worldPerPixelAt(options.projector, options.plane, reference);
  if (!(snapRadius > 0) || !Number.isFinite(snapRadius)) return null;
  const alignmentRadius = snapRadius * 3;
  const candidates: TriangleEdgeCandidate[] = [];
  for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
    for (const segment of segments) {
      if (!options.projector.project(segment.a) || !options.projector.project(segment.b)) continue;
      const candidate = triangleEdgeCandidate(edgeIndex, triangle, segment, options.plane, orientationDeg, alignmentRadius);
      if (candidate) candidates.push(candidate);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.angleDeg !== right.angleDeg) return left.angleDeg - right.angleDeg;
    const byId = (left.segment.entityId ?? '').localeCompare(right.segment.entityId ?? '');
    if (byId !== 0) return byId;
    const bySegment = (left.segment.index ?? 0) - (right.segment.index ?? 0);
    return bySegment || left.edgeIndex - right.edgeIndex;
  });

  const protectedPlane = options.protectedAnchor ? options.plane.toPlane(options.protectedAnchor.point) : null;
  for (const candidate of candidates) {
    const edgeA = triangle[candidate.edgeIndex];
    const edgeB = triangle[(candidate.edgeIndex + 1) % 3];
    if (!edgeA || !edgeB) continue;
    const targetA = options.plane.toPlane(candidate.segment.a);
    const targetB = options.plane.toPlane(candidate.segment.b);
    const edgeDir = sub2(edgeB, edgeA);
    let targetDir = sub2(targetB, targetA);
    if (dot2(edgeDir, targetDir) < 0) targetDir = v2(-targetDir.x, -targetDir.y);
    const edgeLength = length2(edgeDir);
    const targetLength = length2(targetDir);
    if (edgeLength < 1e-9 || targetLength < 1e-9) continue;
    const edgeUnit = v2(edgeDir.x / edgeLength, edgeDir.y / edgeLength);
    const targetUnit = v2(targetDir.x / targetLength, targetDir.y / targetLength);
    const angle = Math.atan2(cross2(edgeUnit, targetUnit), dot2(edgeUnit, targetUnit));
    const pivot = protectedPlane ?? v2((edgeA.x + edgeB.x) / 2, (edgeA.y + edgeB.y) / 2);
    let transformed = triangle.map((point) => rotate2(point, pivot, angle));
    let mode: 'parallel' | 'contact' = 'parallel';
    if (candidate.distance <= snapRadius) {
      const normal = v2(-targetUnit.y, targetUnit.x);
      const transformedEdgeMid = v2(
        (transformed[candidate.edgeIndex].x + transformed[(candidate.edgeIndex + 1) % 3].x) / 2,
        (transformed[candidate.edgeIndex].y + transformed[(candidate.edgeIndex + 1) % 3].y) / 2,
      );
      const shift = dot2(sub2(targetA, transformedEdgeMid), normal);
      if (protectedPlane && Math.abs(shift) > 1e-6) return null;
      transformed = transformed.map((point) => add2(point, scale2(normal, shift)));
      mode = 'contact';
    }
    if (protectedPlane) {
      const protectedIndex = options.protectedAnchor?.cornerIndex ?? -1;
      if (protectedIndex >= 0 && protectedIndex < 3 && distance2(transformed[protectedIndex], protectedPlane) > 1e-5) return null;
    }
    const next = transformed.map((point) => options.plane.toWorld(point)) as [Vec3, Vec3, Vec3];
    return {
      corners: next,
      mode,
      edgeIndex: candidate.edgeIndex,
      entityId: candidate.segment.entityId,
      segmentIndex: candidate.segment.index,
      distance: candidate.distance,
      angleDeg: candidate.angleDeg,
    };
  }
  return null;
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
