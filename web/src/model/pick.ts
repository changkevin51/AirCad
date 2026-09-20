import { entityFaces, type Entity } from './sketch';
import { triangulatePolygon } from './polygon';
import type { Projector } from './snap';
import { add, cross, distance, dot, sub, scale, type Vec2, type Vec3 } from './vec';

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
      const denominator = dot(ray.dir, entity.normal);
      if (Math.abs(denominator) < 1e-9) continue;
      const t = dot(sub(entity.center, ray.origin), entity.normal) / denominator;
      const hit = add(ray.origin, scale(ray.dir, t));
      if (t >= 0 && t <= nearest && distance(hit, entity.center) <= entity.radius + 1e-8 && projector.project(hit)) {
        nearest = t;
        best = entity;
      }
      continue;
    }
    for (const face of entityFaces(entity)) {
      for (const triangle of triangulatePolygon(face)) {
        const t = triangleHit(ray.origin, ray.dir, triangle[0], triangle[1], triangle[2]);
        if (t !== null && t <= nearest && projector.project(add(ray.origin, scale(ray.dir, t)))) {
          nearest = t;
          best = entity;
        }
      }
    }
  }
  return best;
}
