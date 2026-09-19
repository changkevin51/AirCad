import type { PlaneKind, WorkPlane } from './plane';
import type { SnapResult } from './snap';
import { fitStrokePlane, type StrokePlaneFit } from './spatial-plane-fit';
import { isFiniteSnap, type SpatialSnapResult } from './spatial-snap';
import { StrokeSession } from './stroke';
import { clone, distance, isFinite3, sub, type Vec3 } from './vec';
import { shouldCloseLoop } from './spatial-join';

export const SPATIAL_RESUME_MS = 400;
export const SPATIAL_RESUME_RADIUS_MM = 80;
export const SPATIAL_MIN_LENGTH_MM = 5;
export const SPATIAL_POINT_SEP_MM = 3;
export const SPATIAL_RESUME_CONFIRM = 3;

export interface SpatialStrokeIdentity {
  streamId: string;
  sourceRunId: string;
  trackingEpoch: number;
  mappingRevision: number;
}

export interface FittedSpatialStroke extends StrokePlaneFit {
  session: StrokeSession;
}

function identitiesMatch(a: SpatialStrokeIdentity, b: SpatialStrokeIdentity): boolean {
  return (
    a.streamId === b.streamId &&
    a.sourceRunId === b.sourceRunId &&
    a.trackingEpoch === b.trackingEpoch &&
    a.mappingRevision === b.mappingRevision
  );
}

export function spatialToSnapResult(snap: SpatialSnapResult, plane: WorkPlane): SnapResult {
  const world = snap.world;
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

/**
 * Free 3D stroke: a raw world polyline plus identity fencing.
 * `fitted()` projects the path onto the inferred work plane for recognition.
 */
export class SpatialStrokeSession {
  readonly start: SpatialSnapResult;
  current: SpatialSnapResult;
  readonly identity: SpatialStrokeIdentity;
  readonly points: Vec3[] = [];
  status: 'active' | 'dead' = 'active';
  paused = false;
  private pausedAt = 0;
  private resumeHits = 0;

  constructor(start: SpatialSnapResult, identity: SpatialStrokeIdentity, _now: number) {
    this.start = start;
    this.current = start;
    this.identity = identity;
    this.points.push(clone(start.world));
  }

  update(snap: SpatialSnapResult, identity: SpatialStrokeIdentity, fresh: boolean, now: number, scale = 1): boolean {
    if (this.status === 'dead') return false;
    if (!identitiesMatch(this.identity, identity)) {
      this.pause(now);
      return false;
    }
    if (!fresh) {
      this.pause(now);
      return false;
    }
    if (this.paused) {
      if (now - this.pausedAt > SPATIAL_RESUME_MS) {
        this.status = 'dead';
        return false;
      }
      if (distance(snap.world, this.current.world) > SPATIAL_RESUME_RADIUS_MM * scale) {
        this.status = 'dead';
        return false;
      }
      this.resumeHits++;
      if (this.resumeHits < SPATIAL_RESUME_CONFIRM) return false;
      this.paused = false;
      this.resumeHits = 0;
    }
    this.current = snap;
    if (isFiniteSnap(snap) && isFinite3(snap.raw)) this.append(snap.raw, scale);
    return true;
  }

  pause(now: number): void {
    if (this.paused || this.status === 'dead') return;
    this.paused = true;
    this.pausedAt = now;
    this.resumeHits = 0;
  }

  isDead(now: number): boolean {
    return this.status === 'dead' || (this.paused && now - this.pausedAt > SPATIAL_RESUME_MS);
  }

  preview(): { a: Vec3; b: Vec3 } {
    return { a: this.start.world, b: this.current.world };
  }

  polyline(): Vec3[] {
    const points = this.points.map(clone);
    const last = this.current.world;
    if (!points.length) return [clone(last)];
    const tip = points[points.length - 1];
    if (distance(tip, last) > 1e-6) points.push(clone(last));
    else points[points.length - 1] = clone(last);
    return points;
  }

  delta(): Vec3 {
    return sub(this.current.world, this.start.world);
  }

  length(): number {
    return distance(this.start.world, this.current.world);
  }

  worldExtent(): number {
    const points = this.polyline();
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

  canCommit(scale: number): boolean {
    if (this.status !== 'active' || this.paused) return false;
    if (!isFinite3(this.start.world) || !isFinite3(this.current.world)) return false;
    return this.worldExtent() >= SPATIAL_MIN_LENGTH_MM * scale;
  }

  closeLoop(radius: number): boolean {
    if (!shouldCloseLoop(this.start.world, this.current.world, radius)) return false;
    this.current = { ...this.current, world: clone(this.start.world) };
    if (this.points.length > 1) this.points[this.points.length - 1] = clone(this.start.world);
    else this.points.push(clone(this.start.world));
    return true;
  }

  fitted(preferKinds: readonly PlaneKind[] = []): FittedSpatialStroke {
    const points = this.polyline();
    const fit = fitStrokePlane(points, this.start.world, preferKinds);
    const session = new StrokeSession(fit.plane, spatialToSnapResult(this.start, fit.plane));
    const mids = points.slice(1, -1);
    for (const point of mids) {
      const projected = fit.plane.project(point);
      session.add(
        {
          type: 'free',
          world: projected,
          plane: fit.plane.toPlane(point),
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
      session.add(
        spatialToSnapResult(this.current, fit.plane),
        fit.plane.project(this.current.raw),
        this.current.screen ?? { x: 0, y: 0 },
        0,
        0,
      );
    }
    return { ...fit, session };
  }

  private append(world: Vec3, scale: number): void {
    const last = this.points[this.points.length - 1];
    if (distance(world, last) >= SPATIAL_POINT_SEP_MM * scale) this.points.push(clone(world));
    else if (this.points.length > 1) this.points[this.points.length - 1] = clone(world);
  }
}
