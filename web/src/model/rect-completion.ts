import type { WorkPlane } from './plane';
import { pathLength, polygonArea, recognizeStroke } from './recognize';
import type { Projector } from './snap';
import { entitySegments, type Entity, type EntityInput, type Segment } from './sketch';
import {
  add,
  clone,
  closestPointOnSegment2,
  cross,
  cross2,
  distance,
  distance2,
  dot,
  dot2,
  lerp2,
  length,
  length2,
  nearlyEqual,
  roundTo,
  scale,
  sub,
  sub2,
  v2,
  type Vec2,
  type Vec3,
} from './vec';

export interface CompletionContext {
  plane: WorkPlane;
  entities: readonly Entity[];
  gridStep?: number;
}

export interface RectangleCompletion {
  corners: [Vec3, Vec3, Vec3, Vec3];
  removeIds: string[];
}

function geomEps(magnitude: number): number {
  return Math.max(1e-6, Number.EPSILON * Math.abs(magnitude) * 32);
}

function magnitudeOf(points: readonly Vec3[]): number {
  let magnitude = 0;
  for (const p of points) magnitude = Math.max(magnitude, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
  return magnitude;
}

function coplanarSegments(plane: WorkPlane, entities: readonly Entity[]): Segment[] {
  const out: Segment[] = [];
  for (const entity of entities) {
    for (const segment of entitySegments(entity)) {
      const eps = geomEps(magnitudeOf([segment.a, segment.b]));
      if (plane.contains(segment.a, eps) && plane.contains(segment.b, eps)) out.push(segment);
    }
  }
  return out;
}

function pointOnSegment(p: Vec3, a: Vec3, b: Vec3, eps: number): boolean {
  const ab = sub(b, a);
  const len = length(ab);
  if (len < 1e-12) return distance(p, a) <= eps;
  const t = dot(sub(p, a), ab) / (len * len);
  if (t < -eps / len || t > 1 + eps / len) return false;
  return distance(p, add(a, scale(ab, Math.min(1, Math.max(0, t))))) <= eps;
}

function coveredLineIds(entities: readonly Entity[], corners: readonly Vec3[]): string[] {
  const eps = geomEps(magnitudeOf(corners));
  const edges: [Vec3, Vec3][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  const ids: string[] = [];
  for (const entity of entities) {
    if (entity.type !== 'line') continue;
    const covered = edges.some(([a, b]) => pointOnSegment(entity.a, a, b, eps) && pointOnSegment(entity.b, a, b, eps));
    if (covered) ids.push(entity.id);
  }
  return ids;
}

export function sameRectangle(a: readonly Vec3[], b: readonly Vec3[]): boolean {
  if (a.length !== 4 || b.length !== 4) return false;
  const eps = geomEps(magnitudeOf([...a, ...b]));
  for (let start = 0; start < 4; start++) {
    let forward = true;
    let backward = true;
    for (let i = 0; i < 4; i++) {
      if (!nearlyEqual(a[i], b[(start + i) % 4], eps)) forward = false;
      if (!nearlyEqual(a[i], b[(start - i + 8) % 4], eps)) backward = false;
    }
    if (forward || backward) return true;
  }
  return false;
}

export function alignRectangleToBorder(
  corners: readonly Vec3[],
  context: CompletionContext & { projector: Projector; tolerancePx: number },
): RectangleCompletion | null {
  const { plane, projector, tolerancePx } = context;
  const eps = geomEps(magnitudeOf(corners));
  if (corners.length !== 4 || !(tolerancePx > 0) || corners.some((p) => !plane.contains(p, eps))) return null;
  if (context.entities.some((e) => e.type === 'rect' && sameRectangle(e.corners, corners))) return null;
  const candidates: {
    corners: [Vec3, Vec3, Vec3, Vec3];
    score: number;
    border: [Vec3, Vec3];
    coplanarFace: boolean;
  }[] = [];
  for (const entity of context.entities) {
    for (const segment of entitySegments(entity)) {
      if (!plane.contains(segment.a, eps) || !plane.contains(segment.b, eps)) continue;
      const len = distance(segment.a, segment.b);
      if (!(len > eps)) continue;
      const sa = projector.project(segment.a);
      const sb = projector.project(segment.b);
      if (!sa || !sb || distance2(sa, sb) < Math.max(4, tolerancePx)) continue;
      const ray = projector.ray(lerp2(sa, sb, 0.5));
      if (Math.abs(dot(ray.dir, plane.normal)) < 0.15 * length(ray.dir)) continue;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        const k = (i + 2) % 4;
        const m = (i + 3) % 4;
        const edge = sub(corners[j], corners[i]);
        const edgeLength = length(edge);
        if (!(edgeLength > eps)) continue;
        const forward = dot(edge, sub(segment.b, segment.a)) >= 0;
        const a = forward ? segment.a : segment.b;
        const b = forward ? segment.b : segment.a;
        const u = scale(sub(b, a), 1 / len);
        const cosine = dot(edge, u) / edgeLength;
        if (cosine < Math.cos((22 * Math.PI) / 180)) continue;
        const v = cross(plane.normal, u);
        const lo = dot(sub(corners[i], a), u);
        const hi = dot(sub(corners[j], a), u);
        const span = hi - lo;
        const h0 = dot(sub(corners[m], corners[i]), v);
        const h1 = dot(sub(corners[k], corners[j]), v);
        let h = (h0 + h1) / 2;
        if (!(span > eps) || Math.abs(h) <= eps || h0 * h1 <= 0) continue;
        const nearA = add(a, scale(u, lo));
        const nearB = add(a, scale(u, hi));
        const p0 = projector.project(corners[i]);
        const p1 = projector.project(corners[j]);
        const q0 = projector.project(nearA);
        const q1 = projector.project(nearB);
        if (!p0 || !p1 || !q0 || !q1) continue;
        const gap = Math.max(distance2(p0, q0), distance2(p1, q1));
        if (gap > tolerancePx) continue;
        const coplanarFace = entity.type === 'rect' && entity.corners.every((p) => plane.contains(p, eps));
        let neighborDepth = 0;
        if (coplanarFace && entity.type === 'rect') {
          const offsets = entity.corners.map((p) => dot(sub(p, a), v));
          const inside = offsets.reduce((sum, value) => sum + value, 0) / 4;
          if (inside * h >= -eps * Math.abs(h)) continue;
          neighborDepth = Math.max(...offsets.map(Math.abs));
        }
        const full = span >= 0.65 * len && span <= 1.35 * len && Math.abs(lo) <= 0.35 * len && Math.abs(hi - len) <= 0.35 * len;
        if (!full && (lo < -eps || hi > len + eps)) continue;
        if (full && neighborDepth > eps && Math.abs(h) >= 0.75 * neighborDepth && Math.abs(h) <= 1.25 * neighborDepth) {
          h = Math.sign(h) * neighborDepth;
        }
        const start = full ? clone(a) : nearA;
        const end = full ? clone(b) : nearB;
        const rise = scale(v, h);
        const fitted = corners.map(clone) as [Vec3, Vec3, Vec3, Vec3];
        fitted[i] = start;
        fitted[j] = end;
        fitted[m] = add(start, rise);
        fitted[k] = add(end, rise);
        if (fitted.some((p) => !projector.project(p))) continue;
        const score = gap / tolerancePx + (full ? (Math.abs(lo) + Math.abs(hi - len)) / len : 1) + (1 - cosine);
        candidates.push({ corners: fitted, score, border: [a, b], coplanarFace });
      }
    }
  }
  const preferred = candidates.filter(
    (candidate) =>
      candidate.coplanarFace ||
      !candidates.some(
        (other) =>
          other.coplanarFace &&
          other.score <= candidate.score + 0.1 &&
          ((nearlyEqual(candidate.border[0], other.border[0], eps) && nearlyEqual(candidate.border[1], other.border[1], eps)) ||
            (nearlyEqual(candidate.border[0], other.border[1], eps) && nearlyEqual(candidate.border[1], other.border[0], eps))),
      ),
  );
  preferred.sort((a, b) => a.score - b.score);
  const best = preferred[0];
  if (!best) return null;
  if (preferred.some((other) => other.score <= best.score + 0.1 && !sameRectangle(other.corners, best.corners))) return null;
  return { corners: best.corners, removeIds: coveredLineIds(context.entities, best.corners) };
}

export function completeSharedBorder(
  points: readonly Vec2[],
  start: Vec3,
  end: Vec3,
  context: CompletionContext,
): RectangleCompletion | null {
  const { plane } = context;
  const eps = geomEps(magnitudeOf([start, end]));
  if (!plane.contains(start, eps) || !plane.contains(end, eps)) return null;
  const chord = sub(end, start);
  const chordLength = length(chord);
  if (chordLength <= eps) return null;
  const u = scale(chord, 1 / chordLength);
  const v = cross(plane.normal, u);

  const intervals: [number, number][] = [];
  for (const segment of coplanarSegments(plane, context.entities)) {
    const ta = dot(sub(segment.a, start), u);
    const tb = dot(sub(segment.b, start), u);
    const offAxis = Math.max(
      distance(segment.a, add(start, scale(u, ta))),
      distance(segment.b, add(start, scale(u, tb))),
    );
    if (offAxis > eps) continue;
    intervals.push([Math.min(ta, tb), Math.max(ta, tb)]);
  }
  intervals.sort((x, y) => x[0] - y[0]);
  let reach = 0;
  let covered = false;
  for (const [lo, hi] of intervals) {
    if (hi < -eps) continue;
    if (lo > reach + eps) break;
    covered = true;
    reach = Math.max(reach, hi);
    if (reach >= chordLength - eps) break;
  }
  if (!covered || reach < chordLength - eps) return null;

  const local = points.map((p) => {
    const rel = sub(plane.toWorld(p), start);
    return v2(dot(rel, u), dot(rel, v));
  });
  if (local.length < 2) return null;
  const attachTol = Math.max(eps, 0.02 * chordLength);
  if (length2(local[0]) > attachTol) return null;
  if (distance2(local[local.length - 1], v2(chordLength, 0)) > attachTol) return null;

  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of local) {
    vMin = Math.min(vMin, p.y);
    vMax = Math.max(vMax, p.y);
  }
  const extent = Math.max(vMax, -vMin);
  if (extent <= eps) return null;
  if (Math.min(vMax, -vMin) > Math.max(eps, 0.15 * extent)) return null;
  if (pathLength(local) < chordLength + extent) return null;

  const edgeTol = Math.max(eps, 0.15 * extent);
  const uTol = Math.max(0.1 * chordLength, edgeTol);
  if (local.some((p) => p.x < -edgeTol || p.x > chordLength + edgeTol)) return null;

  const recognized = recognizeStroke([...local, local[0]]);
  let h = 0;
  if (recognized.shape?.kind === 'rect') {
    const corners2 = recognized.shape.corners;
    let baseline: [Vec2, Vec2] | null = null;
    for (let i = 0; i < 4; i++) {
      const a = corners2[i];
      const b = corners2[(i + 1) % 4];
      if (Math.abs(a.y) <= edgeTol && Math.abs(b.y) <= edgeTol) {
        if (baseline) return null;
        baseline = [a, b];
        const lo = Math.min(a.x, b.x);
        const hi = Math.max(a.x, b.x);
        if (Math.abs(lo) > uTol || Math.abs(hi - chordLength) > uTol) return null;
        const far = corners2.filter((_, k) => k !== i && k !== (i + 1) % 4);
        if (Math.sign(far[0].y) !== Math.sign(far[1].y)) return null;
        if (Math.abs(far[0].y - far[1].y) > edgeTol) return null;
        h = (far[0].y + far[1].y) / 2;
      }
    }
    if (!baseline || Math.abs(h) <= eps) return null;
  } else if (recognized.shape?.kind === 'polygon' || recognized.shape === null) {
    h = Math.abs(vMax) >= Math.abs(vMin) ? vMax : vMin;
    if (Math.abs(h) <= eps) return null;
  } else {
    return null;
  }

  const fitTol = Math.max(1e-3, 0.28 * Math.min(chordLength, Math.abs(h)));
  const far0 = v2(0, h);
  const far1 = v2(chordLength, h);
  const visits = (target: Vec2) => local.some((p) => distance2(p, target) <= fitTol);
  if (!visits(far0) || !visits(far1)) return null;
  const sides: [Vec2, Vec2][] = [
    [v2(0, 0), far0],
    [far0, far1],
    [far1, v2(chordLength, 0)],
  ];
  for (const [a, b] of sides) {
    const near = local.some((p) => distance2(p, closestPointOnSegment2(p, a, b).point) <= fitTol);
    if (!near) return null;
  }

  if (context.gridStep && context.gridStep > 0) {
    const rounded = roundTo(h, context.gridStep);
    if (Number.isFinite(rounded) && Math.abs(rounded) > eps) h = rounded;
  }

  const rise = scale(v, h);
  const corners: [Vec3, Vec3, Vec3, Vec3] = [clone(start), add(start, rise), add(end, rise), clone(end)];
  return { corners, removeIds: coveredLineIds(context.entities, corners) };
}

