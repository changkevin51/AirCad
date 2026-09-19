import { PLANE_ORDER, PLANES, WorkPlane, type PlaneKind } from './plane';
import type { Projector, SnapResult } from './snap';
import { entitySegments, rectFrame, rectNormal, type Entity } from './sketch';
import {
  add,
  closestPointOnSegment2,
  distance,
  distance2,
  dot,
  normalize,
  scale,
  sub,
  type Vec2,
  type Vec3,
} from './vec';

export type PlaneMode = 'auto' | 'manual';

export interface PlaneInferenceContext {
  currentPlane: WorkPlane;
  projector: Projector;
  cursor: Vec2;
  viewDirection: Vec3;
  snap: SnapResult | null;
  entities: readonly Entity[];
}

export interface PlaneChoice {
  plane: WorkPlane;
  reason: 'current' | 'view' | 'vertex' | 'midpoint' | 'edge' | 'face' | 'unavailable';
  score: number;
}

const USABLE_DOT = 0.15;
const KIND_BIAS = 0.1;
const SNAP_BASE = 1;
const FACE_BASE = 2;
const INCIDENT_FACE_BONUS = 0.05;
const SWITCH_MARGIN = 0.15;
const DWELL_MS = 120;
const BORDER_PX = 14;
const POINT_EPS = 1e-6;
const NORMAL_EPS = 1e-6;

const isObjectSnap = (type: SnapResult['type']): type is 'vertex' | 'midpoint' | 'edge' =>
  type === 'vertex' || type === 'midpoint' || type === 'edge';

const rayParameter = (origin: Vec3, dir: Vec3, point: Vec3): number =>
  dot(sub(point, origin), dir) / Math.max(1e-24, dot(dir, dir));

function usable(plane: WorkPlane, origin: Vec3, dir: Vec3): boolean {
  if (Math.abs(dot(dir, plane.normal)) < USABLE_DOT) return false;
  return plane.intersectRay(origin, dir) !== null;
}

const viewAlignment = (plane: WorkPlane, viewDirection: Vec3): number =>
  Math.abs(dot(normalize(viewDirection), plane.normal));

function pointOnSegment(point: Vec3, a: Vec3, b: Vec3, eps = POINT_EPS): boolean {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-24) return distance(point, a) <= eps;
  const t = Math.min(1, Math.max(0, dot(sub(point, a), ab) / len2));
  return distance(point, add(a, scale(ab, t))) <= eps;
}

function axisKindOf(normal: Vec3): PlaneKind | null {
  for (const kind of PLANE_ORDER) {
    if (Math.abs(dot(normal, PLANES[kind].normal)) >= 1 - NORMAL_EPS) return kind;
  }
  return null;
}

function incidentFaceAt(plane: WorkPlane, point: Vec3, entities: readonly Entity[]): boolean {
  for (const entity of entities) {
    if (entity.type !== 'rect') continue;
    if (Math.abs(dot(rectNormal(entity), plane.normal)) < 1 - NORMAL_EPS) continue;
    if (entitySegments(entity).some((segment) => pointOnSegment(point, segment.a, segment.b))) return true;
  }
  return false;
}

function nearestFaceInterior(context: PlaneInferenceContext, origin: Vec3, dir: Vec3): WorkPlane | null {
  const eligible: { plane: WorkPlane; t: number; id: string }[] = [];
  for (const entity of context.entities) {
    if (entity.type !== 'rect') continue;
    const kind = axisKindOf(rectNormal(entity));
    if (!kind) continue;
    const axisNormal = PLANES[kind].normal;
    const plane = new WorkPlane(kind, scale(axisNormal, dot(axisNormal, entity.corners[0])));
    if (!usable(plane, origin, dir)) continue;
    const hit = plane.intersectRay(origin, dir);
    if (!hit) continue;
    const frame = rectFrame(entity);
    const rel = sub(hit, frame.origin);
    const u = dot(rel, frame.uDir);
    const v = dot(rel, frame.vDir);
    if (u < -POINT_EPS || u > frame.width + POINT_EPS || v < -POINT_EPS || v > frame.height + POINT_EPS) continue;
    let nearBorder = false;
    for (let i = 0; i < 4; i++) {
      const a = context.projector.project(entity.corners[i]);
      const b = context.projector.project(entity.corners[(i + 1) % 4]);
      if (!a || !b) continue;
      if (distance2(closestPointOnSegment2(context.cursor, a, b).point, context.cursor) < BORDER_PX) {
        nearBorder = true;
        break;
      }
    }
    if (nearBorder) continue;
    eligible.push({ plane, t: rayParameter(origin, dir, hit), id: entity.id });
  }
  eligible.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
  return eligible[0]?.plane ?? null;
}

