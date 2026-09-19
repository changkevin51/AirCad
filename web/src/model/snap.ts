import { AXIS_VECTORS, type Axis, type WorkPlane } from './plane';
import type { Segment, Vertex } from './sketch';
import {
  add,
  closestPointOnLineToRay,
  closestPointOnSegmentToRay,
  distance2,
  dot,
  roundTo,
  scale,
  sub,
  v2,
  type Vec2,
  type Vec3,
} from './vec';

export type SnapType = 'vertex' | 'midpoint' | 'axis' | 'edge' | 'grid' | 'free' | 'lock';

export interface SnapResult {
  type: SnapType;
  /** Snapped 3D point.  Vertex/midpoint/edge/lock snaps may lie off the work plane. */
  world: Vec3;
  /** The snapped point expressed in plane coordinates (projection for off-plane points). */
  plane: Vec2;
  /** Screen position of the snapped point, or the raw cursor when unprojectable. */
  screen: Vec2;
  /** True when `world` lies on the work plane. */
  onPlane: boolean;
  /** Unsnapped hit of the cursor ray on the work plane (null when edge-on). */
  raw: Vec3 | null;
  entityId?: string;
  /** For axis snaps: the plane axis (u/v) or the locked world axis (x/y/z). */
  axis?: 'u' | 'v' | Axis;
}

export interface Projector {
  /** World → screen pixels; null when the point is behind the camera. */
  project(world: Vec3): Vec2 | null;
  /** Screen pixels → world ray. */
  ray(screen: Vec2): { origin: Vec3; dir: Vec3 };
}

export interface SnapTargets {
  vertices: readonly Vertex[];
  midpoints: readonly Vertex[];
  segments: readonly Segment[];
}

export interface SnapContext {
  cursor: Vec2;
  projector: Projector;
  plane: WorkPlane;
  targets: SnapTargets;
  /** Grid step in mm; use `adaptiveGridStep` to derive it from the view. */
  gridStep: number;
  gridEnabled?: boolean;
  /** First point of the active stroke (world), enabling axis alignment. */
  strokeStart?: Vec3 | null;
  /** Hard lock to a world axis through the stroke start (X/Y/Z keys). */
  axisLock?: Axis | null;
  tolerancePx?: number;
  axisSnapDeg?: number;
  /** Skip snapping to this entity (e.g. the entity being edited). */
  excludeEntityId?: string | null;
  /** Skip vertex/midpoint/edge targets entirely (e.g. while typing). */
  disableObjectSnaps?: boolean;
}

export const DEFAULT_SNAP_TOLERANCE_PX = 22;
export const DEFAULT_AXIS_SNAP_DEG = 8;
export const GRID_STEPS = [1, 10, 100, 1000];

function makeResult(
  plane: WorkPlane,
  projector: Projector,
  world: Vec3,
  type: SnapType,
  cursor: Vec2,
  raw: Vec3 | null,
  extra: Partial<SnapResult> = {},
): SnapResult {
  return {
    type,
    world,
    plane: plane.toPlane(world),
    screen: projector.project(world) ?? cursor,
    onPlane: plane.contains(world, 1e-6),
    raw,
    ...extra,
  };
}

function axisEdgeSnap(
  plane: WorkPlane,
  projector: Projector,
  ray: { origin: Vec3; dir: Vec3 },
  preferOnPlane: boolean,
  segments: readonly Segment[],
  start2: Vec2,
  axis: 'u' | 'v',
  cursor: Vec2,
  toward: number,
  tolerance: number,
  exclude: string | null | undefined,
): SnapCandidate<Segment> | null {
  const candidates: SnapCandidate<Segment>[] = [];
  const fixed = axis === 'u' ? start2.y : start2.x;
  const startAlong = axis === 'u' ? start2.x : start2.y;
  for (const segment of segments) {
    if (exclude && segment.entityId === exclude) continue;
    if (!plane.contains(segment.a, 1e-6) || !plane.contains(segment.b, 1e-6)) continue;
    const a = plane.toPlane(segment.a);
    const b = plane.toPlane(segment.b);
    const acrossA = (axis === 'u' ? a.y : a.x) - fixed;
    const acrossB = (axis === 'u' ? b.y : b.x) - fixed;
    const denom = acrossB - acrossA;
    let along: number;
    if (Math.abs(denom) < 1e-12) {
      if (Math.abs(acrossA) > 1e-6) continue;
      const hit = plane.intersectRay(ray.origin, ray.dir);
      if (!hit) continue;
      const hit2 = plane.toPlane(hit);
      const lo = Math.min(axis === 'u' ? a.x : a.y, axis === 'u' ? b.x : b.y);
      const hi = Math.max(axis === 'u' ? a.x : a.y, axis === 'u' ? b.x : b.y);
      along = Math.min(hi, Math.max(lo, axis === 'u' ? hit2.x : hit2.y));
    } else {
      const tRaw = -acrossA / denom;
      if (tRaw < -1e-9 || tRaw > 1 + 1e-9) continue;
      const t = Math.min(1, Math.max(0, tRaw));
      along = (axis === 'u' ? a.x : a.y) + t * ((axis === 'u' ? b.x : b.y) - (axis === 'u' ? a.x : a.y));
    }
    if ((along - startAlong) * toward <= 0) continue;
    const world = plane.toWorld(axis === 'u' ? v2(along, fixed) : v2(fixed, along));
    const screen = projector.project(world);
    if (!screen) continue;
    const depth = rayDepth(ray, world);
    if (!(depth > 0)) continue;
    const d = distance2(screen, cursor);
    if (d <= tolerance) candidates.push({ target: segment, world, screen, distance: d, depth });
  }
  return pickNearest(candidates, plane, preferOnPlane);
}

