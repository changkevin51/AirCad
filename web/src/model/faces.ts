import { pickFace, triangleHit } from './pick';
import type { Projector } from './snap';
import {
  circlePoints,
  cylinderTopCenter,
  entityCenter,
  entityFaces,
  extrusionNormal,
  isExtrudableProfile,
  makeRect,
  rectFrame,
  type CircleGeometry,
  type CircleEntity,
  type CylinderEntity,
  type Entity,
  type ExtrusionEntity,
  type ProfileEntity,
  type RectEntity,
} from './sketch';
import { add, dot, normalize, scale, sub, v3, type Vec2, type Vec3 } from './vec';

export interface ProfileFace {
  /** Polygon outline in world space. Circular cap outlines contain the analytic ring tessellation. */
  outline: Vec3[];
  /** Quad corners in world space for rectangular faces; absent for circular caps. */
  quad?: [Vec3, Vec3, Vec3, Vec3];
  /** Exact circle geometry for analytic cap picking. */
  circle?: CircleGeometry;
  /** Unit outward normal. */
  normal: Vec3;
  center: Vec3;
  /** Which box axis this face lies on, and its sign: 'u' | 'v' | 'n'. */
  axis: 'u' | 'v' | 'n';
  sign: 1 | -1;
  /** Human label from the world direction of `normal`, e.g. 'top' (see labelForNormal). */
  label: string;
}

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

/** All extrudable faces of a profile: 2 for a rect (its two sides, +n and -n, same quad), 6 for a solid. */
export function profileFaces(profile: ProfileEntity): ProfileFace[] {
  if (profile.type === 'circle') return circularCapFaces(profile, 0);
  if (profile.type === 'cylinder') return circularCapFaces(profile, profile.depth);
  const n = extrusionNormal(profile);
  const depth = profile.type === 'extrusion' ? profile.depth : 0;
  if (profile.type === 'rect' || Math.abs(depth) < 1e-9) {
    const quad = profile.corners.map((p) => ({ ...p })) as ProfileFace['quad'];
    if (!quad) throw new Error('rectangle profile has no quad');
    const center = quadCenter(quad);
    return [
      { outline: quad, quad, normal: n, center, axis: 'n', sign: 1, label: labelForNormal(n) },
      { outline: quad, quad, normal: scale(n, -1), center, axis: 'n', sign: -1, label: labelForNormal(scale(n, -1)) },
    ];
  }
  const { uDir, vDir } = rectFrame(profile);
  const center = entityCenter(profile);
  const faces: ProfileFace[] = [];
  for (const quad of entityFaces(profile)) {
    const faceCenter = quadCenter(quad);
    const normal = normalize(sub(faceCenter, center));
    const candidates = [
      { axis: 'u' as const, dir: uDir },
      { axis: 'v' as const, dir: vDir },
      { axis: 'n' as const, dir: n },
    ];
    let best = candidates[2];
    for (const candidate of candidates) {
      if (Math.abs(dot(normal, candidate.dir)) > Math.abs(dot(normal, best.dir))) best = candidate;
    }
    const sign = (dot(normal, best.dir) >= 0 ? 1 : -1) as 1 | -1;
    faces.push({
      outline: quad as Vec3[],
      quad: quad as ProfileFace['quad'],
      normal,
      center: faceCenter,
      axis: best.axis,
      sign,
      label: labelForNormal(normal),
    });
  }
  faces.sort((a, b) => FACE_ORDER[`${a.axis}${a.sign}`] - FACE_ORDER[`${b.axis}${b.sign}`]);
  return faces;
}

