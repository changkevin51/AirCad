import type { PlaneKind, WorkPlane } from './plane';
import { recognizeStroke, type RecognizeOptions, type RecognizeResult, type RecognizedShape } from './recognize';
import type { Projector, SnapResult } from './snap';
import type { EntityInput, Vertex } from './sketch';
import { add, distance2, dot, isFinite3, length, normalize, roundTo, scale, sub, type Vec2, type Vec3 } from './vec';

const OBJECT_SNAPS = new Set(['vertex', 'midpoint', 'edge', 'lock']);
const LINE_AIM_MIN_PX = 32;
const LINE_AIM_WINDOW = 12;

export const isObjectSnap = (snap: SnapResult): boolean => OBJECT_SNAPS.has(snap.type);

export interface LineMeasurement {
  start: Vec3;
  direction: Vec3;
  plane: PlaneKind;
  previewLength: number;
}

/**
 * One pen-down → pen-up gesture.
 *
 * The path keeps the *raw* plane points (grid snapping would otherwise turn a
 * diagonal into a staircase and break line recognition); only the first and
 * the latest point use the snapped positions, which is what the recogniser
 * needs for exact endpoints.
 */
export class StrokeSession {
  readonly plane: WorkPlane;
  readonly start: SnapResult;
  /** Raw (unsnapped) plane points between the endpoints, in stroke order. */
  private readonly rawPlane: Vec2[] = [];
  private readonly rawScreen: Vec2[] = [];
  private lastSnap: SnapResult;
  private lastScreen: Vec2;
  private measurementEndpoint: Vec3 | null = null;
  private measurementScreenDistance = 0;
  /** Set when the plane anchor moved to a snapped vertex at pen-down. */
  readonly anchorMoved: boolean;

  constructor(plane: WorkPlane, start: SnapResult, anchorMoved = false) {
    this.plane = plane;
    this.start = start;
    this.lastSnap = start;
    this.lastScreen = start.screen;
    this.anchorMoved = anchorMoved;
  }

  get last(): SnapResult {
    return this.lastSnap;
  }

  get pointCount(): number {
    return this.rawPlane.length + 2;
  }

  /** Add a cursor sample.  Returns false when it was too close to the last one. */
  add(snap: SnapResult, rawWorld: Vec3 | null, cursorScreen: Vec2, minScreenDistance = 2): boolean {
    this.lastSnap = snap;
    const endpoint = isObjectSnap(snap) && snap.onPlane ? snap.world : snap.type === 'lock' ? null : rawWorld;
    this.measurementEndpoint = endpoint && isFinite3(endpoint) && this.plane.contains(endpoint) ? this.plane.project(endpoint) : null;
    this.measurementScreenDistance = distance2(cursorScreen, this.start.screen);
    if (distance2(cursorScreen, this.lastScreen) < minScreenDistance) return false;
    this.lastScreen = cursorScreen;
    const raw = rawWorld ?? snap.world;
    this.rawPlane.push(this.plane.toPlane(raw));
    this.rawScreen.push(cursorScreen);
    return true;
  }

  get measurement(): LineMeasurement | null {
    const endpoint = this.measurementEndpoint;
    if (!endpoint || !isFinite3(this.start.world) || !this.plane.contains(this.start.world)
      || !Number.isFinite(this.measurementScreenDistance) || this.measurementScreenDistance < LINE_AIM_MIN_PX) return null;
    const delta = sub(endpoint, this.start.world);
    if (!isFinite3(delta) || length(delta) <= 1e-6) return null;
    let combined = delta;
    if (!(isObjectSnap(this.lastSnap) && this.lastSnap.onPlane)) {
      combined = { x: 0, y: 0, z: 0 };
      for (const point of this.rawPlane.slice(-LINE_AIM_WINDOW)) {
        const sample = sub(this.plane.toWorld(point), this.start.world);
        if (isFinite3(sample) && dot(sample, delta) > 0) combined = add(combined, sample);
      }
      if (length(combined) <= 1e-6) combined = delta;
    }
    const direction = normalize(combined);
    const previewLength = dot(delta, direction);
    if (!isFinite3(direction) || !Number.isFinite(previewLength) || previewLength <= 1e-6) return null;
    return {
      start: { ...this.start.world },
      direction: { ...direction },
      plane: this.plane.kind,
      previewLength,
    };
  }

  /**
   * Plane coordinates of the current end point as the recogniser should see
   * it.  An off-plane object snap (e.g. a wall-top vertex) is represented by
   * where the cursor ray meets the plane, so the 2D path stays continuous;
   * the exact 3D vertex is substituted when the entity is built.
   */
  private endPoint2(): Vec2 {
    const snap = this.lastSnap;
    if (!snap.onPlane && snap.raw) return this.plane.toPlane(snap.raw);
    return snap.plane;
  }

  /** 2D path used for recognition: snapped start, raw middle, snapped end. */
  planePoints(): Vec2[] {
    return [this.start.plane, ...this.rawPlane, this.endPoint2()];
  }

  /** Raw polyline in world space for rendering the live ink. */
  worldPath(): Vec3[] {
    return [this.start.world, ...this.rawPlane.map((p) => this.plane.toWorld(p)), this.lastSnap.world];
  }