/**
 * Pick the grid step (mm) whose on-screen size is at least `minPx` pixels
 * around `reference`, so the grid stays usable at every zoom level.
 */
export function adaptiveGridStep(projector: Projector, plane: WorkPlane, reference: Vec3, minPx = 10, steps: readonly number[] = GRID_STEPS): number {
  const base = projector.project(reference);
  if (!base) return steps[steps.length - 1];
  for (const step of steps) {
    const alongU = projector.project(add(reference, scale(plane.u, step)));
    const alongV = projector.project(add(reference, scale(plane.v, step)));
    const px = Math.max(alongU ? distance2(alongU, base) : 0, alongV ? distance2(alongV, base) : 0);
    if (px >= minPx) return step;
  }
  return steps[steps.length - 1];
}

const NEAR_TIE_PX = 0.75;

interface SnapCandidate<T> {
  target: T;
  world: Vec3;
  screen: Vec2;
  distance: number;
  depth: number;
}

const rayDepth = (ray: { origin: Vec3; dir: Vec3 }, world: Vec3): number =>
  dot(sub(world, ray.origin), ray.dir) / Math.max(1e-24, dot(ray.dir, ray.dir));

function pickNearest<T extends { entityId: string; index: number }>(
  candidates: SnapCandidate<T>[],
  plane: WorkPlane,
  preferOnPlane: boolean,
): SnapCandidate<T> | null {
  if (!candidates.length) return null;
  const best = Math.min(...candidates.map((candidate) => candidate.distance));
  const tied = candidates.filter((candidate) => candidate.distance <= best + NEAR_TIE_PX);
  tied.sort((a, b) => {
    if (preferOnPlane) {
      const aOn = plane.contains(a.world, 1e-6) ? 0 : 1;
      const bOn = plane.contains(b.world, 1e-6) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
    }
    if (a.depth !== b.depth) return a.depth - b.depth;
    const byId = a.target.entityId.localeCompare(b.target.entityId);
    if (byId !== 0) return byId;
    return a.target.index - b.target.index;
  });
  return tied[0];
}

function pointTargets<T extends Vertex>(
  cursor: Vec2,
  projector: Projector,
  ray: { origin: Vec3; dir: Vec3 },
  plane: WorkPlane,
  preferOnPlane: boolean,
  tolerancePx: number,
  targets: readonly T[],
  excludeEntityId: string | null | undefined,
): SnapCandidate<T> | null {
  const candidates: SnapCandidate<T>[] = [];
  for (const target of targets) {
    if (excludeEntityId && target.entityId === excludeEntityId) continue;
    const screen = projector.project(target.point);
    if (!screen) continue;
    const depth = rayDepth(ray, target.point);
    if (!(depth > 0)) continue;
    const d = distance2(screen, cursor);
    if (d <= tolerancePx) candidates.push({ target, world: target.point, screen, distance: d, depth });
  }
  return pickNearest(candidates, plane, preferOnPlane);
}

/**
 * Screen-space CAD snapping with the priority
 * lock > vertex > midpoint > axis-align > edge > grid > free.
 */
