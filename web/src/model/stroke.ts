import type { PlaneKind, WorkPlane } from './plane';
import { convexHull, recognizeStroke, type RecognizeOptions, type RecognizeResult, type RecognizedShape } from './recognize';
import { alignRectangleToBorder, completeLineRectangle, completeSharedBorder, sameRectangle } from './rect-completion';
import type { Projector, SnapResult } from './snap';
import { snapTriangleToSegments } from './spatial-join';
import { entitySegments, isTriangleProfile, type Entity, type EntityInput, type TriangleEntity, type Vertex } from './sketch';
import { add, distance, distance2, dot, isFinite3, length, nearlyEqual, normalize, roundTo, scale, sub, v2, type Vec2, type Vec3 } from './vec';

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
  private revisionCount = 0;
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

  get revision(): number {
    return this.revisionCount;
  }

  get pointCount(): number {
    return this.rawPlane.length + 2;
  }

  /** Add a cursor sample.  Returns false when it was too close to the last one. */
  add(
    snap: SnapResult,
    rawWorld: Vec3 | null,
    cursorScreen: Vec2,
    minScreenDistance = 2,
    minWorldDistance?: number,
  ): boolean {
    const previous = this.lastSnap;
    if (
      snap.type !== previous.type ||
      snap.entityId !== previous.entityId ||
      snap.onPlane !== previous.onPlane ||
      !nearlyEqual(snap.world, previous.world) ||
      (snap.raw === null) !== (previous.raw === null) ||
      (snap.raw !== null && previous.raw !== null && !nearlyEqual(snap.raw, previous.raw)) ||
      distance2(snap.plane, previous.plane) > 1e-9
    ) {
      this.revisionCount++;
    }
    this.lastSnap = snap;
    const endpoint = isObjectSnap(snap) && snap.onPlane ? snap.world : snap.type === 'lock' ? null : rawWorld;
    this.measurementEndpoint = endpoint && isFinite3(endpoint) && this.plane.contains(endpoint) ? this.plane.project(endpoint) : null;
    this.measurementScreenDistance = distance2(cursorScreen, this.start.screen);
    const raw = rawWorld ?? snap.world;
    const tooClose =
      minWorldDistance !== undefined && minWorldDistance > 0
        ? distance(raw, this.rawPlane.length ? this.plane.toWorld(this.rawPlane[this.rawPlane.length - 1]) : this.start.world) <
          minWorldDistance
        : distance2(cursorScreen, this.lastScreen) < minScreenDistance;
    if (tooClose) return false;
    this.lastScreen = cursorScreen;
    this.rawPlane.push(this.plane.toPlane(raw));
    this.rawScreen.push(cursorScreen);
    this.revisionCount++;
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

  /** Diagonal of the stroke's world-space bounding box in millimetres. */
  worldExtent(): number {
    const points = this.worldPath();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      maxZ = Math.max(maxZ, p.z);
    }
    return Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  }

  recognize(options: Partial<RecognizeOptions> = {}): RecognizeResult {
    const raw = [
      this.plane.toPlane(this.start.raw ?? this.start.world),
      ...this.rawPlane,
      this.plane.toPlane(this.lastSnap.raw ?? this.lastSnap.world),
    ];
    const outline = [...raw];
    if (isObjectSnap(this.start) && this.start.onPlane) outline[0] = this.start.plane;
    if (isObjectSnap(this.lastSnap) && this.lastSnap.onPlane) outline[outline.length - 1] = this.lastSnap.plane;
    const rawResult = recognizeStroke(outline, options);
    if (rawResult.shape?.kind === 'polygon' || rawResult.shape?.kind === 'rect' || rawResult.shape?.kind === 'triangle') return rawResult;
    const snapped = recognizeStroke(this.planePoints(), options);
    if (snapped.shape?.kind === 'polygon' && !rawResult.shape) return rawResult;
    if (snapped.shape?.kind === 'triangle') return rawResult;
    return snapped.shape ? snapped : rawResult;
  }
}

