import { triangleHit } from './pick';
import { polygonFrame, triangulatePolygon } from './polygon';
import type { Projector } from './snap';
import {
  extrusionNormal,
  isRectangleProfile,
  rectFrame,
  type ProfileEntity,
} from './sketch';
import { add, clone, cross, dot, normalize, scale, sub, v3, type Vec2, type Vec3 } from './vec';

export interface ProfileFace {
  /** Face corners in world space (a full outline for caps, a quad for sides). */
  quad: Vec3[];
  /** Unit outward normal. */
  normal: Vec3;
  center: Vec3;
  /** Which box axis this face lies on, and its sign: 'u' | 'v' | 'n'; generic polygon sides are 'edge'. */
  axis: 'u' | 'v' | 'n' | 'edge';
  sign: 1 | -1;
  edgeIndex?: number;
  /** Human label from the world direction of `normal`, e.g. 'top' (see labelForNormal). */
  label: string;
}

export const sameProfileFace = (
  a: Pick<ProfileFace, 'axis' | 'sign' | 'edgeIndex'>,
  b: Pick<ProfileFace, 'axis' | 'sign' | 'edgeIndex'>,
): boolean => a.axis === b.axis && a.sign === b.sign && a.edgeIndex === b.edgeIndex;

/** CAD Z-up labels matching the 1/2/3 view keys: front looks along +Y, right along -X. */
export function labelForNormal(normal: Vec3): string {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) return normal.z >= 0 ? 'top' : 'bottom';
  if (ay >= ax) return normal.y >= 0 ? 'back' : 'front';
  return normal.x >= 0 ? 'right' : 'left';
}

function quadCenter(quad: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of quad) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return v3(x / quad.length, y / quad.length, z / quad.length);
}

/** Canonical index order keeps face indices stable as a preview grows from a rect into a solid. */
const FACE_ORDER: Record<string, number> = { 'n1': 0, 'n-1': 1, 'u1': 2, 'u-1': 3, 'v1': 4, 'v-1': 5 };

/** All extrudable faces of a profile: 2 coincident caps for a flat outline (+n and -n), n+2 for a solid. */
export function profileFaces(profile: ProfileEntity): ProfileFace[] {
  const frame = polygonFrame(profile.corners);
  if (!frame) return [];
  const n = extrusionNormal(profile);
  const depth = profile.type === 'extrusion' ? profile.depth : 0;
  const corners = profile.corners;
  if (profile.type !== 'extrusion' || Math.abs(depth) < 1e-9) {
    const quad = corners.map((p) => ({ ...p }));
    const center = quadCenter(quad);
    return [
      { quad, normal: n, center, axis: 'n', sign: 1, label: labelForNormal(n) },
      { quad: quad.map((p) => ({ ...p })), normal: scale(n, -1), center, axis: 'n', sign: -1, label: labelForNormal(scale(n, -1)) },
    ];
  }
  const offset = scale(n, depth);
  const base = corners.map((p) => ({ ...p }));
  const top = corners.map((p) => add(p, offset));
  const positiveCap = depth > 0 ? top : base;
  const negativeCap = depth > 0 ? base : top;
  const sides = corners.map((a, i) => {
    const b = corners[(i + 1) % corners.length];
    const normal = normalize(cross(sub(b, a), frame.normal));
    const quad = [a, b, add(b, offset), add(a, offset)];
    return { quad, normal, center: quadCenter(quad), axis: 'edge' as const, sign: 1 as const, edgeIndex: i, label: labelForNormal(normal) };
  });
  const faces: ProfileFace[] = [
    { quad: positiveCap, normal: n, center: quadCenter(positiveCap), axis: 'n', sign: 1, label: labelForNormal(n) },
    { quad: negativeCap, normal: scale(n, -1), center: quadCenter(negativeCap), axis: 'n', sign: -1, label: labelForNormal(scale(n, -1)) },
    ...sides,
  ];
  if (isRectangleProfile(corners)) {
    const { uDir, vDir } = rectFrame(profile);
    for (const face of faces) {
      if (face.axis !== 'edge') continue;
      const alongU = dot(face.normal, uDir);
      const alongV = dot(face.normal, vDir);
      const axis: 'u' | 'v' = Math.abs(alongU) >= Math.abs(alongV) ? 'u' : 'v';
      face.axis = axis;
      face.sign = ((axis === 'u' ? alongU : alongV) >= 0 ? 1 : -1) as 1 | -1;
    }
    faces.sort((a, b) => FACE_ORDER[`${a.axis}${a.sign}`] - FACE_ORDER[`${b.axis}${b.sign}`]);
  }
  return faces;
}

/** Index of the face whose outward normal points most toward the camera. Ties: lowest index. */
export function defaultFaceIndex(faces: readonly ProfileFace[], viewDirection: Vec3): number {
  let best = 0;
  let bestDot = -Infinity;
  for (const [index, face] of faces.entries()) {
    const facing = -dot(face.normal, viewDirection);
    if (facing > bestDot) {
      bestDot = facing;
      best = index;
    }
  }
  return best;
}

/**
 * Nearest face under the cursor, or null.  Coincident faces (a flat outline's
 * two caps, or faces meeting at an edge-on corner) resolve to the one whose
 * outward normal faces the camera.
 */
