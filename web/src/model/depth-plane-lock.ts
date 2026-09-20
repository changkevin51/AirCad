import { PLANES, PLANE_ORDER, WorkPlane, type Axis, type PlaneKind } from './plane';
import type { SnapResult } from './snap';
import { fitStrokePlane } from './spatial-plane-fit';
import type { SpatialSnapResult } from './spatial-snap';
import { StrokeSession } from './stroke';
import { clone, distance, dot, length, type Vec3 } from './vec';

/** Physical millimetres of stroke extent before the plane may lock; multiply by mapping scale. */
export const DEPTH_PLANE_LOCK_MM = 30;
export const SPATIAL_POINT_SEP_MM = 3;

export type DepthBufferState = 'pending' | 'provisional' | 'locked';

const OBJECT_SNAPS = new Set(['vertex', 'midpoint', 'edge', 'lock']);

export class DepthStrokeBuffer {
  readonly start: SpatialSnapResult;
  readonly prestroke: WorkPlane;
  readonly points: Vec3[] = [];
  state: DepthBufferState = 'pending';
  announced = false;

  constructor(start: SpatialSnapResult, prestroke: WorkPlane) {
    this.start = start;
    this.prestroke = prestroke;
    this.points.push(clone(start.world));
  }

  get prestrokeKind(): PlaneKind {
    return this.prestroke.kind;
  }

  append(world: Vec3, scale: number): void {
    const last = this.points[this.points.length - 1];
    if (distance(world, last) >= SPATIAL_POINT_SEP_MM * scale) this.points.push(clone(world));
    else if (this.points.length > 1) this.points[this.points.length - 1] = clone(world);
  }

  polyline(current?: Vec3): Vec3[] {
    const points = this.points.map(clone);
    if (!current) return points;
    if (!points.length) return [clone(current)];
    const tip = points[points.length - 1];
    if (distance(tip, current) > 1e-6) points.push(clone(current));
    else points[points.length - 1] = clone(current);
    return points;
  }

  worldExtent(current?: Vec3): number {
    const points = this.polyline(current);
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      minZ = Math.min(minZ, point.z);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      maxZ = Math.max(maxZ, point.z);
    }
    return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  }
}

export interface ChooseStrokePlaneOptions {
  preferKind?: PlaneKind;
  preferPlane?: WorkPlane;
  viewDir?: Vec3 | null;
  axisLock?: Axis | null;
}

export interface StrokePlaneChoice {
  plane: WorkPlane;
  kind: PlaneKind;
  ambiguous: boolean;
  candidates: PlaneKind[];
}

function planesContainingAxis(axis: Axis): PlaneKind[] {
  return PLANE_ORDER.filter((kind) => PLANES[kind].uAxis === axis || PLANES[kind].vAxis === axis);
}

function viewAlignment(kind: PlaneKind, viewDir: Vec3): number {
  const len = length(viewDir);
  if (len < 1e-12) return 0;
  const nx = viewDir.x / len;
  const ny = viewDir.y / len;
  const nz = viewDir.z / len;
  return Math.abs(dot({ x: nx, y: ny, z: nz }, PLANES[kind].normal));
}

function pickKind(candidates: readonly PlaneKind[], preferKind?: PlaneKind, viewDir?: Vec3 | null): PlaneKind {
  if (candidates.length === 1) return candidates[0];
  if (preferKind && candidates.includes(preferKind)) return preferKind;
  if (viewDir) {
    const ranked = [...candidates].sort((a, b) => {
      const byView = viewAlignment(b, viewDir) - viewAlignment(a, viewDir);
      if (byView !== 0) return byView;
      return PLANE_ORDER.indexOf(a) - PLANE_ORDER.indexOf(b);
    });
    return ranked[0];
  }
  return [...candidates].sort((a, b) => PLANE_ORDER.indexOf(a) - PLANE_ORDER.indexOf(b))[0];
}

/** Principal plane that contains the drawn direction, with continuity / view / order tie-breaks. */
export function chooseStrokePlane(
  points: readonly Vec3[],
  anchor: Vec3,
  options: ChooseStrokePlaneOptions = {},
): StrokePlaneChoice {
  const preferKind = options.preferKind ?? options.preferPlane?.kind;
  const fit = fitStrokePlane(points, anchor);
  let candidates = [...fit.candidates];
  if (options.axisLock) {
    const containing = planesContainingAxis(options.axisLock);
    const restricted = candidates.filter((kind) => containing.includes(kind));
    candidates = restricted.length ? restricted : [...containing];
  }
  if (!candidates.length) candidates = [...PLANE_ORDER];
  const ambiguous = candidates.length > 1 && (fit.ambiguous || Boolean(options.axisLock && candidates.length > 1));
  const kind = pickKind(candidates, preferKind, options.viewDir);
  const plane =
    options.preferPlane && options.preferPlane.kind === kind
      ? new WorkPlane(kind, options.preferPlane.anchor)
      : new WorkPlane(kind, anchor);
  return { plane, kind, ambiguous, candidates };
}

export function spatialToSnapResult(snap: SpatialSnapResult, plane: WorkPlane): SnapResult {
  const object = OBJECT_SNAPS.has(snap.type);
  const world = object ? snap.world : plane.project(snap.raw);
  return {
    type: snap.type === 'lock' ? 'lock' : snap.type,
    world,
    plane: plane.toPlane(world),
    screen: snap.screen ?? { x: 0, y: 0 },
    onPlane: plane.contains(world, 1e-3),
    raw: plane.project(snap.raw),
    entityId: snap.entityId,
    axis: snap.axis,
  };
}

export function rebuildPlanarSession(
  plane: WorkPlane,
  start: SpatialSnapResult,
  points: readonly Vec3[],
  last: SpatialSnapResult,
  toSnap: (snap: SpatialSnapResult, plane: WorkPlane) => SnapResult = spatialToSnapResult,
): StrokeSession {
  const session = new StrokeSession(plane, toSnap(start, plane));
  const mids = points.length > 2 ? points.slice(1, -1) : [];
  for (const point of mids) {
    const projected = plane.project(point);
    session.add(
      {
        type: 'free',
        world: projected,
        plane: plane.toPlane(point),
        screen: { x: 0, y: 0 },
        onPlane: true,
        raw: projected,
      },
      projected,
      { x: 0, y: 0 },
      0,
      0,
    );
  }
  if (points.length > 1) {
    const end = toSnap(last, plane);
    session.add(end, plane.project(last.raw), last.screen ?? { x: 0, y: 0 }, 0, 0);
  }
  return session;
}