export interface CommitContext {
  projector: Projector;
  /** Existing sketch vertices that rectangle corners may be pulled onto. */
  vertices: readonly Vertex[];
  tolerancePx: number;
  /** Grid step in mm for rounding the far rectangle corner; 0/undefined disables it. */
  gridStep?: number;
  entities?: readonly Entity[];
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
  if (shape.kind === 'polygon') {
    return { type: 'polygon', corners: shape.corners.map((c) => plane.toWorld(c)) };
  }
  if (shape.kind === 'triangle') {
    const raw = shape.corners.map((corner) => plane.toWorld(corner)) as TriangleEntity['corners'];
    let edgeAligned: TriangleEntity['corners'] | null = null;
    const explicitStart = isObjectSnap(session.start) && session.start.onPlane ? session.start.world : null;
    let protectedCornerIndex = -1;
    if (explicitStart && context.entities?.length) {
      const startScreen = context.projector.project(explicitStart);
      if (startScreen) {
        let nearest = context.tolerancePx;
        raw.forEach((corner, index) => {
          const screen = context.projector.project(corner);
          if (!screen) return;
          const d = distance2(startScreen, screen);
          if (d < nearest) {
            nearest = d;
            protectedCornerIndex = index;
          }
        });
      }
    }
    const candidateCorners =
      explicitStart && protectedCornerIndex >= 0
        ? raw.map((corner, index) => (index === protectedCornerIndex ? { ...explicitStart } : add(corner, sub(explicitStart, raw[protectedCornerIndex]))))
        : raw;
    if (context.entities?.length) {
      const fit = snapTriangleToSegments(candidateCorners, context.entities.flatMap(entitySegments), {
        plane,
        projector: context.projector,
        tolerancePx: context.tolerancePx,
        protectedAnchor:
          explicitStart && protectedCornerIndex >= 0
            ? { point: explicitStart, cornerIndex: protectedCornerIndex }
            : undefined,
      });
      edgeAligned = fit?.corners ?? null;
    }
    if (edgeAligned && isTriangleProfile(edgeAligned)) return { type: 'triangle', corners: edgeAligned };
    const step = context.gridStep ?? 0;
    const corners = raw.map((corner, index) => {
      const screen = context.projector.project(corner);
      let snapped = plane.toWorld(v2(roundTo(shape.corners[index].x, step), roundTo(shape.corners[index].y, step)));
      let nearest = context.tolerancePx;
      const candidates = [
        ...(isObjectSnap(session.start) && session.start.onPlane ? [session.start.world] : []),
        ...context.vertices.map((vertex) => vertex.point),
      ];
      if (screen) for (const point of candidates) {
        if (!plane.contains(point, 1e-3)) continue;
        const projected = context.projector.project(point);
        if (!projected) continue;
        const distance = distance2(screen, projected);
        if (distance < nearest) {
          nearest = distance;
          snapped = { ...point };
        }
      }
      return snapped;
    }) as TriangleEntity['corners'];
    return { type: 'triangle', corners: isTriangleProfile(corners) ? corners : raw };
  }
  const corners2 = shape.oriented ? shape.corners : alignRectToStart(shape.corners, session.start.plane, context.gridStep ?? 0);
  const rawCorners = corners2.map((c) => plane.toWorld(c));
  const aligned = context.entities
    ? alignRectangleToBorder(rawCorners, {
        plane,
        entities: context.entities,
        projector: context.projector,
        tolerancePx: context.tolerancePx,
      })
    : null;
  const corners = aligned?.corners ?? pullRectCorners(rawCorners, plane, context);
  return { type: 'rect', corners: corners as [Vec3, Vec3, Vec3, Vec3] };
}

/** The point the work-plane anchor moves to after a commit. */
export function anchorAfterCommit(entity: EntityInput): Vec3 {
  if (entity.type === 'circle') return entity.center;
  return entity.type === 'line' ? entity.b : entity.corners[0];
}

