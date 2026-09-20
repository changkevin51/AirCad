import { entityTriangles, type CylinderEntity, type Entity } from './sketch';
import type { Projector } from './snap';
import { add, cross, distance, dot, normalize, sub, scale, type Vec2, type Vec3 } from './vec';

/** Ray/triangle intersection, two-sided because sketch profiles can face either way. */
export function triangleHit(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const p = cross(dir, ac);
  const determinant = dot(ab, p);
  if (Math.abs(determinant) < 1e-9) return null;
  const fromA = sub(origin, a);
  const u = dot(fromA, p) / determinant;
  if (u < -1e-8 || u > 1 + 1e-8) return null;
  const q = cross(fromA, ab);
  const v = dot(dir, q) / determinant;
  if (v < -1e-8 || u + v > 1 + 1e-8) return null;
  const t = dot(ac, q) / determinant;
  return t >= 0 ? t : null;
}

/** Pick face interiors as well as outlines. The nearest visible face wins. */
export function pickFace(entities: readonly Entity[], cursor: Vec2, projector: Projector): Entity | null {
  const ray = projector.ray(cursor);
  let best: Entity | null = null;
  let nearest = Infinity;
  for (const entity of entities) {
    if (entity.type === 'circle') {
      const normal = normalize(entity.normal);
      const denominator = dot(ray.dir, normal);
      if (Math.abs(denominator) < 1e-9) continue;
      const t = dot(sub(entity.center, ray.origin), normal) / denominator;
      const hit = add(ray.origin, scale(ray.dir, t));
      if (t >= 0 && t <= nearest && distance(hit, entity.center) <= entity.radius + 1e-8 && projector.project(hit)) {
        nearest = t;
        best = entity;
      }
      continue;
    }
    if (entity.type === 'cylinder') {
      const hit = pickCylinder(entity, ray.origin, ray.dir, projector, nearest);
      if (hit && hit.t <= nearest) {
        nearest = hit.t;
        best = entity;
      }
      continue;
    }
    for (const [a, b, c] of entityTriangles(entity)) {
      const t = triangleHit(ray.origin, ray.dir, a, b, c);
      if (t !== null && t <= nearest && projector.project(add(ray.origin, scale(ray.dir, t)))) {
        nearest = t;
        best = entity;
      }
    }
  }
  return best;
}

/** Exact ray intersection against a finite analytic cylinder, including both caps. */
function pickCylinder(
  cylinder: CylinderEntity,
  origin: Vec3,
  dir: Vec3,
  projector: Projector,
  nearest: number,
): { t: number; point: Vec3 } | null {
  const normal = normalize(cylinder.normal);
  const depth = cylinder.depth;
  const lo = Math.min(0, depth);
  const hi = Math.max(0, depth);
  let best: { t: number; point: Vec3 } | null = null;
  const consider = (t: number): void => {
    if (!Number.isFinite(t) || t < 0 || t > nearest || (best && t > best.t)) return;
    const point = add(origin, scale(dir, t));
    if (!projector.project(point)) return;
    best = { t, point };
  };

  const denominator = dot(dir, normal);
  if (Math.abs(denominator) > 1e-9) {
    for (const axial of [lo, hi]) {
      const capCenter = add(cylinder.center, scale(normal, axial));
      const t = dot(sub(capCenter, origin), normal) / denominator;
      if (t < 0 || t > nearest) continue;
      const hit = add(origin, scale(dir, t));
      const axialOffset = dot(sub(hit, cylinder.center), normal);
      const radial = sub(sub(hit, cylinder.center), scale(normal, axialOffset));
      if (dot(radial, radial) <= cylinder.radius * cylinder.radius + 1e-8) consider(t);
    }
  }

  const relative = sub(origin, cylinder.center);
  const axialOrigin = dot(relative, normal);
  const radialOrigin = sub(relative, scale(normal, axialOrigin));
  const axialDir = dot(dir, normal);
  const radialDir = sub(dir, scale(normal, axialDir));
  const a = dot(radialDir, radialDir);
  const b = 2 * dot(radialOrigin, radialDir);
  const c = dot(radialOrigin, radialOrigin) - cylinder.radius * cylinder.radius;
  if (a > 1e-12) {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= -1e-9) {
      const root = Math.sqrt(Math.max(0, discriminant));
      for (const t of [(-b - root) / (2 * a), (-b + root) / (2 * a)]) {
        if (t < 0 || t > nearest) continue;
        const axial = axialOrigin + t * axialDir;
        if (axial >= lo - 1e-8 && axial <= hi + 1e-8) consider(t);
      }
    }
  }
  return best;
}
