import * as THREE from 'three';
import type { BoundingBox } from '../model/sketch';
import { type Vec2, type Vec3 } from '../model/vec';
import { CAMERA_FOV_DEG, type Viewport } from './viewport';

export type ViewPreset = 'top' | 'front' | 'right' | 'iso';

const PRESET_DIRECTIONS: Record<ViewPreset, THREE.Vector3> = {
  top: new THREE.Vector3(0, 0, 1),
  front: new THREE.Vector3(0, -1, 0),
  right: new THREE.Vector3(1, 0, 0),
  iso: new THREE.Vector3(1, -1, 1).normalize(),
};

export interface OrbitOptions {
  rotateSpeed: number;
  minDistance: number;
  maxDistance: number;
  maxElevationDeg: number;
}

export const DEFAULT_ORBIT_OPTIONS: OrbitOptions = {
  rotateSpeed: 0.006,
  minDistance: 20,
  maxDistance: 5e6,
  maxElevationDeg: 89,
};

const Z = new THREE.Vector3(0, 0, 1);
const HALF_FOV = THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2);

/**
 * Orbit / pan / zoom for a Z-up CAD camera.
 *
 * The state is a camera position plus a look-at target.  Orbit is a rigid
 * rotation of both around an arbitrary pivot, so the pivot stays fixed on
 * screen; elevation is clamped to avoid flipping over the poles.
 */
export class OrbitController {
  readonly position = new THREE.Vector3(6000, -6000, 5000);
  readonly target = new THREE.Vector3(0, 0, 0);
  readonly options: OrbitOptions;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly viewport: Viewport,
    options: Partial<OrbitOptions> = {},
  ) {
    this.options = { ...DEFAULT_ORBIT_OPTIONS, ...options };
    viewport.onResize(() => this.apply());
    this.apply();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get distance(): number {
    return this.position.distanceTo(this.target);
  }

  /** Camera basis vectors (forward, right, up) in world space. */
  basis(): { forward: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
    const forward = this.target.clone().sub(this.position).normalize();
    let right = forward.clone().cross(Z);
    if (right.lengthSq() < 1e-10) right = new THREE.Vector3(1, 0, 0);
    right.normalize();
    const up = right.clone().cross(forward).normalize();
    return { forward, right, up };
  }

  /** World units per screen pixel at the target depth (same for both projections). */
  worldPerPixel(): number {
    return (2 * this.distance * Math.tan(HALF_FOV)) / Math.max(1, this.viewport.height);
  }

  apply(): void {
    const { up } = this.basis();
    const distance = this.distance;
    for (const camera of [this.viewport.perspective, this.viewport.orthographic]) {
      camera.position.copy(this.position);
      camera.up.copy(up);
      camera.lookAt(this.target);
    }
    const perspective = this.viewport.perspective;
    perspective.near = Math.max(1, distance * 0.002);
    perspective.far = Math.max(perspective.near * 1000, distance * 400);
    perspective.updateProjectionMatrix();

    const ortho = this.viewport.orthographic;
    const halfHeight = distance * Math.tan(HALF_FOV);
    const halfWidth = halfHeight * this.viewport.aspect;
    ortho.left = -halfWidth;
    ortho.right = halfWidth;
    ortho.top = halfHeight;
    ortho.bottom = -halfHeight;
    ortho.near = -distance * 400;
    ortho.far = distance * 400;
    ortho.updateProjectionMatrix();
    for (const listener of this.listeners) listener();
  }

  /** Rotate around `pivot` by a screen-space drag. */
  orbit(dxPx: number, dyPx: number, pivot: Vec3): void {
    const pivotVector = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
    const azimuth = -dxPx * this.options.rotateSpeed;
    let elevationDelta = -dyPx * this.options.rotateSpeed;

    const direction = this.position.clone().sub(this.target).normalize();
    const elevation = Math.asin(THREE.MathUtils.clamp(direction.z, -1, 1));
    const limit = THREE.MathUtils.degToRad(this.options.maxElevationDeg);
    elevationDelta = THREE.MathUtils.clamp(elevation + elevationDelta, -limit, limit) - elevation;

    const { right } = this.basis();
    const rotation = new THREE.Quaternion()
      .setFromAxisAngle(Z, azimuth)
      .multiply(new THREE.Quaternion().setFromAxisAngle(right, elevationDelta));
    this.position.sub(pivotVector).applyQuaternion(rotation).add(pivotVector);
    this.target.sub(pivotVector).applyQuaternion(rotation).add(pivotVector);
    this.apply();
  }

  /** Slide the view by a screen-space drag (the scene follows the pen). */
  pan(dxPx: number, dyPx: number): void {
    const { right, up } = this.basis();
    const scale = this.worldPerPixel();
    const delta = right.multiplyScalar(-dxPx * scale).add(up.multiplyScalar(dyPx * scale));
    this.position.add(delta);
    this.target.add(delta);
    this.apply();
  }

  /** Zoom by `factor` (> 1 zooms in), optionally keeping the point under `anchorPx` fixed. */
  zoom(factor: number, anchorPx?: Vec2): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    const before = anchorPx ? this.pointAtTargetDepth(anchorPx) : null;
    const distance = THREE.MathUtils.clamp(this.distance / factor, this.options.minDistance, this.options.maxDistance);
    const direction = this.position.clone().sub(this.target).normalize();
    this.position.copy(this.target).addScaledVector(direction, distance);
    this.apply();
    if (before && anchorPx) {
      const after = this.pointAtTargetDepth(anchorPx);
      const shift = before.sub(after);
      this.position.add(shift);
      this.target.add(shift);
      this.apply();
    }
  }

  /** World point under a pixel on the plane through the target facing the camera. */
  pointAtTargetDepth(px: Vec2): THREE.Vector3 {
    const { forward } = this.basis();
    const ray = this.viewport.ray(px);
    const origin = new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z);
    const dir = new THREE.Vector3(ray.dir.x, ray.dir.y, ray.dir.z);
    const denom = dir.dot(forward);
    const t = Math.abs(denom) < 1e-9 ? 0 : this.target.clone().sub(origin).dot(forward) / denom;
    return origin.addScaledVector(dir, t);
  }

  setView(preset: ViewPreset): void {
    const direction = PRESET_DIRECTIONS[preset];
    const distance = this.distance;
    this.position.copy(this.target).addScaledVector(direction, distance);
    this.apply();
  }

  /** Frame a bounding box (or a default 6 m cube) without changing the view direction. */
  fit(box: BoundingBox | null, padding = 1.2): void {
    const center = box
      ? new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2)
      : new THREE.Vector3(0, 0, 0);
    const radius = box
      ? Math.max(200, new THREE.Vector3(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z).length() / 2)
      : 3500;
    const direction = this.position.clone().sub(this.target).normalize();
    const distance = THREE.MathUtils.clamp((radius * padding) / Math.sin(HALF_FOV), this.options.minDistance, this.options.maxDistance);
    this.target.copy(center);
    this.position.copy(center).addScaledVector(direction, distance);
    this.apply();
  }

  setOrtho(ortho: boolean): void {
    this.viewport.ortho = ortho;
    this.apply();
  }

  toggleProjection(): boolean {
    this.setOrtho(!this.viewport.ortho);
    return this.viewport.ortho;
  }
}
