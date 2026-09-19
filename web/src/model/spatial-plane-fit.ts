import { WorkPlane, type PlaneKind } from './plane';
import { add, distance, dot, length, scale, sub, v3, type Vec3 } from './vec';

export const STRAIGHT_PATH_RATIO = 1.15;
export const STRAIGHT_DEVIATION_FRAC = 0.1;
export const AXIS_ALIGN_DEG = 12;
/** Smallest / largest extent below this is treated as planar. */
export const PLANAR_FLATNESS = 0.25;

export interface StrokePlaneFit {
  plane: WorkPlane;
  kind: PlaneKind;
  flatness: number;
  straight: boolean;
  planar: boolean;
  extents: Vec3;
}

function axisExtents(points: readonly Vec3[]): Vec3 {
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
  return v3(maxX - minX, maxY - minY, maxZ - minZ);
}

function pathLength3(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

function maxLineDeviation(points: readonly Vec3[], a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const denom = dot(ab, ab);
  if (denom < 1e-12) {
    let max = 0;
    for (const point of points) max = Math.max(max, distance(point, a));
    return max;
  }
  let max = 0;
  for (const point of points) {
    const t = dot(sub(point, a), ab) / denom;
    const closest = add(a, scale(ab, t));
    max = Math.max(max, distance(point, closest));
  }
  return max;
}

function kindForNormal(axis: 'x' | 'y' | 'z'): PlaneKind {
  return axis === 'z' ? 'XY' : axis === 'y' ? 'XZ' : 'YZ';
}

function rankedAxes(extents: Vec3): { axis: 'x' | 'y' | 'z'; extent: number }[] {
  return (
    [
      { axis: 'z' as const, extent: extents.z },
      { axis: 'y' as const, extent: extents.y },
      { axis: 'x' as const, extent: extents.x },
    ] as const
  ).slice().sort((a, b) => a.extent - b.extent || (a.axis === 'z' ? -1 : b.axis === 'z' ? 1 : a.axis.localeCompare(b.axis)));
}

/** Planes an axis-aligned-ish entity already sits on, used as a fit tie-break. */
export function preferKindsFromEntity(entity: { type: string; a?: Vec3; b?: Vec3; corners?: readonly Vec3[] }): PlaneKind[] {
  const points = entity.type === 'line' && entity.a && entity.b ? [entity.a, entity.b] : entity.corners ? [...entity.corners] : [];
  if (points.length < 2) return [];
  const extents = axisExtents(points);
  const ranked = rankedAxes(extents);
  const largest = ranked[ranked.length - 1].extent;
  return ranked.filter((item) => item.extent <= Math.max(1e-3, 0.25 * largest)).map((item) => kindForNormal(item.axis));
}

/** Pick XY / XZ / YZ from the smallest per-axis extent; anchor at the snapped start. */
export function fitStrokePlane(points: readonly Vec3[], anchor: Vec3, preferKinds: readonly PlaneKind[] = []): StrokePlaneFit {
  const usable = points.length ? points : [anchor];
  const extents = axisExtents(usable);
  const largest = Math.max(extents.x, extents.y, extents.z, 0);
  const ranked = rankedAxes(extents);
  const smallest = ranked[0].extent;
  const second = ranked[1];
  const ambiguous = second.extent <= Math.max(smallest * 3, PLANAR_FLATNESS * largest, 1e-6);
  const candidates: PlaneKind[] = [kindForNormal(ranked[0].axis)];
  if (ambiguous) candidates.push(kindForNormal(second.axis));
  const kind = candidates.find((item) => preferKinds.includes(item)) ?? candidates[0];
  const flatness = largest > 0 ? smallest / largest : 0;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const chord = distance(first, last);
  const path = pathLength3(usable);
  const deviation = maxLineDeviation(usable, first, last);
  const straight =
    usable.length >= 2 &&
    chord > 1e-6 &&
    path / chord <= STRAIGHT_PATH_RATIO &&
    deviation / chord <= STRAIGHT_DEVIATION_FRAC;
  return {
    plane: new WorkPlane(kind, anchor),
    kind,
    flatness,
    straight,
    planar: flatness <= PLANAR_FLATNESS,
    extents,
  };
}

/** Keep `a`, rotate `b` onto the nearest world axis when the angle is within `deg`. */
export function alignLineToWorldAxis(a: Vec3, b: Vec3, deg = AXIS_ALIGN_DEG): { a: Vec3; b: Vec3; axis: 'x' | 'y' | 'z' | null } {
  const delta = sub(b, a);
  const len = length(delta);
  if (len < 1e-9) return { a, b, axis: null };
  const abs = { x: Math.abs(delta.x), y: Math.abs(delta.y), z: Math.abs(delta.z) };
  const axis: 'x' | 'y' | 'z' = abs.x >= abs.y && abs.x >= abs.z ? 'x' : abs.y >= abs.z ? 'y' : 'z';
  const cosine = abs[axis] / len;
  const angle = Math.acos(Math.min(1, Math.max(0, cosine))) * (180 / Math.PI);
  if (angle > deg) return { a, b, axis: null };
  const sign = delta[axis] >= 0 ? 1 : -1;
  const aligned = add(a, scale(v3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), sign * len));
  return { a, b: aligned, axis };
}
