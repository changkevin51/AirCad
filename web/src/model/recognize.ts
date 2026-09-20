import { isSimplePolygon } from './polygon';
import { closestPointOnSegment2, cross2, distance2, dot2, length2, sub2, v2, type Vec2 } from './vec';

export interface RecognizedLine {
  kind: 'line';
  a: Vec2;
  b: Vec2;
  /** Which plane axis the line was aligned to, if any. */
  alignedTo: 'u' | 'v' | null;
}

export interface RecognizedRect {
  kind: 'rect';
  /** Ordered around the outline, `corners[0]` is nearest to the stroke start. */
  corners: [Vec2, Vec2, Vec2, Vec2];
  width: number;
  height: number;
  /** True when the rectangle is rotated relative to the plane axes. */
  oriented: boolean;
  /** Rotation of the first edge relative to the plane U axis, radians. */
  angle: number;
}

export interface RecognizedPolygon {
  kind: 'polygon';
  corners: Vec2[];
}

export interface RecognizedTriangle {
  kind: 'triangle';
  corners: [Vec2, Vec2, Vec2];
}

export type RecognizedShape = RecognizedLine | RecognizedRect | RecognizedPolygon | RecognizedTriangle;

export interface RecognizeResult {
  shape: RecognizedShape | null;
  /** Short machine-readable reason, useful for HUD feedback and tests. */
  reason: string;
}

export interface RecognizeOptions {
  /** Max ratio of (jitter-smoothed) path length to chord length for a straight line. */
  lineRatioMax: number;
  /** RDP tolerance used to remove sample jitter before measuring path length. */
  smoothFrac: number;
  /** Max perpendicular deviation from the chord as a fraction of chord length. */
  lineDeviationFrac: number;
  /** Lines within this many degrees of a plane axis are aligned to it. */
  axisSnapDeg: number;
  /** A rectangle candidate is closed when start/end are within this fraction of the bbox diagonal. */
  closureFrac: number;
  /** RDP tolerance as a fraction of the bbox diagonal. */
  rdpFrac: number;
  /** Corners below this turn (degrees) are treated as points along an edge. */
  collinearDeg: number;
  /** Allowed deviation of total turning from 2π, as a fraction of 2π. */
  turningTolerance: number;
  /** Minimum polygon area / oriented-bounding-box area. */
  areaRatioMin: number;
  /** Rectangles rotated more than this (degrees) keep their orientation. */
  orientedDeg: number;
  /** Strokes whose bbox diagonal is smaller than this are ignored. */
  minSize: number;
  rectangleTurnDeg: number;
  rectangleEdgeFrac: number;
  outlineRdpFrac: number;
  outlineClosureFrac: number;
  /** A loose rectangle candidate is closed when start/end are within this fraction of the bbox diagonal. */
  rectClosureFrac: number;
  /** Minimum polygon area / oriented-bounding-box area for the aggressive rectangle fallback. */
  obbAreaRatioMin: number;
}

export const DEFAULT_RECOGNIZE_OPTIONS: RecognizeOptions = {
  lineRatioMax: 1.15,
  smoothFrac: 0.02,
  lineDeviationFrac: 0.1,
  axisSnapDeg: 8,
  closureFrac: 0.15,
  rdpFrac: 0.06,
  collinearDeg: 22,
  turningTolerance: 0.3,
  areaRatioMin: 0.75,
  orientedDeg: 12,
  minSize: 1e-6,
  rectangleTurnDeg: 12,
  rectangleEdgeFrac: 0.025,
  outlineRdpFrac: 0.0025,
  outlineClosureFrac: 0.03,
  rectClosureFrac: 0.28,
  obbAreaRatioMin: 0.52,
};

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;

export function dedupePoints(points: readonly Vec2[], eps = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (!out.length || distance2(out[out.length - 1], point) > eps) out.push(v2(point.x, point.y));
  }
  return out;
}

export function pathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance2(points[i - 1], points[i]);
  return total;
}

export function boundingBox2(points: readonly Vec2[]): { min: Vec2; max: Vec2; width: number; height: number; diagonal: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  return { min: v2(minX, minY), max: v2(maxX, maxY), width, height, diagonal: Math.hypot(width, height) };
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub2(b, a);
  const len = length2(ab);
  if (len < 1e-12) return distance2(p, a);
  return Math.abs(cross2(ab, sub2(p, a))) / len;
}