  /** Diagonal of the stroke's screen-space bounding box in pixels. */
  screenExtent(): number {
    const points = [this.start.screen, ...this.rawScreen, this.lastSnap.screen];
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
    return Math.hypot(maxX - minX, maxY - minY);
  }

  recognize(options: Partial<RecognizeOptions> = {}): RecognizeResult {
    const raw = [
      this.plane.toPlane(this.start.raw ?? this.start.world),
      ...this.rawPlane,
      this.plane.toPlane(this.lastSnap.raw ?? this.lastSnap.world),
    ];
    const result = recognizeStroke(raw, options);
    if (result.shape?.kind === 'circle') return result;
    const snapped = recognizeStroke(this.planePoints(), options);
    return snapped.shape?.kind === 'circle' ? result : snapped;
  }
}

export interface CommitContext {
  projector: Projector;
  /** Existing sketch vertices that rectangle corners may be pulled onto. */
  vertices: readonly Vertex[];
  tolerancePx: number;
  /** Grid step in mm for rounding the far rectangle corner; 0/undefined disables it. */
  gridStep?: number;
}

/**
 * Make an axis-aligned rectangle honour the snapped pen-down point exactly
 * (that corner is where the user deliberately started) and round the
 * opposite corner to the grid, keeping the corner order.
 */
export function alignRectToStart(corners: readonly Vec2[], start: Vec2, gridStep = 0): Vec2[] {
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const uLo = Math.min(...xs);
  const uHi = Math.max(...xs);
  const vLo = Math.min(...ys);
  const vHi = Math.max(...ys);
  const c0 = corners[0];
  const startAtLo = Math.abs(c0.x - uLo) <= Math.abs(c0.x - uHi);
  const startAtBottom = Math.abs(c0.y - vLo) <= Math.abs(c0.y - vHi);
  const round = (value: number) => (gridStep > 0 ? roundTo(value, gridStep) : value);
  const next = {
    uLo: startAtLo ? start.x : round(uLo),
    uHi: startAtLo ? round(uHi) : start.x,
    vLo: startAtBottom ? start.y : round(vLo),
    vHi: startAtBottom ? round(vHi) : start.y,
  };
  if (next.uHi - next.uLo < 1e-6 || next.vHi - next.vLo < 1e-6) return [...corners];
  const mid = (lo: number, hi: number) => (lo + hi) / 2;
  return corners.map((c) => ({
    x: c.x < mid(uLo, uHi) ? next.uLo : next.uHi,
    y: c.y < mid(vLo, vHi) ? next.vLo : next.vHi,
  }));
}

/**
 * Pull rectangle corners onto existing on-plane vertices that are within the
 * screen-space tolerance.  Edges are moved as a whole so the result is still
 * a rectangle; the nearest candidates win.
 */
export function pullRectCorners(corners: Vec3[], plane: WorkPlane, context: CommitContext): Vec3[] {
  const [c0, c1, , c3] = corners;
  const e1 = normalize(sub(c1, c0));
  const e2 = normalize(sub(c3, c0));
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
    const cornerScreen = context.projector.project(corner);
    if (!cornerScreen) return;
    for (const vertex of context.vertices) {
      if (!plane.contains(vertex.point, 1e-3)) continue;
      const vertexScreen = context.projector.project(vertex.point);
      if (!vertexScreen) continue;
      const d = distance2(cornerScreen, vertexScreen);
      if (d > context.tolerancePx) continue;
      const rel = sub(vertex.point, c0);
      candidates.push({ corner: index, distance: d, u: dot(rel, e1), v: dot(rel, e2) });
    }
  });
  if (!candidates.length) return corners;

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
  if (bounds.uHi - bounds.uLo < 1e-6 || bounds.vHi - bounds.vLo < 1e-6) return corners;

  const at = (u: number, v: number): Vec3 => add(add(c0, scale(e1, u)), scale(e2, v));
  return [at(bounds.uLo, bounds.vLo), at(bounds.uHi, bounds.vLo), at(bounds.uHi, bounds.vHi), at(bounds.uLo, bounds.vHi)];
}

/** Turn a recognised shape into a sketch entity, honouring exact object snaps. */
export function buildEntityFromStroke(session: StrokeSession, shape: RecognizedShape, context: CommitContext): EntityInput {
  const plane = session.plane;
  if (shape.kind === 'line') {
    const a = isObjectSnap(session.start) ? session.start.world : plane.toWorld(shape.a);
    const b = isObjectSnap(session.last) ? session.last.world : plane.toWorld(shape.b);
    return { type: 'line', a, b };
  }
  if (shape.kind === 'circle') {
    return { type: 'circle', center: plane.toWorld(shape.center), normal: { ...plane.normal }, radius: shape.radius };
  }
  const corners2 = shape.oriented ? shape.corners : alignRectToStart(shape.corners, session.start.plane, context.gridStep ?? 0);
  const corners = pullRectCorners(corners2.map((c) => plane.toWorld(c)), plane, context);
  return { type: 'rect', corners: corners as [Vec3, Vec3, Vec3, Vec3] };
}

/** The point the work-plane anchor moves to after a commit. */
export function anchorAfterCommit(entity: EntityInput): Vec3 {
  if (entity.type === 'circle') return entity.center;
  return entity.type === 'line' ? entity.b : entity.corners[0];
}
