import { AXIS_VECTORS, type Axis } from './plane';
import type { SnapTargets } from './snap';
import {
  add,
  clone,
  distance,
  dot,
  isFinite3,
  roundTo,
  scale,
  sub,
  v3,
  type Vec2,
  type Vec3,
} from './vec';

export type SpatialSnapType = 'vertex' | 'midpoint' | 'edge' | 'grid' | 'free' | 'lock';

export interface SpatialSnapResult {
  type: SpatialSnapType;
  world: Vec3;
  raw: Vec3;
  screen: Vec2 | null;
  entityId?: string;
  index?: number;
  axis?: Axis;
}

export interface SpatialSnapContext {
  raw: Vec3;
  targets: SnapTargets;
  scale: number;
  gridEnabled?: boolean;
  gridStep?: number;
  start?: Vec3 | null;
  axisLock?: Axis | null;
  planeWorld?: ((point: Vec3) => Vec3) | null;
  project?: ((world: Vec3) => Vec2 | null) | null;
  previous?: SpatialSnapResult | null;
  /** Screen-pixel snap floor; combined with worldPerPixel for the hybrid radius. */
  screenTolerancePx?: number;
  /** World millimetres represented by one screen pixel at the cursor. */
  worldPerPixel?: number;
  /** Extra radius multiplier at pen-down / pen-up (1 = none). */
  magnet?: number;
  /** Prefer this world point when two same-priority snaps are tied. */
  prefer?: Vec3 | null;
}

export const SPATIAL_OBJECT_RADIUS_MM = 40;
export const SPATIAL_GRID_STEP_MM = 5;
export const SPATIAL_EXIT_FACTOR = 1.5;
export const SPATIAL_CHALLENGE_FACTOR = 0.2;
export const SPATIAL_SCREEN_TOLERANCE_PX = 22;
export const SPATIAL_MAGNET = 1.5;

const PRIORITY: Record<SpatialSnapType, number> = {
  lock: 0,
  vertex: 1,
  midpoint: 2,
  edge: 3,
  grid: 4,
  free: 5,
};

export function objectRadius(scale: number): number {
  return SPATIAL_OBJECT_RADIUS_MM * scale;
}

export function hybridRadius(
  scale: number,
  worldPerPixel = 0,
  screenTolerancePx = SPATIAL_SCREEN_TOLERANCE_PX,
  magnet = 1,
): number {
  const physical = objectRadius(scale);
  const screen = worldPerPixel > 0 ? screenTolerancePx * worldPerPixel : 0;
  return Math.max(physical, screen) * Math.max(1, magnet);
}

export function gridStepForScale(scale: number): number {
  return SPATIAL_GRID_STEP_MM * scale;
}

export function closestPointOnSegment(point: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number } {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < 1e-12) return { point: clone(a), t: 0 };
  const t = Math.min(1, Math.max(0, dot(sub(point, a), ab) / denom));
  return { point: add(a, scale(ab, t)), t };
}

export function lockAxisPoint(raw: Vec3, start: Vec3, axis: Axis, gridStep = 0): Vec3 {
  const dir = AXIS_VECTORS[axis];
  let along = dot(sub(raw, start), dir);
  if (gridStep > 0) along = roundTo(along, gridStep);
  return add(start, scale(dir, along));
}

function snapGrid(point: Vec3, step: number): Vec3 {
  return v3(roundTo(point.x, step), roundTo(point.y, step), roundTo(point.z, step));
}

interface Candidate {
  type: SpatialSnapType;
  world: Vec3;
  distance: number;
  entityId?: string;
  index?: number;
  axis?: Axis;
}

