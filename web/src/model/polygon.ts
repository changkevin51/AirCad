import { ShapeUtils, Vector2 } from 'three';
import {
  cross,
  cross2,
  distance,
  distance2,
  dot,
  dot2,
  isFinite3,
  length,
  length2,
  normalize,
  scale,
  sub,
  sub2,
  v2,
  v3,
  type Vec2,
  type Vec3,
} from './vec';

export interface PolygonFrame {
  origin: Vec3;
  uDir: Vec3;
  vDir: Vec3;
  normal: Vec3;
  points: Vec2[];
  width: number;
  height: number;
  tolerance: number;
}

export function signedArea(points: readonly Vec2[]): number {
  const n = points.length;
  if (n < 3) return 0;
  const origin = points[0];
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = sub2(points[i], origin);
    const b = sub2(points[(i + 1) % n], origin);
    area += cross2(a, b);
  }
  return area / 2;
}

function tolerance2(points: readonly Vec2[]): number {
  const origin = points[0];
  let span = 0;
  let maxCoordinate = 0;
  for (const p of points) {
    span = Math.max(span, distance2(p, origin));
    maxCoordinate = Math.max(maxCoordinate, Math.abs(p.x), Math.abs(p.y));
  }
  return Math.max(1e-9, span * 1e-10, maxCoordinate * Number.EPSILON * 8);
}

function segmentsConflict(a: Vec2, b: Vec2, c: Vec2, d: Vec2, tolerance: number): boolean {
  if (Math.max(a.x, b.x) + tolerance < Math.min(c.x, d.x) || Math.max(c.x, d.x) + tolerance < Math.min(a.x, b.x)
    || Math.max(a.y, b.y) + tolerance < Math.min(c.y, d.y) || Math.max(c.y, d.y) + tolerance < Math.min(a.y, b.y)) {
    return false;
  }
  const abLen = distance2(a, b);
  const cdLen = distance2(c, d);
  const d1 = cross2(sub2(b, a), sub2(c, a)) / abLen;
  const d2 = cross2(sub2(b, a), sub2(d, a)) / abLen;
  const d3 = cross2(sub2(d, c), sub2(a, c)) / cdLen;
  const d4 = cross2(sub2(d, c), sub2(b, c)) / cdLen;
  if ((d1 > tolerance && d2 > tolerance) || (d1 < -tolerance && d2 < -tolerance)) return false;
  if ((d3 > tolerance && d4 > tolerance) || (d3 < -tolerance && d4 < -tolerance)) return false;
  return true;
}

export function isSimplePolygon(points: readonly Vec2[], tolerance = tolerance2(points)): boolean {
  const n = points.length;
  if (n < 3) return false;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  const minEdge = Math.max(1e-6, tolerance);
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const edge = distance2(points[i], points[(i + 1) % n]);
    if (!(edge > minEdge)) return false;
    perimeter += edge;
  }
  if (!(Math.abs(signedArea(points)) > tolerance * perimeter)) return false;
  for (let i = 0; i < n; i++) {
    const prev = sub2(points[i], points[(i - 1 + n) % n]);
    const next = sub2(points[(i + 1) % n], points[i]);
    if (Math.abs(cross2(prev, next)) <= tolerance * length2(prev) && dot2(prev, next) < 0) return false;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsConflict(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n], tolerance)) return false;
    }
  }
  return true;
}

export function polygonFrame(corners: readonly Vec3[]): PolygonFrame | null {
  const n = corners.length;
  if (n < 3 || !corners.every(isFinite3)) return null;
  const origin = corners[0];
  const local = corners.map((corner) => sub(corner, origin));
  let span = 0;
  let maxCoordinate = 0;
  for (const [i, p] of local.entries()) {
    span = Math.max(span, length(p));
    maxCoordinate = Math.max(maxCoordinate, Math.abs(corners[i].x), Math.abs(corners[i].y), Math.abs(corners[i].z));
  }
  if (!Number.isFinite(span) || span <= 0) return null;
  const tolerance = Math.max(1e-9, span * 1e-10, maxCoordinate * Number.EPSILON * 8);
  const minEdge = Math.max(1e-6, tolerance);
  for (let i = 0; i < n; i++) {
    if (distance(corners[i], corners[(i + 1) % n]) <= minEdge) return null;
  }
  const areaVector = local.reduce((sum, p, i) => {
    const c = cross(p, local[(i + 1) % n]);
    return v3(sum.x + c.x, sum.y + c.y, sum.z + c.z);
  }, v3(0, 0, 0));
  const areaLength = length(areaVector);
  if (!Number.isFinite(areaLength) || areaLength <= tolerance * span) return null;
  const normal = scale(areaVector, 1 / areaLength);
  const uDir = normalize(local[1]);
  const vDir = normalize(cross(normal, uDir));
  const points = local.map((p) => v2(dot(p, uDir), dot(p, vDir)));
  for (const p of local) {
    if (Math.abs(dot(p, normal)) > tolerance) return null;
  }
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of points) {
    minU = Math.min(minU, p.x);
    maxU = Math.max(maxU, p.x);
    minV = Math.min(minV, p.y);
    maxV = Math.max(maxV, p.y);
  }
  if (!isSimplePolygon(points, tolerance)) return null;
  return {
    origin: v3(origin.x, origin.y, origin.z),
    uDir,
    vDir,
    normal,
    points,
    width: maxU - minU,
    height: maxV - minV,
    tolerance,
  };
}

export function triangulatePolygon(corners: readonly Vec3[]): [Vec3, Vec3, Vec3][] {
  const frame = polygonFrame(corners);
  if (!frame) return [];
  return ShapeUtils.triangulateShape(frame.points.map((p) => new Vector2(p.x, p.y)), [])
    .map(([a, b, c]) => [corners[a], corners[b], corners[c]] as [Vec3, Vec3, Vec3]);
}