/** Ramer–Douglas–Peucker polyline simplification (keeps first and last point). */
export function simplifyRdp(points: readonly Vec2[], epsilon: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDistance = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i], points[start], points[end]);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }
    if (index >= 0 && maxDistance > epsilon) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function polygonArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += cross2(a, b);
  }
  return area / 2;
}

export function convexHull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross2(sub2(lower[lower.length - 1], lower[lower.length - 2]), sub2(p, lower[lower.length - 2])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross2(sub2(upper[upper.length - 1], upper[upper.length - 2]), sub2(p, upper[upper.length - 2])) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export interface OrientedBox {
  angle: number;
  area: number;
  width: number;
  height: number;
}

/** Minimum-area bounding rectangle of a convex hull (rotating-calipers style scan). */
export function minAreaRect(hull: readonly Vec2[]): OrientedBox | null {
  if (hull.length < 2) return null;
  let best: OrientedBox | null = null;
  for (let i = 0; i < hull.length; i++) {
    const edge = sub2(hull[(i + 1) % hull.length], hull[i]);
    const len = length2(edge);
    if (len < 1e-12) continue;
    const ux = edge.x / len;
    const uy = edge.y / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (!best || area < best.area) best = { angle: Math.atan2(uy, ux), area, width, height };
  }
  return best;
}

function turningAngles(ring: readonly Vec2[]): number[] {
  const n = ring.length;
  return ring.map((_, i) => {
    const prev = sub2(ring[i], ring[(i - 1 + n) % n]);
    const next = sub2(ring[(i + 1) % n], ring[i]);
    return Math.atan2(cross2(prev, next), dot2(prev, next));
  });
}

function removeShallowCorners(ring: Vec2[], minTurn: number): Vec2[] {
  let current = ring;
  for (let guard = 0; guard < 16 && current.length > 3; guard++) {
    const turns = turningAngles(current);
    let weakest = -1;
    let weakestTurn = Infinity;
    turns.forEach((turn, i) => {
      if (Math.abs(turn) < weakestTurn) {
        weakestTurn = Math.abs(turn);
        weakest = i;
      }
    });
    if (weakest < 0 || weakestTurn >= minTurn) break;
    current = current.filter((_, i) => i !== weakest);
  }
  return current;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

/** Robust extents: trim overshoot at corners once there are enough samples. */
function robustExtent(values: number[]): [number, number] {
  if (values.length < 24) return [Math.min(...values), Math.max(...values)];
  return [percentile(values, 0.04), percentile(values, 0.96)];
}

function rotate(p: Vec2, angle: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return v2(p.x * c - p.y * s, p.x * s + p.y * c);
}

export function alignLineToAxis(a: Vec2, b: Vec2, axisSnapDeg: number): RecognizedLine {
  const d = sub2(b, a);
  const angle = Math.atan2(Math.abs(d.y), Math.abs(d.x)) / DEG;
  if (angle <= axisSnapDeg) return { kind: 'line', a: v2(a.x, a.y), b: v2(b.x, a.y), alignedTo: 'u' };
  if (angle >= 90 - axisSnapDeg) return { kind: 'line', a: v2(a.x, a.y), b: v2(a.x, b.y), alignedTo: 'v' };
  return { kind: 'line', a: v2(a.x, a.y), b: v2(b.x, b.y), alignedTo: null };
}

function normalizeAngle90(angle: number): number {
  let a = angle % (Math.PI / 2);
  if (a > Math.PI / 4) a -= Math.PI / 2;
  if (a < -Math.PI / 4) a += Math.PI / 2;
  return a;
}

function rectangleFromObb(
  points: readonly Vec2[],
  first: Vec2,
  opts: RecognizeOptions,
  minRatio = opts.obbAreaRatioMin,
  maxRatio = 1.02,
): RecognizeResult | null {
  const signedArea = polygonArea(points);
  const area = Math.abs(signedArea);
  const obb = minAreaRect(convexHull(points));
  if (!obb || obb.area < 1e-12) return null;
  const ratio = area / obb.area;
  if (ratio < minRatio || ratio > maxRatio) return null;

  const tilt = normalizeAngle90(obb.angle);
  const oriented = Math.abs(tilt) > opts.orientedDeg * DEG;
  const angle = oriented ? tilt : 0;

  const local = points.map((p) => rotate(p, -angle));
  const [uLo, uHi] = robustExtent(local.map((p) => p.x));
  const [vLo, vHi] = robustExtent(local.map((p) => p.y));
  const width = uHi - uLo;
  const height = vHi - vLo;
  if (width < opts.minSize || height < opts.minSize) return null;

  let corners = [v2(uLo, vLo), v2(uHi, vLo), v2(uHi, vHi), v2(uLo, vHi)].map((c) => rotate(c, angle));
  if (signedArea < 0) corners = [corners[0], corners[3], corners[2], corners[1]];
  let startIndex = 0;
  let startDistance = Infinity;
  corners.forEach((c, i) => {
    const d = distance2(c, first);
    if (d < startDistance) {
      startDistance = d;
      startIndex = i;
    }
  });
  corners = corners.slice(startIndex).concat(corners.slice(0, startIndex));
  const firstEdge = distance2(corners[0], corners[1]);
  const secondEdge = distance2(corners[1], corners[2]);

  return {
    shape: {
      kind: 'rect',
      corners: corners as [Vec2, Vec2, Vec2, Vec2],
      width: firstEdge,
      height: secondEdge,
      oriented,
      angle: Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x),
    },
    reason: oriented ? 'oriented rectangle' : 'rectangle',
  };
}

function recognizeRectangle(points: readonly Vec2[], diagonal: number, opts: RecognizeOptions, first: Vec2): RecognizeResult | null {
  const simplified = simplifyRdp(points, opts.rdpFrac * diagonal);
  let ring = simplified;
  if (ring.length > 1 && distance2(ring[0], ring[ring.length - 1]) <= opts.closureFrac * diagonal) {
    ring = ring.slice(0, -1);
  }
  ring = removeShallowCorners(ring, opts.collinearDeg * DEG);
  if (ring.length !== 4) return null;

  const turns = turningAngles(ring);
  if (turns.some((turn) => Math.abs(Math.abs(turn) - Math.PI / 2) > opts.rectangleTurnDeg * DEG)) return null;
  const turning = turns.reduce((sum, t) => sum + t, 0);
  if (Math.abs(Math.abs(turning) - TWO_PI) > opts.turningTolerance * TWO_PI) return null;

  const obb = minAreaRect(convexHull(points));
  if (!obb || obb.area < 1e-12) return null;
  if (Math.abs(polygonArea(points)) / obb.area < opts.areaRatioMin) return null;

  const obbAligned = points.map((p) => rotate(p, -obb.angle));
  const [suLo, suHi] = robustExtent(obbAligned.map((p) => p.x));
  const [svLo, svHi] = robustExtent(obbAligned.map((p) => p.y));
  const edgeErrors = obbAligned.map((p) => Math.min(
    Math.abs(p.x - suLo), Math.abs(p.x - suHi),
    Math.abs(p.y - svLo), Math.abs(p.y - svHi),
  ));
  if (percentile(edgeErrors, 0.85) > opts.rectangleEdgeFrac * diagonal) return null;

  return rectangleFromObb(points, first, opts, opts.areaRatioMin);
}

function fitTriangle(points: readonly Vec2[], size: number, opts: RecognizeOptions): RecognizedTriangle | null {
  if (points.length < 4 || !Number.isFinite(size) || size <= 0) return null;
  const origin = points[0];
  const local = points.map((point) => v2((point.x - origin.x) / size, (point.y - origin.y) / size));
  if (distance2(local[0], local[local.length - 1]) > opts.closureFrac) return null;
  let ring = simplifyRdp(local, opts.rdpFrac);
  if (ring.length > 1 && distance2(ring[0], ring[ring.length - 1]) <= opts.closureFrac) ring = ring.slice(0, -1);
  ring = removeShallowCorners(ring, opts.collinearDeg * DEG);
  if (ring.length !== 3) return null;
  const sides = ring.map((point, index) => distance2(point, ring[(index + 1) % 3]));
  const area = Math.abs(polygonArea(ring));
  if (sides.some((side) => side < Math.max(0.04, opts.minSize / size)) || area < 0.005) return null;
  const outlineArea = Math.abs(polygonArea(local));
  if (outlineArea < area * 0.7 || outlineArea > area * 1.3) return null;
  const smoothed = simplifyRdp(local, opts.smoothFrac);
  const travel = pathLength(smoothed) + distance2(smoothed[0], smoothed[smoothed.length - 1]);
  const perimeter = sides.reduce((sum, side) => sum + side, 0);
  if (travel < perimeter * 0.75 || travel > perimeter * 1.3) return null;
  const errors = local.map((point) => Math.min(...ring.map((a, index) =>
    distance2(point, closestPointOnSegment2(point, a, ring[(index + 1) % 3]).point))));
  if (percentile(errors, 0.85) > 0.05 || errors.some((error) => error > 0.12)) return null;
  let start = 0;
  for (let index = 1; index < 3; index++) {
    if (distance2(ring[index], local[0]) < distance2(ring[start], local[0])) start = index;
  }
  const ordered = ring.slice(start).concat(ring.slice(0, start));
  return {
    kind: 'triangle',
    corners: ordered.map((point) => v2(origin.x + point.x * size, origin.y + point.y * size)) as [Vec2, Vec2, Vec2],
  };
}

/**
 * Recognise a pen stroke (2D plane coordinates, mm) as a straight line, a
 * fitted triangle or rectangle, or any other simple closed outline (a polygon
 * whose corners are stroke samples). Closed strokes that are even loosely
 * rectangular, including round loops, square up to a rectangle. Open strokes
 * return `shape: null`.
 */
export function recognizeStroke(input: readonly Vec2[], options: Partial<RecognizeOptions> = {}): RecognizeResult {
  const opts = { ...DEFAULT_RECOGNIZE_OPTIONS, ...options };
  const points = dedupePoints(input);
  if (points.length < 2) return { shape: null, reason: 'too few points' };
  const box = boundingBox2(points);
  if (box.diagonal < opts.minSize) return { shape: null, reason: 'too small' };

  const first = points[0];
  const last = points[points.length - 1];
  const chord = distance2(first, last);
  // Dense, slightly jittered samples inflate the raw path length; measure it
  // on a lightly simplified copy so slow strokes still read as straight.
  const smoothed = simplifyRdp(points, opts.smoothFrac * box.diagonal);
  const path = pathLength(smoothed);

  if (chord > 0 && path / chord <= opts.lineRatioMax) {
    let deviation = 0;
    for (const p of points) deviation = Math.max(deviation, perpendicularDistance(p, first, last));
    if (deviation / chord <= opts.lineDeviationFrac) {
      return { shape: alignLineToAxis(first, last, opts.axisSnapDeg), reason: 'line' };
    }
  }

  const triangle = fitTriangle(points, box.diagonal, opts);
  if (triangle) return { shape: triangle, reason: 'triangle' };

  if (chord <= opts.closureFrac * box.diagonal) {
    const rect = recognizeRectangle(points, box.diagonal, opts, first);
    if (rect) return rect;
  }
  if (chord <= opts.rectClosureFrac * box.diagonal) {
    const fitted = rectangleFromObb(points, first, opts);
    if (fitted) return fitted;
  }

  if (chord > opts.outlineClosureFrac * box.diagonal) return { shape: null, reason: 'open stroke' };

  const closed = points.map((p) => v2(p.x, p.y));
  closed[closed.length - 1] = v2(first.x, first.y);
  let ring = simplifyRdp(closed, opts.outlineRdpFrac * box.diagonal);
  if (ring.length > 1 && distance2(ring[0], ring[ring.length - 1]) <= Math.max(1e-9, opts.outlineClosureFrac * box.diagonal)) {
    ring = ring.slice(0, -1);
  }
  if (ring.length < 3) return { shape: null, reason: 'too few corners' };
  if (!isSimplePolygon(ring)) return { shape: null, reason: 'not a simple loop' };
  return { shape: { kind: 'polygon', corners: ring }, reason: 'closed outline' };
}