function choose(
  candidates: Candidate[],
  raw: Vec3,
  radius: number,
  previous: SpatialSnapResult | null,
  prefer: Vec3 | null,
): Candidate {
  candidates.sort((a, b) => {
    if (PRIORITY[a.type] !== PRIORITY[b.type]) return PRIORITY[a.type] - PRIORITY[b.type];
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (prefer) {
      const da = distance(a.world, prefer);
      const db = distance(b.world, prefer);
      if (da !== db) return da - db;
    }
    const byId = (a.entityId ?? '').localeCompare(b.entityId ?? '');
    if (byId !== 0) return byId;
    return (a.index ?? 0) - (b.index ?? 0);
  });
  const best = candidates[0];
  if (!previous || previous.type === 'free' || previous.type === 'lock') return best;
  if (PRIORITY[best.type] < PRIORITY[previous.type]) return best;
  const previousDistance = distance(previous.world, raw);
  if (previousDistance > radius * SPATIAL_EXIT_FACTOR) return best;
  if (PRIORITY[best.type] === PRIORITY[previous.type]) {
    if (best.distance + radius * SPATIAL_CHALLENGE_FACTOR < previousDistance) return best;
    return {
      type: previous.type,
      world: previous.world,
      distance: previousDistance,
      entityId: previous.entityId,
      index: previous.index,
      axis: previous.axis,
    };
  }
  return {
    type: previous.type,
    world: previous.world,
    distance: previousDistance,
    entityId: previous.entityId,
    index: previous.index,
    axis: previous.axis,
  };
}

export function snapSpatial(context: SpatialSnapContext): SpatialSnapResult {
  const {
    raw,
    targets,
    scale,
    gridEnabled = false,
    start = null,
    axisLock = null,
    planeWorld = null,
    project = null,
    previous = null,
    screenTolerancePx = SPATIAL_SCREEN_TOLERANCE_PX,
    worldPerPixel = 0,
    magnet = 1,
    prefer = null,
  } = context;
  const point = planeWorld ? planeWorld(raw) : raw;
  const physical = objectRadius(scale) * Math.max(1, magnet);
  const radius = hybridRadius(scale, worldPerPixel, screenTolerancePx, magnet);
  const step = context.gridStep && context.gridStep > 0 ? context.gridStep : gridStepForScale(scale);

  if (axisLock && start) {
    const world = lockAxisPoint(point, start, axisLock, gridEnabled ? step : 0);
    return { type: 'lock', world, raw: point, screen: project?.(world) ?? null, axis: axisLock };
  }

  const candidates: Candidate[] = [{ type: 'free', world: point, distance: 0 }];
  for (const vertex of targets.vertices) {
    const d = distance(point, vertex.point);
    if (d <= radius) {
      candidates.push({ type: 'vertex', world: vertex.point, distance: d, entityId: vertex.entityId, index: vertex.index });
    }
  }
  for (const mid of targets.midpoints) {
    const d = distance(point, mid.point);
    if (d <= radius) {
      candidates.push({ type: 'midpoint', world: mid.point, distance: d, entityId: mid.entityId, index: mid.index });
    }
  }
  for (const segment of targets.segments) {
    const hit = closestPointOnSegment(point, segment.a, segment.b);
    const d = distance(point, hit.point);
    if (d <= radius) {
      candidates.push({ type: 'edge', world: hit.point, distance: d, entityId: segment.entityId, index: segment.index });
    }
  }
  if (gridEnabled && step > 0) {
    const snapped = snapGrid(point, step);
    candidates.push({ type: 'grid', world: snapped, distance: distance(point, snapped) });
  }

  const objectHits = candidates.filter((item) => item.type === 'vertex' || item.type === 'midpoint' || item.type === 'edge');
  const closeHits = objectHits.filter((item) => item.distance <= physical);
  const usable = closeHits.length
    ? [...closeHits, ...candidates.filter((item) => item.type === 'grid' || item.type === 'free' || item.type === 'lock')]
    : candidates;
  const picked = choose(usable, point, radius, previous, prefer);
  return {
    type: picked.type,
    world: picked.world,
    raw: point,
    screen: project?.(picked.world) ?? null,
    entityId: picked.entityId,
    index: picked.index,
    axis: picked.axis,
  };
}

export class SpatialSnapper {
  previous: SpatialSnapResult | null = null;

  snap(context: Omit<SpatialSnapContext, 'previous'>): SpatialSnapResult {
    const result = snapSpatial({ ...context, previous: this.previous });
    this.previous = result;
    return result;
  }

  reset(): void {
    this.previous = null;
  }
}

export function isFiniteSnap(snap: SpatialSnapResult): boolean {
  return isFinite3(snap.world) && isFinite3(snap.raw);
}
