import { closestPointOnSegment } from './spatial-snap';
import type { EntityInput, Vertex } from './sketch';
import { add, clone, distance, dot, normalize, scale, sub, type Vec3 } from './vec';

export interface JoinTargets {
  vertices: readonly Vertex[];
  segments?: readonly { a: Vec3; b: Vec3 }[];
}

function nearestVertex(point: Vec3, vertices: readonly Vertex[], radius: number): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDistance = radius;
  for (const vertex of vertices) {
    const d = distance(point, vertex.point);
    if (d <= bestDistance) {
      best = vertex.point;
      bestDistance = d;
    }
  }
  return best;
}

function nearestOnEdge(point: Vec3, segments: readonly { a: Vec3; b: Vec3 }[], radius: number): Vec3 | null {
  let best: Vec3 | null = null;
  let bestDistance = radius;
  for (const segment of segments) {
    const hit = closestPointOnSegment(point, segment.a, segment.b);
    const d = distance(point, hit.point);
    if (d <= bestDistance) {
      best = hit.point;
      bestDistance = d;
    }
  }
  return best;
}

export function joinPoint(point: Vec3, targets: JoinTargets, radius: number): Vec3 {
  const vertex = nearestVertex(point, targets.vertices, radius);
  if (vertex) return clone(vertex);
  if (targets.segments?.length) {
    const edge = nearestOnEdge(point, targets.segments, radius);
    if (edge) return clone(edge);
  }
  return clone(point);
}

/** Move whole rectangle edges so corners land on nearby vertices and the result stays a rectangle. */
export function pullRectCornersWorld(corners: readonly Vec3[], vertices: readonly Vertex[], radius: number): Vec3[] {
  const [c0, c1, , c3] = corners;
  const e1 = normalize(sub(c1, c0));
  const e2 = normalize(sub(c3, c0));
  if (dot(e1, e1) < 1e-12 || dot(e2, e2) < 1e-12) return corners.map(clone);
  const width = dot(sub(c1, c0), e1);
  const height = dot(sub(c3, c0), e2);
  const bounds = { uLo: 0, uHi: width, vLo: 0, vHi: height };
  const assigned = { uLo: false, uHi: false, vLo: false, vHi: false };
  const edgesOf: Array<[keyof typeof bounds, keyof typeof bounds]> = [
    ['uLo', 'vLo'],
    ['uHi', 'vLo'],
    ['uHi', 'vHi'],
    ['uLo', 'vHi'],
  ];

  const candidates: { corner: number; distance: number; u: number; v: number }[] = [];
  corners.forEach((corner, index) => {
    for (const vertex of vertices) {
      const d = distance(corner, vertex.point);
      if (d > radius) continue;
      const rel = sub(vertex.point, c0);
      candidates.push({ corner: index, distance: d, u: dot(rel, e1), v: dot(rel, e2) });
    }
  });
  if (!candidates.length) return corners.map(clone);

  candidates.sort((a, b) => a.distance - b.distance);
  const usedCorners = new Set<number>();
  for (const candidate of candidates) {
    if (usedCorners.has(candidate.corner)) continue;
    const [uEdge, vEdge] = edgesOf[candidate.corner];
    if (assigned[uEdge] && assigned[vEdge]) continue;
    if (!assigned[uEdge]) {
      bounds[uEdge] = candidate.u;
      assigned[uEdge] = true;
    }
    if (!assigned[vEdge]) {
      bounds[vEdge] = candidate.v;
      assigned[vEdge] = true;
    }
    usedCorners.add(candidate.corner);
  }
  if (bounds.uHi - bounds.uLo < 1e-6 || bounds.vHi - bounds.vLo < 1e-6) return corners.map(clone);

  const at = (u: number, v: number): Vec3 => add(add(c0, scale(e1, u)), scale(e2, v));
  return [at(bounds.uLo, bounds.vLo), at(bounds.uHi, bounds.vLo), at(bounds.uHi, bounds.vHi), at(bounds.uLo, bounds.vHi)];
}

export function joinEndpoints(input: EntityInput, targets: JoinTargets, radius: number): EntityInput {
  if (input.type === 'line') {
    return { type: 'line', a: joinPoint(input.a, targets, radius), b: joinPoint(input.b, targets, radius) };
  }
  const corners = pullRectCornersWorld(input.corners, targets.vertices, radius);
  return { type: 'rect', corners: corners as [Vec3, Vec3, Vec3, Vec3] };
}

export function shouldCloseLoop(start: Vec3, end: Vec3, radius: number): boolean {
  return distance(start, end) <= radius;
}