export function pickProfileFace(faces: readonly ProfileFace[], cursor: Vec2, projector: Projector): number | null {
  const ray = projector.ray(cursor);
  let best: number | null = null;
  let nearest = Infinity;
  let bestFacing = Infinity;
  for (const [index, face] of faces.entries()) {
    for (const triangle of triangulatePolygon(face.quad)) {
      const t = triangleHit(ray.origin, ray.dir, triangle[0], triangle[1], triangle[2]);
      if (t === null || !projector.project(add(ray.origin, scale(ray.dir, t)))) continue;
      const facing = dot(face.normal, ray.dir);
      if (t < nearest - 1e-6 || (t <= nearest + 1e-6 && facing < bestFacing)) {
        nearest = Math.min(nearest, t);
        bestFacing = facing;
        best = index;
      }
    }
  }
  return best;
}

export function profileEdgeRun(profile: ProfileEntity, face: ProfileFace): number[] {
  const corners = profile.corners;
  const frame = polygonFrame(corners);
  const start = face.edgeIndex;
  if (!frame || start === undefined || !Number.isInteger(start) || start < 0 || start >= corners.length) {
    throw new Error('Side face has no valid boundary edge');
  }
  const count = corners.length;
  const sameSupport = (index: number): boolean => {
    const a = corners[index];
    const b = corners[(index + 1) % count];
    const normal = normalize(cross(sub(b, a), frame.normal));
    return Math.abs(dot(normal, face.normal) - 1) < 1e-9
      && Math.abs(dot(sub(a, corners[start]), face.normal)) <= frame.tolerance;
  };
  const run = [start];
  for (let k = (start - 1 + count) % count; run.length < count && sameSupport(k); k = (k - 1 + count) % count) run.unshift(k);
  for (let k = (start + 1) % count; run.length < count && sameSupport(k); k = (k + 1) % count) run.push(k);
  return run;
}

/**
 * Push/pull `face` of `profile` outward by `distance` mm (negative pushes in).
 * Cap pulls move the whole profile or change only the depth; a side pull
 * translates the edge's supporting line along the face normal and re-meets
 * its unchanged neighbours.  Throws when the edit cannot be represented.
 */
export function pushPull(
  profile: ProfileEntity,
  face: ProfileFace,
  distance: number,
  minSize: number,
): { corners: Vec3[]; depth: number } {
  if (!Number.isFinite(distance)) throw new Error('Pull distance must be finite');
  const frame = polygonFrame(profile.corners);
  if (!frame) throw new Error('Profile is not a simple closed planar outline');
  const corners = profile.corners;
  const count = corners.length;
  const normal = extrusionNormal(profile);
  const ringNormal = frame.normal;
  const depth0 = profile.type === 'extrusion' ? profile.depth : 0;
  const solid = profile.type === 'extrusion' && Math.abs(depth0) > 1e-9;

  if (face.axis === 'n') {
    const s = face.sign;
    // The face with outward normal s*n is the far cap when the profile is flat
    // or the solid grows in direction s; otherwise it is the base cap.
    const far = !solid || Math.sign(depth0) === s;
    if (far) {
      let depth = depth0 + s * distance;
      if (solid && minSize > 0) {
        // A solid cannot be pushed through itself: keep the sign, floor |depth|.
        depth = Math.sign(depth0) > 0 ? Math.max(depth, minSize) : Math.min(depth, -minSize);
      } else if (solid && (depth === 0 || Math.sign(depth) !== Math.sign(depth0))) {
        throw new Error('That pull would collapse or invert the solid');
      }
      return { corners: corners.map(clone), depth };
    }
    let applied = distance;
    let depth = depth0 - s * applied;
    if (minSize > 0) {
      const clamped = Math.sign(depth0) > 0 ? Math.max(depth, minSize) : Math.min(depth, -minSize);
      applied = (depth0 - clamped) / s;
      depth = clamped;
    } else if (depth === 0 || Math.sign(depth) !== Math.sign(depth0)) {
      throw new Error('That pull would collapse or invert the solid');
    }
    const shift = scale(normal, s * applied);
    return { corners: corners.map((corner) => add(corner, shift)), depth };
  }

  if (face.edgeIndex === undefined) throw new Error('Side face has no boundary edge');
  let applied = distance;
  if (minSize > 0 && (face.axis === 'u' || face.axis === 'v') && isRectangleProfile(corners)) {
    const { width, height } = rectFrame(profile);
    const size = face.axis === 'u' ? width : height;
    applied = Math.max(applied, minSize - size);
  }

  const run = profileEdgeRun(profile, face);
  const runVertices = [...run, (run[run.length - 1] + 1) % count];
  const first = runVertices[0];
  const last = runVertices[runVertices.length - 1];
  const before = normalize(sub(corners[first], corners[(first - 1 + count) % count]));
  const after = normalize(sub(corners[(last + 1) % count], corners[last]));
  const d0 = dot(before, face.normal);
  const d1 = dot(after, face.normal);
  if (Math.abs(d0) < 1e-9 || Math.abs(d1) < 1e-9) throw new Error('That pull cannot move this face');

  const out = corners.map(clone);
  for (const vertex of runVertices.slice(1, -1)) {
    out[vertex] = add(corners[vertex], scale(face.normal, applied));
  }
  out[first] = add(corners[first], scale(before, applied / d0));
  out[last] = add(corners[last], scale(after, applied / d1));

  const moved = polygonFrame(out);
  if (!moved || dot(moved.normal, ringNormal) <= 0) throw new Error('That pull breaks the closed outline');
  for (let i = 0; i < count; i++) {
    const was = sub(corners[(i + 1) % count], corners[i]);
    const now = sub(out[(i + 1) % count], out[i]);
    if (dot(now, was) <= 0) throw new Error('That pull would invert the outline');
  }
  return { corners: out, depth: depth0 };
}