interface Draft {
  plane: WorkPlane;
  reason: PlaneChoice['reason'];
  base: number;
}

export function rankPlaneCandidates(context: PlaneInferenceContext): PlaneChoice[] {
  const ray = context.projector.ray(context.cursor);
  const drafts: Draft[] = [];
  for (const kind of PLANE_ORDER) {
    drafts.push({
      plane: new WorkPlane(kind, context.currentPlane.anchor),
      reason: kind === context.currentPlane.kind ? 'current' : 'view',
      base: 0,
    });
  }
  const snap = context.snap;
  const snapType = snap && isObjectSnap(snap.type) ? snap.type : null;
  if (snapType && snap) {
    const anchor = snap.world;
    const incident = context.entities
      .flatMap(entitySegments)
      .filter((segment) => pointOnSegment(anchor, segment.a, segment.b));
    const containing = PLANE_ORDER.filter((kind) => {
      const plane = new WorkPlane(kind, anchor);
      return incident.some((segment) => plane.contains(segment.a, POINT_EPS) && plane.contains(segment.b, POINT_EPS));
    });
    const kinds = snapType === 'edge' ? containing : containing.length ? containing : [...PLANE_ORDER];
    for (const kind of kinds) {
      const plane = new WorkPlane(kind, anchor);
      const bonus = incidentFaceAt(plane, anchor, context.entities) ? INCIDENT_FACE_BONUS : 0;
      drafts.push({ plane, reason: snapType, base: SNAP_BASE + bonus });
    }
  } else {
    const face = nearestFaceInterior(context, ray.origin, ray.dir);
    if (face) drafts.push({ plane: face, reason: 'face', base: FACE_BASE });
  }
  const scored: PlaneChoice[] = drafts.map((draft) => ({
    plane: draft.plane,
    reason: draft.reason,
    score:
      draft.base +
      viewAlignment(draft.plane, context.viewDirection) +
      (draft.plane.kind === context.currentPlane.kind ? KIND_BIAS : 0),
  }));
  const deduped: PlaneChoice[] = [];
  for (const choice of scored) {
    const existing = deduped.find((candidate) => candidate.plane.equals(choice.plane));
    if (!existing) {
      deduped.push(choice);
    } else if (choice.score > existing.score) {
      existing.plane = choice.plane;
      existing.reason = choice.reason;
      existing.score = choice.score;
    }
  }
  const candidates = deduped.filter((choice) => usable(choice.plane, ray.origin, ray.dir));
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aCurrent = a.plane.equals(context.currentPlane) ? 0 : 1;
    const bCurrent = b.plane.equals(context.currentPlane) ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    const kindOrder = PLANE_ORDER.indexOf(a.plane.kind) - PLANE_ORDER.indexOf(b.plane.kind);
    if (kindOrder !== 0) return kindOrder;
    return a.plane.offset - b.plane.offset;
  });
  if (!candidates.length) return [{ plane: context.currentPlane, reason: 'unavailable', score: 0 }];
  return candidates;
}

export class PlaneInference {
  private pending: { plane: WorkPlane; since: number } | null = null;

  update(context: PlaneInferenceContext, nowMs: number): PlaneChoice {
    const candidates = rankPlaneCandidates(context);
    const best = candidates[0];
    if (best.reason === 'unavailable') {
      this.pending = null;
      return best;
    }
    const ray = context.projector.ray(context.cursor);
    const currentUsable = usable(context.currentPlane, ray.origin, ray.dir);
    const listed = candidates.find((candidate) => candidate.plane.equals(context.currentPlane));
    const currentScore = listed
      ? listed.score
      : currentUsable
        ? viewAlignment(context.currentPlane, context.viewDirection) + KIND_BIAS
        : 0;
    if (best.plane.equals(context.currentPlane)) {
      this.pending = null;
      return best;
    }
    if (!currentUsable) {
      this.pending = null;
      return best;
    }
    if (best.score < currentScore + SWITCH_MARGIN) {
      this.pending = null;
      return { plane: context.currentPlane, reason: 'current', score: currentScore };
    }
    if (this.pending && this.pending.plane.equals(best.plane)) {
      if (nowMs - this.pending.since >= DWELL_MS) {
        this.pending = null;
        return best;
      }
    } else {
      this.pending = { plane: best.plane, since: nowMs };
    }
    return { plane: context.currentPlane, reason: 'current', score: currentScore };
  }

  reset(): void {
    this.pending = null;
  }
}