export function snapCursor(context: SnapContext): SnapResult {
  const {
    cursor,
    projector,
    plane,
    targets,
    gridStep,
    gridEnabled = true,
    strokeStart = null,
    axisLock = null,
    tolerancePx = DEFAULT_SNAP_TOLERANCE_PX,
    axisSnapDeg = DEFAULT_AXIS_SNAP_DEG,
    excludeEntityId = null,
    disableObjectSnaps = false,
  } = context;

  const ray = projector.ray(cursor);
  const planeHit = plane.intersectRay(ray.origin, ray.dir);

  if (axisLock && strokeStart) {
    const axisDir = AXIS_VECTORS[axisLock];
    const hit = closestPointOnLineToRay(ray.origin, ray.dir, strokeStart, axisDir);
    if (hit) {
      let along = hit.s;
      if (gridEnabled && gridStep > 0) {
        const startAlong = dot(strokeStart, axisDir);
        along = roundTo(startAlong + along, gridStep) - startAlong;
      }
      const world = add(strokeStart, scale(axisDir, along));
      return makeResult(plane, projector, world, 'lock', cursor, planeHit, { axis: axisLock });
    }
  }

  const preferOnPlane = strokeStart !== null;
  let bestEdge: SnapCandidate<Segment> | null = null;
  if (!disableObjectSnaps) {
    const edgeCandidates: SnapCandidate<Segment>[] = [];
    for (const segment of targets.segments) {
      if (excludeEntityId && segment.entityId === excludeEntityId) continue;
      const { point } = closestPointOnSegmentToRay(ray.origin, ray.dir, segment.a, segment.b);
      const screen = projector.project(point);
      if (!screen) continue;
      const depth = rayDepth(ray, point);
      if (!(depth > 0)) continue;
      const d = distance2(screen, cursor);
      if (d <= tolerancePx) edgeCandidates.push({ target: segment, world: point, screen, distance: d, depth });
    }
    bestEdge = pickNearest(edgeCandidates, plane, preferOnPlane);
  }
  const prefersEdge = (candidate: SnapCandidate<Vertex>): boolean =>
    preferOnPlane &&
    !plane.contains(candidate.world, 1e-6) &&
    bestEdge !== null &&
    plane.contains(bestEdge.world, 1e-6) &&
    bestEdge.distance + NEAR_TIE_PX < candidate.distance;
  if (!disableObjectSnaps) {
    const vertex = pointTargets(cursor, projector, ray, plane, preferOnPlane, tolerancePx, targets.vertices, excludeEntityId);
    if (vertex && !prefersEdge(vertex)) {
      return makeResult(plane, projector, vertex.target.point, 'vertex', cursor, planeHit, {
        screen: vertex.screen,
        entityId: vertex.target.entityId,
      });
    }
    const midpoint = pointTargets(cursor, projector, ray, plane, preferOnPlane, tolerancePx, targets.midpoints, excludeEntityId);
    if (midpoint && !prefersEdge(midpoint)) {
      return makeResult(plane, projector, midpoint.target.point, 'midpoint', cursor, planeHit, {
        screen: midpoint.screen,
        entityId: midpoint.target.entityId,
      });
    }
  }

  let axisResult: SnapResult | null = null;
  if (strokeStart && planeHit) {
    const start2 = plane.toPlane(strokeStart);
    const p2 = plane.toPlane(planeHit);
    const d = v2(p2.x - start2.x, p2.y - start2.y);
    const len = Math.hypot(d.x, d.y);
    if (len > 1e-9) {
      const angle = (Math.atan2(Math.abs(d.y), Math.abs(d.x)) * 180) / Math.PI;
      if (angle <= axisSnapDeg) {
        if (!disableObjectSnaps) {
          const hit = axisEdgeSnap(plane, projector, ray, preferOnPlane, targets.segments, start2, 'u', cursor, Math.sign(d.x), tolerancePx, excludeEntityId);
          if (hit) {
            return makeResult(plane, projector, hit.world, 'edge', cursor, planeHit, {
              screen: hit.screen,
              entityId: hit.target.entityId,
              axis: 'u',
            });
          }
        }
        const x = gridEnabled && gridStep > 0 ? roundTo(p2.x, gridStep) : p2.x;
        const world = plane.toWorld(v2(x, start2.y));
        axisResult = makeResult(plane, projector, world, 'axis', cursor, planeHit, { axis: 'u' });
      }
      if (angle >= 90 - axisSnapDeg) {
        if (!disableObjectSnaps) {
          const hit = axisEdgeSnap(plane, projector, ray, preferOnPlane, targets.segments, start2, 'v', cursor, Math.sign(d.y), tolerancePx, excludeEntityId);
          if (hit) {
            return makeResult(plane, projector, hit.world, 'edge', cursor, planeHit, {
              screen: hit.screen,
              entityId: hit.target.entityId,
              axis: 'v',
            });
          }
        }
        const y = gridEnabled && gridStep > 0 ? roundTo(p2.y, gridStep) : p2.y;
        const world = plane.toWorld(v2(start2.x, y));
        axisResult = makeResult(plane, projector, world, 'axis', cursor, planeHit, { axis: 'v' });
      }
    }
  }

  if (bestEdge) {
    return makeResult(plane, projector, bestEdge.world, 'edge', cursor, planeHit, {
      screen: bestEdge.screen,
      entityId: bestEdge.target.entityId,
    });
  }

  if (axisResult) return axisResult;

  if (!planeHit) {
    // Edge-on or behind: fall back to the point on the ray nearest the anchor.
    const t = Math.max(0, dot(sub(plane.anchor, ray.origin), ray.dir));
    const world = add(ray.origin, scale(ray.dir, t));
    return { type: 'free', world, plane: plane.toPlane(world), screen: cursor, onPlane: false, raw: null };
  }

  if (gridEnabled && gridStep > 0) {
    const p2 = plane.toPlane(planeHit);
    const world = plane.toWorld(v2(roundTo(p2.x, gridStep), roundTo(p2.y, gridStep)));
    return makeResult(plane, projector, world, 'grid', cursor, planeHit);
  }

  return { type: 'free', world: planeHit, plane: plane.toPlane(planeHit), screen: cursor, onPlane: true, raw: planeHit };
}
