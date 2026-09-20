import { polygonFrame, signedArea } from './polygon';
import type { LineEntity, LineLoopProfile } from './sketch';
import {
  cross,
  distance,
  dot,
  isFinite3,
  length,
  normalize,
  scale,
  sub,
  v2,
  v3,
  type Vec3,
} from './vec';

const NODE_TOLERANCE = 1e-6;

interface GraphEdge {
  a: number;
  b: number;
  sourceId: string;
}

interface CandidatePlane {
  normal: Vec3;
  origin: Vec3;
  u: Vec3;
  v: Vec3;
}

interface HalfEdge {
  from: number;
  to: number;
  edge: number;
  sourceId: string;
}

export function findClosedLineProfiles(lines: readonly LineEntity[]): LineLoopProfile[] {
  const nodes: Vec3[] = [];
  const nodeFor = (point: Vec3): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (distance(nodes[i], point) <= NODE_TOLERANCE) return i;
    }
    nodes.push(v3(point.x, point.y, point.z));
    return nodes.length - 1;
  };
  const edges: GraphEdge[] = [];
  for (const line of lines) {
    if (!isFinite3(line.a) || !isFinite3(line.b) || distance(line.a, line.b) <= NODE_TOLERANCE) continue;
    const a = nodeFor(line.a);
    const b = nodeFor(line.b);
    if (a !== b) edges.push({ a, b, sourceId: line.id });
  }
  if (!edges.length) return [];

  const incident: number[][] = nodes.map(() => []);
  edges.forEach((edge, index) => {
    incident[edge.a].push(index);
    incident[edge.b].push(index);
  });

  const planes: CandidatePlane[] = [];
  const canonical = (normal: Vec3): Vec3 => {
    const dominant = [normal.x, normal.y, normal.z].reduce((a, b) => (Math.abs(a) >= Math.abs(b) ? a : b));
    return dominant < 0 ? scale(normal, -1) : normal;
  };
  for (let node = 0; node < nodes.length; node++) {
    const list = incident[node];
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const otherEnd = (edgeIndex: number): number => (edges[edgeIndex].a === node ? edges[edgeIndex].b : edges[edgeIndex].a);
        const dirA = normalize(sub(nodes[otherEnd(list[x])], nodes[node]));
        const dirB = normalize(sub(nodes[otherEnd(list[y])], nodes[node]));
        const n = cross(dirA, dirB);
        if (length(n) <= 1e-8) continue;
        const normal = canonical(normalize(n));
        const origin = nodes[node];
        const duplicate = planes.some((plane) => 1 - Math.abs(dot(plane.normal, normal)) < 1e-9
          && Math.abs(dot(sub(origin, plane.origin), plane.normal)) <= NODE_TOLERANCE);
        if (duplicate) continue;
        planes.push({ normal, origin, u: dirA, v: normalize(cross(normal, dirA)) });
      }
    }
  }

  const profiles = new Map<string, LineLoopProfile>();
  for (const plane of planes) {
    const onPlane = edges.filter((edge) =>
      Math.abs(dot(sub(nodes[edge.a], plane.origin), plane.normal)) <= NODE_TOLERANCE
      && Math.abs(dot(sub(nodes[edge.b], plane.origin), plane.normal)) <= NODE_TOLERANCE);
    const pairKey = (edge: GraphEdge): string => (edge.a < edge.b ? `${edge.a}:${edge.b}` : `${edge.b}:${edge.a}`);
    const pairCounts = new Map<string, number>();
    for (const edge of onPlane) pairCounts.set(pairKey(edge), (pairCounts.get(pairKey(edge)) ?? 0) + 1);
    let active = onPlane.filter((edge) => pairCounts.get(pairKey(edge)) === 1);
    for (;;) {
      const degree = new Map<number, number>();
      for (const edge of active) {
        degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
        degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
      }
      const kept = active.filter((edge) => (degree.get(edge.a) ?? 0) >= 2 && (degree.get(edge.b) ?? 0) >= 2);
      if (kept.length === active.length) break;
      active = kept;
    }
    if (!active.length) continue;

    const adjacency = new Map<number, HalfEdge[]>();
    const angles = new Map<HalfEdge, number>();
    active.forEach((edge, edgeIndex) => {
      for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]] as const) {
        const half: HalfEdge = { from, to, edge: edgeIndex, sourceId: edge.sourceId };
        const delta = sub(nodes[to], nodes[from]);
        angles.set(half, Math.atan2(dot(delta, plane.v), dot(delta, plane.u)));
        const list = adjacency.get(from) ?? [];
        list.push(half);
        adjacency.set(from, list);
      }
    });
    for (const list of adjacency.values()) list.sort((a, b) => angles.get(a)! - angles.get(b)!);

    const visited = new Set<HalfEdge>();
    for (const start of [...adjacency.values()].flat()) {
      if (visited.has(start)) continue;
      const walk: HalfEdge[] = [];
      const seen = new Set<number>();
      let current: HalfEdge = start;
      let closed = false;
      let valid = true;
      while (walk.length <= active.length * 2) {
        if (visited.has(current)) {
          valid = false;
          break;
        }
        visited.add(current);
        walk.push(current);
        if (seen.has(current.from)) {
          valid = false;
          break;
        }
        seen.add(current.from);
        const neighbors = adjacency.get(current.to) ?? [];
        const reverse = neighbors.findIndex((h) => h.edge === current.edge && h.to === current.from);
        if (reverse < 0) {
          valid = false;
          break;
        }
        const next = neighbors[(reverse - 1 + neighbors.length) % neighbors.length];
        if (next === start) {
          closed = true;
          break;
        }
        current = next;
      }
      if (!closed || !valid) continue;
      const orderedNodes = walk.map((h) => nodes[h.from]);
      const projected = orderedNodes.map((p) => v2(dot(sub(p, plane.origin), plane.u), dot(sub(p, plane.origin), plane.v)));
      if (signedArea(projected) <= 0 || !polygonFrame(orderedNodes)) continue;
      const sourceIds = [...new Set(walk.map((h) => h.sourceId))];
      const id = `loop:${JSON.stringify([...sourceIds].sort())}`;
      if (!profiles.has(id)) {
        profiles.set(id, { id, type: 'polygon', corners: orderedNodes.map((p) => ({ ...p })), sourceIds });
      }
    }
  }
  return [...profiles.values()];
}
