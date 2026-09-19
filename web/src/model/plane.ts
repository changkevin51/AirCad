import { add, dot, ORIGIN, scale, v2, v3, X_AXIS, Y_AXIS, Z_AXIS, type Vec2, type Vec3 } from './vec';

export type PlaneKind = 'XY' | 'XZ' | 'YZ';
export type Axis = 'x' | 'y' | 'z';

export interface PlaneInfo {
  kind: PlaneKind;
  /** Short label shown in the HUD, e.g. "XY Top". */
  label: string;
  view: 'Top' | 'Front' | 'Right';
  u: Readonly<Vec3>;
  v: Readonly<Vec3>;
  normal: Readonly<Vec3>;
  normalAxis: Axis;
  uAxis: Axis;
  vAxis: Axis;
}

export const PLANE_ORDER: readonly PlaneKind[] = ['XY', 'XZ', 'YZ'];

export const PLANES: Readonly<Record<PlaneKind, PlaneInfo>> = {
  XY: { kind: 'XY', label: 'XY Top', view: 'Top', u: X_AXIS, v: Y_AXIS, normal: Z_AXIS, normalAxis: 'z', uAxis: 'x', vAxis: 'y' },
  XZ: { kind: 'XZ', label: 'XZ Front', view: 'Front', u: X_AXIS, v: Z_AXIS, normal: Y_AXIS, normalAxis: 'y', uAxis: 'x', vAxis: 'z' },
  YZ: { kind: 'YZ', label: 'YZ Right', view: 'Right', u: Y_AXIS, v: Z_AXIS, normal: X_AXIS, normalAxis: 'x', uAxis: 'y', vAxis: 'z' },
};

export const AXIS_VECTORS: Readonly<Record<Axis, Readonly<Vec3>>> = { x: X_AXIS, y: Y_AXIS, z: Z_AXIS };

export function nextPlaneKind(kind: PlaneKind): PlaneKind {
  const index = PLANE_ORDER.indexOf(kind);
  return PLANE_ORDER[(index + 1) % PLANE_ORDER.length];
}

/**
 * An axis-aligned work plane passing through `anchor`.
 *
 * Plane coordinates are absolute world coordinates along the plane's two
 * axes (for XZ: `(x, z)`), not offsets from the anchor.  That keeps grid
 * snapping identical to the world grid and makes round trips trivial.
 */
export class WorkPlane {
  readonly kind: PlaneKind;
  readonly anchor: Vec3;

  constructor(kind: PlaneKind = 'XY', anchor: Vec3 = ORIGIN) {
    this.kind = kind;
    this.anchor = { ...anchor };
  }

  get info(): PlaneInfo {
    return PLANES[this.kind];
  }

  get u(): Readonly<Vec3> {
    return this.info.u;
  }

  get v(): Readonly<Vec3> {
    return this.info.v;
  }

  get normal(): Readonly<Vec3> {
    return this.info.normal;
  }

  get label(): string {
    return this.info.label;
  }

  /** Signed offset of the plane along its normal. */
  get offset(): number {
    return dot(this.anchor, this.normal);
  }

  /** Origin of the plane coordinate system in world space (plane point (0, 0)). */
  get origin(): Vec3 {
    return scale(this.normal, this.offset);
  }

  withKind(kind: PlaneKind): WorkPlane {
    return new WorkPlane(kind, this.anchor);
  }

  withAnchor(anchor: Vec3): WorkPlane {
    return new WorkPlane(this.kind, anchor);
  }

  toPlane(p: Vec3): Vec2 {
    return v2(dot(p, this.u), dot(p, this.v));
  }

  toWorld(q: Vec2): Vec3 {
    return add(add(scale(this.u, q.x), scale(this.v, q.y)), this.origin);
  }

  signedDistance(p: Vec3): number {
    return dot(p, this.normal) - this.offset;
  }

  contains(p: Vec3, eps = 1e-6): boolean {
    return Math.abs(this.signedDistance(p)) <= eps;
  }

  /** Closest point on the plane. */
  project(p: Vec3): Vec3 {
    return this.toWorld(this.toPlane(p));
  }

  /**
   * Intersect a ray with the plane.  Returns null when the ray is parallel
   * (edge-on view) or the plane lies behind the ray origin.
   */
  intersectRay(origin: Vec3, dir: Vec3, allowBehind = false): Vec3 | null {
    const denom = dot(dir, this.normal);
    if (Math.abs(denom) < 1e-9) return null;
    const t = (this.offset - dot(origin, this.normal)) / denom;
    if (t < 0 && !allowBehind) return null;
    return add(origin, scale(dir, t));
  }

  /** True when the view direction is (almost) parallel to the plane. */
  isEdgeOn(viewDir: Vec3, threshold = 0.08): boolean {
    return Math.abs(dot(viewDir, this.normal)) < threshold;
  }

  /** Preserve the plane's normal offset while moving the anchor in the plane. */
  equals(other: WorkPlane): boolean {
    return this.kind === other.kind && Math.abs(this.offset - other.offset) < 1e-9;
  }

  toJSON(): { kind: PlaneKind; anchor: Vec3 } {
    return { kind: this.kind, anchor: { ...this.anchor } };
  }

  static fromJSON(data: { kind: PlaneKind; anchor: Vec3 }): WorkPlane {
    return new WorkPlane(data.kind, v3(data.anchor.x, data.anchor.y, data.anchor.z));
  }
}