export type StrokeResolution =
  | { status: 'ready'; input: EntityInput; removeIds: string[]; reason: string }
  | { status: 'unrecognized' | 'duplicate'; input: null; removeIds: []; reason: string };

const isDuplicateRectangle = (corners: readonly Vec3[], entities: readonly Entity[]): boolean =>
  entities.some((entity) => entity.type === 'rect' && sameRectangle(entity.corners, corners));

const BORDER_SNAPS = new Set(['vertex', 'midpoint', 'edge']);
const isBorderSnap = (snap: SnapResult): boolean => BORDER_SNAPS.has(snap.type) && snap.onPlane;

function rectangleCornersFromPolygon(corners: readonly Vec2[]): [Vec2, Vec2, Vec2, Vec2] | null {
  const hull = convexHull(corners);
  return hull.length === 4 ? [hull[0], hull[1], hull[2], hull[3]] : null;
}

export function resolveStroke(
  session: StrokeSession,
  context: CommitContext & { entities: readonly Entity[] },
): StrokeResolution {
  const result: RecognizeResult =
    session.last.type === 'lock'
      ? { shape: { kind: 'line', a: session.start.plane, b: session.last.plane, alignedTo: null }, reason: 'axis-locked line' }
      : session.recognize();
  const completionContext = { plane: session.plane, entities: context.entities, gridStep: context.gridStep };

  if (result.shape?.kind === 'line') {
    const input = buildEntityFromStroke(session, result.shape, context);
    if (input.type === 'line') {
      const completion = completeLineRectangle(input, completionContext);
      if (completion) {
        if (isDuplicateRectangle(completion.corners, context.entities)) {
          return { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists' };
        }
        return {
          status: 'ready',
          input: { type: 'rect', corners: completion.corners },
          removeIds: completion.removeIds,
          reason: 'assembled rectangle',
        };
      }
    }
    return { status: 'ready', input, removeIds: [], reason: result.reason };
  }

  if (result.shape?.kind === 'rect' || result.shape?.kind === 'triangle') {
    const input = buildEntityFromStroke(session, result.shape, context);
    if (input.type === 'rect' && isDuplicateRectangle(input.corners, context.entities)) {
      return { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists' };
    }
    return { status: 'ready', input, removeIds: [], reason: result.reason };
  }

  if (isBorderSnap(session.start) && isBorderSnap(session.last)) {
    const completion = completeSharedBorder(session.planePoints(), session.start.world, session.last.world, completionContext);
    if (completion) {
      const aligned =
        alignRectangleToBorder(completion.corners, {
          ...completionContext,
          projector: context.projector,
          tolerancePx: context.tolerancePx,
        }) ?? completion;
      if (isDuplicateRectangle(aligned.corners, context.entities)) {
        return { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists' };
      }
      return {
        status: 'ready',
        input: { type: 'rect', corners: aligned.corners },
        removeIds: aligned.removeIds,
        reason: 'shared-border rectangle',
      };
    }
  }

  if (result.shape?.kind === 'polygon') {
    const quad = rectangleCornersFromPolygon(result.shape.corners);
    if (quad) {
      const input = buildEntityFromStroke(session, {
        kind: 'rect',
        corners: quad,
        width: 0,
        height: 0,
        oriented: true,
        angle: 0,
      }, context);
      if (input.type === 'rect' && isDuplicateRectangle(input.corners, context.entities)) {
        return { status: 'duplicate', input: null, removeIds: [], reason: 'rectangle already exists' };
      }
      if (input.type === 'rect') {
        return { status: 'ready', input, removeIds: [], reason: 'rectangle' };
      }
    }
    const input = buildEntityFromStroke(session, result.shape, context);
    return { status: 'ready', input, removeIds: [], reason: result.reason };
  }

  return { status: 'unrecognized', input: null, removeIds: [], reason: result.reason };
}
