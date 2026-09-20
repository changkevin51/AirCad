import * as THREE from 'three';
import type { BoundingBox } from '../model/sketch';
import { type Vec2, type Vec3 } from '../model/vec';
import { CAMERA_FOV_DEG, type Viewport } from './viewport';

export type ViewPreset = 'top' | 'front' | 'right' | 'iso';

const PRESET_ANGLES: Record<ViewPreset, { azimuth: number; elevation: number }> = {
  top: { azimuth: -Math.PI / 2, elevation: Math.PI / 2 },
  front: { azimuth: -Math.PI / 2, elevation: 0 },
  right: { azimuth: 0, elevation: 0 },
  iso: { azimuth: -Math.PI / 4, elevation: Math.asin(1 / Math.sqrt(3)) },
};

const PRESET_ORDER: readonly ViewPreset[] = ['top', 'front', 'right', 'iso'];

export interface OrbitOptions {
  rotateSpeed: number;
  minDistance: number;
  maxDistance: number;
  maxElevationDeg: number;
  transitionMs: number;
  snapAngleDeg: number;
  reducedMotion: boolean;
}

export const DEFAULT_ORBIT_OPTIONS: OrbitOptions = {
  rotateSpeed: 0.006,
  minDistance: 20,
  maxDistance: 5e6,
  maxElevationDeg: 90,
  transitionMs: 180,
  snapAngleDeg: 6,
  reducedMotion: false,
};

const HALF_FOV = THREE.MathUtils.degToRad(CAMERA_FOV_DEG / 2);
const MIN_SETTLE_PX = 3;

const snapTiny = (value: number): number => (Math.abs(value) < 1e-15 ? 0 : value);

function frameQuaternion(azimuth: number, elevation: number): THREE.Quaternion {
  const cosEl = snapTiny(Math.cos(elevation));
  const back = new THREE.Vector3(
    cosEl * snapTiny(Math.cos(azimuth)),
    cosEl * snapTiny(Math.sin(azimuth)),
    Math.sin(elevation),
  );
  const right = new THREE.Vector3(-snapTiny(Math.sin(azimuth)), snapTiny(Math.cos(azimuth)), 0);
  const up = back.clone().cross(right).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, back));
}

const toVector = (point: Vec3): THREE.Vector3 => new THREE.Vector3(point.x, point.y, point.z);

