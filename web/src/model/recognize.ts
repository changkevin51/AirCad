import { cross2, distance2, dot2, length2, sub2, v2, type Vec2 } from './vec';

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

export interface RecognizedCircle {
  kind: 'circle';
  center: Vec2;
  radius: number;
}

export type RecognizedShape = RecognizedLine | RecognizedRect | RecognizedCircle;

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
  /** A stroke is closed when start/end are within this fraction of the bbox diagonal. */
  closureFrac: number;
  /** RDP tolerance as a fraction of the bbox diagonal. */
  rdpFrac: number;
  /** Corners below this turn (degrees) are treated as points along an edge. */
  collinearDeg: number;
  minCorners: number;
  maxCorners: number;
  /** Allowed deviation of total turning from 2π, as a fraction of 2π. */
  turningTolerance: number;
  /** Minimum polygon area / oriented-bounding-box area. */
  areaRatioMin: number;
  /** Rectangles rotated more than this (degrees) keep their orientation. */
  orientedDeg: number;
  /** Strokes whose bbox diagonal is smaller than this are ignored. */
  minSize: number;
  circleRmsFrac: number;
  circleMaxDeviationFrac: number;
  circleCircularityMin: number;
  circleSmoothFrac: number;
  circleMaxGapDeg: number;
  circleMaxTravelTurns: number;
  /** Max p85 sample distance to the nearest robust rectangle edge, normalized by bbox diagonal. */
  circleRectangleEdgeFrac: number;
}

export const DEFAULT_RECOGNIZE_OPTIONS: RecognizeOptions = {
  lineRatioMax: 1.15,
  smoothFrac: 0.02,
  lineDeviationFrac: 0.1,
  axisSnapDeg: 8,
  closureFrac: 0.15,
  rdpFrac: 0.06,
  collinearDeg: 22,
  minCorners: 4,
  maxCorners: 6,
  turningTolerance: 0.3,
  areaRatioMin: 0.75,
  orientedDeg: 12,
  minSize: 1e-6,
  circleRmsFrac: 0.18,
  circleMaxDeviationFrac: 0.45,
  circleCircularityMin: 0.55,
  circleSmoothFrac: 0.08,
  circleMaxGapDeg: 135,
  circleMaxTravelTurns: 1.75,
  // The old value only rejected nearly perfect rectangles; this still allows
  // ordinary hand jitter while rejecting straight sides that fit an OBB well.
  circleRectangleEdgeFrac: 0.055,
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

/** Open angular strokes need corner evidence in addition to a box-like fit. */
function hasSharpOpenCorners(ring: readonly Vec2[], size: number, opts: RecognizeOptions): boolean {
  let sharpCorners = 0;
  const minTurn = Math.max(60, 90 - opts.collinearDeg) * DEG;
  for (let i = 1; i + 1 < ring.length; i++) {
    const prev = sub2(ring[i], ring[i - 1]);
    const next = sub2(ring[i + 1], ring[i]);
    if (length2(prev) < size * 0.04 || length2(next) < size * 0.04) continue;
    if (Math.abs(Math.atan2(cross2(prev, next), dot2(prev, next))) >= minTurn) sharpCorners++;
  }
  return sharpCorners >= 2;
}

function fitCircle(points: readonly Vec2[], smoothed: readonly Vec2[], size: number, opts: RecognizeOptions): RecognizedCircle | null {
  if (points.length < 8 || !Number.isFinite(size) || size <= 0) return null;
  const origin = points[0];
  const local = points.map((point) => v2((point.x - origin.x) / size, (point.y - origin.y) / size));
  const weights = local.map((point, i) => (
    (i > 0 ? distance2(point, local[i - 1]) : 0)
    + (i + 1 < local.length ? distance2(point, local[i + 1]) : 0)
  ) / 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 1e-12) return null;
  const mean = v2(
    local.reduce((sum, point, i) => sum + point.x * weights[i], 0) / total,
    local.reduce((sum, point, i) => sum + point.y * weights[i], 0) / total,
  );
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let xq = 0;
  let yq = 0;
  for (const [i, point] of local.entries()) {
    const x = point.x - mean.x;
    const y = point.y - mean.y;
    const w = weights[i];
    const q = x * x + y * y;
    xx += w * x * x;
    xy += w * x * y;
    yy += w * y * y;
    xq += w * x * q / 2;
    yq += w * y * q / 2;
  }
  const determinant = xx * yy - xy * xy;
  if (Math.abs(determinant) <= 1e-12) return null;
  const center = v2(mean.x + (xq * yy - yq * xy) / determinant, mean.y + (yq * xx - xq * xy) / determinant);
  const radii = local.map((point) => distance2(point, center));
  const radius = radii.reduce((sum, value, i) => sum + value * weights[i], 0) / total;
  if (!Number.isFinite(radius) || radius <= 0 || radius * size < opts.minSize) return null;
  const errors = radii.map((value) => Math.abs(value - radius));
  const rms = Math.sqrt(errors.reduce((sum, value, i) => sum + value * value * weights[i], 0) / total);
  if (rms > radius * opts.circleRmsFrac || errors.some((error) => error > radius * opts.circleMaxDeviationFrac)) return null;
  const ring = smoothed.map((point) => v2((point.x - origin.x) / size, (point.y - origin.y) / size));
  if (ring.length < 4) return null;
  const perimeter = pathLength(ring) + distance2(ring[0], ring[ring.length - 1]);
  if (perimeter <= 1e-12 || 4 * Math.PI * Math.abs(polygonArea(ring)) / (perimeter * perimeter) < opts.circleCircularityMin) return null;
  let winding = 0;
  let travel = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = sub2(ring[i], center);
    const b = sub2(ring[(i + 1) % ring.length], center);
    const angle = Math.atan2(cross2(a, b), dot2(a, b));
    if (Math.abs(angle) > opts.circleMaxGapDeg * DEG + 1e-8) return null;
    winding += angle;
    travel += Math.abs(angle);
  }
  if (Math.abs(Math.abs(winding) - TWO_PI) > opts.turningTolerance * TWO_PI || travel > opts.circleMaxTravelTurns * TWO_PI) return null;
  const obb = minAreaRect(convexHull(local));
  if (obb) {
    const aligned = local.map((point) => rotate(point, -obb.angle));
    const [uLo, uHi] = robustExtent(aligned.map((point) => point.x));
    const [vLo, vHi] = robustExtent(aligned.map((point) => point.y));
    const edgeErrors = aligned.map((point) => Math.min(
      Math.abs(point.x - uLo), Math.abs(point.x - uHi),
      Math.abs(point.y - vLo), Math.abs(point.y - vHi),
    ));
    if (percentile(edgeErrors, 0.85) <= opts.circleRectangleEdgeFrac) {
      const closed = distance2(points[0], points[points.length - 1]) <= opts.closureFrac * size;
      if (closed || hasSharpOpenCorners(smoothed, size, opts)) return null;
    }
  }
  return { kind: 'circle', center: v2(origin.x + center.x * size, origin.y + center.y * size), radius: radius * size };
}