interface ArrangementNode {
  p: Vec2;
  world: Vec3;
}

interface ArrangementEdge {
  a: number;
  b: number;
  novel: boolean;
  existing: boolean;
}

export function completeLineRectangle(
  line: Extract<EntityInput, { type: 'line' }>,
  context: CompletionContext,
): RectangleCompletion | null {
  const { plane } = context;
  const eps = geomEps(magnitudeOf([line.a, line.b]));
  if (!plane.contains(line.a, eps) || !plane.contains(line.b, eps)) return null;
  if (distance(line.a, line.b) <= eps) return null;

  interface SourceSegment {
    a: Vec2;
    b: Vec2;
    aWorld: Vec3;
    bWorld: Vec3;
    novel: boolean;
  }
  const sources: SourceSegment[] = coplanarSegments(plane, context.entities).map((segment) => ({
    a: plane.toPlane(segment.a),
    b: plane.toPlane(segment.b),
    aWorld: segment.a,
    bWorld: segment.b,
    novel: false,
  }));
  sources.push({ a: plane.toPlane(line.a), b: plane.toPlane(line.b), aWorld: line.a, bWorld: line.b, novel: true });
  const segs = sources.filter((s) => distance2(s.a, s.b) > eps);
  if (!segs.some((s) => s.novel)) return null;

  const params: number[][] = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) {
    const di = sub2(segs[i].b, segs[i].a);
    const li = length2(di);
    const epsI = eps / li;
    for (let j = i + 1; j < segs.length; j++) {
      const dj = sub2(segs[j].b, segs[j].a);
      const lj = length2(dj);
      const epsJ = eps / lj;
      const denom = cross2(di, dj);
      if (Math.abs(denom) <= 1e-12 * li * lj) {
        const off = Math.max(
          Math.abs(cross2(di, sub2(segs[j].a, segs[i].a))) / li,
          Math.abs(cross2(di, sub2(segs[j].b, segs[i].a))) / li,
        );
        if (off > eps) continue;
        for (const p of [segs[j].a, segs[j].b]) {
          const t = dot2(sub2(p, segs[i].a), di) / (li * li);
          if (t > epsI && t < 1 - epsI) params[i].push(t);
        }
        for (const p of [segs[i].a, segs[i].b]) {
          const t = dot2(sub2(p, segs[j].a), dj) / (lj * lj);
          if (t > epsJ && t < 1 - epsJ) params[j].push(t);
        }
        continue;
      }
      const r = sub2(segs[j].a, segs[i].a);
      const t = cross2(r, dj) / denom;
      const s = cross2(r, di) / denom;
      if (t >= -epsI && t <= 1 + epsI && s >= -epsJ && s <= 1 + epsJ) {
        params[i].push(Math.min(1, Math.max(0, t)));
        params[j].push(Math.min(1, Math.max(0, s)));
      }
    }
  }

  const nodes: ArrangementNode[] = [];
  const findNode = (p: Vec2, world?: Vec3): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (distance2(nodes[i].p, p) <= eps) return i;
    }
    nodes.push({ p, world: world ? clone(world) : plane.toWorld(p) });
    return nodes.length - 1;
  };
  for (const s of segs) {
    findNode(s.a, s.aWorld);
    findNode(s.b, s.bWorld);
  }

  const edges: ArrangementEdge[] = [];
  const edgeKeys = new Map<string, ArrangementEdge>();
  const addEdge = (a: number, b: number, novel: boolean): void => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const found = edgeKeys.get(key);
    if (found) {
      found.novel ||= novel;
      found.existing ||= !novel;
      return;
    }
    const edge: ArrangementEdge = { a, b, novel, existing: !novel };
    edgeKeys.set(key, edge);
    edges.push(edge);
  };
  segs.forEach((s, i) => {
    const sorted = params[i].sort((x, y) => x - y);
    const merged: number[] = [];
    const tol = eps / length2(sub2(s.b, s.a));
    for (const t of sorted) {
      if (!merged.length || t - merged[merged.length - 1] > tol) merged.push(t);
      else merged[merged.length - 1] = Math.max(merged[merged.length - 1], t);
    }
    for (let k = 0; k + 1 < merged.length; k++) {
      const a = lerp2(s.a, s.b, merged[k]);
      const b = lerp2(s.a, s.b, merged[k + 1]);
      if (distance2(a, b) <= eps) continue;
      addEdge(findNode(a), findNode(b), s.novel);
    }
  });

  const adjacency: { edge: number; other: number; angle: number }[][] = nodes.map(() => []);
  edges.forEach((edge, index) => {
    const pa = nodes[edge.a].p;
    const pb = nodes[edge.b].p;
    adjacency[edge.a].push({ edge: index, other: edge.b, angle: Math.atan2(pb.y - pa.y, pb.x - pa.x) });
    adjacency[edge.b].push({ edge: index, other: edge.a, angle: Math.atan2(pa.y - pb.y, pa.x - pb.x) });
  });
  for (const list of adjacency) list.sort((x, y) => x.angle - y.angle);

  interface Face {
    ring: number[];
    edges: Set<number>;
    area: number;
  }
  const faces: Face[] = [];
  const seen = new Set<string>();
  for (let start = 0; start < edges.length; start++) {
    for (const startNode of [edges[start].a, edges[start].b]) {
      if (seen.has(`${start}:${startNode}`)) continue;
      const ring: number[] = [];
      const faceEdges = new Set<number>();
      let edge = start;
      let from = startNode;
      let closed = false;
      for (let step = 0; step <= edges.length * 2 + 2; step++) {
        seen.add(`${edge}:${from}`);
        faceEdges.add(edge);
        ring.push(from);
        const to = edges[edge].a === from ? edges[edge].b : edges[edge].a;
        const list = adjacency[to];
        const back = list.findIndex((h) => h.other === from);
        const next = list[(back - 1 + list.length) % list.length];
        edge = next.edge;
        from = to;
        if (edge === start && from === startNode) {
          closed = true;
          break;
        }
      }
      if (!closed) continue;
      const area = polygonArea(ring.map((n) => nodes[n].p));
      if (area > eps * eps) faces.push({ ring, edges: faceEdges, area });
    }
  }

  const simplifyRing = (ring: number[]): number[] => {
    let current = ring;
    const limit = ring.length;
    for (let guard = 0; guard < limit && current.length > 3; guard++) {
      let removed = false;
      for (let i = 0; i < current.length; i++) {
        const prev = nodes[current[(i - 1 + current.length) % current.length]].p;
        const cur = nodes[current[i]].p;
        const next = nodes[current[(i + 1) % current.length]].p;
        const d1 = sub2(cur, prev);
        const d2 = sub2(next, cur);
        if (dot2(d1, d2) > 0 && Math.abs(cross2(d1, d2)) <= 1e-9 * length2(d1) * length2(d2)) {
          current = current.filter((_, k) => k !== i);
          removed = true;
          break;
        }
      }
      if (!removed) break;
    }
    return current;
  };

  const isRectangleRing = (ring: number[]): boolean => {
    if (ring.length !== 4) return false;
    const p = ring.map((n) => nodes[n].p);
    const dirs = [0, 1, 2, 3].map((i) => sub2(p[(i + 1) % 4], p[i]));
    if (dirs.some((d) => length2(d) <= eps)) return false;
    const angularTolerance = 1e-8;
    for (let i = 0; i < 4; i++) {
      const adjacent = dirs[(i + 1) % 4];
      const opposite = dirs[(i + 2) % 4];
      if (Math.abs(dot2(dirs[i], adjacent)) > angularTolerance * length2(dirs[i]) * length2(adjacent)) return false;
      if (Math.abs(cross2(dirs[i], opposite)) > angularTolerance * length2(dirs[i]) * length2(opposite)) return false;
    }
    return true;
  };

  const incomingEdges = edges.map((edge, index) => (edge.novel ? index : -1)).filter((index) => index >= 0);
  const novelEdges = incomingEdges.filter((index) => !edges[index].existing);
  if (!novelEdges.length) return null;
  const eligible: number[][] = [];
  for (const face of faces) {
    if (!incomingEdges.every((index) => face.edges.has(index))) continue;
    if (!novelEdges.some((index) => face.edges.has(index))) continue;
    const ring = simplifyRing(face.ring);
    if (!isRectangleRing(ring)) continue;
    const world = ring.map((n) => nodes[n].world);
    if (context.entities.some((entity) => entity.type === 'rect' && sameRectangle(entity.corners, world))) continue;
    eligible.push(ring);
  }
  if (eligible.length !== 1) return null;

  const ring = eligible[0];
  const anchor = plane.toPlane(line.a);
  let first = 0;
  let best = Infinity;
  ring.forEach((node, index) => {
    const d = distance2(nodes[node].p, anchor);
    if (d < best) {
      best = d;
      first = index;
    }
  });
  const corners = ring
    .slice(first)
    .concat(ring.slice(0, first))
    .map((node) => clone(nodes[node].world)) as [Vec3, Vec3, Vec3, Vec3];
  return { corners, removeIds: coveredLineIds(context.entities, corners) };
}