interface CameraTransition {
  startOrientation: THREE.Quaternion;
  endOrientation: THREE.Quaternion;
  startPosition: THREE.Vector3;
  startTarget: THREE.Vector3;
  pivot: THREE.Vector3;
  endAzimuth: number;
  startTime: number;
}

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
  private readonly orientation = new THREE.Quaternion();
  private azimuth = 0;
  private transition: CameraTransition | null = null;
  private gesturePivot: THREE.Vector3 | null = null;
  private lastOrbitPivot: THREE.Vector3 | null = null;
  private gestureMotion = 0;

  constructor(
    private readonly viewport: Pick<
      Viewport,
      'onResize' | 'perspective' | 'orthographic' | 'ortho' | 'height' | 'aspect' | 'ray'
    >,
    options: Partial<OrbitOptions> = {},
  ) {
    this.options = { ...DEFAULT_ORBIT_OPTIONS, ...options };
    const direction = this.position.clone().sub(this.target).normalize();
    this.azimuth = Math.atan2(direction.y, direction.x);
    this.orientation.copy(
      frameQuaternion(this.azimuth, Math.asin(THREE.MathUtils.clamp(direction.z, -1, 1))),
    );
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

  get transitioning(): boolean {
    return this.transition !== null;
  }

  /** Camera basis vectors (forward, right, up) in world space. */
  basis(): { forward: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 } {
    return {
      forward: new THREE.Vector3(0, 0, -1).applyQuaternion(this.orientation),
      right: new THREE.Vector3(1, 0, 0).applyQuaternion(this.orientation),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(this.orientation),
    };
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
      camera.quaternion.copy(this.orientation);
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
    for (const camera of [this.viewport.perspective, this.viewport.orthographic]) {
      camera.updateMatrixWorld(true);
    }
    for (const listener of this.listeners) listener();
  }

  update(nowMs: number): void {
    const transition = this.transition;
    if (!transition) return;
    const duration = Math.max(1, this.options.transitionMs);
    const t = THREE.MathUtils.clamp((nowMs - transition.startTime) / duration, 0, 1);
    if (t >= 1) {
      this.transition = null;
      this.finishTransition(transition);
      return;
    }
    const eased = t * t * (3 - 2 * t);
    const q = transition.startOrientation.clone().slerp(transition.endOrientation, eased);
    this.applyTransitionPose(transition, q);
    this.apply();
  }

  cancelTransition(finish = false): void {
    const transition = this.transition;
    if (!transition) return;
    this.transition = null;
    if (finish) this.finishTransition(transition);
  }

  beginOrbit(pivot: Vec3): void {
    this.cancelTransition();
    this.gesturePivot = toVector(pivot);
    this.lastOrbitPivot = this.gesturePivot;
    this.gestureMotion = 0;
  }

  endOrbit(settle = true, nowMs = performance.now()): ViewPreset | null {
    const pivot = this.gesturePivot ?? this.lastOrbitPivot;
    const motion = this.gestureMotion;
    this.endGesture();
    if (!settle || !pivot || motion < MIN_SETTLE_PX) return null;
    const snapAngle = THREE.MathUtils.degToRad(this.options.snapAngleDeg);
    let nearest: ViewPreset | null = null;
    let nearestAngle = Infinity;
    for (const preset of PRESET_ORDER) {
      const angles = PRESET_ANGLES[preset];
      const orientationAngle = this.orientation.angleTo(frameQuaternion(angles.azimuth, angles.elevation));
      if (orientationAngle < nearestAngle) {
        nearestAngle = orientationAngle;
        nearest = preset;
      }
    }
    if (!nearest || nearestAngle > snapAngle) return null;
    const angles = PRESET_ANGLES[nearest];
    this.beginTransition(pivot, frameQuaternion(angles.azimuth, angles.elevation), angles.azimuth, nowMs, true);
    return nearest;
  }

  /** Rotate around `pivot` by a screen-space drag. */
  orbit(dxPx: number, dyPx: number, pivot: Vec3): void {
    if (!(Number.isFinite(dxPx) && Number.isFinite(dyPx)) || (dxPx === 0 && dyPx === 0)) return;
    this.cancelTransition();
    const pivotVector = this.gesturePivot ?? toVector(pivot);
    this.lastOrbitPivot = pivotVector;
    this.gestureMotion += Math.hypot(dxPx, dyPx);

    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.orientation);
    const azimuth = Math.hypot(back.x, back.y) > 1e-9 ? Math.atan2(back.y, back.x) : this.azimuth;
    const elevation = Math.asin(THREE.MathUtils.clamp(back.z, -1, 1));
    const limit = Math.min(THREE.MathUtils.degToRad(this.options.maxElevationDeg), Math.PI / 2);
    const nextAzimuth = azimuth - dxPx * this.options.rotateSpeed;
    const nextElevation = THREE.MathUtils.clamp(elevation - dyPx * this.options.rotateSpeed, -limit, limit);

    const rotation = frameQuaternion(nextAzimuth, nextElevation).multiply(
      frameQuaternion(azimuth, elevation).invert(),
    );
    this.position.sub(pivotVector).applyQuaternion(rotation).add(pivotVector);
    this.target.sub(pivotVector).applyQuaternion(rotation).add(pivotVector);
    this.orientation.premultiply(rotation).normalize();
    this.azimuth = nextAzimuth;
    this.apply();
  }

  /** Slide the view by a screen-space drag (the scene follows the pen). */
  pan(dxPx: number, dyPx: number): void {
    if (!(Number.isFinite(dxPx) && Number.isFinite(dyPx)) || (dxPx === 0 && dyPx === 0)) return;
    this.cancelTransition();
    const { right, up } = this.basis();
    const scale = this.worldPerPixel();
    const delta = right.multiplyScalar(-dxPx * scale).add(up.multiplyScalar(dyPx * scale));
    this.position.add(delta);
    this.target.add(delta);
    this.apply();
  }

  /** Zoom by `factor` (> 1 zooms in), optionally keeping the point under `anchorPx` fixed. */
  zoom(factor: number, anchorPx?: Vec2, anchorWorld?: Vec3): void {
    if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return;
    const distance = THREE.MathUtils.clamp(
      this.distance / factor,
      this.options.minDistance,
      this.options.maxDistance,
    );
    if (distance === this.distance) return;
    this.cancelTransition();
    const { forward } = this.basis();
    const planePoint = anchorWorld ? toVector(anchorWorld) : this.target.clone();
    const before = anchorPx ? this.rayPlaneHit(anchorPx, planePoint, forward) : null;
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(this.orientation);
    this.position.copy(this.target).addScaledVector(direction, distance);
    this.apply();
    if (before && anchorPx) {
      const after = this.rayPlaneHit(anchorPx, planePoint, forward);
      if (after) {
        const shift = before.sub(after);
        this.position.add(shift);
        this.target.add(shift);
        this.apply();
      }
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

  setView(preset: ViewPreset, animate = true, nowMs = performance.now()): void {
    this.endGesture();
    const angles = PRESET_ANGLES[preset];
    this.beginTransition(
      this.target.clone(),
      frameQuaternion(angles.azimuth, angles.elevation),
      angles.azimuth,
      nowMs,
      animate,
    );
  }

  /** Frame a bounding box (or a default 6 m cube) without changing the view direction. */
  fit(box: BoundingBox | null, padding = 1.2): void {
    this.cancelTransition();
    this.endGesture();
    const center = box
      ? new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2)
      : new THREE.Vector3(0, 0, 0);
    const radius = box
      ? Math.max(200, new THREE.Vector3(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z).length() / 2)
      : 3500;
    const direction = this.position.clone().sub(this.target).normalize();
    const verticalHalf = HALF_FOV;
    const horizontalHalf = Math.atan(Math.tan(verticalHalf) * this.viewport.aspect);
    const half = Math.min(verticalHalf, horizontalHalf);
    const need = radius * padding;
    const distance = THREE.MathUtils.clamp(
      Math.max(
        need / Math.sin(half),
        need / Math.tan(verticalHalf),
        need / (Math.tan(verticalHalf) * this.viewport.aspect),
      ),
      this.options.minDistance,
      this.options.maxDistance,
    );
    this.target.copy(center);
    this.position.copy(center).addScaledVector(direction, distance);
    this.apply();
  }

  setOrtho(ortho: boolean): void {
    this.cancelTransition();
    this.endGesture();
    this.viewport.ortho = ortho;
    this.apply();
  }

  toggleProjection(): boolean {
    this.setOrtho(!this.viewport.ortho);
    return this.viewport.ortho;
  }

  private endGesture(): void {
    this.gesturePivot = null;
    this.lastOrbitPivot = null;
    this.gestureMotion = 0;
  }

  private beginTransition(
    pivot: THREE.Vector3,
    endOrientation: THREE.Quaternion,
    endAzimuth: number,
    nowMs: number,
    animate: boolean,
  ): void {
    const transition: CameraTransition = {
      startOrientation: this.orientation.clone(),
      endOrientation,
      startPosition: this.position.clone(),
      startTarget: this.target.clone(),
      pivot: pivot.clone(),
      endAzimuth,
      startTime: nowMs,
    };
    if (!animate || this.options.reducedMotion || !(this.options.transitionMs > 0)) {
      this.transition = null;
      this.finishTransition(transition);
      return;
    }
    this.transition = transition;
  }

  private applyTransitionPose(transition: CameraTransition, orientation: THREE.Quaternion): void {
    const delta = orientation.clone().multiply(transition.startOrientation.clone().invert());
    this.position.copy(transition.startPosition).sub(transition.pivot).applyQuaternion(delta).add(transition.pivot);
    this.target.copy(transition.startTarget).sub(transition.pivot).applyQuaternion(delta).add(transition.pivot);
    this.orientation.copy(orientation);
  }

  private finishTransition(transition: CameraTransition): void {
    this.applyTransitionPose(transition, transition.endOrientation);
    this.azimuth = transition.endAzimuth;
    this.apply();
  }

  private rayPlaneHit(px: Vec2, planePoint: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
    const ray = this.viewport.ray(px);
    const origin = new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z);
    const dir = new THREE.Vector3(ray.dir.x, ray.dir.y, ray.dir.z);
    const denom = dir.dot(normal);
    if (Math.abs(denom) < 1e-9) return null;
    const t = planePoint.clone().sub(origin).dot(normal) / denom;
    if (!Number.isFinite(t) || t <= 0) return null;
    return origin.addScaledVector(dir, t);
  }
}
