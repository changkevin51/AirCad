import * as THREE from 'three';
import type { SpatialSnapType } from '../model/spatial-snap';
import type { Vec3 } from '../model/vec';
import { THREE_COLORS } from '../ui/theme';

const SNAP_COLORS: Record<SpatialSnapType, number> = {
  vertex: THREE_COLORS.hoverSnap,
  midpoint: THREE_COLORS.success,
  edge: THREE_COLORS.accent,
  grid: 0xc8cdd3,
  lock: THREE_COLORS.warning,
  free: THREE_COLORS.hoverSnap,
};

export interface SpatialCursorVisualOptions {
  workspace?: number;
  radius?: number;
  snapType?: SpatialSnapType;
  target?: Vec3 | null;
}

/** World-space depth cursor: marker, snap-radius sphere, target highlight, drop line. */
export class SpatialCursorVisual {
  readonly group = new THREE.Group();
  private readonly marker: THREE.Mesh;
  private readonly radiusSphere: THREE.Mesh;
  private readonly targetMark: THREE.Mesh;
  private readonly drop: THREE.Line;
  private readonly axes: THREE.LineSegments;
  private readonly dropPositions: THREE.Float32BufferAttribute;

  constructor() {
    this.group.name = 'spatial-cursor';
    this.marker = new THREE.Mesh(
      new THREE.SphereGeometry(4, 12, 8),
      new THREE.MeshBasicMaterial({ color: THREE_COLORS.hoverSnap, depthTest: false }),
    );
    this.marker.renderOrder = 21;
    this.radiusSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: THREE_COLORS.hoverSnap, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.radiusSphere.renderOrder = 19;
    this.targetMark = new THREE.Mesh(
      new THREE.SphereGeometry(6, 12, 8),
      new THREE.MeshBasicMaterial({ color: THREE_COLORS.text, depthTest: false }),
    );
    this.targetMark.renderOrder = 22;
    this.targetMark.visible = false;
    this.dropPositions = new THREE.Float32BufferAttribute(6, 3);
    this.drop = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', this.dropPositions),
      new THREE.LineBasicMaterial({ color: 0xc8cdd3, transparent: true, opacity: 0.35, depthTest: false }),
    );
    this.drop.renderOrder = 20;
    const axisPoints = [-40, 0, 0, 40, 0, 0, 0, -40, 0, 0, 40, 0, 0, 0, 0, 0, 0, 80];
    this.axes = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(axisPoints, 3)),
      new THREE.LineBasicMaterial({ vertexColors: false, color: THREE_COLORS.accent, transparent: true, opacity: 0.45 }),
    );
    this.group.add(this.marker, this.radiusSphere, this.targetMark, this.drop, this.axes);
    this.group.visible = false;
  }

  update(world: Vec3 | null, visible: boolean, extras: number | SpatialCursorVisualOptions = {}): void {
    const options: SpatialCursorVisualOptions = typeof extras === 'number' ? { workspace: extras } : extras;
    const workspace = options.workspace ?? 400;
    this.group.visible = visible && !!world;
    if (!world) return;
    const color = SNAP_COLORS[options.snapType ?? 'free'];
    (this.marker.material as THREE.MeshBasicMaterial).color.setHex(color);
    (this.radiusSphere.material as THREE.MeshBasicMaterial).color.setHex(color);
    this.marker.position.set(world.x, world.y, world.z);
    const radius = Math.max(1, options.radius ?? 4);
    this.radiusSphere.position.set(world.x, world.y, world.z);
    this.radiusSphere.scale.setScalar(radius);
    const target = options.target;
    this.targetMark.visible = !!target && (options.snapType === 'vertex' || options.snapType === 'midpoint' || options.snapType === 'edge' || options.snapType === 'lock');
    if (target && this.targetMark.visible) {
      (this.targetMark.material as THREE.MeshBasicMaterial).color.setHex(color);
      this.targetMark.position.set(target.x, target.y, target.z);
    }
    this.dropPositions.setXYZ(0, world.x, world.y, world.z);
    this.dropPositions.setXYZ(1, world.x, world.y, 0);
    this.dropPositions.needsUpdate = true;
    this.axes.scale.setScalar(workspace / 80);
    this.axes.position.set(0, 0, 0);
  }
}