/**
 * Recognise a pen stroke (2D plane coordinates, mm) as a straight line or a
 * rectangle.  Anything else returns `shape: null` with a reason.
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

  const circleOutline = simplifyRdp(points, opts.circleSmoothFrac * box.diagonal);
  const circle = fitCircle(points, circleOutline, box.diagonal, opts);
  if (circle) return { shape: circle, reason: 'circle' };

  if (chord > opts.closureFrac * box.diagonal) return { shape: null, reason: 'open stroke' };

  const simplified = simplifyRdp(points, opts.rdpFrac * box.diagonal);
  let ring = simplified;
  if (ring.length > 1 && distance2(ring[0], ring[ring.length - 1]) <= opts.closureFrac * box.diagonal) {
    ring = ring.slice(0, -1);
  }
  ring = removeShallowCorners(ring, opts.collinearDeg * DEG);
  if (ring.length < opts.minCorners || ring.length > opts.maxCorners) {
    return { shape: null, reason: `${ring.length} corners` };
  }

  const turning = turningAngles(ring).reduce((sum, t) => sum + t, 0);
  if (Math.abs(Math.abs(turning) - TWO_PI) > opts.turningTolerance * TWO_PI) {
    return { shape: null, reason: 'not a simple loop' };
  }

  const area = Math.abs(polygonArea(points));
  const obb = minAreaRect(convexHull(points));
  if (!obb || obb.area < 1e-12) return { shape: null, reason: 'degenerate' };
  if (area / obb.area < opts.areaRatioMin) return { shape: null, reason: 'not rectangular' };

  const tilt = normalizeAngle90(obb.angle);
  const oriented = Math.abs(tilt) > opts.orientedDeg * DEG;
  const angle = oriented ? tilt : 0;

  const local = points.map((p) => rotate(p, -angle));
  const [uLo, uHi] = robustExtent(local.map((p) => p.x));
  const [vLo, vHi] = robustExtent(local.map((p) => p.y));
  const width = uHi - uLo;
  const height = vHi - vLo;
  if (width < opts.minSize || height < opts.minSize) return { shape: null, reason: 'degenerate' };

  let corners = [v2(uLo, vLo), v2(uHi, vLo), v2(uHi, vHi), v2(uLo, vHi)].map((c) => rotate(c, angle));
  if (turning < 0) corners = [corners[0], corners[3], corners[2], corners[1]];
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