function circularCapFaces(profile: CircleGeometry | CylinderEntity, depth: number): ProfileFace[] {
  const normal = normalize(profile.normal);
  const base = { center: profile.center, normal, radius: profile.radius } satisfies CircleGeometry;
  const baseOutline = circlePoints(base);
  const farCenter = depth === 0 ? profile.center : cylinderTopCenter({ ...profile, depth });
  const farOutline = depth === 0
    ? baseOutline
    : circlePoints({ center: farCenter, normal, radius: profile.radius });
  const farSign = (depth === 0 ? 1 : Math.sign(depth)) as 1 | -1;
  const nearSign = (farSign * -1) as 1 | -1;
  const nearNormal = scale(normal, nearSign);
  const farNormal = scale(normal, farSign);
  const faces: ProfileFace[] = [
    {
      outline: baseOutline,
      normal: nearNormal,
      center: { ...profile.center },
      axis: 'n',
      sign: nearSign,
      label: labelForNormal(nearNormal),
      circle: base,
    },
    {
      outline: farOutline,
      normal: farNormal,
      center: { ...farCenter },
      axis: 'n',
      sign: farSign,
      label: labelForNormal(farNormal),
      circle: { center: { ...farCenter }, normal, radius: profile.radius },
    },
  ];
  faces.sort((a, b) => FACE_ORDER[`${a.axis}${a.sign}`] - FACE_ORDER[`${b.axis}${b.sign}`]);
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
 * Nearest face under the cursor, or null.  Coincident faces (a flat rect's two
 * sides, or faces meeting at an edge-on corner) resolve to the one whose
 * outward normal faces the camera.
 */
export function pickProfileFace(faces: readonly ProfileFace[], cursor: Vec2, projector: Projector): number | null {
  const ray = projector.ray(cursor);
  let best: number | null = null;
  let nearest = Infinity;
  let bestFacing = Infinity;
  for (const [index, face] of faces.entries()) {
    if (face.circle) {
      const denominator = dot(ray.dir, face.circle.normal);
      if (Math.abs(denominator) < 1e-9) continue;
      const t = dot(sub(face.circle.center, ray.origin), face.circle.normal) / denominator;
      if (t < 0 || t > nearest + 1e-6) continue;
      const hit = add(ray.origin, scale(ray.dir, t));
      if (Math.hypot(
        hit.x - face.circle.center.x,
        hit.y - face.circle.center.y,
        hit.z - face.circle.center.z,
      ) > face.circle.radius + 1e-8) continue;
      if (!projector.project(hit)) continue;
      const facing = dot(face.normal, ray.dir);
      if (t < nearest - 1e-6 || (t <= nearest + 1e-6 && facing < bestFacing)) {
        nearest = t;
        bestFacing = facing;
        best = index;
      }
      continue;
    }
    const [origin, ...rest] = face.outline;
    for (const triangle of rest.slice(1).map((point, triangleIndex) => [origin, rest[triangleIndex], point] as const)) {
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

export function pickExtrusionTarget(
  entities: readonly Entity[],
  cursor: Vec2,
  projector: Projector,
): { entity: ProfileEntity; faceIndex: number } | null {
  const entity = pickFace(entities, cursor, projector);
  if (!entity || entity.type === 'line') return null;
  if ((entity.type === 'rect' || entity.type === 'extrusion') && !isExtrudableProfile(entity.corners)) return null;
  const faces = profileFaces(entity);
  const faceIndex = pickProfileFace(faces, cursor, projector);
  if (faceIndex === null) return null;
  if (entity.type === 'cylinder' && dot(faces[faceIndex].normal, projector.ray(cursor).dir) > 1e-9) return null;
  return { entity, faceIndex };
}

/**
 * Push/pull `face` of `profile` outward by `distance` mm (negative pushes in).
 * Returns the resulting box; the corners change for side and base faces while
 * pulling the far cap only changes depth.
 */
type PushPullResult =
  | { corners: ExtrusionEntity['corners']; depth: number }
  | { center: Vec3; normal: Vec3; radius: number; depth: number };

export function pushPull(
  profile: RectEntity | ExtrusionEntity,
  face: ProfileFace,
  distance: number,
  minSize: number,
): { corners: ExtrusionEntity['corners']; depth: number };
export function pushPull(
  profile: CircleEntity | CylinderEntity,
  face: ProfileFace,
  distance: number,
  minSize: number,
): { center: Vec3; normal: Vec3; radius: number; depth: number };
export function pushPull(
  profile: ProfileEntity,
  face: ProfileFace,
  distance: number,
  minSize: number,
): PushPullResult {
  if (profile.type === 'circle' || profile.type === 'cylinder') {
    const normal = normalize(profile.normal);
    const depth0 = profile.type === 'cylinder' ? profile.depth : 0;
    const solid = profile.type === 'cylinder' && Math.abs(depth0) > 1e-9;
    let center = { ...profile.center };
    let depth = depth0;
    const s = face.sign;
    // On a flat circle either cap grows a cylinder. On an existing cylinder,
    // the cap in the stored normal direction is far only when depth is +;
    // a negative depth swaps which cap is near/far.
    const far = !solid || Math.sign(depth0) === s;
    if (far) {
      depth = depth0 + s * distance;
      if (solid && minSize > 0) {
        depth = Math.sign(depth0) > 0 ? Math.max(depth, minSize) : Math.min(depth, -minSize);
      }
    } else {
      let applied = distance;
      const next = () => depth0 - s * applied;
      let nextDepth = next();
      if (solid && minSize > 0) {
        const clamped = Math.sign(depth0) > 0 ? Math.max(nextDepth, minSize) : Math.min(nextDepth, -minSize);
        applied = (depth0 - clamped) / s;
        nextDepth = clamped;
      }
      depth = nextDepth;
      center = add(center, scale(normal, s * applied));
    }
    return { center, normal, radius: profile.radius, depth };
  }

  const frame = rectFrame(profile);
  const n = extrusionNormal(profile);
  const depth0 = profile.type === 'extrusion' ? profile.depth : 0;
  const solid = profile.type === 'extrusion' && Math.abs(depth0) > 1e-9;
  let { origin, width, height } = frame;
  const { uDir, vDir } = frame;
  let depth = depth0;

  if (face.axis === 'u' || face.axis === 'v') {
    const dir = face.axis === 'u' ? uDir : vDir;
    const size = face.axis === 'u' ? width : height;
    const next = minSize > 0 ? Math.max(size + distance, minSize) : size + distance;
    const applied = next - size;
    if (face.sign < 0) origin = sub(origin, scale(dir, applied));
    if (face.axis === 'u') width = next;
    else height = next;
  } else {
    const s = face.sign;
    // The face with outward normal s*n is the far cap when the profile is flat
    // or the solid grows in direction s; otherwise it is the base cap.
    const far = !solid || Math.sign(depth0) === s;
    if (far) {
      depth = depth0 + s * distance;
      if (solid && minSize > 0) {
        // A solid cannot be pushed through itself: keep the sign, floor |depth|.
        depth = Math.sign(depth0) > 0 ? Math.max(depth, minSize) : Math.min(depth, -minSize);
      }
    } else {
      let applied = distance;
      let next = depth0 - s * applied;
      if (solid && minSize > 0) {
        const clamped = Math.sign(depth0) > 0 ? Math.max(next, minSize) : Math.min(next, -minSize);
        applied = (depth0 - clamped) / s;
        next = clamped;
      }
      depth = next;
      origin = add(origin, scale(n, s * applied));
    }
  }
  return { corners: makeRect(origin, uDir, vDir, width, height), depth };
}
