/** Tiny plain-object vector helpers so the model stays JSON-friendly and three-free. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const v2 = (x: number, y: number): Vec2 => ({ x, y });

export const ORIGIN: Readonly<Vec3> = Object.freeze(v3(0, 0, 0));
export const X_AXIS: Readonly<Vec3> = Object.freeze(v3(1, 0, 0));
export const Y_AXIS: Readonly<Vec3> = Object.freeze(v3(0, 1, 0));
export const Z_AXIS: Readonly<Vec3> = Object.freeze(v3(0, 0, 1));

export const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => v3(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const clone = (a: Vec3): Vec3 => v3(a.x, a.y, a.z);
export const isFinite3 = (a: Vec3): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  return len > 1e-12 ? scale(a, 1 / len) : v3(0, 0, 0);
}

export const nearlyEqual = (a: Vec3, b: Vec3, eps = 1e-6): boolean => distance(a, b) <= eps;

export const add2 = (a: Vec2, b: Vec2): Vec2 => v2(a.x + b.x, a.y + b.y);
export const sub2 = (a: Vec2, b: Vec2): Vec2 => v2(a.x - b.x, a.y - b.y);
export const scale2 = (a: Vec2, s: number): Vec2 => v2(a.x * s, a.y * s);
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** z component of the 2D cross product (positive = counter-clockwise turn). */
export const cross2 = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const length2 = (a: Vec2): number => Math.hypot(a.x, a.y);
export const distance2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 =>
  v2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

export function normalize2(a: Vec2): Vec2 {
  const len = length2(a);
  return len > 1e-12 ? scale2(a, 1 / len) : v2(0, 0);
}

export const roundTo = (value: number, step: number): number =>
  step > 0 ? Math.round(value / step) * step : value;

export const toArray = (a: Vec3): [number, number, number] => [a.x, a.y, a.z];
export const fromArray = (a: ArrayLike<number>): Vec3 => v3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);

/** Closest points between a ray (origin + t*dir, t >= 0) and a line (p + s*axis). */
export function closestPointOnLineToRay(
  rayOrigin: Vec3,
  rayDir: Vec3,
  linePoint: Vec3,
  lineDir: Vec3,
): { point: Vec3; s: number } | null {
  const d1 = normalize(rayDir);
  const d2 = normalize(lineDir);
  const r = sub(rayOrigin, linePoint);
  const a = dot(d1, d1);
  const b = dot(d1, d2);
  const c = dot(d2, d2);
  const d = dot(d1, r);
  const e = dot(d2, r);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-12) return null;
  const s = (a * e - b * d) / denom;
  return { point: add(linePoint, scale(d2, s)), s };
}

/** Closest point on segment [a, b] to a ray, returned with its parameter t in [0, 1]. */
export function closestPointOnSegmentToRay(
  rayOrigin: Vec3,
  rayDir: Vec3,
  a: Vec3,
  b: Vec3,
): { point: Vec3; t: number } {
  const ab = sub(b, a);
  const len = length(ab);
  if (len < 1e-12) return { point: clone(a), t: 0 };
  const hit = closestPointOnLineToRay(rayOrigin, rayDir, a, ab);
  if (!hit) {
    // Parallel: pick the endpoint nearest to the ray origin projection.
    const ta = dot(sub(a, rayOrigin), normalize(rayDir));
    const tb = dot(sub(b, rayOrigin), normalize(rayDir));
    return Math.abs(ta) <= Math.abs(tb) ? { point: clone(a), t: 0 } : { point: clone(b), t: 1 };
  }
  const t = Math.min(1, Math.max(0, hit.s / len));
  return { point: lerp(a, b, t), t };
}

/** Closest point on a 2D segment to a point, with its parameter. */
export function closestPointOnSegment2(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const ab = sub2(b, a);
  const len2 = dot2(ab, ab);
  if (len2 < 1e-12) return { point: { ...a }, t: 0 };
  const t = Math.min(1, Math.max(0, dot2(sub2(p, a), ab) / len2));
  return { point: lerp2(a, b, t), t };
}
